import { randomUUID } from "node:crypto";
import { applyPatchTool, writeFileTool } from "./write.js";
import { listDirTool, readFileTool, repoMapTool, searchTool } from "./read-only.js";
import { runCheckTool } from "./run-check.js";
import { capString, summarizeValue } from "./common.js";
import type { ToolContext, ToolDefinition, ToolResult, ToolRole } from "./types.js";

export const V2_TOOLS = [
  listDirTool,
  readFileTool,
  searchTool,
  repoMapTool,
  writeFileTool,
  applyPatchTool,
  runCheckTool,
] as const;

export const V2_TOOL_NAMES = V2_TOOLS.map((tool) => tool.name) as readonly string[];

/**
 * Role-scoped C1.1 registry. It registers tools only; it does not start a
 * model loop or make provider calls. Each registered tool performs its own
 * zod, role, containment, write-policy, and event-log checks.
 */
export class ToolRegistry {
  private readonly context: ToolContext;
  private readonly definitions: readonly ToolDefinition[];

  constructor(roleOrContext: ToolRole | ToolContext) {
    this.context = typeof roleOrContext === "string"
      ? { workdir: ".", role: roleOrContext }
      : { ...roleOrContext, role: roleOrContext.role ?? "maker" };
    const role = this.context.role!;
    this.definitions = V2_TOOLS.filter((tool) => tool.roles.includes(role));
  }

  list(): readonly ToolDefinition[] {
    return this.definitions;
  }

  has(name: string): boolean {
    return this.definitions.some((tool) => tool.name === name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.find((tool) => tool.name === name);
  }

  async invoke(name: string, rawInput: unknown, toolCallId: string = randomUUID()): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) {
      const message = capString(`unknown or unavailable tool: ${name}`, 64 * 1024).value;
      const result: ToolResult = {
        ok: false,
        error: { code: "policy:tool-not-available", message },
        tool: name,
        toolCallId,
        isError: true,
        content: message,
      };
      this.recordUnavailable(name, rawInput, toolCallId, result);
      return result;
    }
    return tool.execute(rawInput as never, this.context, toolCallId);
  }

  async execute(
    name: string,
    rawInput: unknown,
    context?: ToolContext,
    toolCallId: string = randomUUID(),
  ): Promise<ToolResult> {
    if (context === undefined) return this.invoke(name, rawInput, toolCallId);
    const tool = this.definitions.find((candidate) => candidate.name === name);
    if (!tool) {
      const message = capString(`unknown or unavailable tool: ${name}`, 64 * 1024).value;
      const result: ToolResult = {
        ok: false,
        error: { code: "policy:tool-not-available", message },
        tool: name,
        toolCallId,
        isError: true,
        content: message,
      };
      this.recordUnavailable(name, rawInput, toolCallId, result, context);
      return result;
    }
    return tool.execute(rawInput as never, { ...context, role: context.role ?? this.context.role }, toolCallId);
  }
  private recordUnavailable(
    toolName: string,
    rawInput: unknown,
    toolCallId: string,
    result: ToolResult,
    context = this.context,
  ): void {
    if (!context.eventLog || !context.runId) return;
    try {
      context.eventLog.appendEvent({
        runId: context.runId,
        ...(context.itemId === undefined ? {} : { itemId: context.itemId }),
        ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
        type: "tool.result",
        payload: {
          toolCallId,
          toolName,
          ...(context.role === undefined ? {} : { role: context.role }),
          ok: false,
          durationMs: 0,
          inputSummary: summarizeValue(rawInput, 4 * 1024),
          errorCode: result.error?.code,
          errorMessage: result.error?.message,
        },
      });
    } catch {
      // Telemetry is best effort and must not change the denied result.
    }
  }

}

export function createToolRegistry(roleOrContext: ToolRole | ToolContext): ToolRegistry {
  return new ToolRegistry(roleOrContext);
}

export function toolsForRole(role: ToolRole): readonly ToolDefinition[] {
  return V2_TOOLS.filter((tool) => tool.roles.includes(role));
}
