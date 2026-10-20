import { Position, type Edge, type Node } from "@xyflow/react";
import type { NodeSpec, EdgeSpec, RunStatus } from "@/data/workflow";
import { iconRegistry } from "@/data/workflow";

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 52;
/** Larger size used by the rich-UI nodes (chatbot + progress). React Flow
 *  per-node `style.width`/`style.height` overrides the default when these
 *  need to be wider/taller. The default applies to pill nodes. */
export const RICH_NODE_WIDTH = 380;
export const RICH_NODE_HEIGHT = 280;
export const MAP_NODE_WIDTH = 400;
export const MAP_NODE_HEIGHT = 430;
export const RANK_SEP = 130;
export const NODE_SEP = 60;

export interface WorkflowNodeData extends Record<string, unknown> {
  spec: NodeSpec;
  icon: ReturnType<typeof getIcon>;
  status: RunStatus;
  [key: string]: unknown;
}

function getIcon(name: string) {
  return iconRegistry[name] ?? iconRegistry.action;
}

/**
 * Hand-tuned node positions.
 *
 * Why manual instead of dagre: the previous auto-layout stacked the
 * three terminal nodes (done / retry / escalated) directly under the
 * main column with their wires all crossing at the bottom — see
 * screenshot 1. Manual positions let us:
 *
 *  - keep the main spine in a single centered column (no diagonal drift)
 *  - fan the terminal nodes out symmetrically below `verdict`
 *  - route back-edges (plan_review.no → planner, retry.yes → read_state)
 *    through the LEFT gutter of the main column instead of crossing it
 *  - give the two wires converging on `escalated` distinct y-offsets
 *    so they don't visually merge at the same target handle
 *  - park the rich-UI nodes (chatbot + progress) to the LEFT of the
 *    main spine so they don't fight for visual weight with the spine
 *
 * Coordinates are top-left corners of each node. The main column is
 * centered on x=480, so each main-spine node is placed at x=370
 * (480 − NODE_WIDTH/2). Rich-UI nodes use the same anchor strategy but
 * are offset left so they sit beside the spine, not on top of it.
 */
const MANUAL_POSITIONS: Record<string, { x: number; y: number }> = {
  // Rich-UI nodes around the main spine
  chatbot: { x: -180, y: 260 },
  progress: { x: -180, y: 780 },
  map: { x: 700, y: 0 },
  // Main spine (x=370 puts the node centered on x=480)
  task: { x: 370, y: 0 },
  orchestrator: { x: 370, y: 130 },
  planner: { x: 370, y: 260 },
  plan_review: { x: 370, y: 390 },
  read_state: { x: 370, y: 520 },
  maker: { x: 370, y: 650 },
  verifier: { x: 370, y: 780 },
  verdict: { x: 370, y: 910 },
  // Terminal row — fan out below verdict
  done: { x: 40, y: 1080 },
  retry: { x: 370, y: 1080 },
  escalated: { x: 700, y: 1080 },
  // Own row below `done` so its bottom-source wire has room to drop
  // straight down without crossing the terminal row above it.
  live_preview: { x: 40, y: 1210 },
};

/** Build the flow graph positioned by the manual layout table. */
export function layoutFromSpec(
  nodeSpecs: NodeSpec[],
  edgeSpecs: EdgeSpec[]
): { nodes: Node<WorkflowNodeData>[]; edges: Edge[] } {
  const nodes: Node<WorkflowNodeData>[] = nodeSpecs.map((spec) => {
    const pos = MANUAL_POSITIONS[spec.id] ?? { x: 0, y: 0 };
    // Rich-UI node kinds need a bigger footprint — their React component
    // renders a real form/card, not a pill. We pick the `type` so the canvas
    // registers the right React component and override width/height so React
    // Flow doesn't squash the layout.
    const isMap = spec.kind === "map";
    const isRich = isMap || spec.kind === "chatbot" || spec.kind === "progress";
    return {
      id: spec.id,
      // `type` matches the key in `nodeTypes` in Canvas.tsx
      type: isRich ? spec.kind : "workflow",
      position: pos,
      data: {
        spec,
        icon: getIcon(spec.iconName),
        status: "idle" as RunStatus,
      },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      draggable: true,
      deletable: false,
      // Bigger box for the rich-UI nodes. Pill nodes use the default.
      style: isMap
        ? { width: MAP_NODE_WIDTH, height: MAP_NODE_HEIGHT }
        : isRich
        ? { width: RICH_NODE_WIDTH, height: RICH_NODE_HEIGHT }
        : undefined,
    };
  });

  const edges: Edge[] = edgeSpecs.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: e.targetHandle,
    type: "animated",
    data: {
      branch: e.branch,
      inactive: e.inactive ?? false,
      color: e.color,
      continuation: e.continuation,
    },
  }));

  return { nodes, edges };
}

/**
 * Snap a (possibly user-moved) set of nodes back to the canonical layout.
 * Only uses each node's id to look up its anchor position; missing ids
 * (e.g. a node the user deleted) are left where they were.
 */
export function resnapToLayout(
  currentNodes: Node<WorkflowNodeData>[],
  _edgeSpecs: EdgeSpec[]
): Node<WorkflowNodeData>[] {
  return currentNodes.map((n) => {
    const pos = MANUAL_POSITIONS[n.id];
    if (!pos) return n;
    return { ...n, position: pos };
  });
}