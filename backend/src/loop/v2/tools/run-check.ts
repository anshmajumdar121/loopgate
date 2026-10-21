import { realpath } from "node:fs/promises";
import { runProcess, type ProcessRunResult } from "../process-runner.js";
import { scrubbedEnv } from "../../build-runner.js";
import { isAllowedCheckCommand, PlanCheckSchema } from "../schemas.js";
import {
  MAX_CHECK_OUTPUT_BYTES,
  capString,
  defineTool,
  failure,
  success,
} from "./common.js";
import { selectDeclaredCheck, ToolPolicyException } from "./policy.js";
import { RunCheckInputSchema } from "./schemas.js";
import type { RunCheckInput } from "./schemas.js";
import type { ToolContext, ToolDefinition } from "./types.js";

export interface RunCheckOutput {
  id: string;
  cmd: string[];
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  outputTail: string;
  timeoutMs: number;
  reason?: string;
}

const WINDOWS_SHIMS = new Set(["npm", "npx", "pnpm", "yarn"]);

export const runCheckTool: ToolDefinition<
  RunCheckInput,
  RunCheckOutput
> = defineTool<RunCheckInput, RunCheckOutput>({
  name: "run_check",
  roles: ["maker", "verifier"],
  eventType: "CHECK_RESULT",
  description: "Run one check declared by the approved plan through the bounded v2 process runner.",
  schema: RunCheckInputSchema,
  handler: async (parsed, context) => {
    const plan = context.approvedPlan ?? context.plan;
    if (!plan) return failure("policy:check-not-declared", `check is not declared: ${parsed.id}`);
    const selected = selectDeclaredCheck(plan, parsed.id);
    if ("code" in selected) return failure(selected.code, selected.message, selected.details);
    const validated = PlanCheckSchema.safeParse(selected);
    if (!validated.success || !isAllowedCheckCommand(selected.cmd)) {
      return failure("policy:check-not-declared", `check is not declared or command is not allowlisted: ${parsed.id}`);
    }

    const root = await realpath(context.workdir).catch((error) => {
      throw new ToolPolicyException("policy:workdir", error instanceof Error ? error.message : String(error));
    });
    const command = [...selected.cmd];
    const executable = normalizeExecutable(command.shift()!);
    let result: ProcessRunResult;
    try {
      result = await runProcess({
        executable,
        args: command,
        cwd: root,
        env: scrubbedEnv(),
        extendEnv: false,
        signal: context.signal,
        timeoutMs: selected.timeoutMs,
        stdoutTailBytes: MAX_CHECK_OUTPUT_BYTES,
        stderrTailBytes: MAX_CHECK_OUTPUT_BYTES,
        validateCwd: async (cwd) => {
          const resolved = await realpath(cwd);
          if (resolved !== root) throw new ToolPolicyException("policy:path-escape", "check cwd escapes workdir");
        },
      });
    } catch (error) {
      if (error instanceof ToolPolicyException) return failure(error.code, error.message, error.details);
      return failure("tool:check-failed", error instanceof Error ? error.message : String(error));
    }

    const output = capString(
      [result.stdoutTail, result.stderrTail].filter((part) => part.length > 0).join("\n"),
      MAX_CHECK_OUTPUT_BYTES,
    );
    const passed = result.exitCode === 0 && !result.failed && !result.timedOut && !result.cancelled;
    const value: RunCheckOutput = {
      id: selected.id,
      cmd: [...selected.cmd],
      passed,
      exitCode: result.exitCode ?? null,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      outputTail: output.value,
      timeoutMs: selected.timeoutMs,
      ...(passed
        ? {}
        : {
            reason: result.timedOut
              ? `check timed out after ${selected.timeoutMs}ms`
              : result.cancelled
              ? "check cancelled"
              : `check exited with ${result.exitCode ?? "no exit code"}`,
          }),
    };
    return success(value, output.value, output.truncated);
  },
});

function normalizeExecutable(executable: string): string {
  if (process.platform !== "win32") return executable;
  return WINDOWS_SHIMS.has(executable) ? `${executable}.cmd` : executable;
}
