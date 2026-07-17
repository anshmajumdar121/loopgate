import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffAgainstSnapshot,
  listSnapshots,
  revertToLatest,
  revertToSnapshot,
  snapshotPrompts,
} from "../ratchet.js";

let workdir: string;
let agentsDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "loop-ratchet-"));
  agentsDir = join(workdir, ".opencode", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "loop-planner.md"), "# planner v1\n");
  await writeFile(join(agentsDir, "loop-maker.md"), "# maker v1\n");
  await writeFile(join(agentsDir, "loop-verifier.md"), "# verifier v1\n");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("snapshotPrompts", () => {
  it("copies every .md file into a timestamped directory", async () => {
    const snap = await snapshotPrompts(workdir);
    expect(snap.fileCount).toBe(3);
    const planner = await readFile(join(snap.path, "loop-planner.md"), "utf8");
    expect(planner).toBe("# planner v1\n");
  });

  it("throws when the agents directory does not exist", async () => {
    await rm(agentsDir, { recursive: true, force: true });
    await expect(snapshotPrompts(workdir)).rejects.toThrow(
      /No agent prompts directory/
    );
  });
});

describe("revertToSnapshot", () => {
  it("restores the exact bytes from a specific snapshot", async () => {
    const snap = await snapshotPrompts(workdir);
    // User runs the improve-recipe task: maker edits the prompts.
    await writeFile(join(agentsDir, "loop-planner.md"), "# planner v2 (broken)\n");
    await writeFile(join(agentsDir, "loop-maker.md"), "# maker v2 (broken)\n");
    // User decides to revert.
    const { restored } = await revertToSnapshot(workdir, snap.id);
    expect(restored.sort()).toEqual([
      "loop-maker.md",
      "loop-planner.md",
      "loop-verifier.md",
    ]);
    const planner = await readFile(join(agentsDir, "loop-planner.md"), "utf8");
    expect(planner).toBe("# planner v1\n");
  });

  it("rejects an unknown snapshot id with a clear error", async () => {
    await expect(
      revertToSnapshot(workdir, "no-such-snapshot")
    ).rejects.toThrow(/Snapshot not found/);
  });
});

describe("revertToLatest", () => {
  it("reverts to the most recent snapshot when multiple exist", async () => {
    // Snapshot 1, then edit, then snapshot 2, then edit again.
    const first = await snapshotPrompts(workdir);
    // Tiny sleep to ensure distinct mtime sort order.
    await new Promise((r) => setTimeout(r, 5));
    await writeFile(join(agentsDir, "loop-planner.md"), "# planner v2\n");
    await snapshotPrompts(workdir);
    await writeFile(join(agentsDir, "loop-planner.md"), "# planner v3 (current)\n");

    const { snapshot, restored } = await revertToLatest(workdir);
    // The latest snapshot holds v2, not v1.
    expect(snapshot.id).not.toBe(first.id);
    const planner = await readFile(join(agentsDir, "loop-planner.md"), "utf8");
    expect(planner).toBe("# planner v2\n");
    expect(restored).toContain("loop-planner.md");
  });

  it("throws when no snapshots exist", async () => {
    await expect(revertToLatest(workdir)).rejects.toThrow(/No snapshots/);
  });
});

describe("listSnapshots", () => {
  it("returns snapshots oldest-first", async () => {
    const a = await snapshotPrompts(workdir);
    await new Promise((r) => setTimeout(r, 5));
    const b = await snapshotPrompts(workdir);
    const all = await listSnapshots(workdir);
    expect(all.map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it("returns [] when no snapshots dir exists", async () => {
    const all = await listSnapshots(workdir);
    expect(all).toEqual([]);
  });
});

describe("diffAgainstSnapshot", () => {
  it("reports unchanged for every file when current == snapshot", async () => {
    const snap = await snapshotPrompts(workdir);
    const { changes } = await diffAgainstSnapshot(workdir, snap.id);
    expect(changes.every((c) => c.status === "unchanged")).toBe(true);
  });

  it("flags modified files with before/after byte counts", async () => {
    const snap = await snapshotPrompts(workdir);
    await writeFile(join(agentsDir, "loop-planner.md"), "# planner v2 (longer)\n");
    const { changes } = await diffAgainstSnapshot(workdir, snap.id);
    const planner = changes.find((c) => c.path === "loop-planner.md");
    expect(planner?.status).toBe("modified");
    expect(planner?.beforeBytes).toBe("# planner v1\n".length);
    expect(planner?.afterBytes).toBe("# planner v2 (longer)\n".length);
  });

  it("flags added files (in current, not in snapshot)", async () => {
    const snap = await snapshotPrompts(workdir);
    await writeFile(join(agentsDir, "loop-new-role.md"), "# new\n");
    const { changes } = await diffAgainstSnapshot(workdir, snap.id);
    const added = changes.find((c) => c.path === "loop-new-role.md");
    expect(added?.status).toBe("added");
    expect(added?.beforeBytes).toBeNull();
    expect(added?.afterBytes).toBe("# new\n".length);
  });

  it("flags removed files (in snapshot, not in current)", async () => {
    const snap = await snapshotPrompts(workdir);
    await rm(join(agentsDir, "loop-verifier.md"));
    const { changes } = await diffAgainstSnapshot(workdir, snap.id);
    const removed = changes.find((c) => c.path === "loop-verifier.md");
    expect(removed?.status).toBe("removed");
    expect(removed?.afterBytes).toBeNull();
  });

  it("sorts changed first, then unchanged alphabetically", async () => {
    const snap = await snapshotPrompts(workdir);
    await writeFile(join(agentsDir, "loop-planner.md"), "# planner v2\n");
    const { changes } = await diffAgainstSnapshot(workdir, snap.id);
    const firstUnchanged = changes.findIndex((c) => c.status === "unchanged");
    const lastChanged = changes.map((c) => c.status).lastIndexOf("modified");
    if (firstUnchanged !== -1 && lastChanged !== -1) {
      expect(lastChanged).toBeLessThan(firstUnchanged);
    }
  });

  it("throws on unknown snapshot id", async () => {
    await expect(
      diffAgainstSnapshot(workdir, "no-such-snapshot")
    ).rejects.toThrow(/Snapshot not found/);
  });
});
