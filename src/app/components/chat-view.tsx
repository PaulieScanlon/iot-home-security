import { Fragment, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { dayLabel, formatTime, platformName, ringKindName } from "../lib/labels";
import type { ChatEntry, ChatPart, Origin } from "../hooks/use-thread";

const originColors: Record<Origin, string> = {
  app: "var(--color-app)",
  agent: "var(--color-agent)",
  channel: "var(--color-channel)",
  ring: "var(--color-medium)",
  studio: "var(--color-steel)"
};

const priorityColors: Record<string, string> = {
  urgent: "var(--color-urgent)",
  high: "var(--color-high)",
  medium: "var(--color-medium)",
  low: "var(--color-low)"
};

const markdownClass = [
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
  "[&_p]:mb-2.5 [&_ul]:mb-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2.5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_strong]:font-semibold [&_a]:text-(--accent) [&_a]:underline",
  "[&_code]:rounded [&_code]:bg-line [&_code]:px-1.5 [&_code]:font-mono [&_code]:text-[13px]",
  "[&_table]:my-2 [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_th]:py-1"
].join(" ");

const TextPart = ({ text }: { text: string }) => {
  return (
    <div className={markdownClass}>
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

const JsonBlock = ({ value }: { value: unknown }) => {
  return <pre className="mt-2 rounded-lg border border-line bg-panel p-2.5 font-mono text-xs break-all whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>;
};

const ToolPart = ({ part }: { part: Extract<ChatPart, { kind: "tool" }> }) => {
  const url = (part.result as { url?: string } | undefined)?.url;
  const state = part.error ? "failed" : part.result ? "done" : "running";
  const stateColor = state === "done" ? "bg-mastra" : state === "failed" ? "bg-urgent" : "bg-faint";
  const mediaClass = "mb-2 block w-full max-w-[520px] rounded-lg border border-line bg-black";

  return (
    <div className="mt-2.5">
      {url && part.toolName === "ring_snapshot" ? <img className={mediaClass} src={url} alt="Ring snapshot" /> : null}
      {url && part.toolName === "ring_clip" ? <video className={mediaClass} src={url} controls preload="metadata" /> : null}
      <details className="font-mono text-xs text-muted">
        <summary className="inline-flex cursor-pointer items-center gap-2">
          <span className={`size-1.5 rounded-full ${stateColor}`} aria-hidden="true" />
          {part.toolName} <span className="text-faint">{state}</span>
        </summary>
        <JsonBlock value={{ args: part.args, result: part.result, error: part.error }} />
      </details>
    </div>
  );
};

const Part = ({ part }: { part: ChatPart }) => {
  if (part.kind === "text") {
    return <TextPart text={part.text} />;
  }
  if (part.kind === "tool") {
    return <ToolPart part={part} />;
  }
  return (
    <details className="font-mono text-xs text-muted">
      <summary className="cursor-pointer">{part.label}</summary>
      <JsonBlock value={part.value} />
    </details>
  );
};

const RingEvent = ({ entry }: { entry: ChatEntry }) => {
  const summary = entry.parts.find((part) => part.kind === "text");
  const priority = entry.ring?.priority ?? "medium";
  const color = priorityColors[priority] ?? priorityColors.medium;

  return (
    <li
      className="relative overflow-hidden rounded-[10px] border pt-3.5 pr-[18px] pb-4 pl-[22px]"
      style={{
        borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
        background: `linear-gradient(90deg, color-mix(in srgb, ${color} 16%, transparent), transparent 70%), var(--color-surface)`
      }}
    >
      <span className="absolute inset-y-0 left-0 w-[5px]" style={{ background: color }} aria-hidden="true" />
      <div className="flex items-center gap-2.5 font-mono text-[11px] tracking-[0.08em] uppercase">
        <span className="inline-flex items-center gap-2 font-semibold text-text">
          <span className="size-2 rounded-full" style={{ background: color, boxShadow: `0 0 0 4px color-mix(in srgb, ${color} 22%, transparent)` }} />
          Ring
        </span>
        <span className="rounded-full px-2 py-0.5 font-semibold text-ink" style={{ background: color }}>
          {priority}
        </span>
        <time className="ml-auto text-muted">{formatTime(entry.createdAt)}</time>
      </div>
      <p className="mt-2.5 mb-0.5 flex items-baseline gap-2.5 text-[19px] leading-tight font-semibold md:text-[22px]" style={{ color }}>
        {ringKindName(entry.ring?.kind)}
        {entry.ring?.motionType ? <span className="font-mono text-xs font-normal tracking-[0.06em] text-muted uppercase">{entry.ring.motionType}</span> : null}
      </p>
      <p>{summary?.kind === "text" ? summary.text : ""}</p>
    </li>
  );
};

const originLabel = (origin: Origin, channelPlatform: string | undefined) => {
  if (origin === "app") {
    return "App";
  }
  if (origin === "agent") {
    return "Agent";
  }
  if (origin === "channel") {
    return platformName(channelPlatform);
  }
  return "Studio";
};

const Message = ({ entry, channelPlatform }: { entry: ChatEntry; channelPlatform?: string }) => {
  const color = originColors[entry.origin];
  const fromAgent = entry.origin === "agent";
  const tinted = entry.origin === "app" || entry.origin === "channel";

  return (
    <li
      className={`relative max-w-[min(640px,88%)] rounded-[10px] border border-line px-4 pt-3 pb-3.5 ${fromAgent ? "ml-6 self-start md:ml-12" : "self-end"} ${
        entry.pending ? "opacity-60" : ""
      }`}
      style={{ "--accent": color, background: tinted ? `color-mix(in srgb, ${color} 6%, var(--color-surface))` : "var(--color-surface)" } as CSSProperties}
    >
      <span className={`absolute inset-y-2.5 w-[3px] rounded-full bg-(--accent) ${fromAgent ? "-left-px" : "-right-px"}`} aria-hidden="true" />
      <div className="mb-1.5 flex items-baseline justify-between gap-4 font-mono text-[11px]">
        <span className="font-semibold tracking-[0.08em] text-(--accent) uppercase">{originLabel(entry.origin, channelPlatform)}</span>
        <time className="text-muted">{entry.pending ? "Sending" : formatTime(entry.createdAt)}</time>
      </div>
      {entry.parts.map((part, index) => {
        return <Part key={index} part={part} />;
      })}
    </li>
  );
};

const DayDivider = ({ label }: { label: string }) => {
  return (
    <li className="sticky -top-6 z-[1] flex justify-center pt-2.5 pb-1" style={{ background: "linear-gradient(var(--color-ink) 70%, transparent)" }}>
      <span className="rounded-full border border-line bg-panel px-2.5 py-0.5 font-mono text-[11px] tracking-[0.08em] text-muted uppercase">{label}</span>
    </li>
  );
};

type ChatViewProps = {
  chat: ChatEntry[];
  channelPlatform?: string;
};

export const ChatView = ({ chat, channelPlatform }: ChatViewProps) => {
  const endRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chat]);

  if (chat.length === 0) {
    return (
      <div className="mx-auto mt-[15vh] max-w-[420px] text-center text-muted">
        <p className="font-semibold text-text">Nothing in this thread yet.</p>
        <p>Ring events and messages appear here as they arrive.</p>
      </div>
    );
  }

  return (
    <ol className="mx-auto flex max-w-[820px] flex-col gap-3.5">
      {chat.map((entry, index) => {
        const day = dayLabel(entry.createdAt);
        const showDay = day && day !== dayLabel(chat[index - 1]?.createdAt);

        return (
          <Fragment key={entry.id}>
            {showDay ? <DayDivider label={day} /> : null}
            {entry.origin === "ring" ? <RingEvent entry={entry} /> : <Message entry={entry} channelPlatform={channelPlatform} />}
          </Fragment>
        );
      })}
      <li className="h-px" ref={endRef} aria-hidden="true" />
    </ol>
  );
};
