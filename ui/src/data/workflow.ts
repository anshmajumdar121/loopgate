import type { NodeTypes } from "@xyflow/react";
import {
  FileText,
  Workflow,
  Compass,
  UserCheck,
  RefreshCw,
  Wrench,
  ShieldCheck,
  GitBranch,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  ListChecks,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";

export type NodeKind =
  | "task"
  | "process"
  | "agent-readonly"
  | "agent-readwrite"
  | "decision"
  | "counter"
  | "end-success"
  | "end-escalated"
  | "chatbot"
  | "progress";

export type RunStatus =
  | "idle"
  | "running"
  | "success"
  | "error"
  | "skipped"
  | "waiting"
  // "queued" — the node is downstream of the currently active node and
  // will run once its predecessors complete. Renders with a subtle pulse
  // so the user can see the pipeline has more to do, instead of mistaking
  // it for a stuck node.
  | "queued";

export interface NodeSpec {
  id: string;
  kind: NodeKind;
  title: string;
  subtitle?: string;
  body?: string;
  iconName: string;
  outputs?: { id: string; label: string }[];
}

export interface EdgeSpec {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  /**
   * Which target handle on the target node this edge lands on. Defaults
   * to the unmarked target handle (usually Top-center). Set this when
   * the target has multiple incoming handles at different positions
   * (e.g. `escalated` accepts two wires at distinct y-offsets on its
   * Left edge) or when a back-edge needs to enter from a side other
   * than Top (e.g. `planner` and `read_state` have Left-side handles
   * specifically for back-edges routed through the left gutter).
   */
  targetHandle?: string;
  branch?: "yes" | "no" | "default";
  inactive?: boolean;
  color?: "primary" | "success" | "danger" | "muted";
  continuation?: number;
}

export const iconRegistry: Record<string, LucideIcon> = {
  task: FileText,
  orchestrator: Workflow,
  planner: Compass,
  plan_review: UserCheck,
  read_state: RefreshCw,
  maker: Wrench,
  verifier: ShieldCheck,
  verdict: GitBranch,
  retry: RotateCcw,
  done: CheckCircle2,
  escalated: AlertTriangle,
  chatbot: MessageSquare,
  progress: ListChecks,
  live_preview: ExternalLink,
};

export const nodeSpecs: NodeSpec[] = [
  {
    id: "task",
    kind: "task",
    title: "Task Input",
    subtitle: "User describes the work to be done.",
    iconName: "task",
  },
  {
    id: "orchestrator",
    kind: "process",
    title: "Orchestrator",
    subtitle: "Reads GOAL.md + STATE.md, dispatches agents.",
    iconName: "orchestrator",
  },
  {
    id: "planner",
    kind: "agent-readonly",
    title: "Planner",
    subtitle: "Read-only exploration, writes plan to GOAL.md.",
    iconName: "planner",
  },
  {
    id: "plan_review",
    kind: "decision",
    title: "Plan Review",
    subtitle: "User confirms or adjusts the plan.",
    iconName: "plan_review",
    outputs: [
      { id: "yes", label: "Confirm" },
      { id: "no", label: "Adjust" },
    ],
  },
  {
    id: "read_state",
    kind: "process",
    title: "Read State",
    subtitle: "Reads attempt # + prior verifier feedback.",
    iconName: "read_state",
  },
  {
    id: "maker",
    kind: "agent-readwrite",
    title: "Maker",
    subtitle: "Implements the plan, runs build + tests.",
    iconName: "maker",
  },
  {
    id: "verifier",
    kind: "agent-readonly",
    title: "Verifier",
    subtitle: "Runs tests independently, returns APPROVE/REJECT.",
    iconName: "verifier",
  },
  {
    id: "verdict",
    kind: "decision",
    title: "Verdict",
    subtitle: "APPROVE / REJECT / ESCALATE_HUMAN",
    iconName: "verdict",
    outputs: [
      { id: "yes", label: "Approve" },
      { id: "no", label: "Reject" },
      { id: "escalate", label: "Escalate" },
    ],
  },
  {
    id: "retry",
    kind: "counter",
    title: "Retry?",
    subtitle: "attempt < max_retries (3)?",
    iconName: "retry",
    outputs: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
  },
  {
    id: "done",
    kind: "end-success",
    title: "Done",
    subtitle: "Task complete — verifier APPROVE.",
    iconName: "done",
  },
  {
    id: "live_preview",
    kind: "end-success",
    title: "Live Preview",
    subtitle: "Open the running prototype in a new tab.",
    iconName: "live_preview",
  },
  {
    id: "escalated",
    kind: "end-escalated",
    title: "Escalated",
    subtitle: "Needs human intervention.",
    iconName: "escalated",
  },
  {
    id: "chatbot",
    kind: "chatbot",
    title: "Chatbot",
    subtitle: "Talk to the loop. Attach images, run tasks.",
    iconName: "chatbot",
  },
  {
    id: "progress",
    kind: "progress",
    title: "Progress",
    subtitle: "Live status of every step in the loop.",
    iconName: "progress",
  },
];

export const edgeSpecs: EdgeSpec[] = [
  { id: "e1", source: "task", target: "orchestrator", color: "primary" },
  { id: "e2", source: "orchestrator", target: "planner", color: "primary" },
  { id: "e3", source: "planner", target: "plan_review", color: "primary" },
  {
    id: "e4",
    source: "plan_review",
    sourceHandle: "yes",
    target: "read_state",
    branch: "yes",
    color: "success",
  },
  {
    id: "e4b",
    source: "plan_review",
    sourceHandle: "no",
    target: "planner",
    targetHandle: "back",
    branch: "no",
    color: "muted",
  },
  { id: "e5", source: "read_state", target: "maker", color: "primary" },
  { id: "e6", source: "maker", target: "verifier", color: "primary" },
  { id: "e7", source: "verifier", target: "verdict", color: "muted" },
  {
    id: "e8",
    source: "verdict",
    sourceHandle: "yes",
    target: "done",
    branch: "yes",
    color: "success",
  },
  { id: "e8b", source: "done", target: "live_preview", color: "success" },
  {
    id: "e9",
    source: "verdict",
    sourceHandle: "no",
    target: "retry",
    branch: "no",
    color: "danger",
  },
  {
    id: "e10",
    source: "verdict",
    sourceHandle: "escalate",
    target: "escalated",
    targetHandle: "from-verdict",
    color: "danger",
  },
  {
    id: "e11",
    source: "retry",
    sourceHandle: "yes",
    target: "read_state",
    targetHandle: "loop",
    branch: "yes",
    color: "success",
  },
  {
    id: "e12",
    source: "retry",
    sourceHandle: "no",
    target: "escalated",
    targetHandle: "from-retry",
    branch: "no",
    color: "danger",
  },
  // Chatbot → orchestrator. The user types into the chatbot node and the
  // task is dispatched to the rest of the flow.
  { id: "e13", source: "chatbot", target: "orchestrator", color: "primary" },
  // Orchestrator → progress. The progress node mirrors live state of
  // every step so the user always sees where they are.
  { id: "e14", source: "orchestrator", target: "progress", color: "muted" },
];

/**
 * Maps backend TaskStatus → which canvas nodeId is "running".
 * Used by the UI to light up the right node based on phase.
 */
export const STATUS_TO_NODE: Record<string, string> = {
  draft: "task",
  planning: "planner",
  plan_review: "plan_review",
  implementing: "maker",
  verifying: "verifier",
  done: "done",
  escalated: "escalated",
  cancelled: "task",
};

/** Static custom node types object for ReactFlow. */
export const customNodeTypes: NodeTypes = {};