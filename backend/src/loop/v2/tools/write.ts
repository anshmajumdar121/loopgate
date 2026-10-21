import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inspectMakerAttempt, snapshotWorkdir, type WorkdirSnapshot } from "../anti-cheat.js";
import { MAX_FILE_BYTES, defineTool, failure, success } from "./common.js";
import { checkWritePolicy, normalizeRelativePath, resolveContainedPath, ToolPolicyException } from "./policy.js";
import { ApplyPatchInputSchema, WriteFileInputSchema } from "./schemas.js";
import type { ApplyPatchInput, WriteFileInput } from "./schemas.js";
import type { ToolContext, ToolDefinition, ToolHandlerResult } from "./types.js";

export interface WriteFileOutput {
  path: string;
  bytesWritten: number;
  changed: boolean;
  changedLines?: number;
}

export function applyUnifiedDiff(source: string, unifiedDiff: string): { content: string; changedLines: number } {
  const patchLines = unifiedDiff.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const sourceHadFinalNewline = source.endsWith("\n") || source.endsWith("\r");
  const sourceLines = source.replace(/\r\n|\r/g, "\n").split("\n");
  if (sourceHadFinalNewline) sourceLines.pop();

  const output: string[] = [];
  let cursor = 0;
  let changedLines = 0;
  let sawHunk = false;
  let index = 0;
  while (index < patchLines.length) {
    const line = patchLines[index];
    if (line === "" || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      index += 1;
      continue;
    }
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) throw new Error("malformed unified diff hunk header");
    sawHunk = true;
    const oldStart = Number(header[1]);
    const oldLength = Number(header[2] ?? 1);
    const targetStart = oldStart === 0 ? 0 : oldStart - 1;
    if (targetStart < cursor || targetStart > sourceLines.length) {
      throw new Error("unified diff context is out of range");
    }
    output.push(...sourceLines.slice(cursor, targetStart));
    cursor = targetStart;
    index += 1;
    let consumed = 0;
    while (index < patchLines.length && !patchLines[index].startsWith("@@")) {
      const hunkLine = patchLines[index++];
      if (hunkLine === "\\ No newline at end of file") continue;
      if (hunkLine === "" && index >= patchLines.length) break;
      const marker = hunkLine[0];
      const text = hunkLine.slice(1);
      if (marker === " ") {
        if (sourceLines[cursor] !== text) throw new Error("unified diff context does not match");
        output.push(text);
        cursor += 1;
        consumed += 1;
      } else if (marker === "-") {
        if (sourceLines[cursor] !== text) throw new Error("unified diff deletion does not match");
        cursor += 1;
        consumed += 1;
      } else if (marker === "+") {
        output.push(text);
        changedLines += 1;
      } else {
        throw new Error("malformed unified diff line");
      }
    }
    if (consumed !== oldLength) {
      throw new Error(`unified diff hunk expected ${oldLength} old lines but consumed ${consumed}`);
    }
  }
  if (!sawHunk) throw new Error("unified diff contains no hunks");
  output.push(...sourceLines.slice(cursor));
  const content = output.length === 0
    ? ""
    : `${output.join("\n")}${sourceHadFinalNewline ? "\n" : ""}`;
  return { content, changedLines };
}

export const writeFileTool: ToolDefinition<
  WriteFileInput,
  WriteFileOutput
> = defineTool<WriteFileInput, WriteFileOutput>({
  name: "write_file",
  roles: ["maker"],
  description: "Create or overwrite one approved text file atomically.",
  schema: WriteFileInputSchema,
  handler: async (parsed, context) => writeContent(parsed.path, parsed.content, context),
});

export const applyPatchTool: ToolDefinition<
  ApplyPatchInput,
  WriteFileOutput
> = defineTool<ApplyPatchInput, WriteFileOutput>({
  name: "apply_patch",
  roles: ["maker"],
  description: "Apply a single-file unified diff to one approved text file.",
  schema: ApplyPatchInputSchema,
  handler: async (parsed, context) => {
    let target;
    try {
      target = await resolveContainedPath(context.workdir, parsed.path, "write");
    } catch (error) {
      return policyFailure(error);
    }
    const policy = writePolicyFor(parsed.path, context);
    if (policy) return failure(policy.code, policy.message, policy.details);
    const canonicalPolicy = writePolicyFor(target.relative, context);
    if (canonicalPolicy) return failure(canonicalPolicy.code, canonicalPolicy.message, canonicalPolicy.details);

    let source = "";
    const existing = await stat(target.absolute).catch(() => undefined);
    if (existing !== undefined) {
      if (!existing.isFile()) return failure("policy:not-file", `not a regular file: ${parsed.path}`);
      if (existing.size > MAX_FILE_BYTES) return failure("policy:file-too-large", `${parsed.path} exceeds 1 MiB`);
      try {
        source = (await readFile(target.absolute)).toString("utf8");
        if (source.includes("\0")) return failure("policy:binary-file", `${parsed.path} is binary`);
      } catch (error) {
        return failure("tool:read-failed", error instanceof Error ? error.message : String(error));
      }
    }

    let patched: { content: string; changedLines: number };
    try {
      const headers = patchHeaderPaths(parsed.unifiedDiff.split(/\r\n|\r|\n/));
      if (headers.length > 0 && !headers.every((header) => header === "/dev/null" || samePatchPath(header, parsed.path))) {
        return failure("policy:patch-path-mismatch", `unified diff targets a different path than ${parsed.path}`);
      }
      patched = applyUnifiedDiff(source, parsed.unifiedDiff);
    } catch (error) {
      return failure("tool:invalid-patch", error instanceof Error ? error.message : String(error));
    }
    return writeContent(parsed.path, patched.content, context, patched.changedLines);
  },
});

