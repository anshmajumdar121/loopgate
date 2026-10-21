import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import type { AntiCheatResult } from "../anti-cheat.js";
import type { ToolContext, ToolDefinition, ToolError, ToolHandlerResult, ToolResult } from "./types.js";

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_EVENT_OUTPUT_BYTES = 8 * 1024;
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_LIST_ENTRIES = 300;
export const MAX_READ_LINES = 200;
export const MAX_SEARCH_MATCHES = 50;
export const MAX_REPO_MAP_BYTES = 16 * 1024;
export const MAX_CHECK_OUTPUT_BYTES = 32 * 1024;

export interface ToolEventOptions {
  eventType?: string;
  antiCheat?: Pick<AntiCheatResult, "clean" | "reasons">;
}

/**
 * Wrap one tool implementation with zod validation, role policy, timing,
 * stable tool-call ids, bounded human-readable output, and an append-only
 * event-log record. The implementation itself stays independent of any LLM
 * SDK or runner loop.
 */
export async function executeTool<TInput, TOutput>(
  definition: Pick<ToolDefinition<TInput, TOutput>, "name" | "roles" | "schema" | "eventType">,
  rawInput: unknown,
  context: ToolContext,
  handler: (input: TInput, context: ToolContext) => Promise<ToolHandlerResult<TOutput>>,
  toolCallId = context.toolCallId ?? "tool-call",
): Promise<ToolResult<TOutput>> {
  const startedAt = Date.now();
  let result: ToolResult<TOutput>;

  if (context.role === undefined || !definition.roles.includes(context.role)) {
    result = failureResult(
      definition.name,
      toolCallId,
      "policy:tool-not-available",
      `${definition.name} is not available to ${context.role ?? "unknown"}`,
    );
  } else {
    const parsed = definition.schema.safeParse(rawInput);
    if (!parsed.success) {
      result = failureResult(
        definition.name,
        toolCallId,
        "tool:invalid-input",
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
          .join("; "),
      );
    } else {
      try {
        result = finalizeHandlerResult(
          definition.name,
          toolCallId,
          await handler(parsed.data, { ...context, toolCallId }),
        );
      } catch (error) {
        const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
        if (typeof candidate.code === "string" && typeof candidate.message === "string") {
          const message = capString(candidate.message, MAX_OUTPUT_BYTES).value;
          result = {
            ok: false,
            error: {
              code: candidate.code,
              message,
              ...(candidate.details === undefined ? {} : { details: candidate.details }),
            },
            tool: definition.name,
            toolCallId,
            isError: true,
            content: message,
          };
        } else {
          const message = error instanceof Error ? error.message : String(error);
          result = failureResult(definition.name, toolCallId, "tool:execution", message);
        }
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  await recordToolEvent(
    context,
    definition.name,
    definition.eventType ?? "tool.result",
    toolCallId,
    rawInput,
    result,
    durationMs,
  );
  return result;
}

export function defineTool<TInput, TOutput>(input: {
  name: string;
  roles: readonly ToolContext["role"][];
  description: string;
  schema: ZodType<TInput, any, unknown>;
  eventType?: string;
  handler: (parsed: TInput, context: ToolContext) => Promise<ToolHandlerResult<TOutput>>;
}): ToolDefinition<TInput, TOutput> {
  const roles = input.roles.filter((role): role is NonNullable<ToolContext["role"]> => role !== undefined);
  const execute = (rawInput: unknown, context: ToolContext, toolCallId?: string) =>
    executeTool(
      { name: input.name, roles, schema: input.schema, eventType: input.eventType },
      rawInput,
      { ...context, ...(toolCallId === undefined ? {} : { toolCallId }) },
      input.handler,
      toolCallId,
    );
  return {
    name: input.name,
    roles,
    description: input.description,
    schema: input.schema,
    inputSchema: input.schema,
    parameters: input.schema,
    ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
    execute,
  };
}

export function success<T>(value: T, content?: string, truncated = false): ToolHandlerResult<T> {
  return { ok: true, value, ...(content === undefined ? {} : { content }), ...(truncated ? { truncated: true } : {}) };
}

export function failure<T = never>(code: string, message: string, details?: unknown): ToolHandlerResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function finalizeHandlerResult<T>(tool: string, toolCallId: string, result: ToolHandlerResult<T>): ToolResult<T> {
  if (result.ok) {
    const content = capString(
      result.content ?? formatValue(result.value),
      MAX_OUTPUT_BYTES,
    );
    return {
      ok: true,
      value: result.value,
      tool,
      toolCallId,
      isError: false,
      content: content.value,
      ...(result.truncated || content.truncated ? { truncated: true } : {}),
    };
  }
  const message = capString(result.error.message, MAX_OUTPUT_BYTES).value;
  return {
    ok: false,
    error: {
      ...result.error,
      message,
    },
    tool,
    toolCallId,
    isError: true,
    content: message,
  };
}

function failureResult<T>(tool: string, toolCallId: string, code: string, message: string): ToolResult<T> {
  const bounded = capString(message, MAX_OUTPUT_BYTES).value;
  return {
    ok: false,
    error: { code, message: bounded },
    tool,
    toolCallId,
    isError: true,
    content: bounded,
  };
}

async function recordToolEvent<T>(
  context: ToolContext,
  toolName: string,
  eventType: string,
  toolCallId: string,
  rawInput: unknown,
  result: ToolResult<T>,
  durationMs: number,
): Promise<void> {
  if (!context.eventLog || !context.runId) return;
  const observation = result.ok ? summarizeValue(result.value, MAX_EVENT_OUTPUT_BYTES) : undefined;
  const payload: Record<string, unknown> = {
    toolCallId,
    toolName,
    ...(context.role === undefined ? {} : { role: context.role }),
    ok: result.ok,
    durationMs,
    inputSummary: summarizeValue(rawInput, 4 * 1024),
    ...(observation === undefined ? {} : { observation }),
    ...(result.error === undefined ? {} : {
      errorCode: result.error.code,
      errorMessage: result.error.message,
      ...(result.error.details === undefined ? {} : {
        errorDetails: summarizeValue(result.error.details, MAX_EVENT_OUTPUT_BYTES),
      }),
    }),
  };
  if (eventType === "CHECK_RESULT" && result.ok && isRecord(result.value)) {
    const check = result.value;
    Object.assign(payload, {
      ...check,
      ...(typeof check.outputTail === "string"
        ? { outputTail: capString(check.outputTail, MAX_EVENT_OUTPUT_BYTES).value }
        : {}),
    });
  }
  try {
    await Promise.resolve(context.eventLog.appendEvent({
      runId: context.runId,
      ...(context.itemId === undefined ? {} : { itemId: context.itemId }),
      ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
      type: eventType,
      payload,
    }));
  } catch {
    // A tool observation remains useful even if an optional event sink is
    // unavailable. The durable orchestrator can still record the failure.
  }
}

export function summarizeValue(value: unknown, maxBytes: number): unknown {
  if (typeof value === "string") return capString(value, maxBytes).value;
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return { bytes: value.byteLength, sha256: createHash("sha256").update(value).digest("hex") };
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      if (Buffer.byteLength(JSON.stringify(items) ?? "[]", "utf8") >= maxBytes) break;
      items.push(summarizeValue(item, Math.max(256, Math.floor(maxBytes / 4))));
    }
    return items;
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "content" || key === "unifiedDiff") {
        const text = typeof child === "string" ? child : String(child);
        output[key] = {
          bytes: Buffer.byteLength(text, "utf8"),
          sha256: createHash("sha256").update(text).digest("hex"),
        };
      } else {
        output[key] = summarizeValue(child, Math.max(256, Math.floor(maxBytes / 4)));
      }
      if (Buffer.byteLength(JSON.stringify(output) ?? "{}", "utf8") >= maxBytes) break;
    }
    return output;
  }
  return String(value);
}

export function capString(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  return {
    value: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
