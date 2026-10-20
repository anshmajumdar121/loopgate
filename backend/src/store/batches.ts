// Batch (Map node) store: one batch = one prompt template looped over N
// items, each item run as an ordinary plan → make → verify task. Persisted
// to `${DATA_ROOT}/_batches.json` after every item transition so a crash or
// restart resumes from the first unfinished item instead of redoing work.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nanoid } from "nanoid";
import { TASK_DATA_DIR } from "./persistence.js";

export type BatchItemStatus = "pending" | "running" | "done" | "escalated" | "failed" | "cancelled";
export type BatchStatus = "queued" | "running" | "done" | "partial" | "cancelled";

export interface BatchItem {
  index: number;
  input: string;
  status: BatchItemStatus;
  taskId?: string;
  attempts?: number;
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface Batch {
  id: string;
  title: string;
  promptTemplate: string;
  items: BatchItem[];
  workdirRoot: string;
  model?: string;
  modelOverrides?: { planning?: string; implementation?: string; review?: string };
  maxAttempts?: number;
  status: BatchStatus;
  createdAt: string;
  updatedAt: string;
  reportPath?: string;
}

const BATCHES_FILE = resolve(TASK_DATA_DIR, "..", "_batches.json");
const batches = new Map<string, Batch>();

export function createBatch(input: Omit<Batch, "id" | "status" | "createdAt" | "updatedAt" | "items"> & { items: string[] }): Batch {
  const now = new Date().toISOString();
  const batch: Batch = {
    ...input,
    id: nanoid(12),
    items: input.items.map((text, index) => ({ index, input: text, status: "pending" })),
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  batches.set(batch.id, batch);
  void saveBatches();
  return batch;
}

export function getBatch(id: string): Batch | undefined {
  return batches.get(id);
}

export function listBatches(): Batch[] {
  return [...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateBatch(id: string, patch: Partial<Batch>): Batch | undefined {
  const b = batches.get(id);
  if (!b) return undefined;
  Object.assign(b, patch, { updatedAt: new Date().toISOString() });
  void saveBatches();
  return b;
}

export function updateBatchItem(id: string, index: number, patch: Partial<BatchItem>): Batch | undefined {
  const b = batches.get(id);
  if (!b || !b.items[index]) return undefined;
  Object.assign(b.items[index], patch);
  b.updatedAt = new Date().toISOString();
  void saveBatches();
  return b;
}

/** Render the template for one item: {{item}} and {{index}} (1-based). */
export function renderPrompt(template: string, item: BatchItem): string {
  return template.replace(/\{\{\s*item\s*\}\}/g, item.input).replace(/\{\{\s*index\s*\}\}/g, String(item.index + 1));
}

// ── persistence: serialized, atomic, Windows-safe ─────────────────────────
let writeChain: Promise<void> = Promise.resolve();
let tmpSeq = 0;

export function saveBatches(): Promise<void> {
  const snapshot = JSON.stringify(listBatches(), null, 2);
  writeChain = writeChain.catch(() => undefined).then(() => writeAtomic(BATCHES_FILE, snapshot));
  return writeChain;
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${++tmpSeq}`;
  await writeFile(tmp, data, "utf8");
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows: a reader (AV, indexer, watcher) briefly holding the target
      // makes rename fail with EPERM/EBUSY. Retry, then clean up the tmp.
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && i < 8) {
        await new Promise((r) => setTimeout(r, 25 * (i + 1)));
        continue;
      }
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}

export async function loadBatchesFromDisk(): Promise<Batch[]> {
  try {
    const list = JSON.parse(await readFile(BATCHES_FILE, "utf8")) as Batch[];
    for (const b of list) batches.set(b.id, b);
    return list;
  } catch {
    return [];
  }
}
