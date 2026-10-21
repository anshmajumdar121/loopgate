import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface SnapshotEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  hash?: string;
  content?: string;
  linkTarget?: string;
  resolvesOutside?: boolean;
}

export interface WorkdirSnapshot {
  root: string;
  entries: Map<string, SnapshotEntry>;
}

export interface WorkdirChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  before?: SnapshotEntry;
  after?: SnapshotEntry;
}

export interface AntiCheatResult {
  clean: boolean;
  reasons: string[];
  changes: WorkdirChange[];
}

export interface AntiCheatOptions {
  /** Paths extracted from the maker's response or write-policy audit. */
  attemptedPaths?: readonly string[];
}

const TEST_FILE_RE = /(?:^|\/)(?:__tests__\/|test\/|tests\/)|(?:\.test|\.spec)\.[cm]?[jt]sx?$/i;
const SNAPSHOT_RE = /(?:^|\/)(__snapshots__\/|.*\.snap$)/i;
const TEST_CONFIG_RE = /(?:^|\/)(?:vitest|jest)(?:\.[^/]+)?\.(?:[cm]?[jt]s|json)$/i;
const CHEAT_RE = /(?:\b(?:describe|suite|test|it)\s*\.\s*(?:skip|only)|\bx(?:it|describe)\b|\b(?:test|it)\s*\.\s*todo\b)/i;
const TRIVIAL_ASSERTION_RE = /(?:expect\s*\(\s*(?:true|1)\s*\)\s*\.\s*toBe\s*\(\s*(?:true|1)\s*\)|assert\s*\(\s*true\s*\))/i;

/** Take a recursive, symlink-aware snapshot before or after a maker attempt. */
export async function snapshotWorkdir(workdir: string): Promise<WorkdirSnapshot> {
  const root = await realpath(workdir);
  const entries = new Map<string, SnapshotEntry>();
  await visit(root, root, entries);
  return { root, entries };
}

export const snapshotMakerWorkdir = snapshotWorkdir;

/** Compare snapshots and apply all fail-closed maker anti-cheat rules. */
export async function inspectMakerAttempt(
  before: WorkdirSnapshot,
  after: WorkdirSnapshot,
  options: AntiCheatOptions = {},
): Promise<AntiCheatResult> {
  const changes = diffSnapshots(before, after);
  const reasons: string[] = [];

  for (const attempted of options.attemptedPaths ?? []) {
    if (isUnsafeRelativePath(attempted)) {
      reasons.push(`policy:path-escape:${attempted}`);
    }
  }

  for (const entry of after.entries.values()) {
    if (entry.kind === "symlink" && entry.resolvesOutside) {
      reasons.push(`policy:path-escape:symlink:${entry.path}`);
    }
  }

  for (const change of changes) {
    if (change.kind === "deleted" && isTestFile(change.path)) {
      reasons.push(`anti-cheat:test-deleted:${change.path}`);
    }
    if (isSnapshotFile(change.path)) {
      reasons.push(`anti-cheat:snapshot-edited:${change.path}`);
    }
    if (change.after?.kind !== "file") continue;

    const beforeText = change.before?.content ?? "";
    const afterText = change.after.content ?? "";
    if (isTestFile(change.path)) {
      if (introducedCheat(beforeText, afterText)) {
        reasons.push(`anti-cheat:skip-added: test modifier (.skip/.only/.todo) added: ${change.path}`);
      }
      const beforeAssertions = countAssertions(beforeText);
      const afterAssertions = countAssertions(afterText);
      if (afterAssertions < beforeAssertions) {
        reasons.push(
          `anti-cheat:assertions-lowered:${change.path} (${beforeAssertions} → ${afterAssertions})`,
        );
      }
      if (introducedTrivialAssertion(beforeText, afterText)) {
        reasons.push(`anti-cheat:trivial-assertion: trivially-true assertion added: ${change.path}`);
      }
    }
    if (isTestConfig(change.path)) {
      reasons.push(`anti-cheat:test-policy: test config edited: ${change.path}`);
    }
    if (change.path.replaceAll("\\", "/") === "package.json" && packageTestPolicyChanged(beforeText, afterText)) {
      reasons.push("anti-cheat:test-policy: package.json test script or coverage threshold edited");
    }
  }

  return {
    clean: reasons.length === 0,
    reasons: [...new Set(reasons)],
    changes,
  };
}

