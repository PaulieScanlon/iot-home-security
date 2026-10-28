import type { NotificationPriority } from '@mastra/core/notifications';
import type { SignalProviderTarget } from '@mastra/core/signals';

/**
 * Event types Ring delivers to the webhook URL.
 * See https://developer.amazon.com/docs/ring/api-documentation.html#event-types
 */
export type RingEventType =
  | 'button_press'
  | 'motion_detected'
  | 'device_added'
  | 'device_removed'
  | 'device_online'
  | 'device_offline'
  | 'app_integration_added'
  | 'app_integration_removed'
  | 'subscription_activated'
  | 'subscription_deactivated';

/**
 * `sub_type` values on `motion_detected` when Smart Alerts are enabled.
 * Without Smart Alerts, Ring sends `motion`.
 */
export type RingMotionType = 'human' | 'vehicle' | 'package_delivery' | 'other_motion' | 'motion';

/**
 * A Ring webhook payload.
 */
export type RingWebhookEvent = {
  meta: {
    version: string;
    time: string;
    request_id: string;
    account_id?: string;
  };
  data: {
    id: string;
    type: RingEventType | (string & {});
    attributes: {
      source: string;
      source_type: string;
      timestamp: number;
      sub_type?: RingMotionType | (string & {});
      component_ids?: string[];
    };
  };
};

/**
 * How a Ring event becomes a notification signal. Set an event to `false` to ignore it.
 */
export type RingEventNotification = {
  priority: NotificationPriority;
  summary: string;
  /** Merge repeats of this event into one pending notification (counted by `coalescedCount`). */
  coalesce?: boolean;
  /**
   * Extra attributes the model sees on the notification, merged over the defaults
   * (`deviceId`, `timestamp`, and `motionType` for motion events).
   * Values that aren't strings, numbers, booleans or `null` (e.g. arrays) are dropped.
   */
  attributes?: (event: RingWebhookEvent) => Record<string, unknown>;
};

/**
 * Where a Ring event is delivered. Return a target, or `undefined` to drop the event.
 * Can be async, e.g. to look up which user owns `event.meta.account_id`.
 */
export type RingTargetResolver = (
  event: RingWebhookEvent,
) => SignalProviderTarget | undefined | Promise<SignalProviderTarget | undefined>;

export type RingSignalsOptions = {
  /** Ring app Client ID. Defaults to `RING_CLIENT_ID`. */
  clientId?: string;
  /** Ring app Client Secret. Defaults to `RING_CLIENT_SECRET`. */
  clientSecret?: string;
  /** Ring app HMAC Signature Key, used to verify link nonces and webhook signatures, and to derive the media URL signing key. Defaults to `RING_HMAC_KEY`. */
  hmacKey?: string;
  /** Key used to encrypt stored Ring tokens. Defaults to `MASTRA_ENCRYPTION_KEY`. When unset, tokens are stored unencrypted and a warning is logged. */
  encryptionKey?: string;
  /**
   * Public base URL of the Mastra server, used to build media links.
   * Defaults to `MASTRA_SERVER_URL`, then the Mastra server's host and port.
   */
  baseUrl?: string;
  /** How long signed snapshot and clip links stay valid, in milliseconds. Defaults to 7 days. */
  mediaUrlTtlMs?: number;
  /** Path prefix for the Ring routes. Defaults to `/ring`. */
  routePrefix?: string;
  /** `User-Agent` sent to the Ring API. Defaults to `MastraRingSignals/1.0`. */
  userAgent?: string;
  /**
   * `Hardware_Id` sent to the Ring API. By default a UUID is generated when an account is linked
   * and stored with that account's tokens.
   */
  hardwareId?: string;
  /**
   * Where events are delivered when no thread has subscribed to the device with `subscribeThread()`.
   * Defaults to `{ resourceId: <agent id>, threadId: <device id> }`.
   */
  target?: SignalProviderTarget | RingTargetResolver;
  /** Override how each event type becomes a notification, or set it to `false` to ignore it. */
  events?: Partial<Record<RingEventType, RingEventNotification | false>>;
  /**
   * Guidance added to the agent's system prompt telling it how to handle Ring notifications.
   * The text is fixed, so it doesn't invalidate the prompt cache. Set to `false` to leave it out.
   * Defaults to `DEFAULT_RING_INSTRUCTIONS`.
   */
  instructions?: string | false;
  /**
   * Tools added to the agent. Defaults to both tools enabled.
   * When set, only the tools listed here are added.
   */
  tools?: RingToolsOptions;
};

export type RingClipToolOptions = {
  /** Include audio in clips. Defaults to `true`. */
  audio?: boolean;
  /** Clip length in milliseconds, up to 15 minutes. Defaults to 15 seconds. */
  durationMs?: number;
};

export type RingToolsOptions = {
  /** `ring_snapshot`: a still image for an event. */
  snapshot?: boolean;
  /** `ring_clip`: a link to a video clip for an event. */
  clip?: boolean | RingClipToolOptions;
};

export type RingTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type RingAccount = RingTokens & {
  accountId: string;
  hardwareId: string;
};
