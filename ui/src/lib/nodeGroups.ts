// Groups of related workflow nodes that share a single model config.
//
// Why groups: the user wanted to avoid setting a model on each of 11 nodes
// individually. Instead, nodes that participate in the same logical phase
// of the loop (planning / implementation / review) all inherit the same
// model. Clicking any node in a group surfaces the same picker.
//
// Mapping is by node ID — see `workflow.ts` for the canonical node IDs.

export type NodeGroupId = "planning" | "implementation" | "review";

export interface NodeGroup {
  id: NodeGroupId;
  label: string;
  description: string;
  /** Node IDs in `workflow.ts` that belong to this group. */
  nodeIds: string[];
}

export const NODE_GROUPS: NodeGroup[] = [
  {
    id: "planning",
    label: "Planning",
    description:
      "Reads the codebase, writes the plan into GOAL.md, surfaces it for user review.",
    nodeIds: ["planner", "plan_review"],
  },
  {
    id: "implementation",
    label: "Implementation",
    description:
      "Implements the plan and writes a diff summary to STATE.md.",
    nodeIds: ["maker"],
  },
  {
    id: "review",
    label: "Review",
    description:
      "Re-runs tests independently, returns APPROVE / REJECT / ESCALATE_HUMAN.",
    nodeIds: ["verifier", "verdict", "retry"],
  },
];

/** Nodes that don't run an agent model and therefore don't belong to a group. */
export const NON_AGENT_NODES: readonly string[] = [
  "task", // user prompt input
  "orchestrator", // system loop driver — no LLM agent
  "read_state", // reads STATE.md — no LLM agent
  "done", // terminal state
  "escalated", // terminal state
];

/** Look up the group a given node belongs to, or null. */
export function getGroupForNode(nodeId: string | null): NodeGroup | null {
  if (!nodeId) return null;
  return NODE_GROUPS.find((g) => g.nodeIds.includes(nodeId)) ?? null;
}

/** Look up a group by ID. */
export function getGroupById(id: NodeGroupId): NodeGroup {
  const g = NODE_GROUPS.find((x) => x.id === id);
  if (!g) throw new Error(`unknown node group: ${id}`);
  return g;
}