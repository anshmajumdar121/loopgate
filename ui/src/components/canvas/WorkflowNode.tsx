import { memo, type MouseEvent } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { RunStatus } from "@/data/workflow";
import { NODE_HEIGHT, NODE_WIDTH } from "@/lib/layout";
import { useWorkflow } from "@/lib/store";
import { RuntimeCheckPanel } from "@/components/RuntimeCheckPanel";

export interface WorkflowNodeData extends Record<string, unknown> {
  spec: {
    id: string;
    kind: string;
    title: string;
    subtitle?: string;
    body?: string;
    iconName: string;
    outputs?: { id: string; label: string }[];
  };
  icon: LucideIcon;
  status: RunStatus;
}

/**
 * Two-tone palette (mirrors image-2 reference: green = primary flow,
 * indigo = decision/branching, rose = escalation, amber = warning).
 * Keeping it to 4 tones keeps the canvas feeling like a designed
 * infographic rather than a debug tool.
 */
type Tone = "primary" | "decision" | "success" | "warning";

const toneStyles: Record<
  Tone,
  { circle: string; dot: string; runningRing: string }
> = {
  primary: {
    circle: "bg-emerald-500 text-white",
    dot: "!bg-emerald-500",
    runningRing: "bg-emerald-400/40",
  },
  decision: {
    circle: "bg-indigo-500 text-white",
    dot: "!bg-indigo-500",
    runningRing: "bg-indigo-400/40",
  },
  success: {
    circle: "bg-emerald-600 text-white",
    dot: "!bg-emerald-600",
    runningRing: "bg-emerald-400/40",
  },
  warning: {
    circle: "bg-amber-500 text-white",
    dot: "!bg-amber-500",
    runningRing: "bg-amber-400/40",
  },
};

function getTone(spec: WorkflowNodeData["spec"]): Tone {
  switch (spec.kind) {
    case "decision":
      return "decision";
    case "counter":
      return "decision";
    case "end-success":
      return "success";
    case "end-escalated":
      return "warning";
    default:
      return "primary";
  }
}

/**
 * Tone classes for the per-node /10 score chip. Mirrors the threshold
 * used elsewhere in the app (orchestrator SCRIPT_LOOP_MIN_SCORE_OUT_OF_10
 * = 7): emerald = "done", amber = "close, keep going", rose = "iterate".
 * Kept here (not imported from ProgressNode) so the canvas and the
 * ProgressNode don't share a single point of failure for styling.
 */
function scoreToneClass(score: number): string {
  if (score >= 7) {
    return "bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-300 dark:ring-emerald-500/40";
  }
  if (score >= 5) {
    return "bg-amber-100 text-amber-700 ring-amber-300 dark:bg-amber-500/20 dark:text-amber-300 dark:ring-amber-500/40";
  }
  return "bg-rose-100 text-rose-700 ring-rose-300 dark:bg-rose-500/20 dark:text-rose-300 dark:ring-rose-500/40";
}

/**
 * Decide where each source handle sits on the chip.
 *
 * The default React-Flow position for a source is Bottom-center, which
 * only works cleanly for straight vertical chains. Multi-output decision
 * nodes (verdict / retry / plan_review) need their handles fanned out to
 * Left/Right/Top so the wires don't all stack on top of each other at
 * the bottom of the node.
 */
function sourcePosition(
  spec: WorkflowNodeData["spec"],
  handleId: string
): Position {
  if (spec.id === "verdict") {
    if (handleId === "yes") return Position.Left;
    if (handleId === "escalate") return Position.Right;
    return Position.Bottom; // "no"
  }
  if (spec.id === "retry") {
    // `yes` exits from the LEFT so the back-edge to read_state can route
    // up the left gutter of the main column without crossing any nodes.
    if (handleId === "yes") return Position.Left;
    return Position.Right; // "no"
  }
  if (spec.id === "plan_review") {
    if (handleId === "no") return Position.Left;
    return Position.Bottom; // "yes"
  }
  return Position.Bottom;
}

