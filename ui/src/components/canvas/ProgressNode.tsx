import { memo, useMemo, useState } from "react";
import {
  Handle,
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
      return `Doing now: ${activeLiveText(stepId)}`;
    }
    // status === "done"
    if (stepId === "planning") {
      if (!plan) return "Plan ready.";
      return `Planner wrote a ${plan.steps}-step plan touching ${plan.filesToTouch.length} file${plan.filesToTouch.length === 1 ? "" : "s"}.`;
    }
    if (stepId === "plan_review") return "Plan confirmed.";
    if (stepId === "implementation") {
      if (!diff) return "Implementation done.";
      const build = diff.buildExit === 0 ? "passed" : "failed";
      const tests = `${diff.testsPassed}/${diff.testsPassed + diff.testsFailed}`;
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
      const tests = `${verdict.testsPassed}/${verdict.testsPassed + verdict.testsFailed}`;
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
        <PreviewLinkChip url={task?.previewUrl} />
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
  escalationReason,
}: {
  stepId: string;
  status: StepStatus;
  plan: PlanSummary | null;
  diff: DiffSummary | null;
  verdict: Verdict | null;
  escalationReason: string | null;
}) {
  if (status === "active") {
    // Active rows already have the "Doing now:" summary line; no
    // additional rows needed.
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
          value={diff.buildExit === 0 ? "✓ pass" : "✗ fail"}
        />
        <Row
          label="Tests"
          value={`${diff.testsPassed}/${diff.testsPassed + diff.testsFailed}`}
        />
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