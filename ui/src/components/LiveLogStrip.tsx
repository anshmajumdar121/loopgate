import { useEffect, useRef, useState } from "react";
import {
  ChevronUp,
  ChevronDown,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useWorkflow } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { LogEntry, LogLevel } from "@/types/loop";

/**
 * Bottom strip that streams agent output as monospace text. Always present
 * (collapsible) so the user can monitor live progress without taking over
 * the canvas. Default behaviour:
 *   - expanded when a task is running or was just finished
 *   - collapsed when no task has ever run
 *
 * Color-coded agent tag (planner/maker/verifier/system/orchestrator) and
 * stream (stdout/stderr/error/info) so the eye can scan quickly.
 */
export function LiveLogStrip() {
  const logs = useWorkflow((s) => s.logs);
  const currentTaskId = useWorkflow((s) => s.currentTaskId);
  const isRunning = useWorkflow((s) => s.isRunning);
  const taskMirror = useWorkflow((s) => s.taskMirror);
  const resetTaskState = useWorkflow((s) => s.resetTaskState);

  // Default: collapsed only when no task has ever been started.
  const [expanded, setExpanded] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  const scrollerRef = useRef<HTMLDivElement>(null);

  // Auto-expand when a new task starts.
  useEffect(() => {
    if (isRunning) setExpanded(true);
  }, [isRunning]);

  // Auto-scroll to bottom when new logs arrive, unless the user has scrolled
  // away from the bottom.
  useEffect(() => {
    if (!autoScroll || !expanded) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, autoScroll, expanded]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    setAutoScroll(atBottom);
  };

  const clearLogs = () => {
    // Setting logs to [] in the store requires a dedicated action; simplest
    // is to call resetTaskState which clears everything including logs.
    if (currentTaskId && !isRunning) resetTaskState();
  };

  const phaseLabel = taskMirror
    ? `${taskMirror.title} — ${(taskMirror.status ?? "active").replace("_", " ")}`
    : "no task";

  return (
    <div className="flex shrink-0 flex-col border-t border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      {/* Header bar */}
      <div className="flex h-9 items-center gap-2 px-3">
        <Terminal size={13} className="text-zinc-400" />
        <span className="text-[11.5px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Live Log
        </span>
        <span className="ml-2 truncate text-[11.5px] text-zinc-400 dark:text-zinc-500">
          {phaseLabel}
        </span>
        <span className="ml-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {logs.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {currentTaskId && !isRunning && logs.length > 0 && (
            <button
              onClick={clearLogs}
              className="grid h-6 w-6 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              title="Clear logs"
            >
              <Trash2 size={11} />
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="grid h-6 w-6 place-items-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="max-h-56 overflow-y-auto bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-200"
        >
          {logs.length === 0 ? (
            <p className="text-zinc-500">no log entries yet</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {logs.slice(-200).map((l, i) => (
                <LogLine key={`${l.ts}-${i}`} entry={l} />
              ))}
            </ul>
          )}
          {!autoScroll && logs.length > 0 && (
            <button
              onClick={() => {
                setAutoScroll(true);
                const el = scrollerRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
              className="sticky bottom-1 left-1/2 -translate-x-1/2 mt-1 rounded-full bg-violet-600 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white shadow-md hover:bg-violet-500"
            >
              ↓ Jump to latest
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const streamCls = streamColor(entry.stream);
  return (
    <li className="flex items-start gap-2">
      <span className="shrink-0 text-zinc-500">{entry.ts.slice(11, 19)}</span>
      <span
        className={cn(
          "shrink-0 select-none rounded px-1 py-px text-[9px] font-bold uppercase tracking-wider",
          agentBadge(entry.agent)
        )}
      >
        {entry.agent}
      </span>
      <span className={cn("shrink-0 text-[9px] uppercase", streamCls)}>
        [{entry.stream}]
      </span>
      <span className={cn("flex-1 break-words whitespace-pre-wrap", streamCls)}>
        {entry.text}
      </span>
    </li>
  );
}

// X is currently unused — kept exported from lucide-react in case we want a
// per-line dismiss later. Reference it to satisfy noUnusedLocals if it
// becomes a build error.
void X;

function streamColor(stream: LogLevel): string {
  switch (stream) {
    case "error":
      return "text-rose-400";
    case "stderr":
      return "text-amber-400";
    case "info":
      return "text-zinc-400";
    case "stdout":
    default:
      return "text-zinc-100";
  }
}

function agentBadge(agent: LogEntry["agent"]): string {
  switch (agent) {
    case "planner":
      return "bg-violet-500/20 text-violet-300";
    case "maker":
      return "bg-emerald-500/20 text-emerald-300";
    case "verifier":
      return "bg-amber-500/20 text-amber-300";
    case "orchestrator":
      return "bg-zinc-500/30 text-zinc-300";
    case "system":
      return "bg-rose-500/20 text-rose-300";
  }
}