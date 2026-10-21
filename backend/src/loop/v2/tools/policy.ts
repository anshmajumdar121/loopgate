import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PlanCheck, PlanSchema } from "../schemas.js";
import type { ToolError, ToolRole } from "./types.js";

const RESERVED_FILES = new Set(["goal.md", "state.md", "loop-constraints.md"]);
const RESERVED_DIRS = [".opencode/", ".loop/", ".git/", "node_modules/"];

/** The binding denylist from loop-constraints.md, kept in one v2 adapter. */
export const DEFAULT_DENYLIST: readonly string[] = [
  ".env",
  ".env.*",
  "**/secrets/**",
  "**/credentials/**",
  "**/*_key*",
  "**/*_secret*",
  "**/migrations/**",
  "auth/**",
  "payments/**",
  "billing/**",
];

export const HIDDEN_DIRS = new Set([".git", ".loop", "node_modules"]);

export interface ContainedPath {
  /** Real path for existing targets; lexical path for a not-yet-created write. */
  absolute: string;
  /** Normalized path relative to the real workdir. */
  relative: string;
}

export interface WritePolicyOptions {
  /** Defaults to LOOP_ENFORCE_ALLOWLIST !== "0". */
  enforceAllowlist?: boolean;
  /** Set true when an approved plan exists, including an empty allowlist. */
  allowlistRequired?: boolean;
}

export class ToolPolicyException extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ToolPolicyException";
  }
}

export function isContainedRelativePath(requested: string): boolean {
  if (!requested || requested.includes("\0")) return false;
  if (isAbsoluteLike(requested)) return false;
  const normalized = requested.replaceAll("\\", "/");
  return !normalized.split("/").includes("..");
}

export function normalizeRelativePath(requested: string): string {
  if (!isContainedRelativePath(requested)) {
    throw new ToolPolicyException("policy:path-escape", `path escapes workdir: ${requested}`);
  }
  const normalized = requested.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized || ".";
}

/**
 * Resolve an input against a real workdir and fail closed on traversal,
 * absolute paths, symlink escapes, and missing read/directory targets.
 */
