import { create } from "zustand";
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge as rfAddEdge,
  type Connection,
} from "@xyflow/react";
import {
  type WorkflowNodeData,
  layoutFromSpec,
  resnapToLayout,
} from "@/lib/layout";
import { nodeSpecs, edgeSpecs, STATUS_TO_NODE, type RunStatus } from "@/data/workflow";
import {
  NODE_GROUPS,
  type NodeGroupId,
  type NodeGroup,
} from "@/lib/nodeGroups";
import { DEFAULT_MODEL_ID } from "@/types/loop";
import type {
  Task,
  TaskStatus,
  LogEntry,
  PlanSummary,
  DiffSummary,
  Verdict,
} from "@/types/loop";

type Theme = "light" | "dark";

/** Phases where the orchestrator is actively driving the task. */
const ACTIVE_PHASES: readonly TaskStatus[] = [
  "planning",
  "plan_review",
  "implementing",
  "verifying",
];

interface WorkflowState {
  // Graph state (existing)
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
  theme: Theme;
  selectedNodeId: string | null;
  locked: boolean;

  // Real backend task mirror
  currentTaskId: string | null;
  taskMirror: Task | null;
  phase: TaskStatus | null;
  isRunning: boolean;
  plan: PlanSummary | null;
  diff: DiffSummary | null;
  verdict: Verdict | null;
  /** Live criteria-walk progress during the verifying phase. Updated by
   *  the `verifier_progress` WS event; cleared when the phase ends.
   *  Shape mirrors the parser's `CriteriaWalkItem[]` so the ProgressNode
   *  can render the live walk the same way it renders the final one. */
  liveScore: {
    attempt: number;
    passed: number;
    total: number;
    partial: Array<{ criterion: string; passed: boolean; evidence: string }>;
    done: boolean;
  } | null;
  /**
   * Per-node score snapshot, keyed by canvas node id (planner / maker /
   * verifier). The latest `node_score` WS event for each node wins; the
   * `done` flag freezes the badge when the verifier exits. Read by
   * WorkflowNode to render a small /10 chip on the contributing nodes.
   */
  nodeScores: Record<
    string,
    {
      attempt: number;
      passed: number;
      total: number;
      score: number;
      done: boolean;
    }
  >;
  escalationReason: string | null;
  doneSummary: string | null;
  errorMessage: string | null;
  logs: LogEntry[];
  awaitingConfirmation: boolean;
  awaitingFeedback: boolean;
  /** Live status of the WebSocket — drives the "Reconnecting…" badge. */
  wsStatus: "idle" | "connecting" | "open" | "closed";

  // theme
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;

  // selection
  setSelected: (id: string | null) => void;

  // graph
  onNodesChange: OnNodesChange<Node<WorkflowNodeData>>;
  onEdgesChange: OnEdgesChange;
  onConnect: (c: Connection) => void;
  resnapLayout: () => void;
  toggleLock: () => void;
  setLocked: (locked: boolean) => void;
  resetNodeStatuses: () => void;

  // backend task lifecycle
  setCurrentTask: (id: string | null) => void;
  loadTask: (task: Task) => void;
  setTaskMirror: (t: Task) => void;
  setPhase: (from: TaskStatus, to: TaskStatus) => void;
  appendLog: (entry: LogEntry) => void;
  setPlan: (p: PlanSummary) => void;
  setDiff: (d: DiffSummary) => void;
  setVerdict: (v: Verdict) => void;
  setLiveScore: (s: WorkflowState["liveScore"]) => void;
  setNodeScore: (
    nodeId: string,
    entry: NonNullable<WorkflowState["nodeScores"][string]>
  ) => void;
  setEscalation: (reason: string) => void;
  setDone: (summary: string) => void;
  setError: (message: string) => void;
  setNodeStatus: (nodeId: string, status: RunStatus) => void;
  applyTaskStatusToNodes: (status: TaskStatus, attempt: number) => void;
  resetTaskState: () => void;
  setWsStatus: (s: "idle" | "connecting" | "open" | "closed") => void;

  /**
   * Per-group model config. Each group has its own picker so the user
   * doesn't need to set a model on each individual node. Persisted to
   * localStorage so the user's picks survive page refresh.
   */
  nodeModels: Record<NodeGroupId, string>;
  setNodeModel: (group: NodeGroupId, model: string) => void;
}

const initial = layoutFromSpec(nodeSpecs, edgeSpecs);

