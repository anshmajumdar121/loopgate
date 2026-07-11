// In-memory store of per-model token usage, aggregated from completed
// LLM calls. Persists to disk as a single JSON file so counts survive
// backend restarts.
//
// Keying: we use the picker-facing model id (e.g.
// `custom:<connId>:<upstreamId>` for connection models, or
// `anthropic/claude-sonnet-4.5` for curated models) as the primary key.
// We also store the underlying connection id / name so the UI can group
// rows by provider when desired.

import {
  loadAllTokenUsage,
  saveTokenUsage,
} from "./persistence.js";

export interface TokenUsageEntry {
  /** Picker-facing model id (`custom:<connId>:<upstreamId>` or
   *  `provider/model-name`). Stable across restarts. */
  modelId: string;
  /** Friendly upstream model id (e.g. `minimax/minimax-m3`). */
  upstreamModel: string;
  /** Connection id this model belongs to, or null for curated entries. */
  connectionId: string | null;
  /** Connection name for display, or null for curated entries. */
  connectionName: string | null;
  /** Connection baseUrl for display, or null for curated entries. */
  baseUrl: string | null;
  /** Cumulative prompt (input) tokens. */
  promptTokens: number;
  /** Cumulative completion (output) tokens. */
  completionTokens: number;
  /** Cumulative total tokens. = prompt + completion. */
  totalTokens: number;
  /** Number of LLM calls captured for this model. */
  callCount: number;
  /** Last time usage was recorded (ISO timestamp). */
  lastUsed: string;
}

interface UsageStore {
  entries: Record<string, TokenUsageEntry>;
}

const usageStore: UsageStore = { entries: {} };

/**
 * Record usage for a single LLM call. Idempotent w.r.t. the input values
 * (we sum, not replace). Creates the entry on first call. Saves to disk
 * asynchronously — failure to persist is logged but does not propagate.
 */
export function recordUsage(input: {
  modelId: string;
  upstreamModel: string;
  connectionId: string | null;
  connectionName: string | null;
  baseUrl: string | null;
  promptTokens: number;
  completionTokens: number;
}): TokenUsageEntry {
  const key = input.modelId;
  const now = new Date().toISOString();
  const prompt = Math.max(0, Math.floor(input.promptTokens));
  const completion = Math.max(0, Math.floor(input.completionTokens));
  const existing = usageStore.entries[key];
  if (existing) {
    existing.promptTokens += prompt;
    existing.completionTokens += completion;
    existing.totalTokens = existing.promptTokens + existing.completionTokens;
    existing.callCount += 1;
    existing.lastUsed = now;
    // Connection fields may not have been set on first call (e.g. the
    // curated models). Backfill from later calls so the UI can show them.
    if (!existing.upstreamModel && input.upstreamModel) {
      existing.upstreamModel = input.upstreamModel;
    }
    if (!existing.connectionId && input.connectionId) {
      existing.connectionId = input.connectionId;
    }
    if (!existing.connectionName && input.connectionName) {
      existing.connectionName = input.connectionName;
    }
    if (!existing.baseUrl && input.baseUrl) {
      existing.baseUrl = input.baseUrl;
    }
    void persist();
    return existing;
  }
  const entry: TokenUsageEntry = {
    modelId: input.modelId,
    upstreamModel: input.upstreamModel,
    connectionId: input.connectionId,
    connectionName: input.connectionName,
    baseUrl: input.baseUrl,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    callCount: 1,
    lastUsed: now,
  };
  usageStore.entries[key] = entry;
  void persist();
  return entry;
}

/** All entries, sorted by total tokens (descending). */
export function listUsage(): TokenUsageEntry[] {
  return Object.values(usageStore.entries).sort(
    (a, b) => b.totalTokens - a.totalTokens
  );
}

/** Entries scoped to a single connection id. */
export function listUsageForConnection(
  connectionId: string
): TokenUsageEntry[] {
  return listUsage().filter((e) => e.connectionId === connectionId);
}

/** Aggregate rollup used by the panel-header pill. */
export function usageTotals(): {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  callCount: number;
  modelCount: number;
} {
  let total = 0,
    prompt = 0,
    completion = 0,
    calls = 0;
  for (const e of Object.values(usageStore.entries)) {
    total += e.totalTokens;
    prompt += e.promptTokens;
    completion += e.completionTokens;
    calls += e.callCount;
  }
  return {
    totalTokens: total,
    promptTokens: prompt,
    completionTokens: completion,
    callCount: calls,
    modelCount: Object.keys(usageStore.entries).length,
  };
}

/**
 * Drop entries for a connection. Used when the user deletes a connection
 * so the panel doesn't show stale rows for connections that no longer
 * exist. Returns the number of entries removed.
 */
export function dropConnectionUsage(connectionId: string): number {
  let n = 0;
  for (const [k, e] of Object.entries(usageStore.entries)) {
    if (e.connectionId === connectionId) {
      delete usageStore.entries[k];
      n++;
    }
  }
  if (n > 0) void persist();
  return n;
}

/**
 * Clear all stored usage. Mostly for tests / dev tooling.
 */
export function clearUsage(): void {
  for (const k of Object.keys(usageStore.entries)) {
    delete usageStore.entries[k];
  }
  void persist();
}

/**
 * Replace the in-memory store with the persisted state. Called once at
 * boot from index.ts.
 */
export function loadUsageFromDisk(entries: TokenUsageEntry[]): void {
  usageStore.entries = {};
  for (const e of entries) {
    if (e && typeof e.modelId === "string") {
      usageStore.entries[e.modelId] = e;
    }
  }
}

let persistChain: Promise<void> = Promise.resolve();

function persist(): void {
  // Serialise saves so concurrent calls don't race the .tmp → .json
  // rename. Same pattern as saveTask in persistence.ts.
  const next = persistChain
    .catch(() => undefined)
    .then(() => saveTokenUsage(Object.values(usageStore.entries)));
  persistChain = next;
}
