import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  diffAgainstSnapshot,
  listSnapshots,
  revertToLatest,
  revertToSnapshot,
  snapshotPrompts,
} from "../loop/ratchet.js";

export const ratchetApi = new Hono();

const workdirSchema = z.object({ workdir: z.string().min(1) });

/**
 * Take a snapshot of <workdir>/.opencode/agents/. Call this BEFORE
 * running the improve-recipe task so you can revert if the new
 * prompts are worse. Returns the snapshot id (a timestamp) and the
 * count of files captured.
 */
ratchetApi.post(
  "/ratchet/snapshot",
  zValidator("json", workdirSchema),
  async (c) => {
    const { workdir } = c.req.valid("json");
    try {
      const snap = await snapshotPrompts(workdir);
      return c.json({ snapshot: snap });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  }
);

/**
 * List all snapshots, oldest first. The last entry is the "latest"
 * — that's what revert-latest will use.
 */
ratchetApi.get("/ratchet/snapshots", async (c) => {
  const workdir = c.req.query("workdir");
  if (!workdir) {
    return c.json({ error: "workdir query param required" }, 400);
  }
  const snapshots = await listSnapshots(workdir);
  return c.json({ snapshots });
});

const revertSchema = z.object({
  workdir: z.string().min(1),
  /** Optional snapshot id. Omit to revert to the most recent. */
  snapshotId: z.string().optional(),
});

const diffSchema = z.object({
  workdir: z.string().min(1),
  snapshotId: z.string().min(1),
});

/**
 * Compare a snapshot's <workdir>/.opencode/agents/ contents against the
 * current state. Returns the list of changed files (added / removed /
 * modified / unchanged) with byte sizes before + after. Used by the
 * UI's "Show diff" button so the user can decide whether to revert
 * without leaving the Improve panel.
 */
ratchetApi.post(
  "/ratchet/diff",
  zValidator("json", diffSchema),
  async (c) => {
    const { workdir, snapshotId } = c.req.valid("json");
    try {
      const result = await diffAgainstSnapshot(workdir, snapshotId);
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  }
);

/**
 * Revert <workdir>/.opencode/agents/ to a previous snapshot. The
 * current prompts are wiped and replaced with the snapshot contents.
 * Destructive — call snapshot first if you want to keep the
 * current state before reverting.
 */
ratchetApi.post(
  "/ratchet/revert",
  zValidator("json", revertSchema),
  async (c) => {
    const { workdir, snapshotId } = c.req.valid("json");
    try {
      if (snapshotId) {
        const result = await revertToSnapshot(workdir, snapshotId);
        return c.json({ restored: result.restored, snapshotId });
      }
      const result = await revertToLatest(workdir);
      return c.json({
        restored: result.restored,
        snapshot: result.snapshot,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400
      );
    }
  }
);
