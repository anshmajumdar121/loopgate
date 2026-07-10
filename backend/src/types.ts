// Shared types between backend and frontend.

export type TaskStatus =
  | "draft"
  | "planning"
  | "plan_review"
  | "implementing"
  | "verifying"
  | "done"
  | "escalated"
  | "cancelled";

export type AgentRole = "orchestrator" | "planner" | "maker" | "verifier" | "system";

export type LogLevel = "info" | "stdout" | "stderr" | "error";

export interface PlanSummary {
  steps: number;
  filesToTouch: string[];
  criteria: string[];
  risks: string[];
  notes: string;
  /** Plain markdown of the planner's GOAL.md output for raw display */
  rawGoal: string;
}

export interface DiffFileChange {
  path: string;
  reason: string;
}

export interface DiffSummary {
  attempt: number;
  filesChanged: DiffFileChange[];
  buildExit: number;
  testsPassed: number;
  testsFailed: number;
  testsLintExit: number;
  notes: string;
}

export interface CriteriaWalkItem {
  criterion: string;
  passed: boolean;
  evidence: string;
}

export type VerdictOutcome = "APPROVE" | "REJECT" | "ESCALATE_HUMAN";

export interface Verdict {
  attempt: number;
  outcome: VerdictOutcome;
  buildExit: number;
  testsPassed: number;
  testsFailed: number;
  scopePass: boolean;
  intentPass: boolean;
  noCheatingPass: boolean;
  risk: "LOW" | "MEDIUM" | "HIGH";
  criteriaWalk: CriteriaWalkItem[];
  requiredFixes: string[];
  oneLineReason: string;
}

export interface HistoryEntry {
  ts: string;
  phase: string;
  message: string;
}

export interface LogEntry {
  ts: string;
  agent: AgentRole;
  stream: LogLevel;
  text: string;
}

/**
 * A Project is a top-level workspace the user creates ("Loop Agent",
 * "OpenFlowCut"). Projects contain sessions, and tasks optionally attach
 * to a session within a project. The hierarchy is Project → Session →
 * Task, but `Task.projectId` / `Task.sessionId` are optional — tasks
 * without them sit in the catch-all "Unassigned" bucket so the existing
 * flow keeps working.
 *
 * `rootPath` is the absolute filesystem path the user picked in the New
 * Project modal's Browse button. It's optional — projects without one
 * have no anchored directory and tasks under them fall back to the
 * default workdir derivation. When set, opening the project surfaces
 * this path (e.g. in the sidebar) so the user can `cd` into the project's
 * actual workspace.
 */
