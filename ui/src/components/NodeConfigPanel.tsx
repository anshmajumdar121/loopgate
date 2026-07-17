import { useState, useMemo } from "react";
import {
  X,
  Globe,
  Trash2,
  Plus,
  CircleHelp,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Send,
  Hammer,
  ShieldCheck,
  Play,
  RefreshCw,
  Square,
  RotateCcw,
  Loader2,
  ListChecks,
  FileCode2,
  Terminal,
  MessageSquare,
  ArrowRight,
  CheckSquare,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useWorkflow } from "@/lib/store";
import { cn } from "@/lib/utils";
import { MODEL_OPTIONS } from "@/types/loop";
import { NodeModelPanel } from "@/components/NodeModelPanel";

type Tab = "setup" | "conditions" | "test";

export function NodeConfigPanel() {
  const taskMirror = useWorkflow((s) => s.taskMirror);
  const awaitingConfirmation = useWorkflow((s) => s.awaitingConfirmation);
  const awaitingFeedback = useWorkflow((s) => s.awaitingFeedback);
  const escalationReason = useWorkflow((s) => s.escalationReason);
  const doneSummary = useWorkflow((s) => s.doneSummary);

  // Order of precedence: cancelled > escalation > done > awaiting_feedback > awaiting_confirmation > task-overview > node-model config (no task)
  // `cancelled` checks status directly because cancellation can happen mid-flight
  // without ever having set an escalationReason (e.g. user pressed Stop during
  // a phase that was already running).
  if (taskMirror && taskMirror.status === "cancelled") return <CancelledPanel />;
  if (taskMirror && escalationReason) return <EscalationPanel />;
  if (taskMirror && doneSummary) return <DonePanel />;
  if (taskMirror && awaitingFeedback) return <FeedbackPanel />;
  if (taskMirror && awaitingConfirmation) return <PlanReviewPanel />;
  if (taskMirror) return <TaskOverviewPanel />;
  return <NodeModelPanel />;
}

// ─── Plan Review Panel ─────────────────────────────────────

