import { useState } from "react";
import type { KeyboardEvent } from "react";

type ComposerProps = {
  onSend: (text: string) => Promise<void>;
};

export const Composer = ({ onSend }: ComposerProps) => {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const send = async () => {
    const message = text.trim();
    if (!message || sending) {
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      await onSend(message);
      setText("");
    } catch (sendError) {
      setError(`Message not sent: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <form
      className="border-t border-line bg-ink px-4 pt-3 pb-4 md:px-6"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {error ? <p className="mx-auto mb-2 max-w-[820px] font-mono text-[11px] text-urgent">{error}</p> : null}
      <div className="mx-auto flex max-w-[820px] items-end gap-2.5 rounded-xl border border-line-strong bg-surface py-2 pr-2 pl-3 focus-within:border-mastra/60">
        <textarea
          className="field-sizing-content block max-h-40 min-h-[38px] flex-1 resize-none bg-transparent py-2 leading-[22px] outline-none placeholder:text-faint"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about the front door"
          rows={1}
          aria-label="Message the agent"
        />
        <button
          className="rounded-lg bg-mastra px-4 py-2 leading-[22px] font-semibold text-ink disabled:cursor-default disabled:bg-line disabled:text-faint"
          type="submit"
          disabled={!text.trim() || sending}
        >
          {sending ? "Sending" : "Send"}
        </button>
      </div>
    </form>
  );
};