export interface Project {
  id: string;
  name: string;
  description?: string;
  rootPath?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A Session is a grouping of related tasks within a project. The user
 * creates them explicitly ("Real Agent Spawning", "Improve UI Nodes") and
 * tasks that the user starts in this session share its scope.
 */
export interface Session {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  workdir: string;
  status: TaskStatus;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  /** Default model ID — used when the matching `modelOverrides` slot is unset. */
  model?: string;
  /** Per-agent-role model overrides. The planner agent uses `.planning`,
   *  the maker uses `.implementation`, the verifier uses `.review`. Falls
   *  back to the top-level `model` field, then to whatever's in
   *  `opencode.json`. */
  modelOverrides?: {
    planning?: string;
    implementation?: string;
    review?: string;
  };
  plan?: PlanSummary;
  diff?: DiffSummary;
  verdict?: Verdict;
  history: HistoryEntry[];
  logs: LogEntry[];
  agentPid?: number;
  escalationReason?: string;
  /** Live static preview of the workdir (set once the maker has produced
   *  output). Served by loop/preview-server.ts. Optional + additive so
   *  previously persisted tasks keep loading. */
  previewUrl?: string;
  /** Absolute paths of reference files whose contents are inlined into the
   *  planner and maker prompts ("here's how the existing feature works").
   *  Capped at 20KB/file, 60KB total at prompt-build time. */
  contextFiles?: string[];
  /** Optional project + session this task belongs to. Tasks without
   *  these stay in the "Unassigned" bucket and never appear inside any
   *  Project > Session tree. */
  projectId?: string;
  sessionId?: string;
}

/**
 * Agent role → group key on `Task.modelOverrides`. Used by the orchestrator
 * when spawning each agent to pick the right override. Single source of
 * truth — add a role here and the orchestrator picks the correct model.
 */
export function modelOverrideKeyForRole(
  role: "planner" | "maker" | "verifier"
): "planning" | "implementation" | "review" {
  switch (role) {
    case "planner":
      return "planning";
    case "maker":
      return "implementation";
    case "verifier":
      return "review";
  }
}

// ----
// WebSocket message envelope types

export type WsClientMessage =
  | { type: "subscribe"; taskId: string }
  | { type: "unsubscribe"; taskId: string }
  | { type: "ping" };

export type WsServerMessage =
  | { type: "pong" }
  | { type: "task_update"; taskId: string; task: Task }
  | { type: "log"; taskId: string; entry: LogEntry }
  | { type: "phase_change"; taskId: string; from: TaskStatus; to: TaskStatus }
  | { type: "node_status"; taskId: string; nodeId: string; status: string }
  | { type: "plan_ready"; taskId: string; plan: PlanSummary }
  | { type: "diff_ready"; taskId: string; diff: DiffSummary }
  | { type: "verdict"; taskId: string; verdict: Verdict }
  | { type: "escalation"; taskId: string; reason: string }
  | { type: "done"; taskId: string; summary: string }
  | { type: "error"; taskId: string; message: string }
  | { type: "task_re_prompted"; taskId: string; prompt: string; attempt: number }
  | { type: "task_deleted"; taskId: string };

// ----
// REST request bodies

export interface CreateTaskBody {
  prompt: string;
  title?: string;
  workdir?: string;
  /** Skip the plan-confirmation gate and let the mock run end-to-end */
  autoApprovePlan?: boolean;
  /** Optional default model — `provider/model-name` form. */
  model?: string;
  /** Optional per-role overrides. Same provider/model-name form per slot. */
  modelOverrides?: {
    orchestration?: string;
    planning?: string;
    implementation?: string;
    review?: string;
  };
  /** Optional scoping. When `projectId` is set, the task shows under
   *  that project in the sidebar; when `sessionId` is also set, it
   *  nests under the session within the project. Either may be set
   *  independently of the other (an unassigned session within a
   *  project is valid). */
  projectId?: string;
  sessionId?: string;
  /** Absolute paths of reference files whose contents are inlined into the
   *  planner and maker prompts ("here's how the existing feature works").
   *  Capped at 20KB/file, 60KB total at prompt-build time. */
  contextFiles?: string[];
}

export interface ConfirmPlanBody {
  /** Optional user adjustments to the plan in free text */
  adjustments?: string;
}

export interface FeedbackBody {
  /** User feedback after a REJECT verdict — drives next attempt */
  feedback: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connections — user-configured external API endpoints (OpenAI-compatible
// proxies, Anthropic-compatible proxies, etc.) that are surfaced in the
// model picker. Persisted to `_connections.json` on disk.
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectionProviderType = "openai-compatible" | "anthropic-compatible";

/** A curated provider id used to drive defaults (endpoint, models, hints)
 *  in the Connections UI. The frontend ships a catalog of presets; users
 *  pick one when adding a connection. "custom" means the user types
 *  everything themselves — endpoint, model, key. */
export type ConnectionProviderId =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "custom";

/** A single model exposed by a Connection. The `id` is what the upstream
 *  provider calls this model (e.g. "gpt-4o", "llama3.1:70b"). The `label`
 *  is what the UI shows in the picker — defaults to `id` if omitted. */
export interface ConnectionModel {
  id: string;
  label?: string;
  contextWindow?: number;
}

/**
 * A user-configured external API endpoint. There are two equivalent ways to
 * describe the model(s) a connection exposes:
 *
 *   1. **`model` + `modelLabel` + `temperature` (preferred, single-profile):**
 *      a single (provider, model, key) tuple with a baked-in temperature.
 *      This is what the redesigned "Manual setup" form in the UI creates —
 *      each connection = one ready-to-use model profile. To use multiple
 *      models via the same provider, create multiple connections.
 *
 *   2. **`models: ConnectionModel[]` (legacy, multi-model):** kept for
 *      backwards compat with the previous UI. A connection that still
 *      carries a `models[]` array is rendered in the picker as multiple
 *      selectable model rows; one connection = N model profiles.
 *
 * The picker renders whichever shape is present. New UI always writes
 * shape #1.
 */
export interface Connection {
  id: string;
  name: string;
  description?: string;
  providerId?: ConnectionProviderId;
  providerType: ConnectionProviderType;
  baseUrl: string;
  hasApiKey: boolean;
  /** Raw apiKey when freshly read from disk via getConnection(). NEVER
   *  serialised to clients — only the list endpoint (without `key`) and
   *  create/update responses return apiKey for the brief moment it is
   *  being set. */
  apiKey?: string;
  /** Single-model form: the upstream's model id (e.g. `openai/gpt-4o-mini`). */
  model?: string;
  /** Friendly label for the single-model form (defaults to `model` if absent). */
  modelLabel?: string;
  /** 0..1, what the spawned agent should pass as `temperature` to the
   *  upstream. Default 0.7 when not set. */
  temperature?: number;
  /** Optional roles this connection is "dedicated to". When a role is
   *  listed, the connection appears at the top of the model picker for
   *  that role with a "Dedicated" badge — semantically this is the
   *  default model the user wants for that role. A connection can be
   *  dedicated to multiple roles (e.g. one OpenAI connection used by
   *  both Planning and Review). Empty array / unset means "general use",
   *  shown without a dedicated badge. */
  roles?: Array<"planning" | "implementation" | "review">;
  /** Legacy multi-model form. Rendered as separate picker entries when
   *  `model` is absent. */
  models?: ConnectionModel[];
  createdAt: string;
  updatedAt: string;
}

/** Wire shape returned by GET /api/connections — same as Connection but
 *  `apiKey` is replaced with `hasApiKey: boolean`. The frontend uses this
 *  to decide whether to show "Set API key" in the edit form without
 *  ever seeing the key itself. */
export type ConnectionSummary = Omit<Connection, "apiKey"> & {
  hasApiKey: boolean;
};

/** Request body for POST /api/connections and PATCH /api/connections/:id.
 *  apiKey is OPTIONAL on PATCH; when omitted the existing key is kept.
 *  `model` + `temperature` are the new single-profile shape; `models[]`
 *  is the legacy multi-model shape. The two are mutually exclusive in
 *  the UI but the schema accepts both for backwards compat. */
export interface UpsertConnectionBody {
  name: string;
  description?: string;
  providerId?: ConnectionProviderId;
  providerType: ConnectionProviderType;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  modelLabel?: string;
  temperature?: number;
  roles?: Array<"planning" | "implementation" | "review">;
  models?: ConnectionModel[];
}