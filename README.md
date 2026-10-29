# IoT home security

A [Mastra](https://mastra.ai) agent that watches a Ring doorbell. Ring webhooks arrive in an agent thread as [notification signals](https://mastra.ai/docs/signals/notifications), and the agent fetches a snapshot and video clip when someone rings the doorbell.

## How it works

- `RingSignals` (`src/signals/ring`) is a Mastra [signal provider](https://mastra.ai/docs/signals/signal-providers) for the [Ring Partner API](https://developer.amazon.com/docs/ring/api-documentation.html). It:
  - Registers the routes Ring calls for account linking and webhooks.
  - Verifies webhook signatures and turns each Ring event into a notification signal with its own priority.
  - Stores the linked account's tokens in Mastra storage and refreshes them.
  - Adds `ring_snapshot` and `ring_clip` tools, plus a fixed system instruction telling the agent to use them on a doorbell press.
- The agent (`src/mastra/agents/home-security-agent.ts`) registers it with `signals: [new RingSignals({ ... })]`.
- Low-priority events are batched. The agent's delivery policy wakes it once five of the same event have piled up.

| Ring event | Priority | Effect |
|---|---|---|
| `button_press` | high | Wakes the agent, which fetches a snapshot and clip |
| `motion_detected` | medium | Wakes an idle agent |
| `device_online` / `device_offline` | low | Batched; the 5th repeat wakes the agent |

## Requirements

- A Ring doorbell on a paid Ring plan with **Person, Package & Vehicle Alerts** turned on.
- A Ring **Private App** in the [Ring Developer Console](https://developer.amazon.com/ring/console/apps).
- A libSQL database, such as a [Turso](https://turso.tech) database provisioned on Mastra platform.
- An Anthropic API key.

## Setup

1. Install dependencies and copy the env file:

   ```bash title="Terminal"
   npm install
   cp .env.example .env
   ```

2. Fill in `.env` with your Ring app credentials (Client ID, Client Secret, HMAC Signature Key), database and API key. Set `MASTRA_SERVER_URL` to the public URL of your server.

3. In the Ring Developer Console, open your app's **Account linking** settings and set:

   | Field | Value |
   |---|---|
   | Account Link URL | `<MASTRA_SERVER_URL>/ring/link` |
   | App Homepage URL | `<MASTRA_SERVER_URL>/ring/home` |
   | Token Exchange URL | `<MASTRA_SERVER_URL>/ring/token` |
   | Webhook URL | `<MASTRA_SERVER_URL>/ring/webhook` |

   For local development, expose `localhost:4111` with a tunnel such as `npx cloudflared tunnel --url http://localhost:4111` and use its URL.

4. Start the server:

   ```bash title="Terminal"
   npm run dev
   ```

5. In the Developer Console, connect your Ring account to the app. Then sign in to your Ring account on the web, open your app's page in the Ring Appstore (`https://ring.com/appstore/<your-app>`), and link it. Linked apps are listed under [Integrations](https://account.ring.com/account/integrations). The link page shows `Ring account linked` when it's done.

6. Open the `ring-alerts` thread in Studio: `http://localhost:4111/agents/home-security-agent/chat/ring-alerts`.

## Test scripts

The scripts send signed test webhooks to `MASTRA_SERVER_URL`:

```bash title="Terminal"
npx tsx scripts/button-press.ts
npx tsx scripts/motion-detected.ts             # human
npx tsx scripts/motion-detected.ts vehicle     # or package_delivery, other_motion, motion
npx tsx scripts/device-online.ts
npx tsx scripts/device-offline.ts              # sends 5, the 5th wakes the agent
```

Set `RING_DEVICE_ID` in `.env` to your device's ID so the snapshot and clip tools can fetch media. Test events use the current time, which has no recording behind it. Set `RING_BUTTON_PRESS_TIMESTAMP` and `RING_MOTION_TIMESTAMP` to the timestamps of real events so the test scripts get a real snapshot and clip.

## iMessage alerts

The agent also has an iMessage channel ([Photon](https://app.photon.codes)). Ring events and iMessage share one thread, `ring-alerts`: the channel pins its thread ID with `resolveThreadId`, and `RingSignals` targets the same ID. When a Ring event wakes the agent, its reply is sent to you over iMessage.

1. Set `IMESSAGE_PROJECT_ID`, `IMESSAGE_PROJECT_SECRET` and `IMESSAGE_WEBHOOK_SECRET`. Register `<MASTRA_SERVER_URL>/api/agents/home-security-agent/channels/imessage/webhook` in the Photon dashboard to get the webhook secret.
2. **Text the agent once before any Ring event arrives.** That first message creates `ring-alerts` with its iMessage details. If a Ring event creates the thread first, it has no iMessage details and your text gets a separate thread.

## Thread viewer

`src/app` is a small Vite + React app that subscribes to the `ring-alerts` thread with `@mastra/client-js`. It has two views: **Chat** renders messages, notifications, tool calls and snapshots, and **Raw** shows every chunk the subscription receives.

```bash title="Terminal"
npm run app
```

It connects to `VITE_MASTRA_URL` (default `http://localhost:4111`). Point it at the deployed server to see live runs. To view a different thread, put its ID in the URL: `http://localhost:5173/home-security` or `http://localhost:5173/?thread=home-security`.

## Deploy

```bash title="Terminal"
npx mastra deploy
```

After deploying, set `MASTRA_SERVER_URL` to the deployed URL in the deployment's environment variables, point the Ring account linking URLs at it, and link the app again from [Integrations](https://account.ring.com/account/integrations) in your Ring account.
