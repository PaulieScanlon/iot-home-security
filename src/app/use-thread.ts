import { MastraClient } from "@mastra/client-js";
import { useEffect, useState } from "react";

export const agentId = "home-security-agent";
export const resourceId = "home-security-agent";
const threadFromPath = window.location.pathname.split("/").filter(Boolean).pop();

export const threadId = new URLSearchParams(window.location.search).get("thread") ?? threadFromPath ?? "ring-alerts";

type Chunk = { type: string; runId?: string; payload?: any };

export type ChatPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolCallId: string; toolName: string; args: unknown; result?: unknown; error?: unknown }
  | { kind: "data"; label: string; value: unknown };

export type SignalInfo = {
  tagName?: string;
  kind?: string;
  priority?: string;
  status?: string;
};

export type ChatEntry = {
  id: string;
  role: string;
  createdAt?: string;
  signal?: SignalInfo;
  parts: ChatPart[];
};

export type RawEntry = {
  receivedAt: string;
  chunk: Chunk;
};

const client = new MastraClient({
  baseUrl: import.meta.env.VITE_MASTRA_URL ?? "http://localhost:4111",
  headers: import.meta.env.VITE_MASTRA_TOKEN ? { Authorization: `Bearer ${import.meta.env.VITE_MASTRA_TOKEN}` } : undefined
});

const historyMessageToEntry = (message: any): ChatEntry => {
  const parts: ChatPart[] = (message.content?.parts ?? []).map((part: any): ChatPart => {
    if (part.type === "text") {
      return { kind: "text", text: part.text };
    }
    if (part.type === "tool-invocation") {
      const invocation = part.toolInvocation;
      return {
        kind: "tool",
        toolCallId: invocation.toolCallId,
        toolName: invocation.toolName,
        args: invocation.args,
        result: invocation.result
      };
    }
    return { kind: "data", label: part.type, value: part };
  });

  if (parts.length === 0 && typeof message.content?.content === "string") {
    parts.push({ kind: "text", text: message.content.content });
  }

  const signal = message.content?.metadata?.signal;

  return {
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    signal: signal
      ? {
          tagName: signal.tagName,
          kind: signal.attributes?.kind,
          priority: signal.attributes?.priority ?? signal.metadata?.notification?.priority,
          status: signal.attributes?.status
        }
      : undefined,
    parts
  };
};

const applyLiveChunk = (entries: ChatEntry[], chunk: Chunk): ChatEntry[] => {
  const id = `live-${chunk.runId ?? "run"}`;
  const existing = entries.find((entry) => entry.id === id);
  const entry: ChatEntry = existing ?? { id, role: "assistant", createdAt: new Date().toISOString(), parts: [] };
  const parts = [...entry.parts];

  if (chunk.type === "text-delta") {
    const last = parts[parts.length - 1];
    if (last?.kind === "text") {
      parts[parts.length - 1] = { kind: "text", text: last.text + chunk.payload.text };
    } else {
      parts.push({ kind: "text", text: chunk.payload.text });
    }
  } else if (chunk.type === "tool-call") {
    parts.push({ kind: "tool", toolCallId: chunk.payload.toolCallId, toolName: chunk.payload.toolName, args: chunk.payload.args });
  } else if (chunk.type === "tool-result" || chunk.type === "tool-error") {
    const index = parts.findIndex((part) => part.kind === "tool" && part.toolCallId === chunk.payload.toolCallId);
    if (index !== -1) {
      const tool = parts[index] as Extract<ChatPart, { kind: "tool" }>;
      parts[index] = chunk.type === "tool-result" ? { ...tool, result: chunk.payload.result } : { ...tool, error: chunk.payload.error };
    }
  } else {
    return entries;
  }

  const updated = { ...entry, parts };
  return existing ? entries.map((item) => (item.id === id ? updated : item)) : [...entries, updated];
};

export const useThread = () => {
  const [raw, setRaw] = useState<RawEntry[]>([]);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const subscribe = async () => {
      const subscription = await client.getAgent(agentId).subscribeToThread({
        resourceId,
        threadId,
        withInitialHistory: { perPage: 100 }
      });
      unsubscribe = subscription.unsubscribe;
      setStatus("subscribed");

      await subscription.processDataStream({
        reconnect: true,
        onChunk: (chunk) => {
          const received = chunk as Chunk;
          setRaw((previous) => [...previous, { receivedAt: new Date().toISOString(), chunk: received }]);

          if (received.type === "thread-history") {
            setChat(received.payload.messages.map(historyMessageToEntry));
            return;
          }

          setChat((previous) => applyLiveChunk(previous, received));
        }
      });
    };

    subscribe().catch((error) => {
      setStatus(`error: ${error instanceof Error ? error.message : String(error)}`);
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  return { raw, chat, status };
};
