import type { NotificationSignalAttributes } from "@mastra/core/notifications";
import { registerApiRoute } from "@mastra/core/server";
import type { ApiRoute } from "@mastra/core/server";
import type { InputProcessorOrWorkflow, ProcessInputStepArgs } from "@mastra/core/processors";
import { SignalProvider } from "@mastra/core/signals";
import type { SignalProviderTarget, SignalProviderWebhookRequest, SignalSubscription } from "@mastra/core/signals";
import type { ChannelInstallation, ChannelsStorage } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { computeLinkNonce, computeWebhookSignature, decrypt, deriveMediaKey, encrypt, isEncrypted, safeEqual, signMediaPath } from "./crypto";
import { RingApiClient, RingApiError } from "./ring-api";
import type { RingAuth } from "./ring-api";
import type { RingAccount, RingEventNotification, RingEventType, RingSignalsOptions, RingTokens, RingWebhookEvent } from "./types";

const PLATFORM = "ring";

/**
 * Guidance added to the agent's system prompt for Ring notifications, covering only the enabled tools.
 * It depends only on config, so it's the same on every request and doesn't invalidate the prompt cache.
 */
export const buildRingInstructions = (tools: {
  snapshot: boolean | { inReply: boolean };
  clip: boolean | { inReply: boolean };
}): string => {
  const snapshotInReply = typeof tools.snapshot === "object" ? tools.snapshot.inReply : true;
  const clipInReply = typeof tools.clip === "object" ? tools.clip.inReply : true;
  const steps = [
    ...(tools.snapshot
      ? [
          snapshotInReply
            ? "Call ring_snapshot with its deviceId and timestamp, then describe who or what is at the door. Show the snapshot url as a markdown image."
            : "Call ring_snapshot with its deviceId and timestamp, then describe who or what is at the door. The app shows the image, so don't include its url."
        ]
      : []),
    ...(tools.clip
      ? [
          clipInReply
            ? "Call ring_clip with the same deviceId and timestamp, and link the clip url as [Watch clip](url)."
            : "Call ring_clip with the same deviceId and timestamp. The app shows the clip, so don't include its url."
        ]
      : [])
  ];
  const lines = ['Ring events arrive as <notification source="ring"> messages with deviceId and timestamp attributes.'];
  if (steps.length > 0) {
    lines.push('When a notification has type="button_press":', ...steps.map((step, index) => `${index + 1}. ${step}`));
  }
  return lines.join("\n");
};

/**
 * Default guidance when both tools are enabled.
 */
export const DEFAULT_RING_INSTRUCTIONS = buildRingInstructions({ snapshot: true, clip: true });
const LINK_WINDOW_MS = 10 * 60 * 1000;
const SNAPSHOT_WINDOW_MS = 15_000;
const SNAPSHOT_LOOK_BACK_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
const DEFAULT_CLIP_DURATION_MS = 15_000;
const CLIP_READY_TIMEOUT_MS = 120_000;
const CLIP_RETRY_MS = 5_000;
const DEFAULT_MEDIA_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Default notification for each Ring event type. Unlisted events are ignored.
 */
export const DEFAULT_RING_EVENTS: Partial<Record<RingEventType, RingEventNotification>> = {
  button_press: { priority: "high", summary: "Someone rang the doorbell." },
  motion_detected: { priority: "medium", summary: "Motion was detected." }
};

const primitiveAttributes = (attributes: Record<string, unknown> = {}): NotificationSignalAttributes => {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value),
    ),
  ) as NotificationSignalAttributes;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ring signal provider.
 *
 * Links a Ring account to an agent, receives Ring webhooks, and sends each event
 * to an agent thread as a notification signal. Adds `ring_snapshot` and `ring_clip`
 * tools so the agent can fetch media for an event.
 *
 * ```ts
 * const ring = new RingSignals();
 *
 * const agent = new Agent({ signals: [ring], ... });
 *
 * export const mastra = new Mastra({ agents: { agent }, storage });
 * ```
 *
 * Mastra adds the routes from `getRoutes()` to the server when the agent is registered.
 */
export class RingSignals extends SignalProvider<"ring-signals"> {
  readonly id = "ring-signals" as const;
  override readonly name = "Ring Signals";

  readonly #options: RingSignalsOptions;
  readonly #api: RingApiClient;
  readonly #hmacKey: string;
  readonly #mediaKey: string;
  readonly #missingConfig: string[];
  readonly #routePrefix: string;
  readonly #events: Partial<Record<RingEventType, RingEventNotification | false>>;
  readonly #snapshots = new Map<string, string>();
  #warnedPlaintext = false;

