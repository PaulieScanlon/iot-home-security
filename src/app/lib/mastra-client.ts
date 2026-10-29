import { MastraClient } from "@mastra/client-js";

export const agentId = "home-security-agent";
export const resourceId = "home-security-agent";

export const baseUrl = import.meta.env.VITE_MASTRA_URL ?? "http://localhost:4111";

export const client = new MastraClient({
  baseUrl,
  headers: import.meta.env.VITE_MASTRA_TOKEN ? { Authorization: `Bearer ${import.meta.env.VITE_MASTRA_TOKEN}` } : undefined
});
