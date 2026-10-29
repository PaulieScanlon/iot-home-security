import { useEffect, useState } from "react";
import { ChatView } from "./components/chat-view";
import { Composer } from "./components/composer";
import { RawView } from "./components/raw-view";
import { Sidebar } from "./components/sidebar";
import { useThread } from "./hooks/use-thread";
import { useThreads } from "./hooks/use-threads";

const threadFromUrl = () => {
  const fromQuery = new URLSearchParams(window.location.search).get("thread");
  const fromPath = window.location.pathname.split("/").filter(Boolean).pop();
  return fromQuery ?? fromPath ?? "ring-alerts";
};

const tabClass = (selected: boolean) => {
  return `rounded-md px-3 py-1 text-[13px] ${selected ? "bg-line text-text" : "text-muted hover:text-text"}`;
};

export const App = () => {
  const [threadId, setThreadId] = useState(threadFromUrl);
  const [view, setView] = useState<"chat" | "raw">("chat");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const threads = useThreads(refreshKey);
  const { raw, chat, status, send } = useThread(threadId);
  const activeThread = threads.find((thread) => thread.id === threadId);
  const live = status === "Live";

  useEffect(() => {
    const onPopState = () => {
      setThreadId(threadFromUrl());
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  const selectThread = (id: string) => {
    window.history.pushState(null, "", `/${id}`);
    setThreadId(id);
    setSidebarOpen(false);
  };

  const sendMessage = async (text: string) => {
    await send(text);
    setRefreshKey((key) => key + 1);
  };

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]">
      <Sidebar threads={threads} activeThreadId={threadId} onSelect={selectThread} open={sidebarOpen} />
      <main className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line px-4 py-3.5 md:px-6">
          <button
            className="rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-xs md:hidden"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-expanded={sidebarOpen}
          >
            Threads
          </button>
          <div className="grid min-w-0">
            <h1 className="truncate text-lg leading-tight font-semibold">{activeThread?.title || threadId}</h1>
            <span className="truncate font-mono text-[11px] text-muted">{threadId}</span>
          </div>
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
            <span className={`size-[7px] rounded-full ${live ? "bg-mastra shadow-[0_0_0_3px_rgb(70_244_136/0.2)]" : "bg-faint"}`} />
            {status}
          </span>
          <div className="ml-auto inline-flex rounded-lg border border-line bg-surface p-[3px]" role="tablist">
            <button className={tabClass(view === "chat")} role="tab" aria-selected={view === "chat"} onClick={() => setView("chat")}>
              Chat
            </button>
            <button className={tabClass(view === "raw")} role="tab" aria-selected={view === "raw"} onClick={() => setView("raw")}>
              Raw <span className="font-mono text-[11px] text-muted">{raw.length}</span>
            </button>
          </div>
        </header>
        <div className="overflow-y-auto px-4 py-6 md:px-6">
          {view === "chat" ? <ChatView chat={chat} channelPlatform={activeThread?.channelPlatform} /> : <RawView raw={raw} />}
        </div>
        <Composer onSend={sendMessage} />
      </main>
    </div>
  );
};