  constructor(options: RingSignalsOptions = {}) {
    super();
    this.#options = options;
    const clientId = options.clientId ?? process.env.RING_CLIENT_ID ?? "";
    const clientSecret = options.clientSecret ?? process.env.RING_CLIENT_SECRET ?? "";
    this.#hmacKey = options.hmacKey ?? process.env.RING_HMAC_KEY ?? "";
    this.#mediaKey = this.#hmacKey ? deriveMediaKey(this.#hmacKey) : "";
    this.#missingConfig = [
      ...(clientId ? [] : ["clientId (RING_CLIENT_ID)"]),
      ...(clientSecret ? [] : ["clientSecret (RING_CLIENT_SECRET)"]),
      ...(this.#hmacKey ? [] : ["hmacKey (RING_HMAC_KEY)"])
    ];
    this.#routePrefix = (options.routePrefix ?? "/ring").replace(/\/$/, "");
    this.#events = { ...DEFAULT_RING_EVENTS, ...options.events };
    this.#api = new RingApiClient({ clientId, clientSecret, userAgent: options.userAgent ?? "MastraRingSignals/1.0" });
  }

  /**
   * Registers the Ring routes on the Mastra server when the agent is added to Mastra,
   * so they don't need to be added to `server.apiRoutes` by hand.
   *
   * Temporary: remove once `@mastra/core` merges `getRoutes()` from signal providers
   * itself (https://github.com/mastra-ai/mastra/pull/28575). Core skips routes that are
   * already registered, so keeping this alongside the core hook won't mount them twice.
   */
  override __registerMastra(mastra: Parameters<SignalProvider["__registerMastra"]>[0]): void {
    super.__registerMastra(mastra);

    if (this.#missingConfig.length > 0) {
      mastra.getLogger()?.warn(`[Ring] RingSignals is missing ${this.#missingConfig.join(", ")}. Account linking, webhooks and media will fail until it's set.`);
    }

    const server = mastra.getServer() ?? {};
    const existingRoutes = server.apiRoutes ?? [];
    const newRoutes = this.getRoutes().filter((route) => !existingRoutes.some((existing) => existing.path === route.path && existing.method === route.method));

    if (newRoutes.length > 0) {
      mastra.setServer({ ...server, apiRoutes: [...existingRoutes, ...newRoutes] });
    }
  }

  // ── Subscriptions ───────────────────────────────────────────────────

  /**
   * Send events from a Ring device to a specific thread.
   * Devices without a subscription use the `target` option.
   */
  subscribeThread(target: SignalProviderTarget, deviceId: string): SignalSubscription {
    return this.subscribe(target, deviceId);
  }

  /**
   * Stop sending events from a Ring device to a thread.
   *
   * @returns `true` if the thread was subscribed.
   */
  unsubscribeThread(target: SignalProviderTarget, deviceId: string): boolean {
    return this.unsubscribe(target, deviceId);
  }

  // ── Webhooks ────────────────────────────────────────────────────────

  /**
   * Verify and handle a Ring webhook. `body` must be the raw request body string,
   * because Ring signs the exact bytes it sent.
   */
  async handleWebhook(request: SignalProviderWebhookRequest): Promise<{ status?: number; body?: unknown }> {
    this.#assertConfigured();
    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const signature = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "x-signature")?.[1];

