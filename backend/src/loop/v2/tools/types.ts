import type { ZodType } from "zod";
import type { AntiCheatResult, WorkdirSnapshot } from "../anti-cheat.js";
import type { PlanSchema } from "../schemas.js";
import type { CheckEventSink } from "../checks.js";

export type ToolRole = "planner" | "maker" | "verifier";

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolSuccess<T = unknown> {
  ok: true;
  value: T;
  error?: never;
  tool?: string;
  toolCallId?: string;
  isError?: false;
  content?: string;
  truncated?: boolean;
}

export interface ToolFailure {
  ok: false;
  error: ToolError;
  tool?: string;
  toolCallId?: string;
  isError?: true;
  content?: string;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: ToolError;
  tool?: string;
  toolCallId?: string;
  isError?: boolean;
  content?: string;
  truncated?: boolean;
}

export type ToolHandlerResult<T = unknown> =
  | { ok: true; value: T; content?: string; truncated?: boolean }
  | { ok: false; error: ToolError };


export interface ToolContext {
  workdir: string;
  role?: ToolRole;
  runId?: string;
  itemId?: string;
  attemptId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
  /** Approved plan for this attempt. `approvedPlan` is accepted as an alias. */
  plan?: PlanSchema;
  approvedPlan?: PlanSchema;
  /** Direct test/integration override for the plan's filesToTouch. */
  allowedFiles?: readonly string[];
  /** `false` disables only the plan allowlist, matching the legacy bridge. */
  enforceAllowlist?: boolean;
  eventLog?: CheckEventSink;
  /** Optional attempt baseline. If absent, write tools snapshot per call. */
  makerBaseline?: WorkdirSnapshot;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  roles: readonly ToolRole[];
  description: string;
  schema: ZodType<TInput, any, unknown>;
  /** AI SDK-friendly aliases; all point at the same zod schema. */
  inputSchema: ZodType<TInput, any, unknown>;
  parameters: ZodType<TInput, any, unknown>;
  eventType?: string;
  execute(input: TInput, context: ToolContext, toolCallId?: string): Promise<ToolResult<TOutput>>;
}

export interface ToolEventPayload {
  toolCallId: string;
  toolName: string;
  role?: ToolRole;
  ok: boolean;
  durationMs: number;
  inputSummary: unknown;
  observation?: unknown;
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: unknown;
  antiCheat?: Pick<AntiCheatResult, "clean" | "reasons">;
}
