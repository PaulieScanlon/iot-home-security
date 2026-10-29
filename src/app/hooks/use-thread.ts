import { useCallback, useEffect, useState } from "react";
import { agentId, baseUrl, client, resourceId } from "../lib/mastra-client";


type Chunk = { type: string; runId?: string; payload?: any };

export type Origin = "app" | "agent" | "channel" | "ring" | "studio";

export type ChatPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolCallId: string; toolName: string; args: unknown; result?: unknown; error?: unknown }
  | { kind: "data"; label: string; value: unknown };

export type RingEventInfo = {
  kind?: string;
  priority?: string;
  status?: string;
  motionType?: string;
};

export type ChatEntry = {
  id: string;
  origin: Origin;
  createdAt?: string;
  ring?: RingEventInfo;
  pending?: boolean;
  parts: ChatPart[];
};

export type RawEntry = {
  receivedAt: string;
  chunk: Chunk;
};

const originOf = (message: any): Origin => {
  if (message.role === "assistant") {
    return "agent";
  }
  if (message.role !== "signal") {
    return "studio";
  }

  const signal = message.content?.metadata?.signal;
  if (signal?.type === "notification") {
    return "ring";
  }
  return signal?.attributes?.sentFrom === "app" ? "app" : "channel";
};

const historyMessageToEntry = (message: any): ChatEntry => {
  const parts: ChatPart[] = (message.content?.parts ?? [])
    .filter((part: any) => part.type !== "step-start" && part.type !== "reasoning")
    .map((part: any): ChatPart => {
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

  const origin = originOf(message);
  const attributes = message.content?.metadata?.signal?.attributes;

  return {
    id: message.id,
    origin,
    createdAt: message.createdAt,
    ring:
      origin === "ring"
        ? {
            kind: attributes?.kind,
            priority: attributes?.priority ?? message.content?.metadata?.signal?.metadata?.notification?.priority,
            status: attributes?.status,
            motionType: attributes?.motionType
          }
        : undefined,
    parts
  };
};

const applyLiveChunk = (entries: ChatEntry[], chunk: Chunk): ChatEntry[] => {
  const id = `live-${chunk.runId ?? "run"}`;
  const existing = entries.find((entry) => entry.id === id);
  const entry: ChatEntry = existing ?? { id, origin: "agent", createdAt: new Date().toISOString(), parts: [] };
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

export const useThread = (threadId: string) => {
  const [raw, setRaw] = useState<RawEntry[]>([]);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [status, setStatus] = useState("Connecting");

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    setRaw([]);
    setChat([]);
    setStatus("Connecting");

    const subscribe = async () => {
      const subscription = await client.getAgent(agentId).subscribeToThread({
        resourceId,
        threadId,
        withInitialHistory: { perPage: 100 }
      });
      unsubscribe = subscription.unsubscribe;
      setStatus("Live");

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
      setStatus(`Can't connect: ${error instanceof Error ? error.message : String(error)}`);
    });

    return () => {
      unsubscribe?.();
    };
  }, [threadId]);

  const send = useCallback(
    async (text: string) => {
      const id = `app-${Date.now()}`;
      setChat((previous) => [...previous, { id, origin: "app", createdAt: new Date().toISOString(), pending: true, parts: [{ kind: "text", text }] }]);

      try {
        const response = await fetch(`${baseUrl}/app/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, text })
        });
        if (!response.ok) {
          throw new Error(`the server returned ${response.status}`);
        }
        setChat((previous) => previous.map((entry) => (entry.id === id ? { ...entry, pending: false } : entry)));
      } catch (error) {
        setChat((previous) => previous.filter((entry) => entry.id !== id));
        throw error;
      }
    },
    [threadId]
  );

  return { raw, chat, status, send };
};
