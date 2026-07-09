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
  setTaskMirror: (t) => set({ taskMirror: t }),
  setPhase: (_from, to) => set({ phase: to }),
  appendLog: (entry) =>
    set((s) => ({ logs: [...s.logs, entry].slice(-500) })),
  setPlan: (p) => set({ plan: p }),
  setDiff: (d) => set({ diff: d }),
  setVerdict: (v) =>
    set({
      verdict: v,
      awaitingFeedback: v.outcome === "REJECT",
    }),
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
    set({
      phase: status,
      awaitingConfirmation: status === "plan_review",
      isRunning: !["done", "escalated", "cancelled"].includes(status),
      nodes: get().nodes.map((n) => {
        const isActive = n.id === activeNodeId;
        // Keep prior success states (planner/done already done)
        const prior =
          status === "implementing" || status === "verifying"
            ? n.id === "planner" || n.id === "plan_review"
              ? "success"
              : "idle"
            : status === "done"
            ? "success"
            : "idle";
        return {
          ...n,
          data: {
            ...n.data,
            status: isActive ? "running" : (prior as RunStatus),
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
            status: (n.id === "done"
              ? "success"
              : n.id === "escalated"
              ? "idle"
              : n.id === "task" ||
                n.id === "orchestrator" ||
                n.id === "planner" ||
                n.id === "plan_review" ||
                n.id === "read_state" ||
                n.id === "maker" ||
                n.id === "verifier"
              ? "success"
              : "idle") as RunStatus,
          },
        })),
      });
    }
    if (status === "escalated") {
      set({
        nodes: get().nodes.map((n) => ({
          ...n,
          data: {
            ...n.data,
            status: (n.id === "escalated"
              ? "error"
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