/**
 * Walk the workflow graph from `startId` and return every node reachable
 * via a forward edge (any output handle). Used by applyTaskStatusToNodes
 * to mark downstream-of-active nodes as `queued` so the user can see the
 * pipeline has more to do, instead of mistaking those nodes for broken.
 *
 * Loops are terminated by a hop budget (16) so a misconfigured back-edge
 * can't hang the UI. BFS — depth doesn't matter for status assignment.
 */
/**
 * The main pipeline in execution order. Nodes earlier than the phase's
 * active node are painted "success" on every task_update so completed
 * work stays visibly complete mid-run. Terminal/side nodes (retry, done,
 * escalated, live_preview, chatbot, progress) are intentionally absent —
 * they're driven by the queued/terminal logic and node_status events.
 */
const PIPELINE_ORDER: readonly string[] = [
  "task",
  "orchestrator",
  "planner",
  "plan_review",
  "read_state",
  "maker",
  "verifier",
  "verdict",
];

function collectDownstream(
  startId: string | null,
  edges: ReadonlyArray<{ source: string; target: string }>
): Set<string> {
  if (!startId) return new Set();
  const out = new Set<string>();
  let frontier: string[] = [startId];
  let hops = 0;
  const MAX_HOPS = 16;
  while (frontier.length > 0 && hops < MAX_HOPS) {
    hops++;
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of edges) {
        if (e.source === id && !out.has(e.target)) {
          out.add(e.target);
          next.push(e.target);
        }
      }
    }
    frontier = next;
  }
  return out;
}

