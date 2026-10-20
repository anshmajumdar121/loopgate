import {
  Ban,
  CheckCircle2,
  CircleDashed,
  Loader2,
  AlertTriangle,
  XCircle,
  Clock,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Batch, BatchItemStatus, BatchStatus } from "@/types/batch";

interface StatusStyle {
  label: string;
  icon: LucideIcon;
  className: string;
  spin?: boolean;
}

const ITEM_STYLES: Record<BatchItemStatus, StatusStyle> = {
  pending: {
    label: "Pending",
    icon: CircleDashed,
    className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  },
  running: {
    label: "Running",
    icon: Loader2,
    spin: true,
    className: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  },
  done: {
    label: "Done",
    icon: CheckCircle2,
    className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  escalated: {
    label: "Escalated",
    icon: AlertTriangle,
    className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    className: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  },
  cancelled: {
    label: "Cancelled",
    icon: Ban,
    className: "bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  },
};

const BATCH_STYLES: Record<BatchStatus, StatusStyle> = {
  queued: {
    label: "Queued",
    icon: Clock,
    className: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  },
  running: ITEM_STYLES.running,
  done: ITEM_STYLES.done,
  partial: {
    label: "Partial",
    icon: AlertTriangle,
    className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  },
  cancelled: ITEM_STYLES.cancelled,
};

function Pill({ style, className }: { style: StatusStyle; className?: string }) {
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
        style.className,
        className
      )}
    >
      <Icon size={11} className={style.spin ? "animate-spin" : undefined} aria-hidden />
      {style.label}
    </span>
  );
}

export function ItemStatusChip({ status }: { status: BatchItemStatus }) {
  return <Pill style={ITEM_STYLES[status] ?? ITEM_STYLES.pending} />;
}

export function BatchStatusPill({ status }: { status: BatchStatus }) {
  return <Pill style={BATCH_STYLES[status] ?? BATCH_STYLES.queued} />;
}

export interface BatchCounts {
  total: number;
  finished: number;
  done: number;
  escalated: number;
  failed: number;
  cancelled: number;
  running: number;
  pending: number;
}

export function countItems(batch: Pick<Batch, "items">): BatchCounts {
  const c: BatchCounts = {
    total: batch.items.length,
    finished: 0,
    done: 0,
    escalated: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
    pending: 0,
  };
  for (const it of batch.items) {
    if (it.status in c) c[it.status] += 1;
  }
  c.finished = c.done + c.escalated + c.failed + c.cancelled;
  return c;
}

/**
 * Stacked progress bar: green = done, amber = escalated, rose = failed.
 * The label reads done/total — the headline number for the demo.
 */
export function BatchProgress({ batch, compact }: { batch: Pick<Batch, "items">; compact?: boolean }) {
  const c = countItems(batch);
  const pct = (n: number) => (c.total ? (n / c.total) * 100 : 0);
  return (
    <div>
      <div
        role="progressbar"
        aria-label="Batch progress"
        aria-valuemin={0}
        aria-valuemax={c.total}
        aria-valuenow={c.done}
        className={cn(
          "flex w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800",
          compact ? "h-1.5" : "h-2"
        )}
      >
        <div className="bg-emerald-500 transition-all duration-500" style={{ width: `${pct(c.done)}%` }} />
        <div className="bg-amber-400 transition-all duration-500" style={{ width: `${pct(c.escalated)}%` }} />
        <div className="bg-rose-500 transition-all duration-500" style={{ width: `${pct(c.failed)}%` }} />
        <div
          className="animate-pulse bg-violet-400/70 transition-all duration-500"
          style={{ width: `${pct(c.running)}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>
          <span className="font-semibold text-zinc-800 dark:text-zinc-200">
            {c.done}/{c.total}
          </span>{" "}
          done
        </span>
        {!compact && (
          <span className="flex gap-2">
            {c.escalated > 0 && <span className="text-amber-600 dark:text-amber-400">{c.escalated} escalated</span>}
            {c.failed > 0 && <span className="text-rose-600 dark:text-rose-400">{c.failed} failed</span>}
            {c.cancelled > 0 && <span>{c.cancelled} cancelled</span>}
          </span>
        )}
      </div>
    </div>
  );
}