    if (!signature || !safeEqual(computeWebhookSignature(this.#hmacKey, rawBody), signature)) {
      return { status: 401, body: { error: "invalid signature" } };
    }

    const event = JSON.parse(rawBody) as RingWebhookEvent;
    const notification = this.#events[event.data.type as RingEventType];

    if (!notification) {
      return { status: 200, body: { ignored: event.data.type } };
    }

    const targets = await this.#resolveTargets(event);
    const { source: deviceId, timestamp, sub_type: motionType } = event.data.attributes;

    for (const target of targets) {
      await this.notify(
        {
          source: "ring",
          kind: event.data.type,
          priority: notification.priority,
          summary: notification.summary,
          attributes: {
            deviceId,
            timestamp,
            ...(motionType ? { motionType } : {}),
            ...primitiveAttributes(notification.attributes?.(event)),
          },
          payload: event.data,
          dedupeKey: `ring:${event.meta.request_id}:${target.threadId}`,
          ...(notification.coalesce ? { coalesceKey: `ring:${event.data.type}:${deviceId}` } : {})
        },
        target
      );
    }

    return { status: 200, body: { delivered: targets.length } };
  }

  // ── Routes ──────────────────────────────────────────────────────────

  /**
   * API routes for Ring account linking, webhooks and media. Mastra adds them to `server.apiRoutes` automatically.
   *
   * | Ring setting       | Route                         |
   * | ------------------ | ----------------------------- |
   * | Account Link URL   | `GET  {prefix}/link`          |
   * | Token Exchange URL | `POST {prefix}/token`         |
   * | Webhook URL        | `POST {prefix}/webhook`       |
   * | App Homepage URL   | `GET  {prefix}/home`          |
   */
  getRoutes(): ApiRoute[] {
    const prefix = this.#routePrefix;

    return [
      registerApiRoute(`${prefix}/token`, {
        method: "POST",
        requiresAuth: false,
        handler: async (context) => {
          const { code } = await context.req.parseBody();
          try {
            await this.#exchangeCode(String(code));
            return context.json({ ok: true });
          } catch (error) {
            this.#logError("token exchange failed", error);
            return context.json({ error: "token exchange failed" }, 500);
          }
        }
      }),
      registerApiRoute(`${prefix}/link`, {
        method: "GET",
        requiresAuth: false,
        handler: async (context) => {
          const { nonce, time } = context.req.query();
          try {
            const failure = await this.#completeLink(nonce ?? "", time ?? "");
            if (failure) {
              this.#logError(`account link failed: ${failure}`);
              return context.text(`Ring account link failed: ${failure}`, 400);
            }
            return context.text("Ring account linked");
          } catch (error) {
            this.#logError("account link failed", error);
            return context.text("Ring account link failed", 500);
          }
        }
      }),
      registerApiRoute(`${prefix}/webhook`, {
        method: "POST",
        requiresAuth: false,
        handler: async (context) => {
          try {
            const result = await this.handleWebhook({
              body: await context.req.text(),
              headers: Object.fromEntries(context.req.raw.headers.entries())
            });
            return context.json(result.body ?? {}, (result.status ?? 200) as 200);
          } catch (error) {
            this.#logError("webhook failed", error);
            return context.json({ error: "webhook failed" }, 500);
          }
        }
      }),
      registerApiRoute(`${prefix}/home`, {
        method: "GET",
        requiresAuth: false,
        handler: async (context) => context.text(this.name)
      }),
      registerApiRoute(`${prefix}/media/:kind/:deviceId/:timestamp`, {
        method: "GET",
        requiresAuth: false,
        handler: async (context) => {
          const { kind, deviceId, timestamp } = context.req.param();
          const path = `${kind}/${deviceId}/${timestamp}`;
          const expires = Number(context.req.query("expires"));
          const signature = context.req.query("signature") ?? "";

          if (!this.#mediaKey || !safeEqual(signMediaPath(this.#mediaKey, path, expires), signature)) {
            return context.text("Invalid signature", 403);
          }
          if (!(expires > Date.now())) {
            return context.text("Link expired", 403);
          }

          const media = kind === "clip" ? await this.#downloadClip(deviceId, Number(timestamp)) : await this.#downloadSnapshot(deviceId, Number(timestamp));

          if (!media) {
            return context.text("Not found", 404);
          }

          const contentType = kind === "clip" ? "video/mp4" : "image/jpeg";
          const range = /^bytes=(\d*)-(\d*)$/.exec(context.req.header("Range") ?? "");

          if (range) {
            const start = range[1] ? Number(range[1]) : Math.max(media.length - Number(range[2]), 0);
            const end = range[1] && range[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;

            if (start > end || start >= media.length) {
              return context.body(null, 416, { "Content-Range": `bytes */${media.length}` });
            }

            return context.body(new Uint8Array(media.subarray(start, end + 1)), 206, {
              "Content-Type": contentType,
              "Content-Range": `bytes ${start}-${end}/${media.length}`,
              "Accept-Ranges": "bytes"
            });
          }

          return context.body(new Uint8Array(media), 200, {
            "Content-Type": contentType,
            "Accept-Ranges": "bytes"
          });
        }
      })
    ];
  }

  // ── Tools ───────────────────────────────────────────────────────────

  getInputProcessors(): InputProcessorOrWorkflow[] {
    return [this as unknown as InputProcessorOrWorkflow];
  }

  /**
   * Adds the Ring guidance as a tagged system message. The text never changes, so the
   * system prompt stays identical across requests and the prompt cache stays valid.
   */
  processInputStep({ messageList }: ProcessInputStepArgs) {
    const instructions =
      this.#options.instructions ??
      buildRingInstructions({ snapshot: this.#snapshotOptions() ?? false, clip: this.#clipOptions() ?? false });
    if (instructions) {
      messageList.addSystem(instructions, "ring-signals");
    }
    return messageList;
  }

  /**
   * Resolved snapshot settings, or `undefined` when the snapshot tool is disabled.
   */
  #snapshotOptions(): { inReply: boolean } | undefined {
    const snapshot = this.#options.tools ? this.#options.tools.snapshot : true;
    if (!snapshot) return undefined;
    const options = snapshot === true ? {} : snapshot;
    return { inReply: options.inReply ?? true };
  }

  /**
   * Resolved clip settings, or `undefined` when the clip tool is disabled.
   */
  #clipOptions(): { inReply: boolean; audio: boolean; durationMs: number } | undefined {
    const clip = this.#options.tools ? this.#options.tools.clip : true;
    if (!clip) return undefined;
    const options = clip === true ? {} : clip;
    return { inReply: options.inReply ?? true, audio: options.audio ?? true, durationMs: options.durationMs ?? DEFAULT_CLIP_DURATION_MS };
  }

  getTools() {
    const clipOptions = this.#clipOptions();
    const clipSeconds = Math.round((clipOptions?.durationMs ?? DEFAULT_CLIP_DURATION_MS) / 1000);

    const ringSnapshot = createTool({
      id: "ring_snapshot",
      description:
        "Get a still image from a Ring camera for an event. Uses the latest image after the event, or the most recent image before it if there is none.",
      inputSchema: z.object({
        deviceId: z.string().describe("The deviceId attribute from the Ring notification"),
        timestamp: z.number().describe("The timestamp attribute from the Ring notification, in epoch milliseconds")
      }),
      outputSchema: z.object({ url: z.string() }),
      execute: async ({ deviceId, timestamp }) => {
        const image = await this.#downloadSnapshot(deviceId, timestamp);
        if (!image) {
          throw new Error("Ring has no image for this device in the last 24 hours.");
        }
        const url = this.#mediaUrl("snapshot", deviceId, timestamp);
        this.#snapshots.set(url, image.toString("base64"));
        return { url };
      },
      toModelOutput: (output) => {
        const image = this.#snapshots.get(output.url);
        this.#snapshots.delete(output.url);
        return {
          type: "content",
          value: [
            {
              type: "text",
              text: this.#snapshotOptions()?.inReply
                ? `Show the snapshot by copying this markdown exactly:\n![Snapshot](${output.url})`
                : "Snapshot fetched. The app shows it to the user, so don't include its url."
            },
            ...(image ? [{ type: "image-data" as const, data: image, mediaType: "image/jpeg" }] : [])
          ]
        };
      }
    });

    const ringClip = createTool({
      id: "ring_clip",
      description: `Get a link to a ${clipSeconds} second Ring video clip starting at an event. Waits up to 2 minutes for Ring to process it.`,
      inputSchema: z.object({
        deviceId: z.string().describe("The deviceId attribute from the Ring notification"),
        timestamp: z.number().describe("The timestamp attribute from the Ring notification, in epoch milliseconds")
      }),
      outputSchema: z.object({ url: z.string() }),
      execute: async ({ deviceId, timestamp }) => {
        const clip = await this.#downloadClip(deviceId, timestamp);
        if (!clip) {
          throw new Error("Ring has no recording for this event.");
        }
        return { url: this.#mediaUrl("clip", deviceId, timestamp) };
      },
      toModelOutput: (output) => {
        return {
          type: "content",
          value: [
            {
              type: "text",
              text: this.#clipOptions()?.inReply
                ? `Link the clip by copying this markdown exactly:\n[Watch clip](${output.url})`
                : "Clip fetched. The app shows it to the user, so don't include its url."
            }
          ]
        };
      }
    });

    return {
      ...(this.#snapshotOptions() ? { ring_snapshot: ringSnapshot } : {}),
      ...(clipOptions ? { ring_clip: ringClip } : {})
    };
  }

  // ── Routing ─────────────────────────────────────────────────────────

  async #resolveTargets(event: RingWebhookEvent): Promise<SignalProviderTarget[]> {
    const deviceId = event.data.attributes.source;
    const subscriptions = this.getSubscriptionsForResource(deviceId);

    if (subscriptions.length > 0) {
      return subscriptions.map(({ resourceId, threadId }) => ({ resourceId, threadId }));
    }

    const { target } = this.#options;
    const resolved = typeof target === "function" ? await target(event) : (target ?? { resourceId: this.agent?.id ?? "ring", threadId: deviceId });

    return resolved ? [resolved] : [];
  }

  // ── Account linking ─────────────────────────────────────────────────

  async #exchangeCode(code: string): Promise<void> {
    this.#assertConfigured();
    const tokens = await this.#api.exchangeCode(code);
    const hardwareId = this.#options.hardwareId ?? crypto.randomUUID();
    const accountId = await this.#api.getAccountId({ accessToken: tokens.accessToken, hardwareId });
    await this.#saveAccount({ accountId, hardwareId, ...tokens }, "pending");
  }

  /**
   * Returns a failure reason, or `undefined` when the link completed.
   * The account saved by the token exchange only replaces the linked account once the nonce checks out.
   */

  async #completeLink(nonce: string, time: string): Promise<string | undefined> {
    this.#assertConfigured();
    if (!nonce || !time) return "missing nonce or time";
    if (Date.now() - Number(time) > LINK_WINDOW_MS) return "link request expired";

    const pending = await this.#loadInstallation("pending");
    if (!pending) return "no account saved by the token exchange";

    const account = this.#readAccount(pending);
    if (!safeEqual(computeLinkNonce(this.#hmacKey, time, account.accountId), nonce)) return "nonce mismatch";

    await this.#api.confirmLink(account, nonce, account.accountId);
    await this.#saveAccount(account, "active");
    await (await this.#channelsStorage()).deleteInstallation(this.#installationId("pending"));
    return undefined;
  }

  #assertConfigured(): void {
    if (this.#missingConfig.length > 0) {
      throw new Error(`[Ring] RingSignals is missing ${this.#missingConfig.join(", ")}.`);
    }
  }

  #logError(message: string, error?: unknown) {
    const detail = error instanceof RingApiError ? `${error.message}: ${error.body}` : error instanceof Error ? error.message : "";
    this.mastra?.getLogger()?.error(`[Ring] ${message}${detail ? ` - ${detail}` : ""}`);
  }

  // ── Token storage ───────────────────────────────────────────────────

  /**
   * The linked account and the account waiting for `/link` to confirm it are stored separately,
   * so a new token exchange never overwrites a working link.
   */
  #installationId(status: "active" | "pending"): string {
    const id = `${PLATFORM}:${this.agent?.id ?? "default"}`;
    return status === "pending" ? `${id}:pending` : id;
  }

  async #channelsStorage(): Promise<ChannelsStorage> {
    const storage = this.mastra?.getStorage();
    const channels = storage ? ((await storage.getStore("channels")) as ChannelsStorage | undefined) : undefined;
    if (!channels) {
      throw new Error("[Ring] RingSignals needs Mastra storage with channels support (e.g. LibSQLStore or PostgresStore).");
    }
    return channels;
  }

  async #loadInstallation(status: "active" | "pending"): Promise<ChannelInstallation | null> {
    const channels = await this.#channelsStorage();
    return channels.getInstallation(this.#installationId(status));
  }

  async #saveAccount(account: RingAccount, status: "active" | "pending"): Promise<void> {
    const channels = await this.#channelsStorage();
    const id = this.#installationId(status);
    const existing = await channels.getInstallation(id);
    const now = new Date();
    await channels.saveInstallation({
      id,
      platform: PLATFORM,
      agentId: this.agent?.id ?? "default",
      status,
      data: {
        accountId: account.accountId,
        hardwareId: account.hardwareId,
        accessToken: this.#encrypt(account.accessToken),
        refreshToken: this.#encrypt(account.refreshToken),
        expiresAt: account.expiresAt
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
  }

  #readAccount(installation: ChannelInstallation): RingAccount {
    const data = installation.data as RingAccount;
    return {
      accountId: data.accountId,
      hardwareId: data.hardwareId,
      accessToken: this.#decrypt(data.accessToken),
      refreshToken: this.#decrypt(data.refreshToken),
      expiresAt: data.expiresAt
    };
  }

  async #loadAccount(): Promise<RingAccount | undefined> {
    const installation = await this.#loadInstallation("active");
    if (!installation || installation.status !== "active") return undefined;
    return this.#readAccount(installation);
  }

  async #getAuth(): Promise<RingAuth> {
    const account = await this.#loadAccount();
    if (!account) {
      throw new Error("[Ring] No linked Ring account. Link the app from the Ring Appstore first.");
    }

    if (account.expiresAt - Date.now() > 60_000) {
      return account;
    }

    const tokens: RingTokens = await this.#api.refresh(account.refreshToken);
    const refreshed = { ...account, ...tokens };
    await this.#saveAccount(refreshed, "active");
    return refreshed;
  }

