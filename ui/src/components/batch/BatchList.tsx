import { Layers, Plus } from "lucide-react";
import { formatRelativeTime } from "@/lib/format";
import type { Batch } from "@/types/batch";
import { BatchProgress, BatchStatusPill } from "./BatchStatus";

interface BatchListProps {
  batches: Batch[];
  loaded: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}

export function BatchList({ batches, loaded, onOpen, onNew }: BatchListProps) {
  if (loaded && batches.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-16 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400">
          <Layers size={22} />
        </div>
        <div>
          <div className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">No batches yet</div>
          <p className="mt-1 text-[12px] text-zinc-500 dark:text-zinc-400">
            Run one prompt template across many items — each item becomes its own plan → build → verify loop.
          </p>
        </div>
        <button
          type="button"
          onClick={onNew}
          className="flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-medium text-white hover:bg-violet-700"
        >
          <Plus size={13} /> New batch
        </button>
      </div>
    );
  }

  return (
    <ul aria-label="Batches" className="flex flex-col gap-2 overflow-y-auto px-5 py-4">
      {!loaded && batches.length === 0 && (
        <li className="py-8 text-center text-[12px] text-zinc-500 dark:text-zinc-400">Loading batches…</li>
      )}
      {batches.map((b) => (
        <li key={b.id}>
          <button
            type="button"
            onClick={() => onOpen(b.id)}
            aria-label={`Open batch ${b.title}`}
            className="w-full rounded-xl border border-zinc-200 bg-white p-3 text-left shadow-soft transition hover:border-violet-300 hover:shadow-card dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-violet-500/40"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">{b.title}</div>
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {b.items.length} item{b.items.length === 1 ? "" : "s"} · {formatRelativeTime(b.createdAt)}
                </div>
              </div>
              <BatchStatusPill status={b.status} />
            </div>
            <div className="mt-2.5">
              <BatchProgress batch={b} compact />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
