// Phase 4 (ponytail slice): prompt snapshot + revert. The full plan calls
// for an autonomous keep-or-revert ratchet that runs a benchmark suite
// overnight and decides for you. That's a lot of code for a benchmark
// suite that doesn't exist yet.
//
// The thing you actually need BEFORE running an improve-agents task is:
// "if the new prompts are worse, can I get the old ones back?" Yes —
// snapshot, run, revert-if-needed. That's this file.
//
// Files touched: only <workdir>/.opencode/agents/*.md. Anything outside
// that directory is left alone. Snapshots are full directory copies in
// <workdir>/.loop/snapshots/agents-<timestamp>/. No git, no diff
// library — `cp -r` semantics from the stdlib.

import { cp, readdir, rm, stat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const AGENT_PROMPTS_DIR = ".opencode/agents";
const SNAPSHOTS_ROOT = ".loop/snapshots";

export type FileStatus = "added" | "removed" | "modified" | "unchanged";

export interface Snapshot {
  /** Snapshot id is the directory name minus the "agents-" prefix. */
  id: string;
  /** Absolute path to the snapshot directory. */
  path: string;
  /** ISO 8601 timestamp the snapshot was taken. */
  createdAt: string;
  /** Number of .md files captured. */
  fileCount: number;
}

/**
 * Absolute path of the directory holding the agent system prompts.
 * Returns null if it doesn't exist (caller decides whether to error
 * or proceed with an empty snapshot).
 */
async function agentsDir(workdir: string): Promise<string | null> {
  const p = join(resolve(workdir), AGENT_PROMPTS_DIR);
  try {
    const s = await stat(p);
    return s.isDirectory() ? p : null;
  } catch {
    return null;
  }
}

function snapshotDir(workdir: string, ts: string): string {
  return join(resolve(workdir), SNAPSHOTS_ROOT, `agents-${ts}`);
}

/**
 * Snapshot every .md file in <workdir>/.opencode/agents/ into
 * <workdir>/.loop/snapshots/agents-<timestamp>/. Returns the snapshot
 * record. The source directory must exist; if it doesn't, throws.
 */
export async function snapshotPrompts(workdir: string): Promise<Snapshot> {
  const src = await agentsDir(workdir);
  if (!src) {
    throw new Error(
      `No agent prompts directory at ${join(resolve(workdir), AGENT_PROMPTS_DIR)} — nothing to snapshot.`
    );
  }
  // ISO 8601 → filesystem-safe: replace colons (Windows-incompatible
  // and ugly in `ls`). YYYY-MM-DDTHH-MM-SS-mmmZ-<rand> keeps two
  // snapshots taken in the same millisecond from colliding.
  // ponytail: random suffix beats a module-level counter (no shared
  // state, no test-ordering hazard). 4 chars is enough entropy for
  // "you'll never take 16K snapshots in 1ms" — the realistic upper
  // bound.
  const ts =
    new Date()
      .toISOString()
      .replace(/[:]/g, "-")
      .replace(/\.\d+Z$/, "Z") +
    "-" +
    Math.random().toString(36).slice(2, 6);
  const dst = snapshotDir(workdir, ts);
  await cp(src, dst, { recursive: true });
  const files = await readdir(dst).catch(() => [] as string[]);
  return {
    id: ts,
    path: dst,
    createdAt: new Date().toISOString(),
    fileCount: files.filter((f) => f.endsWith(".md")).length,
  };
}

/**
 * Restore the agent prompts from the given snapshot id. The current
 * <workdir>/.opencode/agents/ is wiped and replaced with the snapshot
 * contents. Returns the list of files restored.
 *
 * ponytail: destructive op, no undo. The snapshot is itself a
 * snapshot, not a versioned history — reverting twice is a no-op
 * (idempotent). If the user wants real history, git is the answer,
 * not this code.
 */
export async function revertToSnapshot(
  workdir: string,
  snapshotId: string
): Promise<{ restored: string[] }> {
  const src = snapshotDir(workdir, snapshotId);
  const dst = await agentsDir(workdir);
  if (!dst) {
    throw new Error(
      `No agent prompts directory at ${join(resolve(workdir), AGENT_PROMPTS_DIR)} — nothing to revert INTO.`
    );
  }
  // Validate the snapshot exists before we wipe the live dir.
  const srcStat = await stat(src).catch(() => null);
  if (!srcStat?.isDirectory()) {
    throw new Error(`Snapshot not found: ${src}`);
  }
  // Wipe the live dir, then cp the snapshot back. Doing it in this
  // order means a crash mid-revert leaves the live dir empty (bad),
  // not a half-merged state (worse). Acceptable for the v1 risk model.
  await rm(dst, { recursive: true, force: true });
  await cp(src, dst, { recursive: true });
  const restored = await readdir(dst).catch(() => [] as string[]);
  return { restored: restored.filter((f) => f.endsWith(".md")) };
}

/**
 * List all snapshots in chronological order (oldest first). Used by
 * the GET /api/ratchet/snapshots endpoint so the user can pick a
 * specific snapshot to revert to, not just the latest.
 */
export async function listSnapshots(workdir: string): Promise<Snapshot[]> {
  const root = join(resolve(workdir), SNAPSHOTS_ROOT);
  const entries = await readdir(root).catch(() => [] as string[]);
  const snapshots: Snapshot[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("agents-")) continue;
    const dir = join(root, entry);
    const s = await stat(dir).catch(() => null);
    if (!s?.isDirectory()) continue;
    const files = await readdir(dir).catch(() => [] as string[]);
    snapshots.push({
      id: entry.slice("agents-".length),
      path: dir,
      createdAt: s.mtime.toISOString(),
      fileCount: files.filter((f) => f.endsWith(".md")).length,
    });
  }
  // Oldest first — the "latest" is the last element, which is what
  // revertToSnapshot picks when no id is given.
  snapshots.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return snapshots;
}

