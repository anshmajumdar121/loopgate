import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Map as MapIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isBatchActive, useBatchStore } from "@/lib/batchStore";
import type { BatchItem, BatchItemStatus } from "@/types/batch";
import { BatchProgress, BatchStatusPill, ItemStatusChip, countItems } from "@/components/batch/BatchStatus";
import { useWorkflow } from "@/lib/store";
import type { RunStatus } from "@/data/workflow";

interface MapNodeData extends Record<string, unknown> {
  spec: {
    id: string;
    title: string;
    subtitle?: string;
  };
  status: RunStatus;
}

const DOT_STYLES: Record<BatchItemStatus, string> = {
  pending: "bg-zinc-300 dark:bg-zinc-600",
  running: "bg-violet-500 ring-violet-200 dark:ring-violet-500/30",
  done: "bg-emerald-500",
  escalated: "bg-amber-400",
  failed: "bg-rose-500",
  cancelled: "bg-zinc-400 dark:bg-zinc-500",
};

/**
 * Batch Map node: a compact, live mirror of the newest/current batch. The
 * batch store is already updated by batch_update WebSocket events, so this
 * node deliberately has no fetching or mutation logic of its own.
 */
function MapNodeImpl({ data, selected }: NodeProps) {
  const batches = useBatchStore((s) => s.batches);
  const loaded = useBatchStore((s) => s.loaded);
  const selectedBatchId = useBatchStore((s) => s.selectedBatchId);
  const activeTask = useWorkflow((s) => s.activeTask);
  const spec = data.spec as MapNodeData["spec"];

  const selectedBatch = selectedBatchId ? batches.find((batch) => batch.id === selectedBatchId) : undefined;
  const activeBatch = activeTask?.batchId ? batches.find((batch) => batch.id === activeTask.batchId) : undefined;
  const batch = selectedBatch ?? activeBatch ?? batches.find(isBatchActive) ?? batches[0] ?? null;
  const counts = batch ? countItems(batch) : null;
  const maxAttempts = batch?.maxAttempts ?? 3;

  const stopInteraction = (event: React.SyntheticEvent) => event.stopPropagation();

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden rounded-xl border bg-white shadow-card dark:bg-zinc-950",
        selected ? "border-violet-400/70 ring-1 ring-violet-400/30" : "border-zinc-200 dark:border-zinc-800"
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="from-orchestrator"
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-violet-400 dark:!border-zinc-950"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-violet-500 dark:!border-zinc-950"
      />

      <div className="shrink-0 cursor-move border-b border-zinc-200 px-3.5 pb-2.5 pt-3 dark:border-zinc-800">
        <div className="flex items-start gap-2">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
            <MapIcon size={15} strokeWidth={2.2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-600 dark:text-violet-300">{spec.title}</div>
            <h3
              className="mt-0.5 truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100"
              title={batch?.title ?? "No batch selected"}
            >
              {batch?.title ?? "No batch selected"}
            </h3>
          </div>
          {batch && <BatchStatusPill status={batch.status} />}
        </div>
        {batch && counts && (
          <>
            <div className="mt-2.5">
              <BatchProgress batch={batch} compact />
            </div>
            <div
              data-testid="map-batch-counts"
              className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400"
            >
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">{counts.done}/{counts.total} done</span>
              {counts.running > 0 && <span className="text-violet-600 dark:text-violet-300">{counts.running} running</span>}
              {counts.pending > 0 && <span>{counts.pending} pending</span>}
              {counts.escalated > 0 && <span className="text-amber-600 dark:text-amber-300">{counts.escalated} escalated</span>}
              {counts.failed > 0 && <span className="text-rose-600 dark:text-rose-300">{counts.failed} failed</span>}
              {counts.cancelled > 0 && <span>{counts.cancelled} cancelled</span>}
            </div>
          </>
        )}
      </div>

      {!batch ? (
        <div data-testid="map-node-empty" className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 py-8 text-center">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-violet-50 text-violet-500 dark:bg-violet-500/10 dark:text-violet-300">
            <MapIcon size={19} />
          </div>
          <div className="mt-3 text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-200">
            {loaded ? "No batch runs yet" : "Waiting for batch updates"}
          </div>
          <p className="mt-1 max-w-[240px] text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            {loaded ? "Start a batch to see each item move through the loop here." : "The latest batch will appear here as soon as it is available."}
          </p>
        </div>
      ) : (
        <div
          className="nodrag nopan nowheel min-h-0 flex-1 overflow-y-auto px-3 py-2.5"
          onPointerDown={stopInteraction}
          onMouseDown={stopInteraction}
          onTouchStart={stopInteraction}
          onClick={stopInteraction}
        >
          {batch.items.length === 0 ? (
            <div data-testid="map-batch-empty" className="rounded-lg border border-dashed border-zinc-200 px-3 py-6 text-center text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              This batch has no items yet.
            </div>
          ) : (
            <ul aria-label="Map batch items" className="space-y-1.5">
              {batch.items.map((item) => (
                <MapItemRow
                  key={item.index}
                  item={item}
                  maxAttempts={maxAttempts}
                  active={activeTask?.batchId === batch.id && activeTask.id === item.taskId}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function MapItemRow({ item, maxAttempts, active }: { item: BatchItem; maxAttempts: number; active: boolean }) {
  const running = item.status === "running";
  return (
    <li
      data-testid={`map-item-${item.index}`}
      data-status={item.status}
      data-live={running ? "true" : undefined}
      data-active-task={active ? "true" : undefined}
      className="relative"
    >
      {running && <span aria-hidden className="pointer-events-none absolute -inset-px rounded-lg ring-1 ring-violet-400/30 animate-pulse" />}
      <div
        className={cn(
          "relative flex items-start gap-2 rounded-lg border px-2.5 py-2 transition-colors",
          active
            ? "border-violet-300 bg-violet-50/80 ring-1 ring-violet-400/50 dark:border-violet-500/50 dark:bg-violet-500/10"
            : running
            ? "border-violet-200 bg-violet-50/40 dark:border-violet-500/30 dark:bg-violet-500/5"
            : "border-zinc-200/80 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/60"
        )}
      >
        {running ? (
          <span
            aria-label={`Running item ${item.index + 1}`}
            className="relative mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center"
          >
            <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-violet-400/35" />
            <span aria-hidden className="relative h-1.5 w-1.5 rounded-full bg-violet-500 ring-2 ring-violet-200 dark:ring-violet-500/30" />
          </span>
        ) : (
          <span aria-hidden className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT_STYLES[item.status])} />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-mono text-[10px] text-zinc-400">{item.index + 1}</span>
            <span className="min-w-0 truncate font-mono text-[11.5px] text-zinc-800 dark:text-zinc-200" title={item.input}>
              {item.input}
            </span>
            {active && (
              <span className="shrink-0 rounded border border-violet-300/70 px-1 py-px text-[8.5px] font-semibold uppercase tracking-wider text-violet-700 dark:border-violet-400/40 dark:text-violet-300">
                Active
              </span>
            )}
          </div>
          {item.reason && (
            <div
              className={cn(
                "mt-0.5 truncate text-[10px]",
                item.status === "failed" ? "text-rose-600 dark:text-rose-400" : item.status === "escalated" ? "text-amber-700 dark:text-amber-300" : "text-zinc-500 dark:text-zinc-400"
              )}
              title={item.reason}
            >
              {item.reason}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <ItemStatusChip status={item.status} />
          <span className="font-mono text-[9.5px] tabular-nums text-zinc-500 dark:text-zinc-400">
            attempt {item.attempts ?? 0}/{maxAttempts}
          </span>
        </div>
      </div>
    </li>
  );
}

export const MapNode = memo(MapNodeImpl);
