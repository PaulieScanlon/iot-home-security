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

5. In the Developer Console, connect your Ring account to the app. Then sign in at [ring.com](https://ring.com), open the [Ring Appstore](https://ring.com/appstore), and link your private app. The link page shows `Ring account linked` when it's done.

6. Open the `home-security` thread in Studio: `http://localhost:4111/agents/home-security-agent/chat/home-security`.

## Test scripts

The scripts send signed test webhooks to `MASTRA_SERVER_URL`:

```bash title="Terminal"
npx tsx scripts/button-press.ts
npx tsx scripts/motion-detected.ts             # human
npx tsx scripts/motion-detected.ts vehicle     # or package_delivery, other_motion, motion
npx tsx scripts/device-online.ts
npx tsx scripts/device-offline.ts              # sends 5, the 5th wakes the agent
```

Set `RING_DEVICE_ID` in `.env` to your device's ID so the snapshot and clip tools can fetch media. Test timestamps have no recording behind them, so clips only work for real doorbell presses.

## Deploy

```bash title="Terminal"
npx mastra deploy
```

After deploying, set `MASTRA_SERVER_URL` to the deployed URL in the deployment's environment variables, point the Ring account linking URLs at it, and link the app again from the Ring Appstore.
