import { memo, useMemo, useState } from "react";
import {
  Handle,
  NodeResizer,
  Position,
  type NodeProps,
} from "@xyflow/react";
import {
  ChevronLeft,
  CheckCircle2,
  Loader2,
  Compass,
  UserCheck,
  Wrench,
  ShieldCheck,
  Sparkles,
  AlertTriangle,
  CircleDashed,
  ArrowLeft,
  Circle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkflow } from "@/lib/store";
import type { RunStatus } from "@/data/workflow";
import type {
  DiffSummary,
  LogEntry,
  PlanSummary,
  TaskStatus,
  Verdict,
} from "@/types/loop";
import { PreviewLinkChip } from "@/components/PreviewLinkChip";
import { RuntimeCheckPanel } from "@/components/RuntimeCheckPanel";
import { AttemptTimeline } from "@/components/AttemptTimeline";

interface ProgressNodeData extends Record<string, unknown> {
  spec: {
    id: string;
    kind: string;
    title: string;
    subtitle?: string;
    iconName: string;
  };
  icon: LucideIcon;
  status: RunStatus;
}

type StepStatus = "done" | "active" | "waiting" | "error";

interface StepDef {
  id: string;
  index: number;
  label: string;
  description: string;
  icon: LucideIcon;
}

const STEPS: StepDef[] = [
  {
    id: "planning",
    index: 1,
    label: "Planning",
    description: "Planner explores the codebase and writes GOAL.md.",
    icon: Compass,
  },
  {
    id: "plan_review",
    index: 2,
    label: "Plan review",
    description: "Confirm or adjust the plan before implementation.",
    icon: UserCheck,
  },
  {
    id: "implementation",
    index: 3,
    label: "Implementation",
    description: "Maker writes the code and runs the build + tests.",
    icon: Wrench,
  },
  {
    id: "verification",
    index: 4,
    label: "Verification",
    description: "Verifier re-runs tests and returns APPROVE/REJECT.",
    icon: ShieldCheck,
  },
];

/**
 * Loop progress node on the canvas. Mirrors Image 2 / Image 3:
 *   - numbered step list (Planning → Plan review → Implementation → Verification)
 *   - green checkmark for done, green ring + index for active, gray for waiting
 *   - active step gets a continuous green left-border line (the
 *     "green line" connecting previous done step to the active one)
 *   - each step has a one-line summary of what it did; the active
 *     step shows a live "Doing now:" line tailing the latest log
 *     entry for its phase
 *   - expanded details (plan criteria, diff stats, verdict stats)
 *     live inline below each step — no click-to-expand required
 *   - the whole thing lights up the moment the loop starts
 *
 * Compact enough to fit inside RICH_NODE_HEIGHT (280) without
 * scrolling for the common case (planning / plan review); bigger
 * tasks add scroll via `overflow-y-auto`.
 */
