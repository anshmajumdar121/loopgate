import { useEffect, useRef, useState } from "react";
import { Layers, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isBatchActive, useBatchStore, useBatchSync } from "@/lib/batchStore";
import { BatchForm } from "./BatchForm";
import { BatchList } from "./BatchList";
import { BatchDetail } from "./BatchDetail";

type Tab = "new" | "runs";

interface BatchPanelProps {
  onClose: () => void;
  /** Select an item's task in the main UI (canvas + side panel). */
  onSelectTask: (taskId: string) => void;
}

/**
 * Right-side drawer for batches (Map node): create a batch from a prompt
 * template + item list, then watch per-item progress live. Rendered by App
 * on top of whatever view is active.
 */
export function BatchPanel({ onClose, onSelectTask }: BatchPanelProps) {
  useBatchSync();
  const batches = useBatchStore((s) => s.batches);
  const loaded = useBatchStore((s) => s.loaded);
  const selectedBatchId = useBatchStore((s) => s.selectedBatchId);
  const selectBatch = useBatchStore((s) => s.selectBatch);
  const upsertBatch = useBatchStore((s) => s.upsertBatch);

  const [tab, setTab] = useState<Tab>(() =>
    useBatchStore.getState().batches.length > 0 || selectedBatchId ? "runs" : "new"
  );
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // First load landed with existing batches → show them instead of the form.
  const initialTabDecided = useRef(batches.length > 0);
  useEffect(() => {
    if (!initialTabDecided.current && loaded) {
      initialTabDecided.current = true;
      if (batches.length > 0) setTab("runs");
    }
  }, [loaded, batches.length]);

  // Ref so an inline onClose from the parent doesn't re-run the effect
  // (which would steal focus from the form on every parent render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = selectedBatchId ? batches.find((b) => b.id === selectedBatchId) ?? null : null;
  const runningCount = batches.filter(isBatchActive).length;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-panel-title"
        tabIndex={-1}
        className="relative flex h-full w-[540px] max-w-[95vw] flex-col border-l border-zinc-200 bg-white shadow-2xl outline-none dark:border-zinc-800 dark:bg-zinc-950"
      >
        <header className="flex items-center gap-3 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 text-white shadow-sm">
            <Layers size={16} strokeWidth={2.2} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="batch-panel-title" className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
              Batch runs
            </h2>
            <p className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
              One prompt template, many items — each runs its own loop.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close batch panel"
            className="grid h-8 w-8 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X size={16} />
          </button>
        </header>

        {selected ? (
          <BatchDetail batch={selected} onBack={() => selectBatch(null)} onSelectTask={onSelectTask} />
        ) : (
          <>
            <div role="tablist" aria-label="Batch views" className="flex gap-1 border-b border-zinc-200 px-5 pt-2 dark:border-zinc-800">
              <TabButton active={tab === "new"} onClick={() => setTab("new")} label="New batch" />
              <TabButton
                active={tab === "runs"}
                onClick={() => setTab("runs")}
                label="Runs"
                badge={batches.length}
                pulse={runningCount > 0}
              />
            </div>
            {tab === "new" ? (
              <div className="flex-1 overflow-y-auto px-5 py-4">
                <BatchForm
                  onCreated={(batch) => {
                    upsertBatch(batch);
                    selectBatch(batch.id);
                    setTab("runs");
                  }}
                />
              </div>
            ) : (
              <BatchList batches={batches} loaded={loaded} onOpen={selectBatch} onNew={() => setTab("new")} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  badge,
  pulse,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
  pulse?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12.5px] font-medium transition-colors",
        active
          ? "border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300"
          : "border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      )}
    >
      {pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" aria-hidden />}
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="rounded-full bg-zinc-100 px-1.5 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {badge}
        </span>
      )}
    </button>
  );
}
