// Frontend mirror of backend types (src/types.ts on the server).
// Kept in sync manually for v1 — would be a shared package in production.

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
  rawGoal: string;
}

export interface DiffFileChange {
  path: string;
  reason: string;
}

export interface DiffSummary {
  attempt: number;
  filesChanged: DiffFileChange[];
  /** `null` when the maker didn't state a build exit (e.g. static files,
   *  no build step) — render "n/a", never NaN. */
  buildExit: number | null;
  testsPassed: number;
  testsFailed: number;
  testsLintExit: number | null;
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
  buildExit: number | null;
  testsPassed: number;
  testsFailed: number;
  scopePass: boolean;
  intentPass: boolean;
  noCheatingPass: boolean;
  risk: "LOW" | "MEDIUM" | "HIGH";
  criteriaWalk: CriteriaWalkItem[];
  requiredFixes: string[];
  oneLineReason: string;
  /** 0-100 quality score. Parsed from the verifier's `**Score:** NN/100`
   *  line; falls back to round(100 * criteriaPassed/criteriaTotal) when
   *  the line is absent. Optional — older persisted verdicts lack it. */
  score?: number;
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
  /** Model ID in `provider/model-name` form. */
  model?: string;
  plan?: PlanSummary;
  diff?: DiffSummary;
  verdict?: Verdict;
  history: HistoryEntry[];
  logs: LogEntry[];
  agentPid?: number;
  escalationReason?: string;
  /** Live static preview of the workdir (set once the maker has produced
   *  output). Served by the backend's preview-server. Optional + additive
   *  so previously persisted tasks keep loading. */
  previewUrl?: string;
  /** Summary of the most recent headless-browser runtime check. Optional +
   *  additive — mirrors backend/src/types.ts Task.runtimeCheck. */
  runtimeCheck?: {
    attempt: number;
    ok: boolean;
    pageErrorCount: number;
    consoleErrorCount: number;
    screenshotRelPath: string | null;
  };
  /** Set at task creation; if true, the orchestrator skips the plan_review
   *  user gate and proceeds straight to implementation. Mirrors
   *  backend/src/types.ts Task.autoApprovePlan. */
  autoApprovePlan?: boolean;
  /** Optional project + session this task belongs to. Tasks without
   *  these stay in the "Unassigned" bucket and never appear inside any
   *  Project > Session tree. */
  projectId?: string;
  sessionId?: string;
  /** Per-attempt timeline. One record per implement→verify cycle,
   *  populated by the orchestrator at the end of each cycle. Mirrors
   *  backend/src/types.ts Task.attempts + AttemptRecord. Optional +
   *  additive — tasks created before this field existed load with
   *  attempts: undefined and the UI renders nothing for them. */
  attempts?: AttemptRecord[];
}

/**
 * Row-sized view returned by GET /api/tasks (the list). Mirrors
 * backend/src/types.ts TaskSummary. It deliberately has no prompt, plan,
 * diff, verdict, history or logs: fetch GET /api/tasks/:id (see
 * lib/selectTask.ts) when a task is opened.
 */
export type TaskSummary = Pick<
  Task,
  | "id"
  | "title"
  | "workdir"
  | "status"
  | "attempt"
  | "maxAttempts"
  | "createdAt"
  | "updatedAt"
  | "model"
  | "escalationReason"
  | "previewUrl"
  | "projectId"
  | "sessionId"
>;

/**
 * Per-attempt timeline row. Mirrors backend/src/types.ts AttemptRecord.
 * Every field is optional because the orchestrator may not reach every
 * phase (e.g. a maker crash skips runtime + verify). The UI renders
 * gracefully when most fields are missing — see AttemptTimeline.tsx.
 */
