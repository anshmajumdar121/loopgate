// REST endpoints for batches (Map node): loop one prompt template over N items.
//
//   POST /api/batches              { promptTemplate, items[], title?, model?, modelOverrides?, workdir?, maxAttempts? }
//   GET  /api/batches              → { batches }
//   GET  /api/batches/:id          → { batch }
//   POST /api/batches/:id/cancel   → stop the running item, cancel the rest
//   POST /api/batches/:id/resume   → re-run pending items (finished items are skipped)

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { createBatch, getBatch, listBatches, updateBatch } from "../store/batches.js";
import { anyBatchRunning, cancelBatch, isBatchRunning, runBatch } from "../loop/batch-runner.js";
import { getActiveTask, TASK_WORKSPACES_ROOT } from "../store/tasks.js";
import { connectionProblemForTask } from "./tasks.js";

export const batchesApi = new Hono();

const createSchema = z.object({
  title: z.string().max(120).optional(),
  promptTemplate: z
    .string()
    .min(3)
    .max(20_000)
    .refine((s) => /\{\{\s*item\s*\}\}/.test(s), "promptTemplate must contain {{item}}"),
  items: z.array(z.string().min(1).max(4_000)).min(1).max(500),
  model: z.string().max(300).optional(),
  modelOverrides: z
    .object({
      planning: z.string().max(300).optional(),
      implementation: z.string().max(300).optional(),
      review: z.string().max(300).optional(),
    })
    .optional(),
  workdir: z.string().max(1_000).optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
});

function busy(): string | null {
  if (anyBatchRunning()) return "another batch is running";
  const active = getActiveTask();
  if (active) return `task ${active.id} is currently active`;
  return null;
}

batchesApi.post("/batches", zValidator("json", createSchema), (c) => {
  const body = c.req.valid("json");
  const problem = connectionProblemForTask({ prompt: body.promptTemplate, model: body.model, modelOverrides: body.modelOverrides });
  if (problem) return c.json({ error: problem }, 400);
  const blocker = busy();
  if (blocker) return c.json({ error: blocker }, 409);
  const batch = createBatch({
    title: body.title?.trim() || `Batch of ${body.items.length}`,
    promptTemplate: body.promptTemplate,
    items: body.items,
    model: body.model,
    modelOverrides: body.modelOverrides,
    maxAttempts: body.maxAttempts,
    workdirRoot: body.workdir || join(TASK_WORKSPACES_ROOT, "batches", nanoid(8)),
  });
  void runBatch(batch.id);
  return c.json({ batch }, 201);
});

batchesApi.get("/batches", (c) => c.json({ batches: listBatches() }));

batchesApi.get("/batches/:id", (c) => {
  const batch = getBatch(c.req.param("id"));
  if (!batch) return c.json({ error: "batch not found" }, 404);
  return c.json({ batch });
});

batchesApi.post("/batches/:id/cancel", (c) => {
  const ok = cancelBatch(c.req.param("id"));
  if (!ok) return c.json({ error: "batch not found" }, 404);
  return c.json({ batch: getBatch(c.req.param("id")) });
});

batchesApi.post("/batches/:id/resume", (c) => {
  const id = c.req.param("id");
  const batch = getBatch(id);
  if (!batch) return c.json({ error: "batch not found" }, 404);
  if (isBatchRunning(id)) return c.json({ error: "batch is already running" }, 409);
  const blocker = busy();
  if (blocker) return c.json({ error: blocker }, 409);
  for (const it of batch.items) if (it.status === "cancelled" || it.status === "failed") it.status = "pending";
  updateBatch(id, { status: "queued" });
  void runBatch(id);
  return c.json({ batch });
});
