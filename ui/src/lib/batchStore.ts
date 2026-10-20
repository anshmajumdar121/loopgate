import { useEffect } from "react";
import { create } from "zustand";
import type { Batch } from "@/types/batch";
import { fetchBatches } from "@/lib/batchApi";

/**
 * Client mirror of the backend's batches. Fed by GET /api/batches, the
 * `batch_update` WebSocket broadcast (see useLoopSocket), and a 3s polling
 * fallback while any batch is active. Kept separate from the workflow store
 * because batches aren't scoped to the current task.
 */
interface BatchState {
  batches: Batch[];
  loaded: boolean;
  selectedBatchId: string | null;
  setBatches: (batches: Batch[]) => void;
  upsertBatch: (batch: Batch) => void;
  selectBatch: (id: string | null) => void;
}

function sortNewestFirst(list: Batch[]): Batch[] {
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const useBatchStore = create<BatchState>((set) => ({
  batches: [],
  loaded: false,
  selectedBatchId: null,
  setBatches: (batches) => set({ batches: sortNewestFirst(batches), loaded: true }),
  upsertBatch: (batch) =>
    set((s) => {
      const rest = s.batches.filter((b) => b.id !== batch.id);
      return { batches: sortNewestFirst([...rest, batch]) };
    }),
  selectBatch: (id) => set({ selectedBatchId: id }),
}));

export function isBatchActive(b: Pick<Batch, "status">): boolean {
  return b.status === "running" || b.status === "queued";
}

export async function refreshBatches(): Promise<void> {
  try {
    useBatchStore.getState().setBatches(await fetchBatches());
  } catch (e) {
    console.error("[batches] refresh failed", e);
  }
}

export const BATCH_POLL_MS = 3000;

/** Fetch once on mount, then poll every 3s while any batch is active. */
export function useBatchSync(): void {
  const anyActive = useBatchStore((s) => s.batches.some(isBatchActive));
  useEffect(() => {
    void refreshBatches();
  }, []);
  useEffect(() => {
    if (!anyActive) return;
    const id = window.setInterval(() => void refreshBatches(), BATCH_POLL_MS);
    return () => window.clearInterval(id);
  }, [anyActive]);
}