export interface AttemptRecord {
  attemptNumber: number;
  makerMs?: number;
  runtimeCheckMs?: number;
  verifierMs?: number;
  filesChanged?: { path: string; reason: string }[];
  runtimeResult?: {
    passed: boolean;
    consoleErrorCount: number;
    pageErrorCount: number;
    screenshotRelPath: string | null;
  };
  verifierVerdict?: "APPROVE" | "REJECT" | "ESCALATE_HUMAN";
  rejectReason?: string;
  artifactPaths?: {
    maker?: string;
    runtimeJson?: string;
    runtimePng?: string;
    verifier?: string;
  };
  stuckDetected?: boolean;
  validation?: {
    passed: boolean;
    errors: string[];
  };
  /** Stall watchdog events for this attempt. Mirrors
   *  backend/src/types.ts AttemptRecord.stalls. */
  stalls?: StallRecord[];
  /** Build/test stage results. Mirrors backend/src/types.ts
   *  BuildRunRecord. Present only for project-shaped workdirs. */
  buildRun?: BuildRunRecord;
  completedAt?: string;
}

/**
 * Per-attempt build/test stage results. Mirrors backend/src/types.ts
 * BuildRunRecord. Optional + additive.
 */
export interface BuildRunRecord {
  installMs?: number;
  buildMs?: number;
  testMs?: number;
  buildExit?: number;
  testExit?: number;
  failedStage?: "install" | "build" | "test";
  outputTail?: string;
}

/**
 * One row in the per-attempt stall watchdog log. Mirrors
 * backend/src/types.ts StallRecord. Optional + additive.
 */
export interface StallRecord {
  phase: "planner" | "verifier" | "maker";
  stalledAfterMs: number;
  resolution: "partial-output" | "reinvoke" | "escalated";
}

/**
 * A Project is a top-level workspace the user creates ("Loop Agent",
 * "OpenFlowCut"). Projects contain sessions, and tasks optionally attach
 * to a session within a project. The hierarchy is Project → Session →
 * Task.
 */
