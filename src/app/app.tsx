import { useState } from "react";
import { ChatView } from "./chat-view";
import { RawView } from "./raw-view";
import { threadId, useThread } from "./use-thread";

export const App = () => {
  const { raw, chat, status } = useThread();
  const [view, setView] = useState<"chat" | "raw">("chat");

  return (
    <main>
      <header>
        <h1>{threadId}</h1>
        <span className="status">{status}</span>
        <nav>
          <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
            Chat
          </button>
          <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>
            Raw ({raw.length})
          </button>
        </nav>
      </header>
      {view === "chat" ? <ChatView chat={chat} /> : <RawView raw={raw} />}
    </main>
  );
};
