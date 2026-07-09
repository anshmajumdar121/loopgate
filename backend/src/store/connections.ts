// In-memory store of user-configured Connections + JSON persistence. A
// Connection is an external API endpoint (OpenAI-compatible, Anthropic-
// compatible, etc.) that the user adds so its models show up in the picker.
//
// apiKey handling: the in-memory object always has `apiKey` set when the
// user has provided one. Public-facing endpoints MUST NEVER serialise
// `apiKey` directly — use `toSummary(c)` for wire responses. The whole
// array is persisted as-is (apiKey included) because we own the file.

import { nanoid } from "nanoid";
import type {
  Connection,
  ConnectionModel,
  ConnectionProviderType,
  ConnectionSummary,
  UpsertConnectionBody,
} from "../types.js";
import {
  loadAllConnections,
  saveConnections,
} from "./persistence.js";

interface ConnectionStore {
  connections: Connection[];
}

const connectionStore: ConnectionStore = { connections: [] };

export function listConnections(): Connection[] {
  return [...connectionStore.connections].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : 1
  );
}

/** Wire-safe: apiKey is replaced with hasApiKey. */
export function listConnectionSummaries(): ConnectionSummary[] {
  return listConnections().map(toSummary);
}

function toSummary(c: Connection): ConnectionSummary {
  // Strip apiKey for transport. We construct a shallow clone to avoid
  // accidentally leaking the field through object identity.
  const { apiKey: _omit, ...rest } = c;
  return { ...rest, hasApiKey: Boolean(c.apiKey) };
}

export function getConnection(id: string): Connection | undefined {
  return connectionStore.connections.find((c) => c.id === id);
}

export function getConnectionSummary(
  id: string
): ConnectionSummary | undefined {
  const c = getConnection(id);
  return c ? toSummary(c) : undefined;
}

export function createConnection(input: UpsertConnectionBody): Connection {
  const now = new Date().toISOString();
  const connection: Connection = buildConnectionRecord(input, now, {
    apiKey: input.apiKey?.trim() || undefined,
    id: nanoid(12),
    createdAt: now,
  });
  connectionStore.connections.push(connection);
  void saveConnections(connectionStore.connections).catch((err) => {
    console.error(`[store] Failed to save connection ${connection.id}:`, err);
  });
  return connection;
}

export function updateConnection(
  id: string,
  input: UpsertConnectionBody
): Connection | undefined {
  const idx = connectionStore.connections.findIndex((c) => c.id === id);
  if (idx === -1) return undefined;
  const existing = connectionStore.connections[idx];
  // apiKey handling: if omitted from the body, keep existing; if explicitly
  // passed (including empty string), replace. The empty-string "clear it"
  // case is rare but useful for "rotate and reset" flows.
  const newApiKey =
    input.apiKey === undefined
      ? existing.apiKey
      : input.apiKey.trim() || undefined;
  const updated: Connection = buildConnectionRecord(
    input,
    existing.createdAt,
    {
      apiKey: newApiKey,
      id,
      createdAt: existing.createdAt,
    },
    existing
  );
  connectionStore.connections[idx] = updated;
  void saveConnections(connectionStore.connections).catch((err) => {
    console.error(`[store] Failed to save connection ${id}:`, err);
  });
  return updated;
}

/**
 * Shared construction logic for create + update. Pulled out so the field
 * handling is in one place — both paths apply the same normalisations and
 * the same "drop empty fields" rules.
 */
function buildConnectionRecord(
  input: UpsertConnectionBody,
  _nowFallback: string,
  meta: { apiKey: string | undefined; id: string; createdAt: string },
  existing?: Connection
): Connection {
  const now = new Date().toISOString();
  const model = input.model?.trim() || undefined;
  const modelLabel =
    input.modelLabel?.trim() || model
      ? input.modelLabel?.trim() || undefined
      : undefined;
  const temperature = clampTemperature(input.temperature);
  const providerId = input.providerId;
  const roles = normaliseRoles(input.roles);
  // Legacy `models[]` is normalised only when the new `model` shape isn't
  // in use. If both are provided, the new single-model shape wins.
  const models =
    input.models && !model ? normaliseModels(input.models) : undefined;
  return {
    ...(existing ?? {}),
    id: meta.id,
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    providerId,
    providerType: input.providerType,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""), // strip trailing slash
    apiKey: meta.apiKey,
    hasApiKey: Boolean(meta.apiKey),
    model,
    modelLabel,
    temperature,
    roles,
    models,
    createdAt: meta.createdAt,
    updatedAt: now,
  };
}

function normaliseRoles(
  roles: UpsertConnectionBody["roles"]
): Connection["roles"] {
  if (!roles) return undefined;
  const set = new Set<string>();
  for (const r of roles) {
    if (r === "planning" || r === "implementation" || r === "review") {
      set.add(r);
    }
  }
  return set.size === 0 ? undefined : Array.from(set) as Connection["roles"];
}

