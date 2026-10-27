import type { NotificationSignalAttributes } from "@mastra/core/notifications";
import { registerApiRoute } from "@mastra/core/server";
import type { ApiRoute } from "@mastra/core/server";
import type { InputProcessorOrWorkflow, ProcessInputStepArgs } from "@mastra/core/processors";
import { SignalProvider } from "@mastra/core/signals";
import type { SignalProviderTarget, SignalProviderWebhookRequest } from "@mastra/core/signals";
import type { ChannelInstallation, ChannelsStorage } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { computeLinkNonce, computeWebhookSignature, decrypt, encrypt, safeEqual, signMediaPath } from "./crypto";
import { RingApiClient, RingApiError } from "./ring-api";
import type { RingAuth } from "./ring-api";
import type { RingAccount, RingEventNotification, RingEventType, RingSignalsOptions, RingTokens, RingWebhookEvent } from "./types";

const PLATFORM = "ring";

/**
 * Default guidance added to the agent's system prompt for Ring notifications.
 */
export const DEFAULT_RING_INSTRUCTIONS = `Ring events arrive as <notification source="ring"> messages with deviceId and timestamp attributes.
When a notification has type="button_press":
1. Call ring_snapshot with its deviceId and timestamp, then describe who or what is at the door.
2. Call ring_clip with the same deviceId and timestamp.
3. In your reply, show the snapshot url as a markdown image and link the clip url as [Watch clip](url).`;
const LINK_WINDOW_MS = 10 * 60 * 1000;
const SNAPSHOT_WINDOW_MS = 15_000;
const SNAPSHOT_LOOK_BACK_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
const CLIP_DURATION_MS = 15_000;
const CLIP_READY_TIMEOUT_MS = 120_000;
const CLIP_RETRY_MS = 5_000;

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
  readonly #routePrefix: string;
  readonly #events: Partial<Record<RingEventType, RingEventNotification | false>>;
  readonly #snapshots = new Map<string, string>();

  constructor(options: RingSignalsOptions = {}) {
    super();
    this.#options = options;
    this.#hmacKey = options.hmacKey ?? process.env.RING_HMAC_KEY ?? "";
    this.#routePrefix = (options.routePrefix ?? "/ring").replace(/\/$/, "");
    this.#events = { ...DEFAULT_RING_EVENTS, ...options.events };
    this.#api = new RingApiClient({
      clientId: options.clientId ?? process.env.RING_CLIENT_ID ?? "",
      clientSecret: options.clientSecret ?? process.env.RING_CLIENT_SECRET ?? "",
      userAgent: options.userAgent ?? "MastraRingSignals/1.0"
    });
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
  watchDevice(target: SignalProviderTarget, deviceId: string) {
    return this.subscribe(target, deviceId);
  }

  unwatchDevice(target: SignalProviderTarget, deviceId: string) {
    return this.unsubscribe(target, deviceId);
  }

  // ── Webhooks ────────────────────────────────────────────────────────

  /**
   * Verify and handle a Ring webhook. `body` must be the raw request body string,
   * because Ring signs the exact bytes it sent.
   */
  async handleWebhook(request: SignalProviderWebhookRequest): Promise<{ status?: number; body?: unknown }> {
    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const signature = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "x-signature")?.[1];

    if (!this.#hmacKey || !signature || !safeEqual(computeWebhookSignature(this.#hmacKey, rawBody), signature)) {
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
          const result = await this.handleWebhook({
            body: await context.req.text(),
            headers: Object.fromEntries(context.req.raw.headers.entries())
          });
          return context.json(result.body ?? {}, (result.status ?? 200) as 200);
        }
      }),
      registerApiRoute(`${prefix}/home`, {
        method: "GET",
        requiresAuth: false,
        handler: async (context) => {
          const account = await this.#loadAccount();
          return context.text(account ? "Ring account linked" : "Ring account not linked");
        }
      }),
      registerApiRoute(`${prefix}/media/:kind/:deviceId/:timestamp`, {
        method: "GET",
        requiresAuth: false,
        handler: async (context) => {
          const { kind, deviceId, timestamp } = context.req.param();
          const path = `${kind}/${deviceId}/${timestamp}`;

          if (!safeEqual(signMediaPath(this.#hmacKey, path), context.req.query("signature") ?? "")) {
            return context.text("Invalid signature", 403);
          }

          const media = kind === "clip" ? await this.#downloadClip(deviceId, Number(timestamp)) : await this.#downloadSnapshot(deviceId, Number(timestamp));

          if (!media) {
            return context.text("Not found", 404);
          }

          return context.body(new Uint8Array(media), 200, {
            "Content-Type": kind === "clip" ? "video/mp4" : "image/jpeg"
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
    const instructions = this.#options.instructions ?? DEFAULT_RING_INSTRUCTIONS;
    if (instructions) {
      messageList.addSystem(instructions, "ring-signals");
    }
    return messageList;
  }

  getTools() {
    return {
      ring_snapshot: createTool({
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
              { type: "text", text: `Snapshot: ${output.url}` },
              ...(image ? [{ type: "image-data" as const, data: image, mediaType: "image/jpeg" }] : [])
            ]
          };
        }
      }),
      ring_clip: createTool({
        id: "ring_clip",
        description: "Get a link to a 15 second Ring video clip starting at an event. Waits up to 2 minutes for Ring to process it.",
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
        }
      })
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
    const tokens = await this.#api.exchangeCode(code);
    const hardwareId = this.#options.hardwareId ?? crypto.randomUUID();
    const accountId = await this.#api.getAccountId({ accessToken: tokens.accessToken, hardwareId });
    await this.#saveAccount({ accountId, hardwareId, ...tokens }, "pending");
  }

  /**
   * Returns a failure reason, or `undefined` when the link completed.
   */
  async #completeLink(nonce: string, time: string): Promise<string | undefined> {
    if (!nonce || !time) return "missing nonce or time";
    if (Date.now() - Number(time) > LINK_WINDOW_MS) return "link request expired";

    const installation = await this.#loadInstallation();
    if (!installation) return "no account saved by the token exchange";

    const account = this.#readAccount(installation);
    if (!safeEqual(computeLinkNonce(this.#hmacKey, time, account.accountId), nonce)) return "nonce mismatch";

    await this.#api.confirmLink(account, nonce, account.accountId);
    await this.#saveAccount(account, "active");
    return undefined;
  }

  #logError(message: string, error?: unknown) {
    const detail = error instanceof RingApiError ? `${error.message}: ${error.body}` : error instanceof Error ? error.message : "";
    this.mastra?.getLogger()?.error(`[Ring] ${message}${detail ? ` - ${detail}` : ""}`);
  }

  // ── Token storage ───────────────────────────────────────────────────

  #installationId(): string {
    return `${PLATFORM}:${this.agent?.id ?? "default"}`;
  }

  async #channelsStorage(): Promise<ChannelsStorage> {
    const storage = this.mastra?.getStorage();
    const channels = storage ? ((await storage.getStore("channels")) as ChannelsStorage | undefined) : undefined;
    if (!channels) {
      throw new Error("[Ring] RingSignals needs Mastra storage with channels support (e.g. LibSQLStore or PostgresStore).");
    }
    return channels;
  }

  async #loadInstallation(): Promise<ChannelInstallation | null> {
    const channels = await this.#channelsStorage();
    return channels.getInstallation(this.#installationId());
  }

  async #saveAccount(account: RingAccount, status: ChannelInstallation["status"]): Promise<void> {
    const channels = await this.#channelsStorage();
    const existing = await channels.getInstallation(this.#installationId());
    const now = new Date();
    await channels.saveInstallation({
      id: this.#installationId(),
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
    const installation = await this.#loadInstallation();
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

  #encrypt(value: string): string {
    const key = this.#options.encryptionKey ?? process.env.MASTRA_ENCRYPTION_KEY;
    return key ? encrypt(value, key) : value;
  }

  #decrypt(value: string): string {
    const key = this.#options.encryptionKey ?? process.env.MASTRA_ENCRYPTION_KEY;
    return key && value.startsWith("aes-256-gcm-hkdf:") ? decrypt(value, key) : value;
  }

  // ── Media ───────────────────────────────────────────────────────────

  #mediaUrl(kind: "snapshot" | "clip", deviceId: string, timestamp: number): string {
    const path = `${kind}/${deviceId}/${timestamp}`;
    const publicUrl = (this.#options.publicUrl ?? "http://localhost:4111").replace(/\/$/, "");
    return `${publicUrl}${this.#routePrefix}/media/${path}?signature=${signMediaPath(this.#hmacKey, path)}`;
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
      const response = await this.#api.downloadClip(await this.#getAuth(), deviceId, timestamp, CLIP_DURATION_MS);

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
