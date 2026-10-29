import { formatDay } from "../lib/labels";
import type { ThreadSummary } from "../hooks/use-threads";

type SidebarProps = {
  threads: ThreadSummary[];
  activeThreadId: string;
  onSelect: (threadId: string) => void;
  open: boolean;
};

export const Sidebar = ({ threads, activeThreadId, onSelect, open }: SidebarProps) => {
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-10 flex w-[min(300px,85vw)] flex-col border-r border-line bg-panel transition-transform motion-reduce:transition-none md:static md:w-auto md:translate-x-0 ${
        open ? "translate-x-0 shadow-[0_0_0_100vmax_rgb(0_0_0/0.5)] md:shadow-none" : "-translate-x-full"
      }`}
      aria-label="Threads"
    >
      <div className="flex items-center justify-between px-[18px] pt-[18px] pb-3 font-mono text-[11px] tracking-[0.08em] text-muted uppercase">
        <span>Threads</span>
        <span>{threads.length}</span>
      </div>
      {threads.length === 0 ? <p className="px-[18px] text-sm text-muted">No threads for this agent yet. Send a message to start one.</p> : null}
      <ul className="overflow-y-auto px-2.5 pb-[18px]">
        {threads.map((thread) => {
          const active = thread.id === activeThreadId;
          return (
            <li key={thread.id}>
              <button
                className={`relative mb-1 grid w-full gap-1 rounded-[10px] border py-3 pr-3 pl-4 text-left hover:bg-surface ${
                  active ? "border-line bg-surface" : "border-transparent"
                }`}
                onClick={() => onSelect(thread.id)}
                aria-current={active ? "page" : undefined}
              >
                {active ? <span className="absolute inset-y-3 left-0 w-[3px] rounded-full bg-mastra" aria-hidden="true" /> : null}
                <span className="truncate font-semibold">{thread.title || thread.id}</span>
                <span className="truncate font-mono text-[11px] text-muted">{thread.id}</span>
                <span className="font-mono text-[11px] text-muted">{formatDay(thread.updatedAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
};