export async function resolveContainedPath(
  workdir: string,
  requested: string,
  mode: "read" | "write" | "directory",
): Promise<ContainedPath> {
  const normalized = normalizeRelativePath(requested);
  const root = await realpath(workdir).catch((error) => {
    throw new ToolPolicyException(
      "policy:workdir",
      `workdir cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const rootInfo = await stat(root).catch((error) => {
    throw new ToolPolicyException(
      "policy:workdir",
      `workdir cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (!rootInfo.isDirectory()) throw new ToolPolicyException("policy:workdir", "workdir is not a directory");

  const candidate = resolve(root, normalized);
  const existing = await lstat(candidate).catch(() => undefined);
  if (existing !== undefined) {
    const resolved = await realpath(candidate).catch((error) => {
      throw new ToolPolicyException(
        "policy:path-escape",
        `path cannot be safely resolved: ${requested}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (!isInside(root, resolved)) {
      throw new ToolPolicyException("policy:path-escape", `path resolves outside workdir: ${requested}`);
    }
    const resolvedInfo = await stat(resolved).catch((error) => {
      throw new ToolPolicyException(
        "policy:path-escape",
        `path cannot be inspected safely: ${requested}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (mode === "directory" && !resolvedInfo.isDirectory()) {
      throw new ToolPolicyException("policy:not-directory", `not a directory: ${requested}`);
    }
    if ((mode === "read" || mode === "write") && !resolvedInfo.isFile()) {
      throw new ToolPolicyException("policy:not-file", `not a regular file: ${requested}`);
    }
    const canonical = relative(root, resolved).replaceAll("\\", "/") || ".";
    return { absolute: resolved, relative: canonical };
  }

  if (mode === "read" || mode === "directory") {
    throw new ToolPolicyException("policy:not-found", `path does not exist: ${requested}`);
  }

  // A write may create missing parents, but every existing ancestor must still
  // resolve inside the workdir. This catches a missing child below an outside
  // symlink before mkdir/write follows it.
  let ancestor = candidate;
  while (true) {
    const ancestorInfo = await lstat(ancestor).catch(() => undefined);
    if (ancestorInfo !== undefined) {
      const resolvedAncestor = await realpath(ancestor).catch((error) => {
        throw new ToolPolicyException(
          "policy:path-escape",
          `parent cannot be safely resolved: ${requested}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (!isInside(root, resolvedAncestor)) {
        throw new ToolPolicyException("policy:path-escape", `parent resolves outside workdir: ${requested}`);
      }
      break;
    }
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) {
      throw new ToolPolicyException("policy:path-escape", `path has no contained ancestor: ${requested}`);
    }
    ancestor = parent;
  }
  return { absolute: candidate, relative: normalized };
}

export function checkRoleAccess(role: ToolRole, toolName: string): ToolError | undefined {
  const allowed: Record<string, readonly ToolRole[]> = {
    list_dir: ["planner", "maker", "verifier"],
    read_file: ["planner", "maker", "verifier"],
    search: ["planner", "maker", "verifier"],
    repo_map: ["planner", "verifier"],
    write_file: ["maker"],
    apply_patch: ["maker"],
    run_check: ["maker", "verifier"],
  };
  if (allowed[toolName]?.includes(role)) return undefined;
  return policyError("policy:tool-not-available", `${toolName} is not available to ${role}`);
}

/**
 * The v2 equivalent of the legacy bridge's checkWritePolicy. Reserved files,
 * the binding denylist, and the approved plan allowlist are evaluated in that
 * order so policy reasons stay stable for the gate and scoreboard.
 */
export function checkWritePolicy(
  relativePath: string,
  filesToTouch: readonly string[],
  options: WritePolicyOptions = {},
): ToolError | undefined {
  const normalized = normalizePolicyPath(relativePath);
  const lower = normalized.toLowerCase();
  const segments = lower.split("/");
  const base = segments.at(-1) ?? lower;

  if (RESERVED_FILES.has(lower) || RESERVED_DIRS.some((dir) => lower.startsWith(dir))) {
    return policyError("policy:reserved-file", `${relativePath}: reserved orchestrator file`);
  }
  if (isDeniedPath(normalized)) {
    return policyError("policy:write", `${relativePath}: binding denylist`);
  }

  const enforce = options.enforceAllowlist ?? process.env.LOOP_ENFORCE_ALLOWLIST !== "0";
  const required = options.allowlistRequired ?? filesToTouch.length > 0;
  if (enforce && required && !filesToTouch.some((entry) => matchesAllowlist(lower, entry))) {
    return policyError("policy:not-in-allowlist", `${relativePath}: not in approved filesToTouch allowlist`);
  }
  return undefined;
}

export function checkReadPolicy(relativePath: string): ToolError | undefined {
  const normalized = normalizePolicyPath(relativePath);
  if (isHiddenPath(normalized)) {
    return policyError("policy:hidden-path", `${relativePath}: hidden from tool observations`);
  }
  if (isDeniedPath(normalized)) {
    return policyError("policy:read-denied", `${relativePath}: binding denylist`);
  }
  return undefined;
}

export function isHiddenPath(relativePath: string): boolean {
  return normalizePolicyPath(relativePath)
    .split("/")
    .some((segment) => HIDDEN_DIRS.has(segment));
}

export function isDeniedPath(relativePath: string, patterns: readonly string[] = DEFAULT_DENYLIST): boolean {
  const normalized = normalizePolicyPath(relativePath);
  return patterns.some((pattern) => matchesPattern(normalized, pattern));
}

export function selectDeclaredCheck(plan: PlanSchema, id: string): PlanCheck | ToolError {
  const check = plan.checks.find((candidate) => candidate.id === id);
  return check ?? policyError("policy:check-not-declared", `check is not declared: ${id}`);
}

export function policyError(code: string, message: string, details?: unknown): ToolError {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function normalizePolicyPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
}

function matchesAllowlist(path: string, entry: string): boolean {
  const raw = entry.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const directory = raw.endsWith("/");
  const normalized = normalizePolicyPath(raw).toLowerCase();
  if (directory) return path === normalized || path.startsWith(`${normalized}/`);
  if (normalized.includes("*")) return globToRegExp(normalized).test(path);
  return normalized === path;
}

function matchesPattern(path: string, pattern: string): boolean {
  const normalizedPattern = pattern.replaceAll("\\", "/").toLowerCase();
  if (!normalizedPattern.includes("/")) {
    return globToRegExp(normalizedPattern).test(path.split("/").at(-1) ?? path);
  }
  return globToRegExp(normalizedPattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  escaped = escaped
    .replace(/\*\*\//g, "\u0000LEADING\u0000")
    .replace(/\/\*\*/g, "\u0000TRAILING\u0000")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000LEADING\u0000/g, "(?:.*/)?")
    .replace(/\u0000TRAILING\u0000/g, "(?:/.*)?");
  return new RegExp(`^${escaped}$`, "i");
}

function isAbsoluteLike(requested: string): boolean {
  return (
    isAbsolute(requested) ||
    requested.startsWith("/") ||
    requested.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(requested) ||
    requested.startsWith("//")
  );
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