  #encryptionKey(): string | undefined {
    return this.#options.encryptionKey ?? process.env.MASTRA_ENCRYPTION_KEY;
  }

  #encrypt(value: string): string {
    const key = this.#encryptionKey();
    if (!key && !this.#warnedPlaintext) {
      this.#warnedPlaintext = true;
      this.mastra?.getLogger()?.warn("[Ring] Storing Ring tokens WITHOUT encryption. Set `encryptionKey` on RingSignals or MASTRA_ENCRYPTION_KEY to encrypt them at rest.");
    }
    return key ? encrypt(value, key) : value;
  }

  #decrypt(value: string): string {
    const key = this.#encryptionKey();
    if (!isEncrypted(value)) return value;
    if (!key) {
      throw new Error("[Ring] The stored Ring tokens are encrypted, but no encryption key is configured. Set `encryptionKey` on RingSignals or MASTRA_ENCRYPTION_KEY.");
    }
    return decrypt(value, key);
  }

  // ── Media ───────────────────────────────────────────────────────────

  #mediaUrl(kind: "snapshot" | "clip", deviceId: string, timestamp: number): string {
    this.#assertConfigured();
    const path = `${kind}/${deviceId}/${timestamp}`;
    const expires = Date.now() + (this.#options.mediaUrlTtlMs ?? DEFAULT_MEDIA_URL_TTL_MS);
    const signature = signMediaPath(this.#mediaKey, path, expires);
    return `${this.#getBaseUrl()}${this.#routePrefix}/media/${path}?expires=${expires}&signature=${signature}`;
  }

  /**
   * Public URL of the Mastra server: the `baseUrl` option, then `MASTRA_SERVER_URL`
   * (set by deployment platforms), then the Mastra server config.
   */
  #getBaseUrl(): string {
    if (this.#options.baseUrl) return this.#options.baseUrl.replace(/\/$/, "");

    const server = this.mastra?.getServer();
    const hasPublicOverride = server?.studioHost != null || server?.studioPort != null || server?.studioProtocol != null;
    const envUrl = process.env.MASTRA_SERVER_URL?.trim();
    if (!hasPublicOverride && envUrl) return envUrl.replace(/\/$/, "");

    const protocol = server?.studioProtocol ?? "http";
    const host = server?.studioHost ?? server?.host ?? process.env.MASTRA_HOST ?? "localhost";
    const port = server?.studioPort ?? server?.port ?? (Number(process.env.PORT) || 4111);
    const includePort = !((protocol === "https" && port === 443) || (protocol === "http" && port === 80));
    return includePort ? `${protocol}://${host}:${port}` : `${protocol}://${host}`;
  }

  async #downloadSnapshot(deviceId: string, timestamp: number): Promise<Buffer | undefined> {
    const endTimestamp = Math.min(timestamp + SNAPSHOT_WINDOW_MS, Date.now() + SNAPSHOT_WINDOW_MS);
    const waitMs = endTimestamp - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    const auth = await this.#getAuth();
    const afterEvent = await this.#api.downloadLatestImage(auth, deviceId, timestamp, endTimestamp);
    if (afterEvent) return afterEvent;

    for (const lookBack of SNAPSHOT_LOOK_BACK_MS) {
      const beforeEvent = await this.#api.downloadLatestImage(auth, deviceId, timestamp - lookBack, endTimestamp);
      if (beforeEvent) return beforeEvent;
    }

    return undefined;
  }

  async #downloadClip(deviceId: string, timestamp: number): Promise<Buffer | undefined> {
    const deadline = Date.now() + CLIP_READY_TIMEOUT_MS;

    while (true) {
      const clipOptions = this.#clipOptions() ?? { inReply: true, audio: true, durationMs: DEFAULT_CLIP_DURATION_MS };
      const response = await this.#api.downloadClip(await this.#getAuth(), deviceId, timestamp, clipOptions.durationMs, clipOptions.audio);

      if (response.ok) {
        return Buffer.from(await response.arrayBuffer());
      }

      if (![416, 425].includes(response.status) || Date.now() > deadline) {
        return undefined;
      }

      await sleep(CLIP_RETRY_MS);
    }
  }
}
