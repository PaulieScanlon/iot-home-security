import { useEffect, useState } from "react";
import { agentId, client, resourceId } from "../lib/mastra-client";

export type ThreadSummary = {
  id: string;
  title?: string;
  updatedAt?: string;
  channelPlatform?: string;
};

export const useThreads = (refreshKey: number) => {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);

  useEffect(() => {
    client
      .listMemoryThreads({ resourceId, agentId })
      .then((response) => {
        const list = (response.threads ?? []).map((thread: any): ThreadSummary => {
          const platform = thread.metadata?.channel_platform;
          return {
            id: thread.id,
            title: thread.title,
            updatedAt: thread.updatedAt,
            channelPlatform: typeof platform === "string" ? platform : undefined
          };
        });
        list.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
        setThreads(list);
      })
      .catch(() => {
        setThreads([]);
      });
  }, [refreshKey]);

  return threads;
};
