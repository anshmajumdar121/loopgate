// Regression tests for the GOAL.md truncate-then-write race (tasks
// DSqjXsXf-sNV / ZzkgVu6vwD5g: "Planner returned 0 steps, 0 files").
//
// Failure mode: `fs.writeFile` truncates the file, then writes the data.
// With `awaitWriteFinish: false`, chokidar (fsevents) can deliver a single
// coalesced event whose read catches the file at 0 bytes; the watcher caches
// "" as the latest content and bumps the generation, and no follow-up event
// corrects it. The orchestrator's post-exit grace path then trusts the empty
// cache and hands "" to parsePlanGoal → 0 steps, 0 files.
//
// The exact fsevents coalescing is nondeterministic, so these tests lock in
// the intended behavior (events observe stable, complete content) rather
// than reproducing the coalesced 0-byte read bit-for-bit.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchFiles, type FileWatcher } from "../state-sync.js";

const PLAN = `# Current Goal

## Task

Build the thing.

## Completion Criteria

- [ ] it works

## Implementation Plan

1. do it

## Files to touch

- index.html
`;

describe("watchFiles write-stability", () => {
  let dir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "state-sync-test-"));
    watcher = watchFiles(dir);
    await watcher.ready();
  });

  afterEach(() => {
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers the full content for a plain write to a new file", async () => {
    const promise = watcher.awaitChange("GOAL.md", 10_000);
    writeFileSync(join(dir, "GOAL.md"), PLAN, "utf8");
    await expect(promise).resolves.toBe(PLAN);
    expect(watcher.getLatestContent("GOAL.md")).toBe(PLAN);
  });

  it("never caches the 0-byte truncated state of a truncate-then-write", async () => {
    // Seed an existing GOAL.md (previous plan), as in the failing runs.
    writeFileSync(join(dir, "GOAL.md"), "# old plan\n", "utf8");
    // Let the seed write's events drain so they can't satisfy the await below.
    await new Promise((r) => setTimeout(r, 800));

    const startGen = watcher.getGeneration("GOAL.md");
    const promise = watcher.awaitChange("GOAL.md", 10_000);

    // Reproduce writeFile's syscall pattern with a visible gap between the
    // truncation and the data landing: open(O_TRUNC) → pause → write → close.
    const fd = openSync(join(dir, "GOAL.md"), "w");
    await new Promise((r) => setTimeout(r, 100));
    writeSync(fd, PLAN);
    closeSync(fd);

    await expect(promise).resolves.toBe(PLAN);
    expect(watcher.getGeneration("GOAL.md")).toBeGreaterThan(startGen);
    // The cache the orchestrator's post-exit grace path reads must hold the
    // full plan, not the truncated intermediate state.
    expect(watcher.getLatestContent("GOAL.md")).toBe(PLAN);
  }, 15_000);
});
