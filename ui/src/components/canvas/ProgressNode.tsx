import { memo, useMemo } from "react";
import {
  Handle,
  NodeResizeControl,
  NodeResizer,
  Position,
  type NodeProps,
} from "@xyflow/react";
import {
  AlertTriangle,
  Check,
  Compass,
  FileCode2,
  Loader2,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkflow } from "@/lib/store";
import type { RunStatus } from "@/data/workflow";
import type {
  AttemptRecord,
  DiffSummary,
  LogEntry,
  PlanSummary,
  Task,
  TaskStatus,
  Verdict,
} from "@/types/loop";
import { AttemptTimeline } from "@/components/AttemptTimeline";

interface ProgressNodeData extends Record<string, unknown> {
  spec: { id: string; kind: string; title: string; subtitle?: string; iconName: string };
  icon: LucideIcon;
  status: RunStatus;
}

type StepStatus = "done" | "active" | "waiting" | "error";
type StepId = "planning" | "plan_review" | "implementation" | "verification";

interface LiveScore {
  attempt: number;
  passed: number;
  total: number;
  partial: Array<{ criterion: string; passed: boolean; evidence: string }>;
  done: boolean;
}

const STEPS: { id: StepId; label: string; role: string; icon: LucideIcon; waiting: string }[] = [
  { id: "planning", label: "Plan", role: "planner", icon: Compass, waiting: "Turns the request into acceptance criteria and a file allowlist." },
  { id: "plan_review", label: "Review plan", role: "gate", icon: UserCheck, waiting: "Plan is approved before any file is written." },
  { id: "implementation", label: "Implement", role: "maker", icon: Wrench, waiting: "Maker writes only the files the plan allows." },
  { id: "verification", label: "Verify", role: "verifier", icon: ShieldCheck, waiting: "An independent verifier checks every criterion." },
];

/**
 * Loop progress card on the canvas: a vertical timeline of the four loop
 * phases. Each phase shows who did it (role tag), how long it took, and the
 * concrete artifacts — criteria, allowed files, files written, the
 * verifier's evidence per criterion — so a viewer can follow exactly what
 * happened and why the loop decided what it did. Resizable from the corner
 * grip at any time (all edges when selected).
 */