export interface Project {
  id: string;
  name: string;
  description?: string;
  /** Absolute filesystem path the user picked in the New Project modal's
   *  Browse button. When set, this is the project's workspace root —
   *  opening the project in the sidebar surfaces it. */
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
  | {
      type: "verifier_progress";
      taskId: string;
      attempt: number;
      passed: number;
      total: number;
      partial: Array<{ criterion: string; passed: boolean; evidence: string }>;
      done: boolean;
    }
  // Per-node score breakdown. Fired alongside verifier_progress (same
  // cadence) so the canvas can show a small /10 badge on whichever nodes
  // contributed criteria this attempt. `nodeId` matches a canvas node id
  // ("planner" / "maker" / "verifier"); the UI ignores unknown ids.
  | {
      type: "node_score";
      taskId: string;
      attempt: number;
      nodeId: string;
      passed: number;
      total: number;
      score: number;
      done: boolean;
    }
  | { type: "escalation"; taskId: string; reason: string }
  | { type: "done"; taskId: string; summary: string }
  | { type: "error"; taskId: string; message: string }
  | { type: "task_re_prompted"; taskId: string; prompt: string; attempt: number }
  | { type: "task_deleted"; taskId: string }
  // Not task-scoped: fired whenever a connection's automated health check
  // changes status. The Connections panel refreshes its list on receipt.
  | { type: "connection_health"; connectionId: string; health: ConnectionHealth };

export interface CreateTaskBody {
  prompt: string;
  title?: string;
  workdir?: string;
  /** Absolute paths of reference files inlined into the planner/maker
   *  prompts. Mirrors backend/src/types.ts CreateTaskBody.contextFiles. */
  contextFiles?: string[];
  autoApprovePlan?: boolean;
  model?: string;
  modelOverrides?: {
    planning?: string;
    implementation?: string;
    review?: string;
  };
  /** Optional scoping. When `projectId` is set, the task shows under that
   *  project in the sidebar; when `sessionId` is also set, it nests under
   *  the session within the project. Either may be set independently of
   *  the other (an unassigned session within a project is valid). */
  projectId?: string;
  sessionId?: string;
}

/** Curated list of model options shown in the New Task modal. The
 *  picker writes the chosen `provider/model-name` into `Task.model`,
 *  which the spawner forwards to opencode via env + CLI flag. When unset,
 *  the orchestrator falls back to whatever's configured in `opencode.json`. */
export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  /** Short, plain-language description shown next to the label. */
  blurb: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connections — user-configured external API endpoints (OpenAI-compatible,
// Anthropic-compatible). Models exposed by connections show up in the
// model picker alongside the curated MODEL_OPTIONS.
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectionProviderType =
  | "openai-compatible"
  | "anthropic-compatible"
  | "local-cli"
  | "mavis-cli";

/** Curated provider ids. Drives the provider dropdown in the Connections UI
 *  — each id maps to a preset with default endpoint, model list, hints.
 *  "custom" is the BYO-endpoint catch-all. */
export type ConnectionProviderId =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "local-cli"
  | "mavis-cli"
  | "custom";

export interface ConnectionModel {
  id: string;
  label?: string;
  contextWindow?: number;
}

export type ConnectionRole = "planning" | "implementation" | "review";

export interface Connection {
  id: string;
  name: string;
  description?: string;
  providerId?: ConnectionProviderId;
  providerType: ConnectionProviderType;
  baseUrl: string;
  hasApiKey: boolean;
  /** Single-model form: the upstream's model id. The picker exposes this
   *  connection as ONE option (the one selected model). */
  model?: string;
  modelLabel?: string;
  temperature?: number;
  /** Agent roles this connection is "dedicated to". When a role is listed,
   *  the connection surfaces at the top of the model picker for that
   *  role with a "Dedicated" badge — semantically it's the user's
   *  preferred model for that phase. A connection can be dedicated to
   *  multiple roles. Empty array / undefined = general use. */
  roles?: ConnectionRole[];
  /** Legacy multi-model form. Rendered as multiple picker options when
   *  `model` is absent. */
  models?: ConnectionModel[];
  /** Latest automated health-check result (backend connection-health
   *  monitor). Optional + additive — absent means "never checked". */
  health?: ConnectionHealth;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertConnectionBody {
  name: string;
  description?: string;
  providerId?: ConnectionProviderId;
  providerType: ConnectionProviderType;
  baseUrl: string;
  /** Optional. On PATCH: omit to keep existing; empty string clears it. */
  apiKey?: string;
  /** Single-model form (preferred): the upstream model id. */
  model?: string;
  modelLabel?: string;
  temperature?: number;
  /** Optional role dedication: which agent roles this connection powers. */
  roles?: ConnectionRole[];
  /** Legacy multi-model form: list of models. Rendered as one picker entry
   *  per model when `model` is absent. */
  models?: ConnectionModel[];
}

/** Result of the most recent automated health check for a connection. */
export interface ConnectionHealth {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  /** ISO-8601 timestamp of when the check ran. */
  checkedAt: string;
}

/** Build the model id used internally when referring to a model that
 *  comes from a user-defined Connection. Format: `custom:<connId>:<modelId>`. */
export function customModelId(connId: string, modelId: string): string {
  return `custom:${connId}:${modelId}`;
}

/** Inverse of `customModelId`. Returns null if the id isn't a custom one. */
export function parseCustomModelId(
  modelId: string
): { connId: string; modelId: string } | null {
  if (!modelId.startsWith("custom:")) return null;
  const parts = modelId.split(":");
  if (parts.length < 3) return null;
  return {
    connId: parts[1],
    modelId: parts.slice(2).join(":"),
  };
}

/**
 * Flat list of models (curated + custom), shaped like ModelOption so the
 * existing pickers can render them unchanged.
 *
 * Connections can be in either of two shapes:
 *   - Single-model form (`connection.model` set): contributes exactly ONE
 *     picker option — the user already chose which model to use when
 *     configuring the connection.
 *   - Legacy multi-model form (`connection.models[]` set): contributes
 *     one picker option per model — kept for back-compat with v1.
 */
export function dynamicModelOptions(
  conns: Array<
    Pick<Connection, "id" | "name" | "baseUrl"> &
      Partial<Pick<Connection, "model" | "modelLabel" | "models">>
  >
): ModelOption[] {
  const custom: ModelOption[] = [];
  for (const c of conns) {
    if (c.model) {
      custom.push({
        id: customModelId(c.id, c.model),
        label: c.modelLabel || c.model,
        provider: `via ${c.name}`,
        blurb: `${c.model} on ${c.baseUrl}`,
      });
    } else if (c.models) {
      for (const m of c.models) {
        custom.push({
          id: customModelId(c.id, m.id),
          label: m.label || m.id,
          provider: `via ${c.name}`,
          blurb: `${m.id} on ${c.baseUrl}`,
        });
      }
    }
  }
  // Curated first, custom after — keeps the "familiar defaults" section at
  // the top so users can pick from those without scrolling past user additions.
  return [...MODEL_OPTIONS, ...custom];
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "opencode-go/minimax-m3",
    label: "MiniMax-M3",
    provider: "opencode-go",
    blurb: "Default. Fast + cheap. Good for everyday tasks.",
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    label: "Claude Sonnet 4.5",
    provider: "anthropic",
    blurb: "Strong reasoning. Best for nuanced planning.",
  },
  {
    id: "openai/gpt-5",
    label: "GPT-5",
    provider: "openai",
    blurb: "Careful verifier. Best for catch-the-bug reviews.",
  },
  {
    id: "google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "google",
    blurb: "Balanced speed + quality. Good middle ground.",
  },
  {
    id: "ollama/llama-3.3-70b",
    label: "Local Ollama (Llama 3.3 70B)",
    provider: "ollama",
    blurb: "Runs on your CPU. Slowest, fully private.",
  },
];

export const DEFAULT_MODEL_ID = "opencode-go/minimax-m3";

// ─────────────────────────────────────────────────────────────────────────────
// Token usage — aggregated counters per model, populated by the backend
// agent spawner as LLM calls complete. The UI reads this through
// `useTokenUsage` (see lib/useTokenUsage.ts) and shows totals / per-model
// rows in the Connections panel.
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenUsageEntry {
  /** Picker-facing model id (`custom:<connId>:<upstreamId>` or
   *  `provider/model-name`). Stable across restarts. */
  modelId: string;
  /** Friendly upstream model id (e.g. `minimax/minimax-m3`). */
  upstreamModel: string;
  /** Connection id this model belongs to, or null for curated entries. */
  connectionId: string | null;
  /** Connection name for display, or null for curated entries. */
  connectionName: string | null;
  /** Connection baseUrl for display, or null for curated entries. */
  baseUrl: string | null;
  /** Cumulative prompt (input) tokens. */
  promptTokens: number;
  /** Cumulative completion (output) tokens. */
  completionTokens: number;
  /** Cumulative total tokens. = prompt + completion. */
  totalTokens: number;
  /** Number of LLM calls captured for this model. */
  callCount: number;
  /** Last time usage was recorded (ISO timestamp). */
  lastUsed: string;
}

export interface TokenUsageTotals {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;
  modelCount: number;
}

export interface TokenUsageSnapshot {
  entries: TokenUsageEntry[];
  totals: TokenUsageTotals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection test — result of POST /api/connections/:id/test
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectionTestStatus =
  | "connected"
  | "failed"
  | "no_key"
  | "unsupported";

export interface ConnectionTestResult {
  ok: boolean;
  status: ConnectionTestStatus;
  message: string;
  latencyMs?: number;
  endpoint?: string;
  /** ISO timestamp captured client-side when the result landed. */
  testedAt: string;
}