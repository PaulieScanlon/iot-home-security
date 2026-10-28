import type { RawEntry } from "./use-thread";

export const RawView = ({ raw }: { raw: RawEntry[] }) => {
  return (
    <div className="raw">
      {raw.map((entry, index) => {
        return (
          <details key={index} open={entry.chunk.type !== "text-delta"}>
            <summary>
              <span className="time">{entry.receivedAt}</span> <strong>{entry.chunk.type}</strong>
            </summary>
            <pre>{JSON.stringify(entry.chunk, null, 2)}</pre>
          </details>
        );
      })}
    </div>
  );
};