function ProgressNodeImpl({ data, selected }: NodeProps) {
  const Icon = (data.icon as LucideIcon) ?? Sparkles;
  const spec = data.spec as ProgressNodeData["spec"];
  const phase = useWorkflow((s) => s.phase);
  const task = useWorkflow((s) => s.taskMirror);
  const plan = useWorkflow((s) => s.plan);
  const diff = useWorkflow((s) => s.diff);
  const verdict = useWorkflow((s) => s.verdict);
  const liveScore = useWorkflow((s) => s.liveScore);
  const escalationReason = useWorkflow((s) => s.escalationReason);
  const doneSummary = useWorkflow((s) => s.doneSummary);
  const isRunning = useWorkflow((s) => s.isRunning);
  const logs = useWorkflow((s) => s.logs);

  // Map backend phase → active step id. We collapse "done" and
  // "escalated" to verification so the last step lights up.
  const activeStep = useMemo(() => {
    if (!phase || phase === "draft" || phase === "cancelled") return null;
    if (phase === "done" || phase === "escalated") return "verification";
    return phase;
  }, [phase]);

  const stepStatus = (stepId: string): StepStatus => {
    if (phase === "done") return "done";
    if (phase === "escalated") {
      const order = STEPS.map((s) => s.id);
      const thisIdx = order.indexOf(stepId);
      const escIdx = order.indexOf("verification");
      if (thisIdx < escIdx) return "done";
      if (thisIdx === escIdx) return "error";
      return "waiting";
    }
    if (!activeStep) return "waiting";
    const order = STEPS.map((s) => s.id);
    const activeIdx = order.indexOf(activeStep);
    const thisIdx = order.indexOf(stepId);
    if (thisIdx < activeIdx) return "done";
    if (thisIdx === activeIdx) return "active";
    return "waiting";
  };

  // "Doing now:" text for the active step — pulls the most recent
  // log entry from that phase's agent. If no per-phase log exists,
  // fall back to the very latest log entry overall.
  const latestLog = useMemo(() => {
    if (!logs || logs.length === 0) return null;
    return logs[logs.length - 1];
  }, [logs]);

  // Most recent LLM latency line for the active phase's agent — the
  // backend emits `[<agent>] LLM OK in Nms, ...` after every LLM call.
  // Surfaced on the active step so the user can see it's LLM latency,
  // not a hang, when a step is in the long part of its work.
  function latestLatencyMsForStep(stepId: string): number | null {
    const phaseAgent = phaseAgentFor(stepId);
    if (!phaseAgent) return null;
    const re = new RegExp(
      `\\[${phaseAgent}\\]\\s+LLM\\s+OK\\s+in\\s+(\\d+)ms`
    );
    for (let i = logs.length - 1; i >= Math.max(0, logs.length - 50); i--) {
      const m = logs[i].text?.match(re);
      if (m) return Number(m[1]);
    }
    return null;
  }
  function formatLatency(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function activeLiveText(stepId: string): string {
    const phaseAgent = phaseAgentFor(stepId);
    const recentForPhase = phaseAgent
      ? [...logs].reverse().find((l) => l.agent === phaseAgent)
      : undefined;
    const text = recentForPhase?.text ?? latestLog?.text;
    if (!text) return "In progress…";
    return truncate(text.replace(/\s+/g, " ").trim(), 120);
  }

  // Synthesized one-line summary per step + status:
  //   done   → "Planner wrote a 3-step plan touching 2 files."
  //   active → "Doing now: <latest log line>"
  //   waiting → "Waiting for earlier steps to finish."
  //   error  → escalation reason
  function stepSummary(stepId: string, status: StepStatus): string {
    if (status === "waiting") return "Waiting for earlier steps to finish.";
    if (status === "error") {
      return escalationReason ?? "Failed.";
    }
    if (status === "active") {
      // Active step summary — "Doing now: <latest log>". When the most
      // recent LLM call latency is known for this phase's agent, append
      // it so the user can tell "model is thinking" from "the loop is
      // hung". On the planning step, also surface the retry counter
      // (1/3, 2/3) — the planner is the phase that goes through
      // re-prompts most often, and the user has no other way to see
      // that progress.
      const baseText = `Doing now: ${activeLiveText(stepId)}`;
      const ms = latestLatencyMsForStep(stepId);
      const parts: string[] = [baseText];
      if (ms !== null) parts.push(`last call ${formatLatency(ms)}`);
      if (stepId === "planning" && task && task.attempt > 0) {
        const max = task.maxAttempts ?? 3;
        parts.push(`attempt ${task.attempt + 1}/${max}`);
      }
      return parts.join(" · ");
    }
    // status === "done"
    if (stepId === "planning") {
      if (!plan) return "Plan ready.";
      return `Planner wrote a ${plan.steps}-step plan touching ${plan.filesToTouch.length} file${plan.filesToTouch.length === 1 ? "" : "s"}.`;
    }
    if (stepId === "plan_review") return "Plan confirmed.";
    if (stepId === "implementation") {
      if (!diff) return "Implementation done.";
      const build =
        diff.buildExit == null ? "n/a" : diff.buildExit === 0 ? "passed" : "failed";
      const testTotal = diff.testsPassed + diff.testsFailed;
      const tests = testTotal === 0 ? "n/a" : `${diff.testsPassed}/${testTotal}`;
      return `Maker changed ${diff.filesChanged.length} file${diff.filesChanged.length === 1 ? "" : "s"} (build ${build}, tests ${tests}).`;
    }
    if (stepId === "verification") {
      if (!verdict) return "Verification done.";
      const outcome =
        verdict.outcome === "APPROVE"
          ? "approved"
          : verdict.outcome === "REJECT"
          ? "rejected"
          : "escalated";
      const vTotal = verdict.testsPassed + verdict.testsFailed;
      const tests = vTotal === 0 ? "n/a" : `${verdict.testsPassed}/${vTotal}`;
      return `Verifier ${outcome} the change (tests ${tests}, risk ${verdict.risk}).`;
    }
    return "";
  }

  const headerLabel = task?.title ?? "Loop progress";
  const headerStatus: string = useMemo(() => {
    switch (phase) {
      case "done":
        return "Complete";
      case "escalated":
        return "Escalated";
      case "cancelled":
        return "Cancelled";
      case "planning":
        return "Planning";
      case "plan_review":
        return "Plan review";
      case "implementing":
        return "Implementing";
      case "verifying":
        return "Verifying";
      default:
        return isRunning ? "Running" : "Idle";
    }
  }, [phase, isRunning]);

  /**
   * Same React Flow interaction-escape pattern as the chatbot node —
   * stop mouse / touch events from being captured by the node's drag
   * handler so step row interactions work.
   */
  const stopReactFlowPointer = (e: React.SyntheticEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden rounded-2xl border bg-white shadow-card transition-shadow dark:bg-zinc-900",
        selected
          ? "border-emerald-400 ring-2 ring-emerald-400/30 dark:border-emerald-500 dark:ring-emerald-500/30"
          : "border-zinc-200 dark:border-zinc-800"
      )}
    >
      {/* Drag-to-resize handles on all 4 corners/edges, visible only
          when the node is selected — lets users grow the node when
          AttemptTimeline content is tall, or shrink it back down. */}
      <NodeResizer
        isVisible={selected}
        minWidth={320}
        minHeight={200}
        maxWidth={900}
        maxHeight={1000}
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border !border-emerald-500 !bg-white dark:!bg-zinc-900"
        lineClassName="!border-emerald-400/60"
      />

      {/* React Flow handles — left/right. The wire from the
          orchestrator enters here. */}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-zinc-300 dark:!border-zinc-900"
      />
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-emerald-500 dark:!border-zinc-900"
      />

      {/* Header — mirrors Image 2/3. Task title (or generic label) on
          the left, status pill on the right. This is the only drag
          handle so the step rows inside don't fight React Flow. */}
      <div className="nodrag flex cursor-move items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="grid h-5 w-5 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Back"
        >
          <ChevronLeft size={12} />
        </button>
        <div className="grid h-5 w-5 place-items-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
          <Icon size={10} strokeWidth={2.4} />
        </div>
        <span
          className="truncate text-[12px] font-semibold text-zinc-800 dark:text-zinc-100"
          title={task?.title ?? "Loop progress"}
        >
          {headerLabel}
        </span>
        <span
          className={cn(
            "ml-1 rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider",
            phase === "done"
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
              : phase === "escalated"
              ? "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
              : isRunning
              ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
          )}
        >
          {headerStatus}
        </span>
        <HeaderScoreBadge liveScore={liveScore} verdict={verdict} />
        <PreviewLinkChip url={task?.previewUrl} />
        <RuntimeCheckPanel task={task} />
      </div>

      {/* Step list — Image 2/3's numbered, always-expanded rows.
          Wrapped in `nodrag nopan` so React Flow doesn't capture the
          clicks. Each row shows its short summary inline + the
          per-step expanded details. The active step carries the
          green left-border line that the brief asks for. */}
      <div
        className="nodrag nopan max-h-[calc(100%-44px)] space-y-1 overflow-y-auto px-1.5 py-1.5"
        onPointerDown={stopReactFlowPointer}
        onMouseDown={stopReactFlowPointer}
        onTouchStart={stopReactFlowPointer}
        onClick={stopReactFlowPointer}
      >
        {STEPS.map((step) => {
          const s = stepStatus(step.id);
          const StepIcon = step.icon;
          const summary = stepSummary(step.id, s);
          return (
            <div
              key={step.id}
              className={cn(
                "rounded-lg px-1.5 py-1.5",
                // The "green line" — a 2px emerald left border on the
                // active step. Image 3 shows this as a continuous
                // vertical bar; we approximate with border-l-2 +
                // emerald tint background.
                s === "active" &&
                  "border-l-2 border-emerald-500 bg-emerald-50/70 pl-2 dark:bg-emerald-500/10"
              )}
            >
              <div className="flex items-start gap-2">
                <StepBadge status={s} index={step.index} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <StepIcon
                      size={11}
                      className={cn(
                        s === "done" && "text-emerald-600",
                        s === "active" && "text-emerald-600",
                        s === "error" && "text-rose-500",
                        s === "waiting" && "text-zinc-400"
                      )}
                    />
                    <span
                      className={cn(
                        "truncate text-[12px] font-semibold",
                        s === "done" && "text-zinc-700 dark:text-zinc-200",
                        s === "active" &&
                          "text-emerald-700 dark:text-emerald-300",
                        s === "error" &&
                          "text-rose-700 dark:text-rose-300",
                        s === "waiting" &&
                          "text-zinc-500 dark:text-zinc-400"
                      )}
                    >
                      {step.label}
                    </span>
                    {s === "active" && (
                      <Loader2
                        size={10}
                        className="ml-auto shrink-0 animate-spin text-emerald-500"
                      />
                    )}
                  </div>
                  <p
                    className={cn(
                      "mt-0.5 text-[10.5px] leading-snug",
                      s === "done" && "text-zinc-600 dark:text-zinc-300",
                      s === "active" &&
                        "text-emerald-700 dark:text-emerald-300",
                      s === "error" &&
                        "text-rose-700 dark:text-rose-300",
                      s === "waiting" &&
                        "text-zinc-400 dark:text-zinc-500"
                    )}
                    title={summary}
                  >
                    {summary}
                  </p>
                  {/* Per-step expanded details — kept inline (no click
                      needed). Plan criteria, diff stats, verdict
                      stats, etc. Show only when status is done / error /
                      active; waiting rows just show the summary. */}
                  {(s === "done" || s === "active" || s === "error") && (
                    <StepDetail
                      stepId={step.id}
                      status={s}
                      plan={plan}
                      diff={diff}
                      verdict={verdict}
                      liveScore={liveScore}
                      escalationReason={escalationReason}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* Terminal state footer — done or escalated. */}
        {(phase === "done" || phase === "escalated") && (
          <div className="mt-1 border-t border-zinc-100 px-1.5 py-2 dark:border-zinc-800">
            <FinalState
              phase={phase}
              doneSummary={doneSummary}
              escalationReason={escalationReason}
            />
          </div>
        )}

        {!phase && (
          <p className="px-3 py-6 text-center text-[11px] text-zinc-400">
            No task running. Start one from the chatbot.
          </p>
        )}

        {/* Full-width block, not a header chip — was mistakenly mounted
            in the single-line header flex row, which pushed its content
            off the right edge of the node. Scrolls with the step list. */}
        <AttemptTimeline task={task} />
      </div>
    </div>
  );
}

/**
 * Numbered badge — matches Image 2/3.
 *   done   = green filled circle with white check
 *   active = white circle with green ring + index number
 *   error  = white circle with rose ring + !
 *   waiting = white circle with gray ring + index number
 */
function StepBadge({ status, index }: { status: StepStatus; index: number }) {
  if (status === "done") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
        <CheckCircle2 size={11} strokeWidth={2.5} />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-emerald-500 bg-white text-[10px] font-bold text-emerald-700 dark:bg-zinc-900 dark:text-emerald-300">
        {index}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-rose-400 bg-white text-rose-600 dark:bg-zinc-900">
        <AlertTriangle size={10} />
      </span>
    );
  }
  return (
    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-zinc-300 bg-white text-[10px] font-semibold text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
      {index}
    </span>
  );
}

/**
 * Inline detail rows for each step. The user wanted summaries always
 * visible (no click-to-expand), but the actual numbers — file counts,
 * build pass/fail, test counts, verdict outcome — are useful too and
 * fit naturally under the summary line.
 */
function StepDetail({
  stepId,
  status,
  plan,
  diff,
  verdict,
  liveScore,
  escalationReason,
}: {
  stepId: string;
  status: StepStatus;
  plan: PlanSummary | null;
  diff: DiffSummary | null;
  verdict: Verdict | null;
  liveScore: {
    attempt: number;
    passed: number;
    total: number;
    partial: Array<{ criterion: string; passed: boolean; evidence: string }>;
    done: boolean;
  } | null;
  escalationReason: string | null;
}) {
  if (status === "active") {
    // Active rows already have the "Doing now:" summary line. The one
    // exception: the verification step gets a live X/Y PASS counter
    // because the verifier streams its response into STATE.md and we
    // can render the running score in real time. This is the
    // "real-time live score in the verifier node" the user asked for.
    if (stepId === "verification" && liveScore && liveScore.total > 0) {
      return <LiveScoreCard liveScore={liveScore} />;
    }
    return null;
  }
  if (status === "error") {
    return (
      <p className="mt-0.5 flex items-start gap-1 text-[10.5px] text-rose-700 dark:text-rose-300">
        <AlertTriangle size={9} className="mt-0.5 shrink-0" />
        <span className="line-clamp-3">
          {escalationReason ?? "Failed."}
        </span>
      </p>
    );
  }
  // status === "done"
  if (stepId === "planning") {
    if (!plan) return null;
    return (
      <ul className="mt-1 space-y-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
        {plan.criteria.length > 0 && (
          <Row
            label="Criteria"
            value={String(plan.criteria.length)}
          />
        )}
        {plan.risks.length > 0 && (
          <Row label="Risks" value={String(plan.risks.length)} />
        )}
        {plan.filesToTouch.length > 0 && (
          <Row
            label="Files"
            value={String(plan.filesToTouch.length)}
          />
        )}
      </ul>
    );
  }
  if (stepId === "implementation") {
    if (!diff) return null;
    return (
      <ul className="mt-1 space-y-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
        <Row
          label="Build"
          value={diff.buildExit == null ? "n/a" : diff.buildExit === 0 ? "✓ pass" : "✗ fail"}
        />
        <Row
          label="Tests"
          value={
            diff.testsPassed + diff.testsFailed === 0
              ? "n/a"
              : `${diff.testsPassed}/${diff.testsPassed + diff.testsFailed}`
          }
        />
        {diff.filesChanged.length > 0 && (
          <li className="mt-1 space-y-0.5">
            {diff.filesChanged.map((f, i) => (
              <div
                key={i}
                className="font-mono text-zinc-500 dark:text-zinc-400"
                style={{ fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={f.reason}
              >
                {f.path}
              </div>
            ))}
          </li>
        )}
      </ul>
    );
  }
  if (stepId === "verification") {
    if (!verdict) return null;
    return (
      <ul className="mt-1 space-y-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
        <Row
          label="Outcome"
          value={
            verdict.outcome === "APPROVE"
              ? "✓ Approve"
              : verdict.outcome === "REJECT"
              ? "✗ Reject"
              : "! Escalate"
          }
        />
        <Row label="Risk" value={verdict.risk} />
        {typeof verdict.score === "number" && (
          <Row label="Score" value={`${verdict.score}/100`} />
        )}
        {verdict.criteriaWalk.length > 0 && (
          <li className="mt-1 space-y-0.5">
            {verdict.criteriaWalk.map((c, i) => (
              <div
                key={i}
                style={{ display: "flex", gap: 4, alignItems: "flex-start", fontSize: 10 }}
                title={c.evidence}
              >
                <span style={{ color: c.passed ? "#3fb950" : "#f85149", flexShrink: 0 }}>
                  {c.passed ? "✓" : "✗"}
                </span>
                <span className="text-zinc-500 dark:text-zinc-400" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.criterion}
                </span>
              </div>
            ))}
          </li>
        )}
      </ul>
    );
  }
  return null;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between">
      <span>{label}</span>
      <span className="font-mono text-zinc-600 dark:text-zinc-300">
        {value}
      </span>
    </li>
  );
}

/**
 * Live verifier scorecard — renders the streaming `**Criteria walk:**`
 * as the LLM emits it. Mirrors the shape of the post-verdict details
 * so the transition to "done" is seamless. The "live" cue is a small
 * pulsing dot + the "LIVE" label so the user knows the numbers will
 * keep updating.
 */
/**
 * Convert a (passed, total) pair from the criteria walk into the
 * 0–10 scale the script-loop surfaces. Matches the orchestrator's
 * `scaleScoreOutOf10` so backend + UI agree on the number.
 */
function scoreOutOf10(passed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(10, Math.round((passed * 10) / total)));
}

/** Threshold below which the script auto-iterates. Mirrors
 *  SCRIPT_LOOP_MIN_SCORE_OUT_OF_10 in orchestrator.ts. */
const SCRIPT_SCORE_THRESHOLD = 7;

/**
 * Color a 0–10 score the same way the orchestrator decides to ship
 * or iterate: red < 5 (clearly not done), amber 5–6 (close, keep going),
 * emerald >= 7 (good enough — done).
 */
function scoreToneClass(score: number): string {
  if (score >= SCRIPT_SCORE_THRESHOLD) {
    return "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-300 dark:ring-emerald-500/40";
  }
  if (score >= 5) {
    return "bg-amber-100 text-amber-700 ring-1 ring-amber-300 dark:bg-amber-500/20 dark:text-amber-300 dark:ring-amber-500/40";
  }
  return "bg-rose-100 text-rose-700 ring-1 ring-rose-300 dark:bg-rose-500/20 dark:text-rose-300 dark:ring-rose-500/40";
}

/**
 * Score badge pinned to the ProgressNode header. Shows the live /10
 * score while the verifier is streaming, the final /10 score after
 * the verdict, and disappears when there's nothing to display (no
 * attempt has been graded yet). Pulses while the score is live so
 * the user can tell at a glance that the loop is still working.
 */
function HeaderScoreBadge({
  liveScore,
  verdict,
}: {
  liveScore: {
    attempt: number;
    passed: number;
    total: number;
    partial: Array<{ criterion: string; passed: boolean; evidence: string }>;
    done: boolean;
  } | null;
  verdict: Verdict | null;
}) {
  // Prefer the live score if present; fall back to the final verdict.
  const passed = liveScore?.passed ?? (verdict ? verdict.criteriaWalk.filter((c) => c.passed).length : null);
  const total = liveScore?.total ?? (verdict ? verdict.criteriaWalk.length : null);
  if (passed === null || total === null || total === 0) return null;
  const score = scoreOutOf10(passed, total);
  const isLive = liveScore !== null && !liveScore.done;
  const isFinal = liveScore?.done === true || (verdict && liveScore === null);
  return (
    <span
      className={cn(
        "ml-auto inline-flex items-center gap-1 rounded-full px-2 py-px text-[10px] font-semibold tabular-nums",
        scoreToneClass(score)
      )}
      title={
        isLive
          ? `Streaming: ${passed}/${total} criteria pass → ${score}/10 (threshold ${SCRIPT_SCORE_THRESHOLD}/10)`
          : `${passed}/${total} criteria pass → ${score}/10 (threshold ${SCRIPT_SCORE_THRESHOLD}/10)`
      }
    >
      {isLive && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      <span className="font-mono">
        Score {score}/10
      </span>
      {isLive && !isFinal && (
        <span className="text-[8.5px] font-normal uppercase tracking-wider opacity-70">
          live
        </span>
      )}
    </span>
  );
}

function LiveScoreCard({
  liveScore,
}: {
  liveScore: {
    attempt: number;
    passed: number;
    total: number;
    partial: Array<{ criterion: string; passed: boolean; evidence: string }>;
    done: boolean;
  };
}) {
  const failed = liveScore.partial.filter((c) => !c.passed).length;
  const score = scoreOutOf10(liveScore.passed, liveScore.total);
  const isFinal = liveScore.done;
  const aboveThreshold = score >= SCRIPT_SCORE_THRESHOLD;
  return (
    <div
      className={cn(
        "mt-1 rounded-md border p-1.5",
        aboveThreshold
          ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-800/60 dark:bg-emerald-950/30"
          : score >= 5
          ? "border-amber-200 bg-amber-50/60 dark:border-amber-800/60 dark:bg-amber-950/30"
          : "border-rose-200 bg-rose-50/60 dark:border-rose-800/60 dark:bg-rose-950/30"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-1.5 w-1.5">
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
                aboveThreshold
                  ? "bg-emerald-400"
                  : score >= 5
                  ? "bg-amber-400"
                  : "bg-rose-400"
              )}
            />
            <span
              className={cn(
                "relative inline-flex h-1.5 w-1.5 rounded-full",
                aboveThreshold
                  ? "bg-emerald-500"
                  : score >= 5
                  ? "bg-amber-500"
                  : "bg-rose-500"
              )}
            />
          </span>
          <span
            className={cn(
              "text-[9.5px] font-semibold uppercase tracking-wider",
              aboveThreshold
                ? "text-emerald-700 dark:text-emerald-300"
                : score >= 5
                ? "text-amber-700 dark:text-amber-300"
                : "text-rose-700 dark:text-rose-300"
            )}
          >
            {isFinal ? "Final" : "Live"}
          </span>
          <span className="text-[9.5px] text-zinc-500 dark:text-zinc-400">
            attempt {liveScore.attempt}
          </span>
        </div>
        <div className="flex items-baseline gap-1">
          <span
            className={cn(
              "font-mono text-[15px] font-bold tabular-nums",
              aboveThreshold
                ? "text-emerald-700 dark:text-emerald-300"
                : score >= 5
                ? "text-amber-700 dark:text-amber-300"
                : "text-rose-700 dark:text-rose-300"
            )}
            title={`${liveScore.passed}/${liveScore.total} criteria pass; threshold ${SCRIPT_SCORE_THRESHOLD}/10`}
          >
            {score}
            <span className="text-[10px] font-normal text-zinc-400">/10</span>
          </span>
          {!isFinal && !aboveThreshold && (
            <span className="text-[9px] text-zinc-500 dark:text-zinc-400">
              need {SCRIPT_SCORE_THRESHOLD - score}
            </span>
          )}
          {isFinal && aboveThreshold && (
            <span className="text-[9px] font-semibold uppercase text-emerald-700 dark:text-emerald-300">
              ✓ done
            </span>
          )}
        </div>
      </div>
      {liveScore.partial.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {liveScore.partial.map((c, i) => (
            <li
              key={i}
              className="flex items-start gap-1 text-[10px]"
              title={c.evidence}
            >
              <span
                className="shrink-0 font-mono"
                style={{ color: c.passed ? "#3fb950" : "#f85149" }}
              >
                {c.passed ? "✓" : "✗"}
              </span>
              <span
                className="text-zinc-600 dark:text-zinc-300"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.criterion}
              </span>
            </li>
          ))}
        </ul>
      )}
      {failed > 0 && !isFinal && (
        <p className="mt-1 text-[9px] text-zinc-500 dark:text-zinc-400">
          {failed} failing · loop will auto-iterate when below {SCRIPT_SCORE_THRESHOLD}/10
        </p>
      )}
    </div>
  );
}

