import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatEntry, ChatPart, SignalInfo } from "./use-thread";

const TextPart = ({ text }: { text: string }) => {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          }
        }}
      >
        {text}
      </Markdown>
    </div>
  );
};

const Part = ({ part }: { part: ChatPart }) => {
  if (part.kind === "text") {
    return <TextPart text={part.text} />;
  }

  if (part.kind === "tool") {
    const url = (part.result as { url?: string } | undefined)?.url;

    return (
      <div className="tool-part">
        {url && part.toolName === "ring_snapshot" ? <img className="media" src={url} alt="Ring snapshot" /> : null}
        {url && part.toolName === "ring_clip" ? <video className="media" src={url} controls preload="metadata" /> : null}
        <details className="tool">
          <summary>
            🔧 {part.toolName} {part.error ? "failed" : part.result ? "done" : "running…"}
          </summary>
          <pre>{JSON.stringify({ args: part.args, result: part.result, error: part.error }, null, 2)}</pre>
        </details>
      </div>
    );
  }

  return (
    <details className="data">
      <summary>{part.label}</summary>
      <pre>{JSON.stringify(part.value, null, 2)}</pre>
    </details>
  );
};

const SignalBadge = ({ signal }: { signal: SignalInfo }) => {
  return (
    <div className="signal-badge">
      {signal.priority ? <span className={`priority ${signal.priority}`}>{signal.priority}</span> : null}
      <span className="kind">{signal.kind ?? signal.tagName}</span>
      {signal.status ? <span className="status-label">{signal.status}</span> : null}
    </div>
  );
};

export const ChatView = ({ chat }: { chat: ChatEntry[] }) => {
  return (
    <div className="chat">
      {chat.map((entry) => {
        return (
          <div key={entry.id} className={`message ${entry.role} ${entry.signal?.priority ? `priority-${entry.signal.priority}` : ""}`}>
            <div className="meta">
              {entry.role} {entry.createdAt ? `· ${new Date(entry.createdAt).toLocaleString()}` : ""}
            </div>
            {entry.signal ? <SignalBadge signal={entry.signal} /> : null}
            {entry.parts.map((part, index) => {
              return <Part key={index} part={part} />;
            })}
          </div>
        );
      })}
    </div>
  );
};