function clampTemperature(t: number | undefined): number | undefined {
  if (t === undefined || Number.isNaN(t)) return undefined;
  return Math.max(0, Math.min(2, t));
}

export function deleteConnection(id: string): boolean {
  const idx = connectionStore.connections.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  connectionStore.connections.splice(idx, 1);
  void saveConnections(connectionStore.connections).catch((err) => {
    console.error(`[store] Failed to save connections after delete:`, err);
  });
  return true;
}

export function loadConnectionsFromDisk(connections: Connection[]): void {
  connectionStore.connections = connections;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function normaliseModels(models: ConnectionModel[]): ConnectionModel[] {
  return models
    .filter((m) => m.id?.trim())
    .map((m) => ({
      id: m.id.trim(),
      label: m.label?.trim() || undefined,
      contextWindow:
        typeof m.contextWindow === "number" && m.contextWindow > 0
          ? m.contextWindow
          : undefined,
    }));
}

/**
 * Look up the full Connection for a model id returned by the picker.
 * Model ids exposed by connections are formed as `custom:<connId>:<modelId>`.
 * Returns null if the id isn't a custom one or the underlying connection
 * has been deleted.
 */
export function resolveConnectionModel(
  modelId: string
): { connection: Connection; model: ConnectionModel } | null {
  if (!modelId.startsWith("custom:")) return null;
  const parts = modelId.split(":");
  // parts[0] = "custom", parts[1] = connId, parts[2..] = modelId (may contain
  // ":" — so rejoin). Worst case: a single-conn-id case where parts[2] is
  // the model id; double split is correct only when connId has no colon
  // (it doesn't, nanoid(12)).
  const connId = parts[1];
  const mdlId = parts.slice(2).join(":");
  const connection = getConnection(connId);
  if (!connection) return null;
  const models = connection.models ?? [];
  const model = models.find((m) => m.id === mdlId);
  if (!model) return null;
  return { connection, model };
}

/** Re-export for callers that only have the providerType enum. */
export const PROVIDER_TYPES: readonly ConnectionProviderType[] = [
  "openai-compatible",
  "anthropic-compatible",
] as const;

/**
 * Provider key used in opencode config + model ids for a connection. Stable
 * across restarts so logs and `--model` flags don't change meaning over time.
 * Format: `loop-<id>` (e.g. `loop-5WY6zeHXOV`). The `loop-` prefix keeps it
 * distinct from any user-named or built-in provider key.
 */
export function providerKeyForConnection(c: Pick<Connection, "id">): string {
  return `loop-${c.id}`;
}

/**
 * The full model id opencode will see for a custom-connection model. The
 * picker format is `custom:<connId>:<upstreamModelId>`. We translate that
 * to `loop-<connId>/<upstreamModelId>` for opencode's `<provider>/<name>`
 * model shape, where the provider key is mapped by a generated per-spawn
 * config fragment (see `buildSpawnEnvForModel` in agent-spawner.ts).
 */
export function spawnModelIdForConnection(
  connection: Connection,
  upstreamModelId: string
): string {
  return `${providerKeyForConnection(connection)}/${upstreamModelId}`;
}

/**
 * Build the env-var patch a real opencode spawn applies when the chosen
 * model id is `custom:<connId>:<upstreamModelId>`. The orchestrator supplies
 * this to the spawner; the mock spawner uses it to log the routing so the
 * user can SEE which endpoint the task is heading out on.
 *
 * Currently produces:
 *   - LOOP_CONNECTION_NAME — friendly name (cosmetic, logged in mock)
 *   - LOOP_CONNECTION_BASE_URL — connection's endpoint URL
 *   - LOOP_CONNECTION_HAS_KEY — "true" / "false" (don't leak the key)
 *   - LOOP_MODEL — the upstream model id
 *   - LOOP_PROVIDER_KEY — the rewritten provider key (`loop-<connId>`)
 *
 * The actual API key is NEVER returned through this struct — the spawner
 * either re-reads it from the store directly (real path) or announces
 * `[mock-agent] using API key: ***set***` (mock path).
 */
export interface SpawnEnvOverride {
  modelForOpencode: string;
  upstreamModel: string;
  providerKey: string;
  connectionName: string;
  baseUrl: string;
  hasApiKey: boolean;
}

/** Build the SpawnEnvOverride for the chosen model id. For non-custom
 *  model ids (built-in / curated) this returns null — the spawner falls
 *  back to its existing behavior unmodified. */
export function buildSpawnEnvOverride(
  modelId: string | undefined
): SpawnEnvOverride | null {
  if (!modelId) return null;
  const parsed = resolveConnectionModel(modelId);
  if (!parsed) return null;
  const { connection, model } = parsed;
  return {
    modelForOpencode: spawnModelIdForConnection(connection, model.id),
    upstreamModel: model.id,
    providerKey: providerKeyForConnection(connection),
    connectionName: connection.name,
    baseUrl: connection.baseUrl,
    hasApiKey: Boolean(connection.apiKey),
  };
}