async function writeContent(
  inputPath: string,
  content: string,
  context: ToolContext,
  changedLines?: number,
): Promise<ToolHandlerResult<WriteFileOutput>> {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    return failure("policy:write-too-large", `${inputPath} exceeds 1 MiB`);
  }
  const policy = writePolicyFor(inputPath, context);
  if (policy) return failure(policy.code, policy.message, policy.details);

  let target;
  try {
    target = await resolveContainedPath(context.workdir, inputPath, "write");
  } catch (error) {
    return policyFailure(error);
  }
  const canonicalPolicy = writePolicyFor(target.relative, context);
  if (canonicalPolicy) return failure(canonicalPolicy.code, canonicalPolicy.message, canonicalPolicy.details);

  const previous = await readFile(target.absolute).catch(() => undefined);
  if (previous !== undefined && previous.toString("utf8") === content) {
    return success({
      path: normalizeRelativePath(inputPath),
      bytesWritten: Buffer.byteLength(content, "utf8"),
      changed: false,
      ...(changedLines === undefined ? {} : { changedLines: 0 }),
    });
  }

  const before = context.makerBaseline ?? await snapshotWorkdir(context.workdir);
  const temp = `${target.absolute}.tmp-tool-${process.pid}-${Date.now()}`;
  try {
    await mkdir(dirname(target.absolute), { recursive: true });
    // Re-resolve after mkdir so a race cannot turn a missing parent into an
    // outside symlink between the containment check and the write.
    await resolveContainedPath(context.workdir, inputPath, "write");
    await writeFile(temp, content, "utf8");
    try {
      await rename(temp, target.absolute);
    } catch (error) {
      // Windows may refuse rename-over-existing-file. Remove only the already
      // policy-checked target, then complete the replacement.
      const code = (error as { code?: unknown }).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await rm(target.absolute, { force: true });
      await rename(temp, target.absolute);
    }

    const after = await snapshotWorkdir(context.workdir);
    const antiCheat = await inspectMakerAttempt(before, after, { attemptedPaths: [inputPath] });
    if (!antiCheat.clean) {
      await restoreTarget(target.absolute, previous);
      return failure(
        antiCheat.reasons[0] ?? "anti-cheat:write-rejected",
        antiCheat.reasons.join("; "),
        { antiCheat: { clean: antiCheat.clean, reasons: antiCheat.reasons } },
      );
    }

    return success({
      path: normalizeRelativePath(inputPath),
      bytesWritten: Buffer.byteLength(content, "utf8"),
      changed: true,
      ...(changedLines === undefined ? {} : { changedLines }),
    });
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    await restoreTarget(target.absolute, previous);
    if (error instanceof ToolPolicyException) return failure(error.code, error.message, error.details);
    return failure("tool:write-failed", error instanceof Error ? error.message : String(error));
  }
}

function writePolicyFor(inputPath: string, context: ToolContext) {
  const plan = context.approvedPlan ?? context.plan;
  const filesToTouch = context.allowedFiles ?? plan?.filesToTouch ?? [];
  return checkWritePolicy(normalizeRelativePath(inputPath), filesToTouch, {
    enforceAllowlist: context.enforceAllowlist,
    // A maker write without an approved plan is fail-closed. Callers that
    // intentionally disable only the plan allowlist can still pass
    // enforceAllowlist: false, matching the legacy bridge switch.
    allowlistRequired: true,
  });
}

function policyFailure(error: unknown): ToolHandlerResult<never> {
  if (error instanceof ToolPolicyException) return failure(error.code, error.message, error.details);
  return failure("tool:path-resolution", error instanceof Error ? error.message : String(error));
}

async function restoreTarget(path: string, previous: Buffer | undefined): Promise<void> {
  if (previous === undefined) {
    await rm(path, { force: true }).catch(() => {});
    return;
  }
  await writeFile(path, previous).catch(() => {});
}

function patchHeaderPaths(lines: readonly string[]): string[] {
  const paths: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
    const raw = line.slice(4).trim().split(/\s+/)[0];
    if (!raw) continue;
    const normalized = raw.replace(/^a\//, "").replace(/^b\//, "");
    if (!paths.includes(normalized)) paths.push(normalized);
  }
  return paths;
}

function samePatchPath(header: string, requested: string): boolean {
  try {
    return normalizeRelativePath(header) === normalizeRelativePath(requested);
  } catch {
    return false;
  }
}
