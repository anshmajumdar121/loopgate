import {
  Settings2,
  Moon,
  Sun,
  Bell,
  Square,
  Plus,
  PanelLeftClose,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader2,
  WifiOff,
  Wifi,
  Sparkles,
  Play,
  RotateCcw,
  Boxes,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useWorkflow } from "@/lib/store";
import { useConnectionList } from "@/lib/useConnectionList";
import { useBatchStore } from "@/lib/batchStore";
import { cn } from "@/lib/utils";
import { dynamicModelOptions } from "@/types/loop";
import type { TaskStatus } from "@/types/loop";

interface TopBarProps {
  onToggleSidebar: () => void;
  onNewTask: () => void;
  /** Opens the Batch drawer. */
  onOpenBatch?: () => void;
}

/**
 * Top bar — shows current task (or "no task"), phase badge, attempt counter,
 * and a stop button when something is running. Theme + settings stay on the
 * right.
 */
export function TopBar({ onToggleSidebar, onNewTask, onOpenBatch }: TopBarProps) {
  const theme = useWorkflow((s) => s.theme);
  const toggleTheme = useWorkflow((s) => s.toggleTheme);
  const taskMirror = useWorkflow((s) => s.taskMirror);
  const phase = useWorkflow((s) => s.phase);
  const isRunning = useWorkflow((s) => s.isRunning);
  const currentTaskId = useWorkflow((s) => s.currentTaskId);
  const activeTask = useWorkflow((s) => s.activeTask);
  const followLive = useWorkflow((s) => s.followLive);
  const toggleFollowLive = useWorkflow((s) => s.toggleFollowLive);
  const batches = useBatchStore((s) => s.batches);
  const wsStatus = useWorkflow((s) => s.wsStatus);
  // Live + final score for the top-bar badge. Mirrors the same data the
  // ProgressNode's HeaderScoreBadge reads from, so the two stay in sync
  // — the TopBar just makes the score visible from any view (sidebar,
  // connections, settings, etc.) instead of only when ProgressNode is
  // mounted.
  const liveScore = useWorkflow((s) => s.liveScore);
  const verdict = useWorkflow((s) => s.verdict);

  const liveTask = activeTask ?? (isRunning && taskMirror ? taskMirror : null);
  const liveStatus = liveTask?.status ?? null;
  const livePhase =
    liveTask && liveTask.id === currentTaskId
      ? phase ?? liveTask.status
      : liveStatus;
  const liveBatchPosition = liveTask
    ? findBatchPosition(liveTask.id, liveTask.batchId, batches)
    : null;

  const handleStop = () => {
    // Stop is destructive — fire an event that App picks up and shows a
    // confirmation modal before issuing the POST /stop.
    window.dispatchEvent(new CustomEvent("loop:requestStop"));
  };

  /**
   * Resume a previously stopped (or escalated) loop from where it left off.
   * The backend picks the resume point based on what was preserved
   * (plan + diff → verifying; plan only → plan_review; nothing → draft).
   * No confirmation needed — Resume is a continuation, not a destructive
   * action. The backend's task_update broadcast flips isRunning back to
   * true via the WS handler.
   */
  const handleResume = async () => {
    if (!currentTaskId) return;
    try {
      const res = await fetch(`/api/tasks/${currentTaskId}/resume`, {
        method: "POST",
      });
      if (!res.ok) {
        console.error(`[topbar] resume failed: ${res.status}`);
      }
    } catch (err) {
      console.error("[topbar] resume error:", err);
    }
  };

  /**
   * Reset the current task — clear plan/diff/verdict/history and start a
   * fresh loop from scratch (attempt counter increments). This is
   * destructive (discards in-flight progress), so confirm with the user
   * before firing the request.
   */
  const handleReset = () => {
    if (!currentTaskId) return;
    const ok = window.confirm(
      "Reset will clear the current plan, diff, and history, and start a fresh loop from the beginning.\n\nContinue?"
    );
    if (!ok) return;
    void (async () => {
      try {
        const res = await fetch(`/api/tasks/${currentTaskId}/reset`, {
          method: "POST",
        });
        if (!res.ok) {
          console.error(`[topbar] reset failed: ${res.status}`);
        }
      } catch (err) {
        console.error("[topbar] reset error:", err);
      }
    })();
  };

  const handleNewTask = () => {
    // The "New Task" button is disabled when isRunning, so we know there's
    // no active loop here. App.handleNewTask owns the conflict guard for
    // edge cases (e.g. racing state updates). Just delegate.
    onNewTask();
  };

  // Visibility rules for the three control buttons:
  //   Stop    → only while the loop is running
  //   Resume  → stopped or escalated (backend refuses otherwise, so
  //             we hide rather than show a 400)
  //   Reset   → any non-running, non-done task (gives the user an escape
  //             hatch to start over from a cancelled/escalated/draft state)
  const canResume =
    !!taskMirror &&
    !isRunning &&
    (taskMirror.status === "cancelled" || taskMirror.status === "escalated");
  const canReset =
    !!taskMirror && !isRunning && taskMirror.status !== "done";

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950">
      <button
        onClick={onToggleSidebar}
        className="grid h-8 w-8 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        aria-label="Toggle sidebar"
      >
        <PanelLeftClose size={16} />
      </button>

      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-400 to-violet-700 text-white">
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          >
            <path d="M6 5 L6 19 M18 5 L18 19 M6 12 L18 12" />
            <circle cx="6" cy="5" r="1.5" fill="currentColor" />
            <circle cx="18" cy="5" r="1.5" fill="currentColor" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <circle cx="6" cy="19" r="1.5" fill="currentColor" />
            <circle cx="18" cy="19" r="1.5" fill="currentColor" />
          </svg>
        </div>
        <span className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Loop Agent
        </span>
      </div>

      <LiveLoopChip
        followLive={followLive}
        liveTask={liveTask}
        livePhase={livePhase}
        batchPosition={liveBatchPosition}
        onToggle={toggleFollowLive}
      />

      {/* Task title + phase badge + attempt counter */}
      <div className="ml-2 flex min-w-0 items-center gap-2">
        {taskMirror ? (
          <>
            <span className="max-w-[280px] truncate text-[12.5px] font-medium text-zinc-700 dark:text-zinc-200">
              {taskMirror.title}
            </span>
            {taskMirror.model && <ModelBadge modelId={taskMirror.model} />}
            <PhaseBadge phase={phase} />
            <LiveScoreBadge liveScore={liveScore} verdict={verdict} phase={phase} />
            {taskMirror.attempt > 0 && (
              <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                Attempt {taskMirror.attempt}/{taskMirror.maxAttempts}
              </span>
            )}
          </>
        ) : (
          <span className="text-[12.5px] italic text-zinc-400 dark:text-zinc-500">
            no task running
          </span>
        )}
        <ConnectionBadge status={wsStatus} />
      </div>

      <div className="ml-auto flex items-center gap-1">
        {/* Stop button — only visible when an agent is running */}
        {isRunning && currentTaskId && (
          <button
            onClick={handleStop}
            className="mr-1 flex h-8 items-center gap-1.5 rounded-md bg-rose-500 px-2.5 text-[12px] font-medium text-white shadow-sm transition hover:bg-rose-600"
            title="Stop loop"
          >
            <Square size={11} fill="currentColor" />
            Stop
          </button>
        )}

        {/* Resume button — visible when a stopped/escalated task is selected.
            Continues the loop from where it left off (plan/diff preserved). */}
        {canResume && (
          <button
            onClick={handleResume}
            className="mr-1 flex h-8 items-center gap-1.5 rounded-md bg-violet-500 px-2.5 text-[12px] font-medium text-white shadow-sm transition hover:bg-violet-600"
            title="Resume loop from where it stopped"
          >
            <Play size={11} fill="currentColor" />
            Resume
          </button>
        )}

        {/* Reset button — visible for any non-running, non-done task.
            Clears plan/diff/verdict and starts a fresh loop from scratch. */}
        {canReset && (
          <button
            onClick={handleReset}
            className="mr-1 flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            title="Reset and start a fresh loop from the beginning"
          >
            <RotateCcw size={11} />
            Reset
          </button>
        )}

        <IconButton aria-label="Settings">
          <Settings2 size={15} />
        </IconButton>
        <IconButton
          aria-label="Toggle theme"
          onClick={toggleTheme}
          active={theme === "dark"}
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </IconButton>
        <IconButton aria-label="Notifications" dot>
          <Bell size={15} />
        </IconButton>
        {onOpenBatch && (
          <button
            type="button"
            onClick={onOpenBatch}
            aria-label="Open batch runs"
            title="Run one prompt over many items"
            className="ml-2 flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-[12px] font-medium text-zinc-700 transition hover:border-violet-300 hover:text-violet-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
          >
            <Boxes size={13} />
            Batch
          </button>
        )}
        <Button
          variant="primary"
          size="sm"
          className="ml-2 pr-2.5"
          onClick={handleNewTask}
          disabled={isRunning}
          title={isRunning ? "Another task is already running" : "Start a new task"}
        >
          <Plus size={13} />
          New Task
        </Button>
      </div>
    </header>
  );
}

