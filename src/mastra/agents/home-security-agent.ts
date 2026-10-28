import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { RingSignals } from "../../signals/ring";
// import { RingSignals } from "@mastra/ring-signals";

export const homeSecurityAgent = new Agent({
  id: "home-security-agent",
  name: "Home Security Agent",
  instructions: `
    You watch over a home using a Ring doorbell.
    When someone rings the doorbell, mention any motion notifications that came before it, and say briefly whether it needs attention.
    When you're woken by a batch of the same low priority event, summarize it in one line.
  `,
  model: "anthropic/claude-sonnet-5-5",
  signals: [
    new RingSignals({
      clientId: process.env.RING_CLIENT_ID,
      clientSecret: process.env.RING_CLIENT_SECRET,
      hmacKey: process.env.RING_HMAC_KEY,
      baseUrl: process.env.MASTRA_SERVER_URL,
      target: async () => {
        return { resourceId: "home-security-agent", threadId: "home-security" };
      },
      events: {
        button_press: { priority: "high", summary: "Someone rang the doorbell." },
        motion_detected: {
          priority: "medium",
          summary: "Motion was detected at the front door.",
          attributes: (event) => ({ ...event.data.attributes, custom_attribute: "front door" })
        }
      },
      tools: {
        snapshot: true,
        clip: { audio: true, durationMs: 15_000 }
      }
    })
  ],
  memory: new Memory({
    options: {
      observationalMemory: true
    }
  }),
  notifications: {
    deliveryPolicy: {
      decide: ({ record }) => {
        const repeatCount = record.coalescedCount ?? 1;

        if (record.priority === "low" && repeatCount >= 5) {
          return { action: "deliver", reason: `${repeatCount} ${record.kind} events` };
        }
      }
    }
  }
});