export const useWorkflow = create<WorkflowState>((set, get) => ({
  // Graph
  nodes: initial.nodes,
  edges: initial.edges,
  theme:
    (typeof window !== "undefined" &&
      (localStorage.getItem("theme") as Theme)) ||
    "light",
  selectedNodeId: "orchestrator",
  locked: false,

  // Backend mirror
  currentTaskId: null,
  taskMirror: null,
  phase: null,
  isRunning: false,
  plan: null,
  diff: null,
  verdict: null,
  liveScore: null,
  nodeScores: {},
  escalationReason: null,
  doneSummary: null,
  errorMessage: null,
  logs: [],
  awaitingConfirmation: false,
  awaitingFeedback: false,
  wsStatus: "idle",

  // theme
  setTheme: (theme) => {
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      root.classList.toggle("dark", theme === "dark");
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
    }
    try {
      localStorage.setItem("theme", theme);
    } catch {}
    set({ theme });
  },

  toggleTheme: () => {
    const next = get().theme === "dark" ? "light" : "dark";
    get().setTheme(next);
  },

  // selection
  setSelected: (id) => set({ selectedNodeId: id }),

  // graph
  onNodesChange: (changes) => {
    set({
      nodes: applyNodeChanges(
        changes,
        get().nodes
      ) as Node<WorkflowNodeData>[],
    });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection) => {
    set({
      edges: rfAddEdge({ ...connection, type: "animated" }, get().edges),
    });
  },

  resnapLayout: () => {
    set({
      nodes: resnapToLayout(get().nodes, edgeSpecs),
    });
  },

  resetNodeStatuses: () => {
    set({
      nodes: get().nodes.map((n) => ({
        ...n,
        data: { ...n.data, status: "idle" as const },
      })),
    });
  },

  toggleLock: () => set({ locked: !get().locked }),
  setLocked: (locked) => set({ locked }),

  // ─── Backend task lifecycle ──────────────────────────────

  setCurrentTask: (id) =>
    set({
      currentTaskId: id,
      taskMirror: null,
      phase: null,
      plan: null,
      diff: null,
      verdict: null,
      liveScore: null,
      nodeScores: {},
      escalationReason: null,
      doneSummary: null,
      errorMessage: null,
      logs: [],
      awaitingConfirmation: false,
      awaitingFeedback: false,
      // Caller is responsible for setting isRunning accurately after the
      // load — this function only clears the mirror. Use `loadTask(task)`
      // for selecting an existing task, or call `setCurrentTask` + manual
      // `isRunning` flip for a freshly-created task (handled in App).
      isRunning: false,
    }),
  /**
   * Select an existing task by loading the full Task object. Sets every
   * piece of derived state — phase, awaiting flags, isRunning — from the
   * task's actual status, so the UI doesn't briefly show "running" on a
   * finished task.
   */
  loadTask: (task) => {
    const status = task.status;
    set({
      currentTaskId: task.id,
      taskMirror: task,
      phase: status,
      // Hydrate plan / diff / verdict from the loaded task — these are
      // persisted on disk and shouldn't require a WS re-broadcast to
      // surface in the UI. Without this, refreshing the page while a
      // task is in plan_review shows "Loading plan..." forever.
      plan: task.plan ?? null,
      diff: task.diff ?? null,
      verdict: task.verdict ?? null,
      escalationReason: task.escalationReason ?? null,
      doneSummary:
        status === "done"
          ? `Task approved on attempt ${task.attempt}.`
          : null,
      errorMessage: null,
      logs: [],
      awaitingConfirmation: status === "plan_review",
      awaitingFeedback:
        status === "verifying" && task.verdict?.outcome === "REJECT",
      isRunning: ACTIVE_PHASES.includes(status),
      nodes: get().nodes.map((n) => ({
        ...n,
        data: { ...n.data, status: "idle" as const },
      })),
    });
  },
  setTaskMirror: (t) => {
    // previewUrl often arrives via a task_update broadcast with no
    // accompanying phase transition (the orchestrator registers it
    // mid-attempt, before "verifying"), so `applyTaskStatusToNodes`
    // alone would leave `live_preview` idle until the next phase
    // change. Recompute its status here too, same as done/escalated
    // paths in applyTaskStatusToNodes.
    const previewLive = Boolean(t?.previewUrl);
    set({
      taskMirror: t,
      nodes: get().nodes.map((n) =>
        n.id === "live_preview"
          ? { ...n, data: { ...n.data, status: (previewLive ? "success" : "idle") as RunStatus } }
          : n
      ),
    });
  },
  setPhase: (_from, to) => set({ phase: to }),
  appendLog: (entry) =>
    set((s) => ({ logs: [...s.logs, entry].slice(-500) })),
  setPlan: (p) => set({ plan: p }),
  setDiff: (d) => set({ diff: d }),
  setVerdict: (v) =>
    set({
      verdict: v,
      // Final verdict arrived — clear the live score so the UI shows the
      // canonical verdict instead of the streaming partial.
      liveScore: null,
      awaitingFeedback: v.outcome === "REJECT",
    }),
  setLiveScore: (s) => set({ liveScore: s }),
  setNodeScore: (nodeId, entry) =>
    set((s) => ({ nodeScores: { ...s.nodeScores, [nodeId]: entry } })),
  setEscalation: (reason) =>
    set({
      escalationReason: reason,
      isRunning: false,
      awaitingFeedback: false,
    }),
  setDone: (summary) =>
    set({
      doneSummary: summary,
      isRunning: false,
      awaitingConfirmation: false,
      awaitingFeedback: false,
    }),
  setError: (message) => set({ errorMessage: message }),

  setNodeStatus: (nodeId, status) => {
    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, status } }
          : n
      ),
    });
  },

  applyTaskStatusToNodes: (status, _attempt) => {
    // Reset all then highlight the active node based on backend phase
    const activeNodeId = STATUS_TO_NODE[status] ?? null;
    // `live_preview` tracks the URL itself, not the loop phase — the
    // orchestrator registers a preview well before the task reaches
    // "done" (right after the maker's runtime check), so this node
    // should light up the moment a link exists rather than waiting for
    // final approval. Computed once here and forced onto every branch
    // below so the generic phase-based status logic never overrides it.
    const mirror = get().taskMirror;
    const previewLive = Boolean(mirror?.previewUrl);
    // Downstream-of-active: nodes the loop will visit next. Marked
    // "queued" so they get a subtle pulse — the user can tell the
    // pipeline has more to do, instead of assuming the run is stuck.
    // Skipped for terminal phases (done / escalated) where the graph
    // is fully resolved.
    const edges = get().edges;
    const isTerminal = status === "done" || status === "escalated" || status === "cancelled";
    const downstream = isTerminal
      ? new Set<string>()
      : collectDownstream(activeNodeId, edges);
    // Everything upstream of the active node in the main pipeline has
    // finished — paint it success so the frequent task_update broadcasts
    // don't wipe completed nodes back to idle mid-run (that wipe was the
    // "canvas looks stuck" bug: node_status refinements from the backend
    // were clobbered by the very next task_update).
    const activeIdx = activeNodeId ? PIPELINE_ORDER.indexOf(activeNodeId) : -1;
    // Verifier REJECT parks the loop on the verdict/retry pair awaiting
    // feedback — the verifier itself is finished at that point.
    const awaitingRetry =
      status === "verifying" && mirror?.verdict?.outcome === "REJECT";
    set({
      phase: status,
      awaitingConfirmation: status === "plan_review",
      isRunning: !["done", "escalated", "cancelled"].includes(status),
      nodes: get().nodes.map((n) => {
        if (n.id === "live_preview") {
          return {
            ...n,
            data: { ...n.data, status: (previewLive ? "success" : "idle") as RunStatus },
          };
        }
        const idx = PIPELINE_ORDER.indexOf(n.id);
        let next: RunStatus;
        if (awaitingRetry && (n.id === "verdict" || n.id === "retry")) {
          next = "waiting";
        } else if (awaitingRetry && n.id === "verifier") {
          next = "success";
        } else if (n.id === activeNodeId) {
          next = "running";
        } else if (idx !== -1 && activeIdx !== -1 && idx < activeIdx) {
          next = "success";
        } else if (downstream.has(n.id)) {
          next = "queued";
        } else {
          next = "idle";
        }
        return {
          ...n,
          data: {
            ...n.data,
            status: next,
          },
        };
      }),
    });
    if (status === "done") {
      set({
        nodes: get().nodes.map((n) => ({
          ...n,
          data: {
            ...n.data,
            status: (n.id === "live_preview"
              ? previewLive
                ? "success"
                : "idle"
              : n.id === "done"
              ? "success"
              : n.id === "escalated"
              ? "idle"
              : PIPELINE_ORDER.includes(n.id)
              ? "success"
              : "idle") as RunStatus,
          },
        })),
      });
    }
    if (status === "escalated") {
      // Keep completed work visible: derive chain successes from what the
      // task actually produced instead of blanking the whole canvas.
      const done = new Set<string>(["task", "orchestrator"]);
      if (mirror?.plan) {
        done.add("planner");
        done.add("plan_review");
      }
      if (mirror?.diff) {
        done.add("read_state");
        done.add("maker");
      }
      if (mirror?.verdict) done.add("verifier");
      set({
        nodes: get().nodes.map((n) => ({
          ...n,
          data: {
            ...n.data,
            status: (n.id === "live_preview"
              ? previewLive
                ? "success"
                : "idle"
              : n.id === "escalated"
              ? "error"
              : n.id === "verdict" && mirror?.verdict
              ? "error"
              : done.has(n.id)
              ? "success"
              : "idle") as RunStatus,
          },
        })),
      });
    }
  },

  resetTaskState: () =>
    set({
      currentTaskId: null,
      taskMirror: null,
      phase: null,
      plan: null,
      diff: null,
      verdict: null,
      liveScore: null,
      nodeScores: {},
      escalationReason: null,
      doneSummary: null,
      errorMessage: null,
      logs: [],
      awaitingConfirmation: false,
      awaitingFeedback: false,
      isRunning: false,
      nodes: get().nodes.map((n) => ({
        ...n,
        data: { ...n.data, status: "idle" as const },
      })),
    }),

  setWsStatus: (s) => set({ wsStatus: s }),

  // ─── Per-group model config ──────────────────────────────────────
  nodeModels: loadNodeModelsFromStorage(),
  setNodeModel: (group, model) => {
    set((s) => ({
      nodeModels: { ...s.nodeModels, [group]: model },
    }));
    // Persist after each set so refresh doesn't lose the user's picks.
    saveNodeModelsToStorage(get().nodeModels);
  },
}));

// Apply theme on first load (before first render)
if (typeof document !== "undefined") {
  const stored = (localStorage.getItem("theme") as Theme) || "light";
  const root = document.documentElement;
  root.classList.toggle("dark", stored === "dark");
  root.dataset.theme = stored;
  root.style.colorScheme = stored;
}

// ─── Persisted per-group model config ─────────────────────────────────
// Loaded synchronously at module init so the store starts with the user's
// previous picks rather than defaults.
function loadNodeModelsFromStorage(): Record<NodeGroupId, string> {
  const defaults: Record<NodeGroupId, string> = {
    planning: DEFAULT_MODEL_ID,
    implementation: DEFAULT_MODEL_ID,
    review: DEFAULT_MODEL_ID,
  };
  if (typeof window === "undefined") return defaults;
  try {
    const raw = localStorage.getItem("loopNodeModels");
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<NodeGroupId, string>>;
    // Merge over defaults so a new group key gets default-model without
    // erasing the user's existing picks.
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function saveNodeModelsToStorage(models: Record<NodeGroupId, string>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem("loopNodeModels", JSON.stringify(models));
  } catch {
    /* quota exceeded / private mode — silently ignore */
  }
}