// Batch ("Map node") types — mirror backend/src/store/batches.ts. One prompt
// template looped over N items; each item runs as a normal task.

export type BatchStatus = "queued" | "running" | "done" | "partial" | "cancelled";

export type BatchItemStatus =
  | "pending"
  | "running"
  | "done"
  | "escalated"
  | "failed"
  | "cancelled";

export interface ModelOverrides {
  planning?: string;
  implementation?: string;
  review?: string;
}

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
  modelOverrides?: ModelOverrides;
  maxAttempts?: number;
  status: BatchStatus;
  createdAt: string;
  updatedAt: string;
  reportPath?: string;
}

export interface CreateBatchBody {
  promptTemplate: string;
  items: string[];
  title?: string;
  model?: string;
  modelOverrides?: ModelOverrides;
  workdir?: string;
  maxAttempts?: number;
}

export const ITEM_PLACEHOLDER_RE = /\{\{\s*item\s*\}\}/;
export const MAX_BATCH_ITEMS = 500;