export const evaluateMakerDiff = inspectMakerAttempt;

export function diffSnapshots(
  before: WorkdirSnapshot,
  after: WorkdirSnapshot,
): WorkdirChange[] {
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  const changes: WorkdirChange[] = [];
  for (const path of [...paths].sort()) {
    const previous = before.entries.get(path);
    const current = after.entries.get(path);
    if (!previous && current) changes.push({ path, kind: "added", after: current });
    else if (previous && !current) changes.push({ path, kind: "deleted", before: previous });
    else if (previous && current && !sameEntry(previous, current)) {
      changes.push({ path, kind: "modified", before: previous, after: current });
    }
  }
  return changes;
}

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path.replaceAll("\\", "/"));
}

export function isSnapshotFile(path: string): boolean {
  return SNAPSHOT_RE.test(path.replaceAll("\\", "/"));
}

function isTestConfig(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return TEST_CONFIG_RE.test(normalized) || /(?:^|\/)vitest\.config\.|(?:^|\/)jest\.config\./i.test(normalized);
}

async function visit(
  root: string,
  absolute: string,
  entries: Map<string, SnapshotEntry>,
): Promise<void> {
  const relativePath = relative(root, absolute).replaceAll("\\", "/");
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) {
    let target = "";
    let outside = true;
    try {
      target = await readlink(absolute);
      const resolvedTarget = await realpath(absolute);
      outside = !isInside(root, resolvedTarget);
    } catch {
      outside = true;
    }
    entries.set(relativePath, {
      path: relativePath,
      kind: "symlink",
      linkTarget: target,
      resolvesOutside: outside,
    });
    return;
  }
  if (info.isDirectory()) {
    if (relativePath) entries.set(relativePath, { path: relativePath, kind: "directory" });
    for (const child of await readdir(absolute)) {
      await visit(root, resolve(absolute, child), entries);
    }
    return;
  }
  if (!info.isFile()) return;
  const buffer = await readFile(absolute);
  entries.set(relativePath, {
    path: relativePath,
    kind: "file",
    hash: createHash("sha256").update(buffer).digest("hex"),
    content: buffer.toString("utf8"),
  });
}

function sameEntry(a: SnapshotEntry, b: SnapshotEntry): boolean {
  return (
    a.kind === b.kind &&
    a.hash === b.hash &&
    a.linkTarget === b.linkTarget &&
    a.resolvesOutside === b.resolvesOutside
  );
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isUnsafeRelativePath(path: string): boolean {
  if (isAbsolute(path) || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return true;
  return path.split(/[\\/]/).includes("..");
}

function introducedCheat(before: string, after: string): boolean {
  const oldLines = new Set(before.split(/\r?\n/).map((line) => line.trim()));
  return after.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return !oldLines.has(trimmed) && CHEAT_RE.test(trimmed);
  });
}

function introducedTrivialAssertion(before: string, after: string): boolean {
  const oldMatches = before.match(new RegExp(TRIVIAL_ASSERTION_RE.source, "gi"))?.length ?? 0;
  const newMatches = after.match(new RegExp(TRIVIAL_ASSERTION_RE.source, "gi"))?.length ?? 0;
  return newMatches > oldMatches;
}

function countAssertions(text: string): number {
  return (
    text.match(/\bexpect\s*\(/g)?.length ?? 0
  ) + (text.match(/\bassert(?:\.[A-Za-z_$][\w$]*)?\s*\(/g)?.length ?? 0);
}

function packageTestPolicyChanged(before: string, after: string): boolean {
  try {
    const oldPkg = JSON.parse(before) as Record<string, unknown>;
    const newPkg = JSON.parse(after) as Record<string, unknown>;
    const oldScripts = (oldPkg.scripts ?? {}) as Record<string, unknown>;
    const newScripts = (newPkg.scripts ?? {}) as Record<string, unknown>;
    if (oldScripts.test !== newScripts.test) return true;
    return JSON.stringify(findCoverageThresholds(oldPkg)) !== JSON.stringify(findCoverageThresholds(newPkg));
  } catch {
    return true;
  }
}

function findCoverageThresholds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(findCoverageThresholds);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/threshold|coverage/i.test(key)) result[key] = child;
    else if (child && typeof child === "object") {
      const nested = findCoverageThresholds(child);
      if (nested && typeof nested === "object" && Object.keys(nested as object).length > 0) result[key] = nested;
    }
  }
  return result;
}