type LiveTaskLike = {
  id: string;
  title: string;
  status: TaskStatus;
  batchId?: string;
};

function LiveLoopChip({
  followLive,
  liveTask,
  livePhase,
  batchPosition,
  onToggle,
}: {
  followLive: boolean;
  liveTask: LiveTaskLike | null;
  livePhase: TaskStatus | null;
  batchPosition: { index: number; total: number } | null;
  onToggle: () => void;
}) {
  const running = isActiveTaskStatus(liveTask?.status);

  if (!running) {
    return (
      <button
        type="button"
        data-testid="follow-live-chip"
        onClick={onToggle}
        aria-label="Follow live status: idle"
        title="No task is running"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500 transition-colors hover:border-violet-300 hover:text-violet-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-violet-500/50 dark:hover:text-violet-300"
      >
        Idle
      </button>
    );
  }

  if (!followLive) {
    return (
      <button
        type="button"
        data-testid="follow-live-chip"
        onClick={onToggle}
        aria-label="Follow live"
        title="Follow the currently active task"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-violet-700 transition-colors hover:border-violet-400 hover:bg-violet-100 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300 dark:hover:border-violet-400/60 dark:hover:bg-violet-500/15"
      >
        Follow live
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid="follow-live-chip"
      onClick={onToggle}
      aria-label="Turn off Follow live"
      title="Stop following the active task"
      className="flex h-7 min-w-0 max-w-[360px] shrink-0 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 text-[10.5px] font-semibold text-emerald-700 transition-colors hover:border-emerald-400 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:border-emerald-400/60 dark:hover:bg-emerald-500/15"
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-70" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
      <span className="shrink-0 uppercase tracking-wider">LIVE</span>
      <span className="truncate font-medium normal-case tracking-normal">
        — {liveTask?.title ?? "active task"} — {livePhase ? phaseLabel(livePhase) : "active"}
      </span>
      {batchPosition && (
        <span className="shrink-0 border-l border-emerald-300/70 pl-1.5 font-mono text-[9.5px] dark:border-emerald-500/40">
          batch item {batchPosition.index} of {batchPosition.total}
        </span>
      )}
    </button>
  );
}

function isActiveTaskStatus(status: TaskStatus | undefined): boolean {
  return (
    status === "planning" ||
    status === "plan_review" ||
    status === "implementing" ||
    status === "verifying"
  );
}

function phaseLabel(phase: TaskStatus): string {
  switch (phase) {
    case "plan_review":
      return "Plan review";
    case "planning":
      return "Planning";
    case "implementing":
      return "Implementing";
    case "verifying":
      return "Verifying";
    case "draft":
      return "Draft";
    case "done":
      return "Done";
    case "escalated":
      return "Escalated";
    case "cancelled":
      return "Cancelled";
  }
}

function findBatchPosition(
  taskId: string,
  batchId: string | undefined,
  batches: Array<{ id: string; items: Array<{ index: number; taskId?: string }> }>
): { index: number; total: number } | null {
  if (!batchId) return null;
  const batch = batches.find((candidate) => candidate.id === batchId);
  const item = batch?.items.find((candidate) => candidate.taskId === taskId);
  return item && batch ? { index: item.index + 1, total: batch.items.length } : null;
}

/**
 * Maps a TaskStatus to a small colored badge in the top bar.
 * - planning/implementing/verifying → animated spinner, violet
 * - plan_review → waiting, amber (user action needed)
 * - done → success, green
 * - escalated → error, red
 * - cancelled → muted, gray
 */
function PhaseBadge({ phase }: { phase: TaskStatus | null }) {
  if (!phase) return null;
  const config = badgeConfig(phase);
  const Icon = config.icon;
  return (
    <span
      className={cn(
        "flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-semibold uppercase tracking-wider",
        config.cls
      )}
    >
      <Icon size={11} className={config.spin ? "animate-spin" : ""} />
      {config.label}
    </span>
  );
}

function badgeConfig(phase: TaskStatus): {
  label: string;
  icon: React.ElementType;
  cls: string;
  spin: boolean;
} {
  switch (phase) {
    case "draft":
      return { label: "Draft", icon: CircleDashed, cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300", spin: false };
    case "planning":
      return { label: "Planning", icon: Loader2, cls: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300", spin: true };
    case "plan_review":
      return { label: "Awaiting Confirm", icon: CircleDashed, cls: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300", spin: false };
    case "implementing":
      return { label: "Implementing", icon: Loader2, cls: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300", spin: true };
    case "verifying":
      return { label: "Verifying", icon: Loader2, cls: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300", spin: true };
    case "done":
      return { label: "Done", icon: CheckCircle2, cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300", spin: false };
    case "escalated":
      return { label: "Escalated", icon: AlertTriangle, cls: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300", spin: false };
    case "cancelled":
      return { label: "Cancelled", icon: CircleDashed, cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400", spin: false };
  }
}

/**
 * WebSocket connection indicator. Shows in the top bar next to the phase
 * badge so the user knows whether live updates are flowing.
 *   - connecting → amber, "Connecting"
 *   - open → nothing (don't clutter the bar)
 *   - closed → rose, "Reconnecting…"
 *   - idle → nothing
 */
function ConnectionBadge({
  status,
}: {
  status: "idle" | "connecting" | "open" | "closed";
}) {
  if (status === "open" || status === "idle") return null;
  if (status === "connecting") {
    return (
      <span className="flex h-6 items-center gap-1 rounded-md bg-amber-100 px-2 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
        <Wifi size={11} className="animate-pulse" />
        Connecting
      </span>
    );
  }
  // closed
  return (
    <span className="flex h-6 items-center gap-1 rounded-md bg-rose-100 px-2 text-[11px] font-semibold uppercase tracking-wider text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">
      <WifiOff size={11} className="animate-pulse" />
      Reconnecting
    </span>
  );
}

/**
 * Small chip showing which model is driving the current task. Resolves the
 * id against `dynamicModelOptions` (curated + connection-supplied) so we
 * can show the friendly label (e.g. "Claude Sonnet 4.5" rather than
 * "anthropic/claude-sonnet-4.5"). Falls back to the raw ID if the model
 * isn't known — including the case where the user picked a connection model
 * but later deleted the connection.
 */
function ModelBadge({ modelId }: { modelId: string }) {
  const { connections } = useConnectionList();
  const opt = dynamicModelOptions(connections).find(
    (m) => m.id === modelId
  );
  const label = opt?.label ?? modelId;
  return (
    <span
      className="flex h-6 items-center gap-1 rounded-md bg-violet-50 px-2 text-[11px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
      title={modelId}
    >
      <Sparkles size={10} />
      {label}
    </span>
  );
}

function IconButton({
  children,
  active,
  dot,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  dot?: boolean;
}) {
  return (
    <button
      {...props}
      className={`relative grid h-8 w-8 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 ${
        active ? "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100" : ""
      }`}
    >
      {children}
      {dot && (
        <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-rose-500" />
      )}
    </button>
  );
}

/**
 * Threshold for the autonomous /10 score. Mirrors the backend's
 * SCRIPT_LOOP_MIN_SCORE_OUT_OF_10 (orchestrator.ts). Drift guard: a test
 * in the backend pins the boundary at 7/10 — if you change this here,
 * update that constant too.
 */
const SCRIPT_SCORE_THRESHOLD = 7;

/**
 * Colour the score chip. Same threshold family used elsewhere
 * (ProgressNode / WorkflowNode): emerald ≥ 7 = done, amber 5–6 = close,
 * rose < 5 = iterate.
 */
function topbarScoreToneClass(score: number): string {
  if (score >= SCRIPT_SCORE_THRESHOLD) {
    return "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-300 dark:ring-emerald-500/40";
  }
  if (score >= 5) {
    return "bg-amber-100 text-amber-700 ring-1 ring-amber-300 dark:bg-amber-500/20 dark:text-amber-300 dark:ring-amber-500/40";
  }
  return "bg-rose-100 text-rose-700 ring-1 ring-rose-300 dark:bg-rose-500/20 dark:text-rose-300 dark:ring-rose-500/40";
}

/**
 * Live score badge for the TopBar. Sits next to the phase badge so the
 * user sees the streaming /10 score no matter which view they're in
 * (canvas, connections, settings, etc.) — not only when ProgressNode
 * is mounted.
 *
 * Visibility:
 *   - hidden when no score has been produced yet (planning / making
 *     phase, before the verifier writes its criteria walk)
 *   - pulsing during live streaming
 *   - frozen on the final value once the verifier exits (or a verdict
 *     has landed for a prior attempt)
 *
 * Mirrors the same data source the ProgressNode's HeaderScoreBadge
 * reads, so the two stay in lockstep.
 */
function LiveScoreBadge({
  liveScore,
  verdict,
  phase,
}: {
  liveScore: {
    attempt: number;
    passed: number;
    total: number;
    partial: Array<{ criterion: string; passed: boolean; evidence: string }>;
    done: boolean;
  } | null;
  verdict: {
    attempt: number;
    outcome: "APPROVE" | "REJECT" | "ESCALATE_HUMAN";
    criteriaWalk: Array<{ criterion: string; passed: boolean; evidence: string }>;
  } | null;
  phase: TaskStatus | null;
}) {
  // Prefer live (streaming) over final. If neither is present, hide.
  // Don't synthesise a "0/0" chip before the verifier has had a chance
  // to write anything — would be visual noise during planning / making.
  const passed =
    liveScore?.passed ??
    (verdict ? verdict.criteriaWalk.filter((c) => c.passed).length : null);
  const total =
    liveScore?.total ??
    (verdict ? verdict.criteriaWalk.length : null);
  if (passed === null || total === null || total === 0) return null;
  // Don't show during phases that haven't reached the verifier — the
  // score is meaningless before that and clutters the top bar.
  if (
    phase !== "verifying" &&
    phase !== "done" &&
    phase !== "escalated" &&
    liveScore === null &&
    verdict === null
  ) {
    return null;
  }
  const score = Math.max(0, Math.min(10, Math.round((passed * 10) / total)));
  const isLive = liveScore !== null && !liveScore.done;
  return (
    <span
      className={cn(
        "flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold tabular-nums",
        topbarScoreToneClass(score)
      )}
      title={
        isLive
          ? `Live: ${passed}/${total} criteria pass → ${score}/10 (threshold ${SCRIPT_SCORE_THRESHOLD}/10)`
          : `Final: ${passed}/${total} criteria pass → ${score}/10 (threshold ${SCRIPT_SCORE_THRESHOLD}/10)`
      }
    >
      {isLive && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      <Sparkles size={10} className="opacity-70" />
      <span className="font-mono">Score {score}/10</span>
      {isLive && (
        <span className="text-[8.5px] font-normal uppercase tracking-wider opacity-70">
          live
        </span>
      )}
    </span>
  );
}