/**
 * Revert to the most recent snapshot. Convenience for the common
 * "I just ran the recipe and the new prompts are bad" case — the
 * user doesn't have to know the snapshot id.
 */
export async function revertToLatest(workdir: string): Promise<{
  restored: string[];
  snapshot: Snapshot;
}> {
  const all = await listSnapshots(workdir);
  if (all.length === 0) {
    throw new Error(
      `No snapshots in ${join(resolve(workdir), SNAPSHOTS_ROOT)} — nothing to revert to.`
    );
  }
  const latest = all[all.length - 1];
  const restored = await revertToSnapshot(workdir, latest.id);
  return { restored: restored.restored, snapshot: latest };
}

/**
 * One file's status when comparing a snapshot against the current
 * <workdir>/.opencode/agents/ directory. `unchanged` is reported for
 * completeness but the UI collapses it out of the visible list.
 */
export interface FileChange {
  path: string;
  status: FileStatus;
  /** Bytes the snapshot held. `null` for added files. */
  beforeBytes: number | null;
  /** Bytes the current file holds. `null` for removed files. */
  afterBytes: number | null;
}

/**
 * Compare a snapshot's <workdir>/.opencode/agents/ contents against the
 * current state. Reports every .md file in either side as added /
 * removed / modified / unchanged. Used by the UI's "Show diff" button
 * so the user can decide whether to revert without leaving the panel.
 *
 * ponytail: byte-equality is enough to flag "modified" — a real line-
 * level diff is not needed for the "should I revert?" decision. If the
 * user wants the actual line changes, `cat` the file and compare.
 */
export async function diffAgainstSnapshot(
  workdir: string,
  snapshotId: string
): Promise<{ changes: FileChange[]; snapshotPath: string }> {
  const src = snapshotDir(workdir, snapshotId);
  const dst = await agentsDir(workdir);
  // Validate the snapshot exists. If the live dir is also gone (e.g.
  // user wiped the workdir), every snapshot file shows as "removed".
  await stat(src).catch(() => {
    throw new Error(`Snapshot not found: ${src}`);
  });

  const srcFiles = new Set(await readdir(src).catch(() => [] as string[]));
  const dstFiles = dst
    ? new Set(await readdir(dst).catch(() => [] as string[]))
    : new Set<string>();

  const changes: FileChange[] = [];
  const seen = new Set<string>();

  for (const f of srcFiles) {
    seen.add(f);
    const srcBytes = await readFile(join(src, f), "utf8").catch(() => "");
    if (!dstFiles.has(f)) {
      changes.push({ path: f, status: "removed", beforeBytes: srcBytes.length, afterBytes: null });
      continue;
    }
    const dstBytes = await readFile(join(dst!, f), "utf8").catch(() => "");
    changes.push({
      path: f,
      status: srcBytes === dstBytes ? "unchanged" : "modified",
      beforeBytes: srcBytes.length,
      afterBytes: dstBytes.length,
    });
  }
  for (const f of dstFiles) {
    if (seen.has(f)) continue;
    const dstBytes = await readFile(join(dst!, f), "utf8").catch(() => "");
    changes.push({ path: f, status: "added", beforeBytes: null, afterBytes: dstBytes.length });
  }

  // Sort: changed first (added/removed/modified), then unchanged.
  const order: Record<FileStatus, number> = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 1,
  };
  changes.sort((a, b) => {
    const o = order[a.status] - order[b.status];
    if (o !== 0) return o;
    return a.path.localeCompare(b.path);
  });
  return { changes, snapshotPath: src };
}
