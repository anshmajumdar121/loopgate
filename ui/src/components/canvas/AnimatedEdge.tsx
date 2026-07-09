import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import { cn } from "@/lib/utils";

type EdgeColor = "primary" | "success" | "danger" | "muted";

/**
 * Wire palette — two-tone by design, matching the new node palette:
 *   primary  = emerald   → main flow / forward path
 *   success  = emerald   → "yes" branches (continue forward)
 *   danger   = rose      → "no" / escalate (off the happy path)
 *   muted    = slate     → back-edges / inactive (subtle, not loud)
 *
 * All four are still distinct enough that branches read at a glance,
 * but none of them competes with the others for attention.
 */
const colorHex: Record<EdgeColor, string> = {
  primary: "#10b981", // emerald-500
  success: "#10b981", // emerald-500
  danger: "#f43f5e", // rose-500
  muted: "#94a3b8", // slate-400
};

const markerName: Record<EdgeColor, string> = {
  primary: "marker-primary",
  success: "marker-success",
  danger: "marker-danger",
  muted: "marker-muted",
};

interface EdgeData extends Record<string, unknown> {
  branch?: "yes" | "no" | "default";
  inactive?: boolean;
  active?: boolean;
  color?: EdgeColor;
  continuation?: number;
}

function AnimatedEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const d = (data as EdgeData) ?? {};

  // Smooth-step path = orthogonal right-angle turns with rounded corners.
  // This is what makes the wires read like the reference infographic
  // (clean L-shapes) rather than the previous curvy bezier lines.
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 14,
  });

  const isActive = !!d.active;
  const isInactive = !!d.inactive;
  const branch = d.branch;
  const tone: EdgeColor =
    d.color ??
    (branch === "yes"
      ? "success"
      : branch === "no" || isInactive
        ? "danger"
        : "primary");

  const stroke = colorHex[tone];

  // Dashing rules:
  //  - active run path: animated dashes that visibly flow toward the target
  //  - inactive / continuation: static dashes (so it reads as "off")
  //  - everything else: solid
  const dashArray = isActive ? "6 6" : isInactive ? "5 5" : undefined;

  const endMarker = isActive ? "marker-active" : markerName[tone];

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke,
          strokeWidth: isActive ? 2.25 : 1.75,
          strokeDasharray: dashArray,
          transition: "stroke 200ms",
        }}
        className={cn(isActive && "animate-flow")}
        markerEnd={`url(#${endMarker})`}
      />

      {/* Optional straight continuation stub below the target node.
          Used when a back-edge needs to drop down a bit before turning. */}
      {typeof d.continuation === "number" && d.continuation > 0 && !isActive && (
        <BaseEdge
          id={`${id}-cont`}
          path={`M ${targetX} ${targetY} L ${targetX} ${targetY + d.continuation}`}
          style={{
            stroke,
            strokeWidth: 1.75,
            strokeDasharray: "5 5",
            opacity: 0.85,
          }}
          className="react-flow__edge-continuation"
        />
      )}

      {/* Branch label — small pill at the midpoint of the wire */}
      {branch && branch !== "default" && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: labelX, top: labelY }}
          >
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize shadow-sm",
                branch === "yes" &&
                  "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300 dark:ring-emerald-400/30",
                branch === "no" &&
                  "bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200 dark:bg-indigo-500/20 dark:text-indigo-300 dark:ring-indigo-400/30"
              )}
            >
              {branch}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const AnimatedEdge = memo(AnimatedEdgeImpl);