function PlanReviewPanel() {
  const plan = useWorkflow((s) => s.plan);
  const task = useWorkflow((s) => s.taskMirror);
  const currentTaskId = useWorkflow((s) => s.currentTaskId);
  const [adjustments, setAdjustments] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<"confirm" | "adjust">("confirm");
  const [showFullPlan, setShowFullPlan] = useState(false);

  const handleConfirm = async () => {
    if (!currentTaskId) return;
    setSubmitting(true);
    try {
      await fetch(`/api/tasks/${currentTaskId}/confirm-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adjustments: adjustments.trim() || undefined }),
      });
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAdjust = async () => {
    if (!currentTaskId) return;
    const text = adjustments.trim();
    if (!text) return; // disabled in UI but defensive guard
    setSubmitting(true);
    try {
      await fetch(`/api/tasks/${currentTaskId}/adjust-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adjustments: text }),
      });
      // The orchestrator re-spawns the planner and emits plan_review
      // again with a fresh plan. We clear local state — the next plan_ready
      // will repopulate `plan`, and we'll re-render with the new content.
      setAdjustments("");
      setMode("confirm");
      setShowFullPlan(false);
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const canAdjust = adjustments.trim().length > 0 && !submitting;

  // Extract numbered steps ("1. blah") from the planner's GOAL.md raw
  // output so we can show real text, not just "Step 1 — see GOAL.md".
  // Falls back to count-only rendering if no numbered list is found.
  const stepLines = useMemo(
    () => extractNumberedSteps(plan?.rawGoal ?? ""),
    [plan?.rawGoal]
  );

  // Build / test / lint commands lifted out of the notes blob. The
  // planner usually puts these in `## Notes for the maker` as
  // `Build command: …`, `Test command: …`, `Lint command: …` lines.
  // We surface them as a proper "Commands" card so the user can see
  // exactly what will be run without scrolling through notes.
  const commands = useMemo(
    () => extractCommands(plan?.notes ?? ""),
    [plan?.notes]
  );

  return (
    <aside className="flex h-full w-[380px] flex-col border-l border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-950">
      {/* Header — bigger, more colorful than the other panels so the
          "your decision is needed" state reads clearly. */}
      <div className="flex items-start gap-3 border-b border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-sm">
          <CheckCircle2 size={20} strokeWidth={2.4} />
          <span className="absolute -right-0.5 -top-0.5 grid h-3.5 w-3.5 place-items-center rounded-full border-2 border-white bg-amber-400 dark:border-zinc-900">
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
            Plan Ready
          </h2>
          <p className="mt-0.5 text-[12px] text-zinc-500 dark:text-zinc-400">
            Read it through, then either confirm or tell the planner to
            change something.
          </p>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {plan ? (
          <>
            {/* Task card — your original ask. */}
            <PlanCard
              icon={MessageSquare}
              tone="violet"
              title="What you asked for"
            >
              <p className="text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                {task?.title || task?.prompt}
              </p>
            </PlanCard>

            {/* Steps card — numbered, with the planner's actual step text */}
            {plan.steps > 0 && (
              <PlanCard
                icon={ListChecks}
                tone="emerald"
                title={`What we'll do — ${plan.steps} step${plan.steps === 1 ? "" : "s"}`}
              >
                {stepLines.length > 0 ? (
                  <ol className="space-y-1.5">
                    {stepLines.map((line, i) => (
                      <li
                        key={i}
                        className="flex gap-2.5 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300"
                      >
                        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-100 font-mono text-[10.5px] font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                          {i + 1}
                        </span>
                        <span>{line}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <ol className="space-y-1 text-[12.5px] text-zinc-500 dark:text-zinc-400">
                    {Array.from({ length: plan.steps }).map((_, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="font-mono text-zinc-400">{i + 1}.</span>
                        <span>Step {i + 1} — see GOAL.md</span>
                      </li>
                    ))}
                  </ol>
                )}
              </PlanCard>
            )}

            {/* Files card — with file-type badges so the user can
                eyeball "is this touching the right files?" quickly. */}
            {plan.filesToTouch.length > 0 && (
              <PlanCard
                icon={FileCode2}
                tone="sky"
                title={`Files we'll touch — ${plan.filesToTouch.length}`}
              >
                <ul className="space-y-1">
                  {plan.filesToTouch.map((f) => (
                    <li
                      key={f}
                      className="flex items-center gap-2 text-[12px]"
                    >
                      <FileBadge path={f} />
                      <span
                        className="truncate font-mono text-zinc-700 dark:text-zinc-300"
                        title={f}
                      >
                        {f}
                      </span>
                    </li>
                  ))}
                </ul>
              </PlanCard>
            )}

            {/* Criteria card — styled checklist (real visual checkbox,
                intentionally not interactive — these are the planner's
                success conditions, not user tasks). */}
            {plan.criteria.length > 0 && (
              <PlanCard
                icon={CheckSquare}
                tone="emerald"
                title={`How we'll know it works — ${plan.criteria.length} check${plan.criteria.length === 1 ? "" : "s"}`}
              >
                <ul className="space-y-1.5">
                  {plan.criteria.map((c, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300"
                    >
                      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border-2 border-emerald-400 bg-white text-emerald-600 dark:border-emerald-500 dark:bg-zinc-900">
                        <CheckCircle2 size={10} strokeWidth={3} />
                      </span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </PlanCard>
            )}

            {/* Risks card — amber to flag this section as "pay attention". */}
            {plan.risks.length > 0 && (
              <PlanCard
                icon={AlertTriangle}
                tone="amber"
                title={`Things to watch — ${plan.risks.length}`}
              >
                <ul className="space-y-1.5">
                  {plan.risks.map((r, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-[12.5px] leading-relaxed text-amber-900 dark:text-amber-200"
                    >
                      <span className="mt-0.5 text-amber-500">⚠</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </PlanCard>
            )}

            {/* Commands card — pulled from the notes blob, rendered as
                a tidy terminal-styled block so build/test/lint are
                scannable at a glance. */}
            {commands.length > 0 && (
              <PlanCard
                icon={Terminal}
                tone="zinc"
                title="Commands that'll run"
              >
                <div className="space-y-1 rounded-md bg-zinc-900 p-2 font-mono text-[11px] leading-relaxed dark:bg-zinc-950">
                  {commands.map((c, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-zinc-300"
                    >
                      <span className="select-none text-emerald-500">
                        $
                      </span>
                      <span className="flex-1 truncate">{c}</span>
                    </div>
                  ))}
                </div>
              </PlanCard>
            )}

            {/* Free-form notes (without the build/test/lint lines we
                already extracted above). */}
            {plan.notes &&
              plan.notes.replace(/^.*command:.*$/gm, "").trim().length >
                10 && (
                <PlanCard icon={Sparkles} tone="violet" title="Notes from the planner">
                  <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {plan.notes.replace(/^.*command:.*$/gm, "").trim()}
                  </p>
                </PlanCard>
              )}

            {/* Adjustments card — let the user steer. */}
            <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-2 flex items-center gap-2">
                <div className="grid h-6 w-6 place-items-center rounded-md bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400">
                  <RefreshCw size={12} />
                </div>
                <h3 className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                  Want changes?
                </h3>
                <span className="ml-auto text-[10px] uppercase tracking-wider text-zinc-400">
                  {mode === "adjust" ? "required" : "optional"}
                </span>
              </div>
              <textarea
                rows={3}
                placeholder={'e.g. "Skip the lint step", "Use the existing Button component — do not create a new one".'}
                value={adjustments}
                onChange={(e) => setAdjustments(e.target.value)}
                onFocus={() => setMode("adjust")}
                className="w-full resize-none rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-[12.5px] leading-relaxed text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-violet-500 focus:bg-white focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
              {mode === "adjust" && (
                <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-amber-700 dark:text-amber-300">
                  <Sparkles size={10} className="mt-0.5 shrink-0" />
                  <span>
                    The planner will rewrite the plan with your feedback.
                    Up to 3 rounds before the loop escalates.
                  </span>
                </p>
              )}
            </div>

            {/* Collapsible rawGoal — escape hatch for the curious. */}
            {plan.rawGoal && (
              <details
                className="rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900"
                open={showFullPlan}
                onToggle={(e) =>
                  setShowFullPlan((e.target as HTMLDetailsElement).open)
                }
              >
                <summary className="cursor-pointer text-[11px] font-semibold text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
                  Raw planner output (GOAL.md)
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-900 p-2.5 font-mono text-[10.5px] leading-relaxed text-zinc-100">
                  {plan.rawGoal}
                </pre>
              </details>
            )}
          </>
        ) : (
          <EmptyPlanState />
        )}
      </div>

      {/* Footer — single primary CTA on top, secondary pair below.
          Visual hierarchy matters here: "Looks good" is the obvious
          yes (green gradient, big, with an arrow); "Re-plan" is for
          when the user wants to send the planner back to the
          drawing board (amber-tinted, refresh icon); "Clear changes"
          is a tertiary escape hatch (muted text button). */}
      <div className="space-y-2.5 border-t border-zinc-200 bg-white px-4 py-3.5 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Primary CTA — gradient, shadow, animated arrow. The eye
            should land here first. */}
        <button
          type="button"
          onClick={handleConfirm}
          disabled={submitting || !plan}
          className={cn(
            "group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl px-4 py-3 text-[13.5px] font-semibold text-white transition-all",
            "bg-gradient-to-br from-emerald-500 via-emerald-500 to-emerald-600 shadow-md shadow-emerald-500/25",
            "hover:from-emerald-600 hover:via-emerald-600 hover:to-emerald-700 hover:shadow-lg hover:shadow-emerald-500/30",
            "active:scale-[0.99] active:shadow-sm",
            "disabled:cursor-not-allowed disabled:from-zinc-300 disabled:via-zinc-300 disabled:to-zinc-300 disabled:shadow-none disabled:text-zinc-500",
            "dark:disabled:from-zinc-700 dark:disabled:via-zinc-700 dark:disabled:to-zinc-700 dark:disabled:text-zinc-400"
          )}
        >
          {/* Subtle shine sweep — purely decorative. The
              translate-x transition on the inner span gives the
              button a "live" feel when hovered. */}
          <span className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/15 to-transparent opacity-0 transition-all duration-500 group-hover:left-full group-hover:opacity-100" />
          {submitting ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              Confirming…
            </>
          ) : (
            <>
              <span>Looks good — start implementing</span>
              <ArrowRight
                size={15}
                className="transition-transform group-hover:translate-x-0.5"
                strokeWidth={2.5}
              />
            </>
          )}
        </button>

        {/* Secondary row — Re-plan (amber-tinted, the "not quite
            right" path) + Clear changes (muted, escape hatch). */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleAdjust}
            disabled={!canAdjust}
            title={
              canAdjust
                ? "Send feedback to the planner"
                : "Type adjustments first to enable"
            }
            className={cn(
              "group flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-medium transition-all",
              canAdjust
                ? "border-amber-300 bg-amber-50 text-amber-800 hover:border-amber-400 hover:bg-amber-100 hover:shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:border-amber-400/60 dark:hover:bg-amber-500/15"
                : "cursor-not-allowed border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-500"
            )}
          >
            <RefreshCw
              size={12}
              className={cn(
                "transition-transform",
                canAdjust && "group-hover:-rotate-90"
              )}
              strokeWidth={2.5}
            />
            Re-plan with feedback
          </button>
          <button
            type="button"
            onClick={() => setAdjustments("")}
            disabled={!adjustments || submitting}
            className={cn(
              "rounded-lg px-3 py-2 text-[12px] font-medium transition-colors",
              adjustments && !submitting
                ? "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                : "cursor-not-allowed text-zinc-300 dark:text-zinc-600"
            )}
            title="Clear your feedback text"
          >
            Clear
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * Pull numbered steps ("1. blah blah") out of the planner's raw GOAL.md.
 * Used by PlanReviewPanel so we can show real step text instead of the
 * placeholder "Step N — see GOAL.md". Returns an empty array if no
 * numbered list is found (caller falls back to count-only rendering).
 */
function extractNumberedSteps(rawGoal: string): string[] {
  if (!rawGoal) return [];
  const lines = rawGoal.split(/\r?\n/);
  const steps: string[] = [];
  for (const line of lines) {
    // Match "1. " through "99. " — the planner writes steps in this format.
    const m = line.match(/^\s*(\d+)\.\s+(.+?)\s*$/);
    if (m) {
      const num = Number(m[1]);
      // Guard against sparse numbering / duplicates — push only if this
      // is the next expected number.
      if (num === steps.length + 1) {
        steps.push(m[2]);
      }
    }
  }
  return steps;
}

/**
 * Pull the build / test / lint commands out of the planner's notes
 * blob. The planner writes things like:
 *   `Build command: npm run build`
 *   `Test command: npm test`
 *   `Lint command: npm run lint`
 * Returns an array of command strings in document order. Commands are
 * rendered in a terminal-styled card so the user sees exactly what
 * will run.
 */
function extractCommands(notes: string): string[] {
  if (!notes) return [];
  const out: string[] = [];
  for (const line of notes.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:build|test|lint|type|format)\s+command\s*:\s*(.+?)\s*$/i);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** Color tokens for the various section tones. */
type Tone = "violet" | "emerald" | "sky" | "amber" | "zinc";

const TONE_STYLES: Record<
  Tone,
  { chip: string; ring: string; iconBg: string; iconColor: string }
> = {
  violet: {
    chip: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
    ring: "border-violet-200/70 dark:border-violet-500/20",
    iconBg: "bg-violet-100 dark:bg-violet-500/15",
    iconColor: "text-violet-600 dark:text-violet-400",
  },
  emerald: {
    chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    ring: "border-emerald-200/70 dark:border-emerald-500/20",
    iconBg: "bg-emerald-100 dark:bg-emerald-500/15",
    iconColor: "text-emerald-600 dark:text-emerald-400",
  },
  sky: {
    chip: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    ring: "border-sky-200/70 dark:border-sky-500/20",
    iconBg: "bg-sky-100 dark:bg-sky-500/15",
    iconColor: "text-sky-600 dark:text-sky-400",
  },
  amber: {
    chip: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    ring: "border-amber-200/70 dark:border-amber-500/20",
    iconBg: "bg-amber-100 dark:bg-amber-500/15",
    iconColor: "text-amber-600 dark:text-amber-400",
  },
  zinc: {
    chip: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    ring: "border-zinc-200 dark:border-zinc-700",
    iconBg: "bg-zinc-100 dark:bg-zinc-800",
    iconColor: "text-zinc-600 dark:text-zinc-400",
  },
};

/**
 * Card used for every section of the redesigned plan review. White
 * card with a colored left-edge tint matching the section's tone,
 * a small colored icon header, the section title (with optional count),
 * and a body for the section's content. Sized consistently so the
 * panel feels like a stack of clean info cards.
 */
function PlanCard({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: LucideIcon;
  tone: Tone;
  title: string;
  children: React.ReactNode;
}) {
  const t = TONE_STYLES[tone];
  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-xl border bg-white shadow-sm dark:bg-zinc-900",
        t.ring
      )}
    >
      {/* Colored left edge — gives the card its tone without a heavy
          header band. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          tone === "violet" && "bg-violet-400 dark:bg-violet-500",
          tone === "emerald" && "bg-emerald-400 dark:bg-emerald-500",
          tone === "sky" && "bg-sky-400 dark:bg-sky-500",
          tone === "amber" && "bg-amber-400 dark:bg-amber-500",
          tone === "zinc" && "bg-zinc-300 dark:bg-zinc-600"
        )}
      />
      <header className="flex items-center gap-2 px-3 pt-2.5">
        <span
          className={cn(
            "grid h-6 w-6 shrink-0 place-items-center rounded-md",
            t.iconBg,
            t.iconColor
          )}
        >
          <Icon size={12} strokeWidth={2.2} />
        </span>
        <h3 className="truncate text-[12px] font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
          {title}
        </h3>
      </header>
      <div className="px-3 py-2.5 pt-2">{children}</div>
    </section>
  );
}

/**
 * File-type badge — small rounded label showing the language inferred
 * from the file extension. Used next to each path in the "Files we'll
 * touch" list so the user can eyeball whether the planner is touching
 * the right files without reading each path.
 */
function FileBadge({ path }: { path: string }) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const meta: Record<
    string,
    { label: string; classes: string }
  > = {
    ts: { label: "TS", classes: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300" },
    tsx: { label: "TSX", classes: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300" },
    js: { label: "JS", classes: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300" },
    jsx: { label: "JSX", classes: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300" },
    json: { label: "JSON", classes: "bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200" },
    css: { label: "CSS", classes: "bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300" },
    scss: { label: "SCSS", classes: "bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300" },
    html: { label: "HTML", classes: "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300" },
    md: { label: "MD", classes: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" },
    py: { label: "PY", classes: "bg-yellow-100 text-yellow-800 dark:bg-yellow-500/20 dark:text-yellow-300" },
    go: { label: "GO", classes: "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300" },
    rs: { label: "RS", classes: "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-300" },
    sh: { label: "SH", classes: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" },
  };
  const m = meta[ext] ?? { label: ext.toUpperCase().slice(0, 3) || "FILE", classes: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" };
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px font-mono text-[9px] font-bold tracking-tight",
        m.classes
      )}
    >
      {m.label}
    </span>
  );
}

function EmptyPlanState() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <Loader2 size={20} className="animate-spin text-zinc-400" />
      <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
        Waiting for the planner to finish writing GOAL.md…
      </p>
      <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
        If this stays here for more than a minute, the planner may have
        crashed. Check the live log strip below the canvas for errors.
      </p>
    </div>
  );
}

// ─── Feedback Panel ────────────────────────────────────────

function FeedbackPanel() {
  const verdict = useWorkflow((s) => s.verdict);
  const diff = useWorkflow((s) => s.diff);
  const currentTaskId = useWorkflow((s) => s.currentTaskId);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleRetry = async () => {
    if (!currentTaskId || !feedback.trim()) return;
    setSubmitting(true);
    try {
      await fetch(`/api/tasks/${currentTaskId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: feedback.trim() }),
      });
      setFeedback("");
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <aside className="flex h-full w-[380px] flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <PanelHeader
        icon={<AlertTriangle size={16} strokeWidth={2.2} />}
        iconBg="bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400"
        title="Rejected — Retry"
        subtitle={`Attempt ${verdict?.attempt ?? 0} was REJECTED. Send feedback for the next attempt.`}
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {verdict && (
          <>
            <Section label="One-line reason">
              <p className="text-[12.5px] text-rose-700 dark:text-rose-300">
                {verdict.oneLineReason}
              </p>
            </Section>
            <Section label="Build / Tests">
              <div className="grid grid-cols-2 gap-2 text-[12px]">
                <Stat label="Build" value={verdict.buildExit == null ? "n/a" : verdict.buildExit === 0 ? "✓ pass" : "✗ fail"} />
                <Stat label="Tests" value={verdict.testsPassed + verdict.testsFailed === 0 ? "n/a" : `${verdict.testsPassed}/${verdict.testsPassed + verdict.testsFailed}`} />
              </div>
            </Section>
            <Section label="Criteria walk">
              <ul className="space-y-1.5">
                {verdict.criteriaWalk.map((c, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[12.5px]">
                    <span className={cn("mt-0.5 h-3.5 w-3.5 rounded", c.passed ? "bg-emerald-500" : "bg-rose-500")} />
                    <span className="text-zinc-700 dark:text-zinc-300">{c.criterion}</span>
                  </li>
                ))}
              </ul>
            </Section>
            <Section label="Required fixes">
              <ul className="space-y-1 text-[12.5px] text-rose-700 dark:text-rose-300">
                {verdict.requiredFixes.map((f, i) => <li key={i}>• {f}</li>)}
              </ul>
            </Section>
          </>
        )}
        {diff && (
          <Section label={`Diff (attempt ${diff.attempt})`}>
            <ul className="space-y-1 text-[11.5px] font-mono text-zinc-700 dark:text-zinc-300">
              {diff.filesChanged.map((f) => (
                <li key={f.path} className="truncate">{f.path}</li>
              ))}
            </ul>
          </Section>
        )}
        <Section label="Your feedback">
          <textarea
            autoFocus
            rows={4}
            placeholder="e.g. The handler test needs to assert the new contract — see line 42."
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            className="w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-[12.5px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
        </Section>
      </div>
      <PanelFooter>
        <Button variant="ghost" size="md" disabled={submitting}>
          Escalate
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={handleRetry}
          disabled={!feedback.trim() || submitting}
        >
          <RefreshCw size={13} />
          {submitting ? "Retrying…" : "Retry with feedback"}
        </Button>
      </PanelFooter>
    </aside>
  );
}

// ─── Cancelled Panel ───────────────────────────────────────

/**
 * Shown after the user pressed Stop. Two actions:
 *   - Resume: pick up from where the loop was when it stopped (the
 *     orchestrator picks the appropriate phase based on the persisted
 *     plan/diff — see `resumeLoop` in backend/src/loop/orchestrator.ts).
 *   - Reset:  clear plan/diff/verdict, increment attempt counter, restart
 *     from scratch (planning phase). Destructive — confirm first.
 *
 * The backend transitions the task and broadcasts a `task_update` over
 * WS — the panel automatically swaps to PlanReview / Verifying /
 * TaskOverview depending on what phase was selected by resumeLoop().
 */
function CancelledPanel() {
  const task = useWorkflow((s) => s.taskMirror);
  const currentTaskId = useWorkflow((s) => s.currentTaskId);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!task || !currentTaskId) return null;

  const resumeHint = task.diff
    ? "Resume will re-verify the existing diff."
    : task.plan
    ? "Resume will re-approve the existing plan."
    : "Resume will restart from planning.";

  const handleResume = async () => {
    setResumeBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${currentTaskId}/resume`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Resume failed (${res.status})`);
      }
      // Success path: backend broadcasts task_update → store updates →
      // NodeConfigPanel re-routes to PlanReview / Verifying /
      // TaskOverview automatically. Nothing to do client-side.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResumeBusy(false);
    }
  };

  const handleReset = async () => {
    setResetBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${currentTaskId}/reset`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Reset failed (${res.status})`);
      }
      // On success the orchestrator kicks off a fresh runLoop; the
      // panel auto-routes when status flips.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetBusy(false);
      setResetConfirm(false);
    }
  };

  return (
    <aside className="flex h-full w-[380px] flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <PanelHeader
        icon={<Square size={16} strokeWidth={2.2} />}
        iconBg="bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
        title="Stopped"
        subtitle="The loop was cancelled. Resume from where you were, or reset to start over."
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <Section label="What was preserved">
          <ul className="ml-4 list-disc text-[12px] text-zinc-600 dark:text-zinc-300 space-y-0.5">
            {task.plan && (
              <li>
                Plan — {task.plan.steps} step
                {task.plan.steps === 1 ? "" : "s"}
              </li>
            )}
            {task.diff && (
              <li>
                Last diff — {task.diff.filesChanged.length} file
                {task.diff.filesChanged.length === 1 ? "" : "s"}
              </li>
            )}
            {task.verdict && (
              <li>
                Verdict — {task.verdict.outcome} (attempt {task.verdict.attempt})
              </li>
            )}
            <li>Attempt counter — currently {task.attempt}/{task.maxAttempts}</li>
          </ul>
        </Section>

        {error && (
          <Section label="Error">
            <div className="rounded-md bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
              {error}
            </div>
          </Section>
        )}
      </div>

      <PanelFooter>
        {!resetConfirm ? (
          <>
            <Button
              variant="ghost"
              size="md"
              onClick={() => setResetConfirm(true)}
              disabled={resumeBusy || resetBusy}
              title="Clear plan/diff/verdict and restart from planning"
            >
              <RotateCcw size={13} />
              Reset
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handleResume}
              disabled={resumeBusy || resetBusy}
              title={resumeHint}
            >
              <Play size={13} fill="currentColor" />
              {resumeBusy ? "Resuming…" : "Resume"}
            </Button>
          </>
        ) : (
          <div className="flex w-full flex-col gap-2">
            <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
              Reset clears the plan, diff, verdict and history. Attempt
              counter goes to {task.attempt + 1}/{task.maxAttempts}. Continue?
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setResetConfirm(false)}
                disabled={resetBusy}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleReset}
                disabled={resetBusy}
                className="bg-rose-600 hover:bg-rose-700"
              >
                {resetBusy ? "Resetting…" : "Yes, reset"}
              </Button>
            </div>
          </div>
        )}
      </PanelFooter>
    </aside>
  );
}

// ─── Escalation Panel ──────────────────────────────────────

function EscalationPanel() {
  const reason = useWorkflow((s) => s.escalationReason);
  const verdict = useWorkflow((s) => s.verdict);
  const resetTaskState = useWorkflow((s) => s.resetTaskState);
  const resetNodeStatuses = useWorkflow((s) => s.resetNodeStatuses);

  return (
    <aside className="flex h-full w-[380px] flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <PanelHeader
        icon={<AlertTriangle size={16} strokeWidth={2.2} />}
        iconBg="bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400"
        title="Escalated"
        subtitle="The loop needs human intervention."
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <Section label="Reason">
          <p className="text-[12.5px] text-rose-700 dark:text-rose-300">{reason}</p>
        </Section>
        {verdict && (
          <Section label="Last verdict">
            <pre className="overflow-x-auto rounded-md bg-zinc-900 p-2.5 font-mono text-[11px] text-zinc-100">
{`outcome: ${verdict.outcome}
attempt: ${verdict.attempt}
risk:    ${verdict.risk}
reason:  ${verdict.oneLineReason}`}
            </pre>
          </Section>
        )}
        <Section label="Manual takeover">
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
            Inspect the workdir, fix the issue yourself, then start a new task.
          </p>
        </Section>
      </div>
      <PanelFooter>
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            resetTaskState();
            resetNodeStatuses();
          }}
        >
          Start a new task
        </Button>
      </PanelFooter>
    </aside>
  );
}

// ─── Done Panel ────────────────────────────────────────────

function DonePanel() {
  const summary = useWorkflow((s) => s.doneSummary);
  const verdict = useWorkflow((s) => s.verdict);
  const resetTaskState = useWorkflow((s) => s.resetTaskState);
  const resetNodeStatuses = useWorkflow((s) => s.resetNodeStatuses);

  return (
    <aside className="flex h-full w-[380px] flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <PanelHeader
        icon={<CheckCircle2 size={16} strokeWidth={2.2} />}
        iconBg="bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
        title="Task Complete"
        subtitle="The verifier approved the work."
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <Section label="Summary">
          <p className="text-[12.5px] text-zinc-700 dark:text-zinc-300">{summary}</p>
        </Section>
        {verdict && (
          <Section label="Final verdict">
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <Stat label="Outcome" value={verdict.outcome} />
              <Stat label="Attempt" value={`${verdict.attempt}`} />
              <Stat label="Build" value={verdict.buildExit == null ? "n/a" : verdict.buildExit === 0 ? "✓" : "✗"} />
              <Stat label="Tests" value={verdict.testsPassed + verdict.testsFailed === 0 ? "n/a" : `${verdict.testsPassed}/${verdict.testsPassed + verdict.testsFailed}`} />
            </div>
          </Section>
        )}
      </div>
      <PanelFooter>
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            resetTaskState();
            resetNodeStatuses();
          }}
        >
          Start a new task
        </Button>
      </PanelFooter>
    </aside>
  );
}

// ─── Task Overview Panel ───────────────────────────────────

function TaskOverviewPanel() {
  const task = useWorkflow((s) => s.taskMirror);
  const phase = useWorkflow((s) => s.phase);
  const diff = useWorkflow((s) => s.diff);
  const verdict = useWorkflow((s) => s.verdict);

  return (
    <aside className="flex h-full w-[380px] flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <PanelHeader
        icon={<Play size={16} strokeWidth={2.2} />}
        iconBg="bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400"
        title="Loop Running"
        subtitle={phase ? phase.replace("_", " ") : "active"}
      />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <Section label="Task">
          <p className="text-[12.5px] text-zinc-700 dark:text-zinc-300">{task?.prompt}</p>
        </Section>
        {task?.model && (
          <Section label="Model">
            <ModelLine modelId={task.model} />
          </Section>
        )}
        <Section label="Attempt">
          <p className="font-mono text-[12.5px] text-zinc-700 dark:text-zinc-300">
            {task?.attempt} / {task?.maxAttempts}
          </p>
        </Section>
        {diff && (
          <Section label={`Diff (attempt ${diff.attempt})`}>
            <ul className="space-y-1 text-[11.5px] font-mono text-zinc-700 dark:text-zinc-300">
              {diff.filesChanged.map((f) => (
                <li key={f.path} className="truncate">
                  <span className="text-emerald-600">M</span> {f.path}
                </li>
              ))}
            </ul>
            <div className="mt-1.5 grid grid-cols-2 gap-2 text-[11.5px]">
              <Stat label="Build" value={diff.buildExit == null ? "n/a" : diff.buildExit === 0 ? "✓" : "✗"} />
              <Stat label="Tests" value={diff.testsPassed + diff.testsFailed === 0 ? "n/a" : `${diff.testsPassed}/${diff.testsPassed + diff.testsFailed}`} />
            </div>
          </Section>
        )}
        {verdict && (
          <Section label={`Verdict (attempt ${verdict.attempt})`}>
            <p className={cn(
              "text-[12.5px] font-semibold",
              verdict.outcome === "APPROVE" ? "text-emerald-600 dark:text-emerald-400" :
              verdict.outcome === "ESCALATE_HUMAN" ? "text-rose-600 dark:text-rose-400" :
              "text-amber-600 dark:text-amber-400"
            )}>
              {verdict.outcome} — {verdict.oneLineReason}
            </p>
          </Section>
        )}
        <div className="rounded-md bg-violet-50/60 px-3 py-2 text-[11.5px] text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
          Live agent output appears in the strip at the bottom of the page.
        </div>
      </div>
    </aside>
  );
}

// ─── Default Node Config (existing, when no task active) ─

function DefaultNodeConfig() {
  const [tab, setTab] = useState<Tab>("setup");
  return (
    <aside className="flex h-full w-[380px] flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start gap-3 border-b border-zinc-200 px-4 py-3.5 dark:border-zinc-800">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400">
          <Globe size={16} strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
            Node Configuration
          </h2>
          <p className="mt-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
            Click "+ New Task" below to start a loop.
          </p>
        </div>
        <button className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100/60 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
          <X size={14} />
        </button>
      </div>
      <div className="flex border-b border-zinc-200 px-4 dark:border-zinc-800">
        <TabButton active={tab === "setup"} onClick={() => setTab("setup")}>Setup</TabButton>
        <TabButton active={tab === "conditions"} onClick={() => setTab("conditions")}>Conditions</TabButton>
        <TabButton active={tab === "test"} onClick={() => setTab("test")}>Test Run</TabButton>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {tab === "setup" && <SetupTab />}
        {tab === "conditions" && <ConditionsTab />}
        {tab === "test" && <TestRunTab />}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <Button variant="ghost" size="md">Cancel</Button>
        <Button variant="primary" size="md">Save Node</Button>
      </div>
    </aside>
  );
}

// ─── Shared panel pieces ──────────────────────────────────

function PanelHeader({
  icon,
  iconBg,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-zinc-200 px-4 py-3.5 dark:border-zinc-800">
      <div className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg", iconBg)}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
        </h2>
        <p className="mt-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">{subtitle}</p>
      </div>
    </div>
  );
}

function PanelFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      {children}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        {label}
      </h4>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-zinc-50 px-2 py-1.5 dark:bg-zinc-900">
      <div className="text-[10px] uppercase tracking-wider text-zinc-400">{label}</div>
      <div className="font-mono text-[12px] font-medium text-zinc-800 dark:text-zinc-200">{value}</div>
    </div>
  );
}

function TabButton({ active, children, onClick }: { active?: boolean; children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative px-3 py-2.5 text-[12.5px] font-medium transition-colors",
        active ? "text-violet-700 dark:text-violet-300" : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      )}
    >
      {children}
      {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-violet-600" />}
    </button>
  );
}

// ─── Default panel body tabs (kept from the original) ─────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center gap-1">
        <label className="text-[11.5px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{label}</label>
        {hint && (
          <span title={hint} className="text-zinc-300 hover:text-zinc-500 dark:text-zinc-600">
            <CircleHelp size={11} />
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function SetupTab() {
  return (
    <>
      <Field label="Node Type"><Select value="HTTP Request" /></Field>
      <Field label="Method"><Select value="GET" /></Field>
      <Field label="URL" hint="Endpoint this node will call">
        <input
          type="text"
          defaultValue="https://api.nexusflow.com/users"
          className="h-9 w-full rounded-md border border-zinc-300 bg-white px-3 text-[13px] text-zinc-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </Field>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-[11.5px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Headers</h4>
        <button className="flex items-center gap-1 text-[11.5px] font-medium text-violet-700 hover:text-violet-800 dark:text-violet-300">
          <Plus size={12} /> Add Header
        </button>
      </div>
      <div className="mb-2 grid grid-cols-2 gap-2">
        <input defaultValue="Authorization" className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-[12.5px] outline-none focus:border-violet-500 dark:border-zinc-700 dark:bg-zinc-900" />
        <div className="relative">
          <input type="password" defaultValue="Bearer sk_test_abc123def456" className="h-9 w-full rounded-md border border-zinc-200 bg-white pl-3 pr-8 text-[12.5px] outline-none focus:border-violet-500 dark:border-zinc-700 dark:bg-zinc-900" />
          <button className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-300 hover:text-zinc-600 dark:text-zinc-600"><Trash2 size={12} /></button>
        </div>
      </div>
    </>
  );
}

function ConditionsTab() {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/40 p-6 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
      <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full bg-white text-zinc-400 dark:bg-zinc-800">
        <CircleHelp size={18} />
      </div>
      <p className="text-[12.5px] font-medium text-zinc-700 dark:text-zinc-200">No conditions set</p>
      <p className="mt-1 text-[11.5px] text-zinc-500 dark:text-zinc-400">Add a condition to control when this node runs.</p>
      <Button variant="outline" size="sm" className="mt-3"><Plus size={12} /> Add Condition</Button>
    </div>
  );
}

function TestRunTab() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Last run</span>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">200 OK</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11.5px]">
          <Stat label="Duration" value="248ms" />
          <Stat label="Response size" value="3.4 KB" />
        </div>
      </div>
      <Button variant="outline" size="md" className="w-full"><Sparkles size={13} /> Run Again</Button>
    </div>
  );
}

function Select({ value }: { value: string }) {
  return (
    <div className="relative">
      <select
        defaultValue={value}
        className="h-9 w-full appearance-none rounded-md border border-zinc-300 bg-white pl-3 pr-9 text-[13px] outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <option>{value}</option>
      </select>
      <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
    </div>
  );
}

/**
 * Friendly model line for the Task Overview panel. Shows the human label
 * if the model is in MODEL_OPTIONS, otherwise the raw `provider/model-name`
 * ID. The raw ID is always rendered underneath as a muted mono string so
 * users (and agents debugging logs) can see exactly what was passed.
 */
function ModelLine({ modelId }: { modelId: string }) {
  const opt = MODEL_OPTIONS.find((m) => m.id === modelId);
  const label = opt?.label ?? "Custom model";
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
        <Sparkles size={11} className="text-violet-500" />
        {label}
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
        {modelId}
      </div>
    </div>
  );
}