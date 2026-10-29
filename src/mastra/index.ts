import { Mastra } from "@mastra/core";
import { registerApiRoute } from "@mastra/core/server";
import { MastraEditor } from "@mastra/editor";
import { LibSQLStore } from "@mastra/libsql";
import { MastraPlatformExporter, MastraStorageExporter, Observability } from "@mastra/observability";
import { homeSecurityAgent } from "./agents/home-security-agent";

export const mastra = new Mastra({
  agents: { homeSecurityAgent },
  storage: new LibSQLStore({
    id: "mastra-storage",
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN
  }),
  editor: new MastraEditor(),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "iot-home-security",
        exporters: [new MastraPlatformExporter(), new MastraStorageExporter()]
      }
    }
  }),
  server: {
    apiRoutes: [
      registerApiRoute("/app/messages", {
        method: "POST",
        handler: async (context) => {
          const { threadId, text } = await context.req.json<{ threadId: string; text: string }>();
          const agent = context.get("mastra").getAgent("homeSecurityAgent");

          const channelThread = await agent.getChannels()?.buildRenderContextForThread(threadId);
          await channelThread?.chatThread.post(`From the app: ${text}`);

          await agent.sendMessage({ contents: text, attributes: { sentFrom: "app" } }, { resourceId: agent.id, threadId }).accepted;

          return context.json({ ok: true, echoedTo: channelThread?.platform ?? null });
        }
      })
    ]
  }
});
