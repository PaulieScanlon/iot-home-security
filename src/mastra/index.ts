import { Mastra } from "@mastra/core";
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
  })
});