function ProgressNodeImpl({ data, selected }: NodeProps) {
  const spec = data.spec as ProgressNodeData["spec"];
  void spec;
  const phase = useWorkflow((s) => s.phase);
  const task = useWorkflow((s) => s.taskMirror);
  const plan = useWorkflow((s) => s.plan);
  const diff = useWorkflow((s) => s.diff);
  const verdict = useWorkflow((s) => s.verdict);
  const liveScore = useWorkflow((s) => s.liveScore) as LiveScore | null;
  const escalationReason = useWorkflow((s) => s.escalationReason);
  const isRunning = useWorkflow((s) => s.isRunning);
  const logs = useWorkflow((s) => s.logs);

  const effectivePhase = phase ?? task?.status ?? null;
  const running = isRunning || isActiveTaskStatus(effectivePhase);
  const escReason = escalationReason ?? task?.escalationReason ?? null;
  const lastAttempt: AttemptRecord | undefined = task?.attempts?.[task.attempts.length - 1];

  const activeStep: StepId | null = useMemo(() => {
    if (!effectivePhase || effectivePhase === "draft" || effectivePhase === "cancelled") return null;
    if (effectivePhase === "done" || effectivePhase === "escalated" || effectivePhase === "verifying") return "verification";
    if (effectivePhase === "implementing") return "implementation";
    return effectivePhase as StepId;
  }, [effectivePhase]);

  const order = STEPS.map((s) => s.id);
  const stepStatus = (id: StepId): StepStatus => {
    if (effectivePhase === "done") return "done";
    if (!activeStep) return "waiting";
    const a = order.indexOf(activeStep);
    const i = order.indexOf(id);
    if (i < a) return "done";
    if (i === a) return effectivePhase === "escalated" ? "error" : "active";
    return "waiting";
  };

  const latencyMs = (role: string): number | null => {
    const re = new RegExp(`\\[${role}\\]\\s+LLM\\s+OK\\s+in\\s+(\\d+)ms`);
    for (let i = logs.length - 1; i >= Math.max(0, logs.length - 80); i--) {
      const m = logs[i].text?.match(re);
      if (m) return Number(m[1]);
    }
    return null;
  };
  const durationFor = (id: StepId): number | null => {
    if (id === "planning") return latencyMs("planner");
    if (id === "implementation") return lastAttempt?.makerMs ?? latencyMs("maker");
    if (id === "verification") return lastAttempt?.verifierMs ?? latencyMs("verifier");
    return null;
  };
  const liveLine = (id: StepId): string => {
    const agent = phaseAgentFor(id);
    const recent = agent ? [...logs].reverse().find((l) => l.agent === agent) : undefined;
    const text = recent?.text?.replace(/\s+/g, " ").trim();
    return text ? truncate(text, 110) : phaseActivityLine(id, task);
  };

  const totalMs =
    task && (effectivePhase === "done" || effectivePhase === "escalated")
      ? Date.parse(task.updatedAt) - Date.parse(task.createdAt)
      : null;
  const modelLabel = shortModel(task?.model);
  const attemptLabel = task && task.attempt > 0 ? `attempt ${task.attempt}/${task.maxAttempts ?? 3}` : null;

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden rounded-xl border bg-white shadow-card dark:bg-zinc-950",
        selected ? "border-violet-400/70 ring-1 ring-violet-400/30" : "border-zinc-200 dark:border-zinc-800"
      )}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={340}
        minHeight={220}
        maxWidth={960}
        maxHeight={1400}
        handleClassName="!h-2 !w-2 !rounded-sm !border !border-violet-400 !bg-white dark:!bg-zinc-900"
        lineClassName="!border-violet-400/40"
      />
      {/* Always-available corner grip: drag to resize without selecting first. */}
      <NodeResizeControl
        position="bottom-right"
        minWidth={340}
        minHeight={220}
        maxWidth={960}
        maxHeight={1400}
        style={{ background: "transparent", border: "none", zIndex: 20 }}
      >
        <span
          className="absolute -bottom-0.5 -right-0.5 block h-4 w-4 cursor-nwse-resize text-zinc-400 hover:text-violet-400 dark:text-zinc-600"
          title="Drag to resize"
          aria-label="Resize card"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M13 7 7 13M13 10.5 10.5 13" />
          </svg>
        </span>
      </NodeResizeControl>

      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-zinc-400 dark:!border-zinc-950" />
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-white !bg-emerald-500 dark:!border-zinc-950" />

      {/* Header — same chip language as the top bar. */}
      <div className="shrink-0 cursor-move border-b border-zinc-200 px-3.5 pb-2.5 pt-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-gradient-to-br from-violet-400 to-violet-700 text-white">
            <Sparkles size={12} strokeWidth={2.4} />
          </div>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100" title={task?.title}>
            {task?.title ?? "Loop progress"}
          </span>
          <StatusChip phase={effectivePhase} running={running} />
          <ScoreChip liveScore={liveScore} verdict={verdict} />
        </div>
        {(modelLabel || attemptLabel || totalMs) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-8 text-[10.5px] text-zinc-500 dark:text-zinc-400">
            {modelLabel && (
              <span className="rounded-md bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
                {modelLabel}
              </span>
            )}
            {attemptLabel && <span className="font-mono">{attemptLabel}</span>}
            {totalMs !== null && totalMs > 0 && <span className="font-mono">· {formatMs(totalMs)} total</span>}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div
        className="nodrag nopan nowheel min-h-0 flex-1 overflow-y-auto px-3.5 py-3"
        onPointerDown={stop}
        onMouseDown={stop}
        onTouchStart={stop}
        onClick={stop}
      >
        {!effectivePhase ? (
          <p className="py-8 text-center text-[11.5px] text-zinc-500">No task running. Start one from the chat or a Batch.</p>
        ) : (
          <ol className="relative">
            {STEPS.map((step, idx) => {
              const s = stepStatus(step.id);
              const ms = s === "done" || s === "error" ? durationFor(step.id) : null;
              return (
                <li key={step.id} className="relative flex gap-3 pb-4 last:pb-1">
                  {idx < STEPS.length - 1 && (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute left-[9px] top-6 h-[calc(100%-20px)] w-px",
                        s === "done" ? "bg-emerald-500/50" : "bg-zinc-200 dark:bg-zinc-800"
                      )}
                    />
                  )}
                  <Dot status={s} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "text-[12.5px] font-semibold",
                          s === "waiting" ? "text-zinc-400 dark:text-zinc-500" : "text-zinc-900 dark:text-zinc-100"
                        )}
                      >
                        {step.label}
                      </span>
                      <span className="rounded-md border border-zinc-200 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
                        {step.role}
                      </span>
                      {ms !== null && (
                        <span className="ml-auto font-mono text-[10.5px] tabular-nums text-zinc-500">{formatMs(ms)}</span>
                      )}
                      {s === "active" && <Loader2 size={12} className="ml-auto animate-spin text-violet-400" />}
                    </div>
                    <StepBody
                      id={step.id}
                      status={s}
                      waitingText={step.waiting}
                      liveText={s === "active" ? liveLine(step.id) : ""}
                      task={task}
                      plan={plan}
                      diff={diff}
                      verdict={verdict}
                      liveScore={liveScore}
                      lastAttempt={lastAttempt}
                      escalationReason={escReason}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {(effectivePhase === "done" || effectivePhase === "escalated") && (
          <ResultBanner phase={effectivePhase} task={task} verdict={verdict} escalationReason={escReason} />
        )}

        <AttemptTimeline task={task} />
      </div>
    </div>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────

function Dot({ status }: { status: StepStatus }) {
  const base = "relative z-10 mt-0.5 grid h-[19px] w-[19px] shrink-0 place-items-center rounded-full";
  if (status === "done")
    return (
      <span className={cn(base, "bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/50")}>
        <Check size={11} strokeWidth={3} />
      </span>
    );
  if (status === "active")
    return (
      <span className={cn(base, "bg-violet-500/15 ring-1 ring-violet-400/60")}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
      </span>
    );
  if (status === "error")
    return (
      <span className={cn(base, "bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/50")}>
        <X size={11} strokeWidth={3} />
      </span>
    );
  return <span className={cn(base, "bg-white ring-1 ring-zinc-300 dark:bg-zinc-950 dark:ring-zinc-700")} />;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="mt-0.5 text-[11.5px] leading-snug text-zinc-500 dark:text-zinc-400">{children}</p>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 mt-2 text-[9.5px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{children}</div>;
}

function FileChip({ path, tone = "neutral" }: { path: string; tone?: "neutral" | "written" }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 font-mono text-[10.5px]",
        tone === "written"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
      )}
      title={path}
    >
      <FileCode2 size={10} className="shrink-0 opacity-70" />
      <span className="truncate">{path}</span>
    </span>
  );
}

function CriterionRow({ text, passed, evidence }: { text: string; passed?: boolean; evidence?: string }) {
  return (
    <li className="flex items-start gap-2 py-0.5">
      <span
        className={cn(
          "mt-[3px] grid h-3 w-3 shrink-0 place-items-center rounded-[3px]",
          passed === undefined
            ? "ring-1 ring-zinc-300 dark:ring-zinc-700"
            : passed
            ? "bg-emerald-500 text-white"
            : "bg-rose-500 text-white"
        )}
      >
        {passed !== undefined && (passed ? <Check size={9} strokeWidth={3.5} /> : <X size={9} strokeWidth={3.5} />)}
      </span>
      <span className="min-w-0">
        <span className="text-[11.5px] leading-snug text-zinc-700 dark:text-zinc-200">{text}</span>
        {evidence && <span className="block truncate text-[10.5px] text-zinc-500" title={evidence}>{evidence}</span>}
      </span>
    </li>
  );
}

function StepBody(props: {
  id: StepId;
  status: StepStatus;
  waitingText: string;
  liveText: string;
  task: Task | null;
  plan: PlanSummary | null;
  diff: DiffSummary | null;
  verdict: Verdict | null;
  liveScore: LiveScore | null;
  lastAttempt?: AttemptRecord;
  escalationReason: string | null;
}) {
  const { id, status, plan, diff, verdict, liveScore, task, lastAttempt } = props;

  if (status === "waiting") return <Muted>{props.waitingText}</Muted>;
  if (status === "active") {
    return (
      <>
        <p className="mt-0.5 text-[11.5px] leading-snug text-violet-600 dark:text-violet-300">{phaseActivityLine(id, task)}</p>
        {props.liveText && props.liveText !== phaseActivityLine(id, task) && (
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-zinc-500" title={props.liveText}>
            {props.liveText}
          </p>
        )}
        {id === "verification" && liveScore && liveScore.partial.length > 0 && (
          <ul className="mt-1.5">
            {liveScore.partial.map((c, i) => (
              <CriterionRow key={i} text={c.criterion} passed={c.passed} evidence={c.evidence} />
            ))}
          </ul>
        )}
      </>
    );
  }
  // An escalation at the verify step still has a verdict: show what the
  // verifier actually found (criteria + required fixes) rather than only
  // the generic reason — the banner below carries the reason.
  if (status === "error" && !(id === "verification" && verdict)) {
    return (
      <div className="mt-1 rounded-md border border-rose-500/30 bg-rose-500/5 px-2 py-1.5 text-[11px] leading-snug text-rose-700 dark:text-rose-300">
        {cleanReason(props.escalationReason) ?? "The loop stopped here."}
      </div>
    );
  }

  // done
  if (id === "planning") {
    if (!plan) return <Muted>Plan ready.</Muted>;
    return (
      <>
        <Muted>
          Turned the request into {plan.criteria.length} acceptance criteri{plan.criteria.length === 1 ? "on" : "a"} and a{" "}
          {plan.steps}-step plan.
        </Muted>
        {plan.criteria.length > 0 && (
          <>
            <Label>Acceptance criteria</Label>
            <ul>
              {plan.criteria.map((c, i) => (
                <CriterionRow key={i} text={c} />
              ))}
            </ul>
          </>
        )}
        {plan.filesToTouch.length > 0 && (
          <>
            <Label>Allowed to write</Label>
            <div className="flex flex-wrap gap-1">
              {plan.filesToTouch.map((f) => (
                <FileChip key={f} path={f} />
              ))}
            </div>
          </>
        )}
      </>
    );
  }
  if (id === "plan_review") {
    return (
      <Muted>
        {task?.autoApprovePlan
          ? "Auto-approved — this task runs unattended. Writes outside the allowlist are blocked in code."
          : "Approved by you. Writes outside the allowlist are blocked in code."}
      </Muted>
    );
  }
  if (id === "implementation") {
    const files = diff?.filesChanged ?? lastAttempt?.filesChanged ?? [];
    const hasBuild = diff && diff.buildExit !== null && diff.buildExit !== undefined;
    const tests = diff ? diff.testsPassed + diff.testsFailed : 0;
    const rt = lastAttempt?.runtimeResult;
    return (
      <>
        <Muted>
          Wrote {files.length} file{files.length === 1 ? "" : "s"}
          {hasBuild ? ` · build ${diff!.buildExit === 0 ? "passed" : `failed (exit ${diff!.buildExit})`}` : ""}
          {tests > 0 ? ` · tests ${diff!.testsPassed}/${tests}` : ""}
          {!hasBuild && tests === 0 ? " · static files, no build step" : ""}.
        </Muted>
        {files.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {files.map((f) => (
              <FileChip key={f.path} path={f.path} tone="written" />
            ))}
          </div>
        )}
        {rt && (
          <p className="mt-1.5 text-[10.5px] text-zinc-500">
            Headless browser check:{" "}
            <span className={rt.passed ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"}>
              {rt.passed ? "page loaded clean" : "errors on load"}
            </span>{" "}
            · {rt.consoleErrorCount} console / {rt.pageErrorCount} page errors
          </p>
        )}
      </>
    );
  }
  // verification
  if (!verdict) return <Muted>Verification done.</Muted>;
  const passed = verdict.criteriaWalk.filter((c) => c.passed).length;
  const approved = verdict.outcome === "APPROVE";
  return (
    <>
      <Muted>
        {approved ? "Approved" : verdict.outcome === "REJECT" ? "Rejected" : "Escalated to a human"} after checking{" "}
        {verdict.criteriaWalk.length} criteri{verdict.criteriaWalk.length === 1 ? "on" : "a"} — {passed} passed · risk{" "}
        {verdict.risk.toLowerCase()}.
      </Muted>
      {verdict.criteriaWalk.length > 0 && (
        <ul className="mt-1.5">
          {verdict.criteriaWalk.map((c, i) => (
            <CriterionRow key={i} text={c.criterion} passed={c.passed} evidence={c.evidence} />
          ))}
        </ul>
      )}
      {!approved && verdict.requiredFixes.length > 0 && (
        <>
          <Label>Required fixes</Label>
          <ul className="space-y-0.5">
            {verdict.requiredFixes.map((f, i) => (
              <li key={i} className="text-[11px] leading-snug text-amber-700 dark:text-amber-300">
                {i + 1}. {f}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function ResultBanner({
  phase,
  task,
  verdict,
  escalationReason,
}: {
  phase: TaskStatus;
  task: Task | null;
  verdict: Verdict | null;
  escalationReason: string | null;
}) {
  const attempt = task?.attempt ?? 1;
  const max = task?.maxAttempts ?? 3;
  if (phase === "done") {
    const total = verdict?.criteriaWalk.length ?? 0;
    const passed = verdict?.criteriaWalk.filter((c) => c.passed).length ?? 0;
    return (
      <div className="mb-2 mt-1 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-500" />
        <div className="text-[11.5px] leading-snug">
          <div className="font-semibold text-emerald-700 dark:text-emerald-300">
            Approved on attempt {attempt} of {max}
          </div>
          <div className="text-zinc-500 dark:text-zinc-400">
            {total > 0 ? `${passed}/${total} criteria verified by an independent verifier.` : "Verified by an independent verifier."}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mb-2 mt-1 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-500" />
      <div className="text-[11.5px] leading-snug">
        <div className="font-semibold text-rose-700 dark:text-rose-300">Needs a human — stopped after attempt {attempt} of {max}</div>
        <div className="text-zinc-500 dark:text-zinc-400">{cleanReason(escalationReason) ?? "The loop could not converge."}</div>
      </div>
    </div>
  );
}

function StatusChip({ phase, running }: { phase: TaskStatus | null; running: boolean }) {
  const label =
    phase === "done" ? "Done"
    : phase === "escalated" ? "Escalated"
    : phase === "cancelled" ? "Cancelled"
    : phase === "planning" ? "Planning"
    : phase === "plan_review" ? "Review"
    : phase === "implementing" ? "Implementing"
    : phase === "verifying" ? "Verifying"
    : running ? "Running" : "Idle";
  const tone =
    phase === "done"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
      : phase === "escalated"
      ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"
      : running
      ? "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300"
      : "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400";
  return (
    <span className={cn("flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[10px] font-semibold uppercase tracking-wider", tone)}>
      {phase === "done" ? <Check size={11} strokeWidth={3} /> : phase === "escalated" ? <AlertTriangle size={10} /> : running ? <Loader2 size={10} className="animate-spin" /> : null}
      {label}
    </span>
  );
}

function ScoreChip({ liveScore, verdict }: { liveScore: LiveScore | null; verdict: Verdict | null }) {
  const passed = liveScore?.passed ?? (verdict ? verdict.criteriaWalk.filter((c) => c.passed).length : null);
  const total = liveScore?.total ?? (verdict ? verdict.criteriaWalk.length : null);
  if (passed === null || total === null || total === 0) return null;
  const score = Math.max(0, Math.min(10, Math.round((passed * 10) / total)));
  const live = liveScore !== null && !liveScore.done;
  const tone =
    score >= 7
      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
      : score >= 5
      ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
      : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300";
  return (
    <span
      className={cn("flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 font-mono text-[10.5px] font-semibold tabular-nums", tone)}
      title={`${passed}/${total} criteria pass`}
    >
      {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {score}/10
    </span>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function isActiveTaskStatus(status: TaskStatus | null): boolean {
  return status === "planning" || status === "plan_review" || status === "implementing" || status === "verifying";
}

function phaseActivityLine(id: StepId, task: Task | null): string {
  switch (id) {
    case "planning":
      return "Writing acceptance criteria and the file allowlist…";
    case "plan_review":
      return "Waiting for your go-ahead on the plan.";
    case "implementation":
      return `Maker is writing files — attempt ${Math.max(1, task?.attempt ?? 0)} of ${task?.maxAttempts ?? 3}…`;
    case "verification":
      return "Independent verifier is checking each criterion…";
  }
}

function phaseAgentFor(id: StepId): LogEntry["agent"] | null {
  if (id === "planning") return "planner";
  if (id === "plan_review") return "orchestrator";
  if (id === "implementation") return "maker";
  return "verifier";
}

function shortModel(model?: string): string | null {
  if (!model) return null;
  // custom:<connId>:<upstream> → upstream
  const parts = model.split(":");
  return parts.length >= 3 && parts[0] === "custom" ? parts.slice(2).join(":") : model;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Escalation reasons carry an artifact-path tail meant for logs, not the card. */
function cleanReason(reason: string | null): string | null {
  if (!reason) return null;
  return reason.replace(/\s+—\s+raw LLM outputs.*$/s, "").trim();
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export const ProgressNode = memo(ProgressNodeImpl);
