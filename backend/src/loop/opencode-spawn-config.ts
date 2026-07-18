// Builds a per-spawn opencode config fragment that maps the user's custom
// `loop-<connId>` provider keys to baseURL + apiKey. The spawner writes this
// to `<workdir>/.opencode.task.json`, points `opencode --config` at it, and
// cleans it up after the agent exits.
//
// We don't write the connection's apiKey into the project's own
// `opencode.json` — that would commit credentials to git and pollute the
// user's repo. The `.task.json` suffix and the leading `.` mean it's
// auto-ignored by most tooling, but the cleanup step is what protects us
// for real: the file only exists for the lifetime of one agent run.

import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { Connection } from "../types.js";
import { providerKeyForConnection } from "../store/connections.js";

/** Shape of the per-spawn opencode config. Only the `provider` block is
 *  used — `agent` settings stay in the project's `opencode.json` so the
 *  loop orchestrator's sub-agent definitions (loop-planner, loop-maker,
 *  loop-verifier) still apply. */
export interface SpawnConfig {
  $schema?: string;
  provider: Record<string, ProviderEntry>;
}

interface ProviderEntry {
  /** npm package implementing this provider's SDK (opencode convention). */
  npm: string;
  /** Forwarded by opencode to the SDK at runtime. */
  options: {
    baseURL: string;
    apiKey: string;
  };
}

/**
 * Build the config fragment for one or more connections. Each connection
 * gets its own provider entry, keyed by `providerKeyForConnection(c)`.
 */
export function buildSpawnConfig(connections: Connection[]): SpawnConfig {
  const provider: Record<string, ProviderEntry> = {};
  for (const c of connections) {
    provider[providerKeyForConnection(c)] = {
      ...providerEntryFor(c),
    };
  }
  return { $schema: "https://opencode.ai/config.json", provider };
}

function providerEntryFor(c: Connection): ProviderEntry {
  // The actual npm + adapter specifics differ by SDK, but the shape that
  // matters for the LLM to actually use the connection is the same: an
  // entry with a real npm package and an `options` block carrying the
  // baseURL + apiKey. The two SDKs we currently support — OpenAI and
  // Anthropic — are the canonical ones opencode's ecosystem supports.
  switch (c.providerType) {
    case "openai-compatible":
      return {
        npm: "@ai-sdk/openai",
        options: {
          baseURL: c.baseUrl,
          apiKey: c.apiKey ?? "",
        },
      };
    case "anthropic-compatible":
      return {
        npm: "@ai-sdk/anthropic",
        options: {
          baseURL: c.baseUrl,
          apiKey: c.apiKey ?? "",
        },
      };
    case "local-cli":
      // Not actually reachable in practice: local-cli connections run
      // through the bridge runner's `--cli` path (spawnBridgeRunner),
      // which never touches this opencode CLI config-fragment path.
      // Handled here only so this switch stays exhaustive; the entry
      // itself is inert (no npm SDK talks to a local CLI over HTTP).
      return {
        npm: "@ai-sdk/openai",
        options: {
          baseURL: c.baseUrl,
          apiKey: "",
        },
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Materialise on disk + cleanup
// ─────────────────────────────────────────────────────────────────────────────

/** Path to the per-spawn config fragment. Lives inside the workdir so the
 *  spawned process picks it up via the same `cwd`-based relative path
 *  resolution opencode uses for the project config. */
export const SPAWN_CONFIG_FILENAME = ".opencode.task.json";

export function spawnConfigPath(workdir: string): string {
  return pathResolve(workdir, SPAWN_CONFIG_FILENAME);
}

/**
 * Write the config fragment + return its absolute path so the spawner can
 * pass it as `--config <path>`. Idempotent — overwrites any prior
 * `.opencode.task.json` for the same workdir.
 *
 * `onExitCleanup` is wired by the spawner so the file is removed the
 * moment the agent exits (success, failure, or killed). Stale files from
 * crashed backends aren't a security issue (the apiKey is already on disk
 * in `_connections.json`) but they ARE a clutter issue, so the cleanup
 * is worth wiring.
 */
export function writeSpawnConfig(
  workdir: string,
  connections: Connection[]
): string {
  const path = spawnConfigPath(workdir);
  const config = buildSpawnConfig(connections);
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  return path;
}

/** Attach an exit handler that removes the per-spawn config file. Safe to
 *  call multiple times — if the file is already gone, `unlinkSync` is
 *  skipped via the ENOENT check. */
export function attachSpawnConfigCleanup(
  workdir: string,
  exited: Promise<number | null>
): void {
  const path = spawnConfigPath(workdir);
  void exited
    .catch(() => null)
    .finally(() => {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        /* ENOENT or perm error — leave it, no big deal */
      }
    });
}
