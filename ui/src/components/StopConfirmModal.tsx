import { useState } from "react";
import { AlertTriangle, Square, X } from "lucide-react";

interface StopConfirmModalProps {
  taskTitle: string;
  attempt: number;
  maxAttempts: number;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Stops are destructive — they kill the live agent process, abandon any
 * in-flight file changes the maker might have started, and lose the current
 * attempt's progress. Show a confirmation before doing it.
 */
export function StopConfirmModal({
  taskTitle,
  attempt,
  maxAttempts,
  onClose,
  onConfirm,
}: StopConfirmModalProps) {
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      onConfirm();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-sm"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-[440px] max-w-[90vw] rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400">
            <AlertTriangle size={18} strokeWidth={2.2} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14.5px] font-semibold text-zinc-900 dark:text-zinc-100">
              Stop this loop?
            </h2>
            <p className="mt-1 text-[12.5px] text-zinc-500 dark:text-zinc-400">
              The live agent process will be killed and the task marked as
              cancelled. Any in-flight file changes the maker started may be
              left in an inconsistent state.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X size={15} />
          </button>
        </div>

        <div className="my-3 rounded-md bg-zinc-50 px-3 py-2 text-[12px] dark:bg-zinc-900">
          <div className="truncate font-medium text-zinc-800 dark:text-zinc-200">
            {taskTitle}
          </div>
          {attempt > 0 && (
            <div className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
              attempt {attempt}/{maxAttempts}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="h-9 rounded-md px-4 text-[13px] font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Keep running
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting}
            className="flex h-9 items-center gap-1.5 rounded-md bg-rose-500 px-4 text-[13px] font-medium text-white shadow-sm transition hover:bg-rose-600 disabled:opacity-50"
          >
            <Square size={12} fill="currentColor" />
            {submitting ? "Stopping…" : "Stop loop"}
          </button>
        </div>
      </div>
    </div>
  );
}