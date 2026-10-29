import type { RawEntry } from "../hooks/use-thread";

export const RawView = ({ raw }: { raw: RawEntry[] }) => {
  return (
    <div className="mx-auto max-w-[820px] font-mono text-xs">
      {raw.map((entry, index) => {
        return (
          <details key={index} className="border-b border-line py-1.5" open={entry.chunk.type !== "text-delta"}>
            <summary className="cursor-pointer">
              <span className="text-muted">{entry.receivedAt}</span> <strong className="font-semibold">{entry.chunk.type}</strong>
            </summary>
            <pre className="mt-2 rounded-lg border border-line bg-panel p-2.5 break-all whitespace-pre-wrap">{JSON.stringify(entry.chunk, null, 2)}</pre>
          </details>
        );
      })}
    </div>
  );
};