function FinalState({
  phase,
  doneSummary,
  escalationReason,
}: {
  phase: TaskStatus | null;
  doneSummary: string | null;
  escalationReason: string | null;
}) {
  if (phase === "done") {
    return (
      <div className="flex items-start gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 size={11} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">Task complete</p>
          {doneSummary && (
            <p className="mt-0.5 text-[10.5px] text-zinc-500 dark:text-zinc-400">
              {doneSummary}
            </p>
          )}
        </div>
      </div>
    );
  }
  if (phase === "escalated") {
    return (
      <div className="flex items-start gap-1.5 text-[11px] text-rose-700 dark:text-rose-300">
        <AlertTriangle size={11} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">Escalated</p>
          {escalationReason && (
            <p className="mt-0.5 line-clamp-3 text-[10.5px] text-zinc-500 dark:text-zinc-400">
              {escalationReason}
            </p>
          )}
        </div>
      </div>
    );
  }
  return null;
}

function phaseAgentFor(stepId: string): LogEntry["agent"] | null {
  if (stepId === "planning") return "planner";
  if (stepId === "plan_review") return "orchestrator";
  if (stepId === "implementation") return "maker";
  if (stepId === "verification") return "verifier";
  return null;
}

function truncate(s: string, n: number) {
  if (!s) return s;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Keep imports used so tree-shaking doesn't drop them if a future
// refactor wants them. Circle and CircleDashed are referenced in
// alternative visual styles we may want later.
void Circle;
void CircleDashed;
void ArrowLeft;

export const ProgressNode = memo(ProgressNodeImpl);