function WorkflowNodeImpl({ data, selected }: NodeProps) {
  const Icon = (data.icon as LucideIcon) ?? CheckCircle2;
  const spec = data.spec as WorkflowNodeData["spec"];
  const status = (data.status as RunStatus) ?? "idle";
  const tone = getTone(spec);
  const t = toneStyles[tone];

  // The live-preview node is the one interactive pill in the diagram —
  // clicking it opens the running prototype. Only wired when a URL
  // actually exists (status flips to "success" the moment the
  // orchestrator registers one; see store.ts applyTaskStatusToNodes /
  // setTaskMirror).
  const previewUrl = useWorkflow((s) => s.taskMirror?.previewUrl);
  const runtimeCheck = useWorkflow((s) => s.taskMirror?.runtimeCheck);
  const isLivePreviewNode = spec.id === "live_preview";
  const previewClickable = isLivePreviewNode && Boolean(previewUrl);
  const openPreview = (e: MouseEvent) => {
    if (!previewClickable) return;
    e.stopPropagation();
    window.open(previewUrl, "_blank", "noopener,noreferrer");
  };

  // Per-node score chip. Surfaces the canvas node's /10 contribution
  // (planner / maker / verifier only — other node kinds don't drive
  // the rubric). The chip is hidden until the first node_score event
  // arrives and freezes on its final value once the verifier exits.
  const nodeScore = useWorkflow((s) => s.nodeScores[spec.id] ?? null);
  const showScoreChip = nodeScore !== null;

  const isSkipped = status === "skipped";
  const isRunning = status === "running";
  const isSuccess = status === "success";
  const isError = status === "error";
  const isQueued = status === "queued";

  // When the node is in an error state, swap the icon for the warning glyph
  // so the failure reads instantly even without colour.
  const GlyphIcon = isError ? AlertTriangle : Icon;

  return (
    <div
      className={cn(
        "group relative inline-flex items-center select-none rounded-full transition-colors duration-150",
        // No stroke on the container — the selection marker lives entirely
        // on the icon-circle (see the icon-circle's `outline` below).
        // The pill picks up only a soft sky tint, no border change.
        isSkipped && "opacity-40 saturate-50",
        // Live-preview affordance: pointer cursor + hover lift only when
        // an actual URL exists to open; `nodrag` keeps React Flow from
        // treating the click as the start of a node drag.
        previewClickable && "nodrag cursor-pointer hover:brightness-105",
        isLivePreviewNode && !previewClickable && "opacity-60"
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      onClick={openPreview}
      title={previewClickable ? previewUrl : isLivePreviewNode ? "No live preview yet" : undefined}
    >
      {/* Running pulse — two stacked rings around the icon-circle.
          Ring colour flips to blue when the node is selected so the
          running state stays consistent with the sky selection theme. */}
      {isRunning && (
        <span className="pointer-events-none absolute left-0 top-1/2 z-0 grid h-11 w-11 -translate-y-1/2 place-items-center">
          <span
            className={cn(
              "absolute inset-0 animate-ping rounded-full",
              selected ? "bg-blue-400/40" : t.runningRing
            )}
          />
          <span
            className={cn(
              "absolute inset-0 rounded-full ring-2 animate-pulse-ring",
              selected ? "ring-blue-400/60" : "ring-emerald-400/60"
            )}
          />
        </span>
      )}

      {/* Queued pulse — a softer, slower halo so the user can see the
          node is in the pipeline queue (downstream of the active node)
          without mistaking it for "running" or "stuck". A single ring
          with low opacity beats at the 1.4s cadence. */}
      {isQueued && !isRunning && (
        <span className="pointer-events-none absolute left-0 top-1/2 z-0 grid h-11 w-11 -translate-y-1/2 place-items-center">
          <span
            className={cn(
              "absolute inset-0 rounded-full ring-2 animate-pulse-ring",
              selected
                ? "ring-sky-300/50"
                : tone === "decision"
                ? "ring-indigo-300/40"
                : "ring-emerald-300/40"
            )}
            style={{ animationDuration: "1.6s" }}
          />
        </span>
      )}

{/* Icon circle — left side, overlapping the pill.
          When selected: sky-200 fill + blue-700 glyph + a 3px blue outline
          that lives ONLY on the circle (the pill stays un-stroked, just
          gets a soft sky tint below). The outline is drawn outside the
          circle so it reads as a stroke around the circle, not inside it. */}
      <div
        className={cn(
          "relative z-10 grid h-11 w-11 shrink-0 place-items-center rounded-full ring-4 transition-colors",
          selected
            ? "bg-sky-200 text-blue-700 ring-sky-100 outline outline-[3px] outline-blue-500 dark:bg-sky-800/50 dark:text-sky-200 dark:ring-sky-700/40 dark:outline-blue-400"
            : cn(
                t.circle,
                "ring-zinc-50 dark:ring-zinc-950",
                "shadow-pill"
              ),
          isError && "!bg-rose-500 !text-white"
        )}
      >
        <GlyphIcon size={16} strokeWidth={2.2} />
      </div>

      {/* Pill label */}
      <div
        className={cn(
          "relative z-0 -ml-3 inline-flex items-center gap-2 rounded-full border py-1.5 pl-5 pr-3 shadow-pill transition-colors",
          selected
            ? "bg-sky-50/80 border-sky-200 dark:bg-sky-950/30 dark:border-sky-800/60"
            : "bg-white border-zinc-200 dark:bg-zinc-900 dark:border-zinc-800"
        )}
      >
        <div className="flex min-w-0 flex-col leading-tight">
          <h3
            className={cn(
              "truncate text-[13px] font-semibold transition-colors",
              selected
                ? "text-blue-900 dark:text-sky-100"
                : "text-zinc-900 dark:text-zinc-100"
            )}
          >
            {spec.title}
          </h3>
          {spec.subtitle && (
            <p
              className={cn(
                "truncate text-[10.5px] transition-colors",
                selected
                  ? "text-blue-700/80 dark:text-sky-300/80"
                  : "text-zinc-500 dark:text-zinc-400"
              )}
            >
              {spec.subtitle}
            </p>
          )}
        </div>

        {/* Status indicator — sits at the right end of the pill.
            Colours flip to the blue family when the chip is selected so
            the whole selected chip reads as one consistent sky palette. */}
        {(isRunning || isSuccess || isError || isSkipped) && (
          <div className="ml-0.5 flex shrink-0 items-center">
            {isRunning && (
              <Loader2
                size={12}
                className={cn(
                  "animate-spin",
                  selected ? "text-blue-600" : "text-emerald-500"
                )}
              />
            )}
            {isSuccess && (
              <CheckCircle2
                size={14}
                className={cn(
                  selected ? "text-blue-600" : "text-emerald-500"
                )}
                strokeWidth={2.5}
              />
            )}
            {isError && (
              <XCircle
                size={14}
                className={cn(
                  selected ? "text-blue-600" : "text-rose-500"
                )}
                strokeWidth={2.5}
              />
            )}
            {isSkipped && (
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  selected ? "bg-blue-400" : "bg-zinc-400"
                )}
              />
            )}
          </div>
        )}

        {/* Per-node score chip — surfaces the canvas node's /10
            contribution. Sits between the status indicator and the
            right edge of the pill, with its own tone family (emerald
            ≥ 7 / amber 5–6 / rose < 5) so it stays legible regardless
            of the node's success/error state. Hidden until the first
            `node_score` WS event arrives; the LIVE label animates while
            streaming and disappears once the verifier freezes. */}
        {showScoreChip && nodeScore && (
          <span
            className={cn(
              "ml-1 inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[9.5px] font-semibold tabular-nums ring-1",
              scoreToneClass(nodeScore.score)
            )}
            title={`${nodeScore.passed}/${nodeScore.total} criteria pass → ${nodeScore.score}/10`}
          >
            {!nodeScore.done && (
              <span className="relative flex h-1 w-1">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
                <span className="relative inline-flex h-1 w-1 rounded-full bg-current" />
              </span>
            )}
            <span className="font-mono">{nodeScore.score}/10</span>
          </span>
        )}
      </div>

      {/* Runtime check panel — absolutely positioned below the pill so it
          doesn't affect the node's fixed width/height layout. Only ever
          mounted for the live_preview node; RuntimeCheckPanel itself
          renders null until both previewUrl + runtimeCheck are present. */}
      {isLivePreviewNode && (
        <div
          className="nodrag nopan absolute left-0 top-full z-20 mt-2 w-56"
          onClick={(e) => e.stopPropagation()}
        >
          <RuntimeCheckPanel previewUrl={previewUrl} runtimeCheck={runtimeCheck} />
        </div>
      )}

      {/* Default target handle on TOP — incoming edges arrive here */}
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2 !w-2 !rounded-full !border-2 !border-zinc-50 !bg-zinc-400 dark:!border-zinc-950"
        style={{ left: "50%" }}
      />

      {/* Side target handles for back-edges / multi-incoming nodes */}
      {spec.id === "planner" && (
        <Handle
          type="target"
          position={Position.Left}
          id="back"
          className="!h-2 !w-2 !rounded-full !border-2 !border-zinc-50 !bg-indigo-400 dark:!border-zinc-950"
        />
      )}
      {spec.id === "read_state" && (
        <Handle
          type="target"
          position={Position.Left}
          id="loop"
          className="!h-2 !w-2 !rounded-full !border-2 !border-zinc-50 !bg-indigo-400 dark:!border-zinc-950"
        />
      )}
      {spec.id === "done" && (
        <Handle
          type="target"
          position={Position.Right}
          className="!h-2 !w-2 !rounded-full !border-2 !border-zinc-50 !bg-emerald-500 dark:!border-zinc-950"
        />
      )}
      {spec.id === "escalated" && (
        <>
          {/* Two distinct target handles so the two incoming wires can
              enter at different y positions and not stack on each other */}
          <Handle
            type="target"
            position={Position.Left}
            id="from-verdict"
            className="!h-2 !w-2 !rounded-full !border-2 !border-zinc-50 !bg-rose-400 dark:!border-zinc-950"
            style={{ top: "32%" }}
          />
          <Handle
            type="target"
            position={Position.Left}
            id="from-retry"
            className="!h-2 !w-2 !rounded-full !border-2 !border-zinc-50 !bg-rose-400 dark:!border-zinc-950"
            style={{ top: "68%" }}
          />
        </>
      )}

      {/* Source handles — per-output placement */}
      {spec.outputs && spec.outputs.length > 0 ? (
        spec.outputs.map((o) => (
          <Handle
            key={o.id}
            type="source"
            position={sourcePosition(spec, o.id)}
            id={o.id}
            className={cn(
              "!h-2 !w-2 !rounded-full !border-2 !border-zinc-50 transition-colors dark:!border-zinc-950",
              t.dot
            )}
          />
        ))
      ) : (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!h-2 !w-2 !rounded-full !border-2 !border-zinc-50 !bg-emerald-500 transition-colors dark:!border-zinc-950"
        />
      )}
    </div>
  );
}

export const WorkflowNode = memo(WorkflowNodeImpl);