import { useState } from "react";
import { ArrowLeft, Ban, Copy, Check, FileText, Loader2, RotateCcw, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkflow } from "@/lib/store";
import { formatRelativeTime } from "@/lib/format";
import { cancelBatch, resumeBatch } from "@/lib/batchApi";
import { isBatchActive, useBatchStore } from "@/lib/batchStore";
import type { Batch, BatchItem } from "@/types/batch";
import { BatchProgress, BatchStatusPill, ItemStatusChip } from "./BatchStatus";

const RESUMABLE: ReadonlyArray<BatchItem["status"]> = ["pending", "cancelled", "failed"];

interface BatchDetailProps {
  batch: Batch;
  onBack: () => void;
  onSelectTask: (taskId: string) => void;
}

export function BatchDetail({ batch, onBack, onSelectTask }: BatchDetailProps) {
  const upsertBatch = useBatchStore((s) => s.upsertBatch);
  const [busy, setBusy] = useState<"cancel" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = isBatchActive(batch);
  const canResume = !active && batch.items.some((i) => RESUMABLE.includes(i.status));
  const maxAttempts = batch.maxAttempts ?? 3;

  const run = async (kind: "cancel" | "resume") => {
    setBusy(kind);
    setError(null);
    try {
      const next = kind === "cancel" ? await cancelBatch(batch.id) : await resumeBatch(batch.id);
      if (next) upsertBatch(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to batch list"
          className="mb-2 flex items-center gap-1 text-[11.5px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          <ArrowLeft size={12} /> All batches
        </button>
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-100" title={batch.title}>
            {batch.title}
          </h3>
          <BatchStatusPill status={batch.status} />
        </div>
        <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
          Started {formatRelativeTime(batch.createdAt)} · up to {maxAttempts} attempt{maxAttempts === 1 ? "" : "s"} per item
          {batch.model ? ` · ${batch.model}` : ""}
        </div>

        <div className="mt-3">
          <BatchProgress batch={batch} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {active && (
            <button
              type="button"
              onClick={() => void run("cancel")}
              disabled={busy !== null}
              aria-label="Cancel batch"
              className="flex h-8 items-center gap-1.5 rounded-md border border-rose-200 bg-white px-3 text-[12px] font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/30 dark:bg-zinc-900 dark:text-rose-400 dark:hover:bg-rose-500/10"
            >
              {busy === "cancel" ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}
              Cancel
            </button>
          )}
          {canResume && (
            <button
              type="button"
              onClick={() => void run("resume")}
              disabled={busy !== null}
              aria-label="Resume batch"
              className="flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-medium text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-50"
            >
              {busy === "resume" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
              Resume
            </button>
          )}
        </div>

        {batch.reportPath && <ReportPath path={batch.reportPath} />}

        {error && (
          <div role="alert" className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            {error}
          </div>
        )}

        <details className="mt-3 text-[11.5px]">
          <summary className="cursor-pointer select-none font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Prompt template
          </summary>
          <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2 font-mono text-[11px] text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            {batch.promptTemplate}
          </pre>
        </details>
      </div>

      <ul aria-label="Batch items" className="min-h-0 flex-1 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800/70">
        {batch.items.map((item) => (
          <ItemRow key={item.index} item={item} maxAttempts={maxAttempts} onSelectTask={onSelectTask} />
        ))}
      </ul>
    </div>
  );
}

function ItemRow({
  item,
  maxAttempts,
  onSelectTask,
}: {
  item: BatchItem;
  maxAttempts: number;
  onSelectTask: (taskId: string) => void;
}) {
  const currentTaskId = useWorkflow((s) => s.currentTaskId);
  const selected = Boolean(item.taskId) && item.taskId === currentTaskId;
  const body = (
    <>
      <span className="w-7 shrink-0 pt-0.5 text-right font-mono text-[10.5px] text-zinc-400">{item.index + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12px] text-zinc-800 dark:text-zinc-200" title={item.input}>
          {item.input}
        </div>
        {item.reason && (
          <div
            className={cn(
              "mt-0.5 line-clamp-2 text-[11px]",
              item.status === "failed" ? "text-rose-600 dark:text-rose-400" : "text-amber-700 dark:text-amber-400"
            )}
            title={item.reason}
          >
            {item.reason}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <ItemStatusChip status={item.status} />
        {item.attempts !== undefined && item.attempts > 0 && (
          <span className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
            attempt {item.attempts}/{maxAttempts}
          </span>
        )}
      </div>
    </>
  );
  const rowCls = "flex w-full items-start gap-2.5 px-5 py-2.5 text-left";
  return (
    <li data-testid={`batch-item-${item.index}`} data-status={item.status}>
      {item.taskId ? (
        <button
          type="button"
          onClick={() => onSelectTask(item.taskId as string)}
          aria-label={`Open task for item ${item.index + 1}: ${item.input}`}
          aria-current={selected ? "true" : undefined}
          className={cn(
            rowCls,
            "group transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900",
            selected && "bg-violet-50/70 dark:bg-violet-500/10"
          )}
        >
          {body}
          <ExternalLink size={12} className="mt-1 shrink-0 text-zinc-300 group-hover:text-violet-500 dark:text-zinc-600" aria-hidden />
        </button>
      ) : (
        <div className={rowCls}>
          {body}
          <span className="w-3 shrink-0" aria-hidden />
        </div>
      )}
    </li>
  );
}

function ReportPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — path is still selectable */
    }
  };
  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/60 px-2.5 py-1.5 dark:border-emerald-500/25 dark:bg-emerald-500/5">
      <FileText size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Report</div>
        <div className="truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-300" title={path}>
          {path}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="Copy report path"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-zinc-500 hover:bg-emerald-100 dark:hover:bg-emerald-500/15"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}
