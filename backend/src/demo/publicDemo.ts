// Public demo mode (LOOP_PUBLIC_DEMO=1): a locked-down profile for hosting
// Loopgate as a clickable demo on the open internet.
//
// The normal backend trusts its (local) user: it spawns real LLM / CLI
// agents, accepts arbitrary workdirs and stores API keys. In demo mode:
//   - the only model is the deterministic fake LLM from scripts/demo/,
//     started in-process on a loopback port (no keys, no network egress);
//   - connections are read-only (one in-memory demo connection);
//   - every write lands in a fresh temp dir; user workdirs, folders,
//     projects and context files are refused;
//   - batch size, prompt size and run rate are capped (see guard.ts);
//   - no build step, preview server or headless-browser runtime check runs.
// Each restriction is enforced at the HTTP layer (guard.ts) AND again where
// the dangerous thing would happen (spawner, task/connection stores).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Connection } from "../types.js";

export const DEMO_CONNECTION_ID = "public-demo-llm";
export const DEMO_UPSTREAM_MODEL = "fake-model";
export const DEMO_MODEL = `custom:${DEMO_CONNECTION_ID}:${DEMO_UPSTREAM_MODEL}`;

export function isPublicDemo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOOP_PUBLIC_DEMO === "1";
}

export interface PublicDemoLimits {
  /** Items per batch. */
  maxItems: number;
  /** Characters per batch item. */
  maxItemChars: number;
  /** Characters in a task prompt / batch template / re-prompt / feedback. */
  maxPromptChars: number;
  /** Attempts per task (batch maxAttempts is clamped to this). */
  maxAttempts: number;
  /** Loop runs (one plan→make→verify task each) per hour, whole instance. */
  loopsPerHour: number;
  /** Loop runs per hour per client (keyed on X-Forwarded-For; best effort). */
  loopsPerClientPerHour: number;
  /** Stored tasks before new runs are refused until the next restart. */
  maxTasks: number;
  /** Request body cap (bytes). */
  maxBodyBytes: number;
}

function intEnv(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function publicDemoLimits(env: NodeJS.ProcessEnv = process.env): PublicDemoLimits {
  return {
    maxItems: intEnv(env.LOOP_DEMO_MAX_ITEMS, 5, 1, 50),
    maxItemChars: intEnv(env.LOOP_DEMO_MAX_ITEM_CHARS, 200, 1, 4_000),
    maxPromptChars: intEnv(env.LOOP_DEMO_MAX_PROMPT_CHARS, 2_000, 3, 20_000),
    maxAttempts: intEnv(env.LOOP_DEMO_MAX_ATTEMPTS, 3, 1, 5),
    loopsPerHour: intEnv(env.LOOP_DEMO_LOOPS_PER_HOUR, 120, 1, 100_000),
    loopsPerClientPerHour: intEnv(env.LOOP_DEMO_LOOPS_PER_CLIENT_PER_HOUR, 30, 1, 100_000),
    maxTasks: intEnv(env.LOOP_DEMO_MAX_TASKS, 500, 1, 100_000),
    maxBodyBytes: intEnv(env.LOOP_DEMO_MAX_BODY_BYTES, 64 * 1024, 1_024, 10 * 1024 * 1024),
  };
}

/**
 * Env vars that would let the process reach something other than the
 * bundled fake LLM (keys, local CLIs, mocks, a swapped agent script) or
 * write outside the demo's temp dirs. Removed before any module reads them.
 */
export const PUBLIC_DEMO_SCRUBBED_ENV = [
  "LOOP_LLM_API_KEY",
  "LOOP_LOCAL_CLI",
  "LOOP_MAVIS_CLI",
  "LOOP_MAVIS_BIN",
  "LOOP_ALLOW_MOCK",
  "LOOP_LLM_AGENT_SCRIPT",
  "LOOP_WORKDIR",
] as const;

/**
 * Scrub dangerous env, force the LLM bridge (never opencode / mocks) and
 * point data + workspaces at a fresh temp dir unless the operator chose
 * them explicitly. Must run before the store modules are evaluated — see
 * demo/bootstrap.ts.
 */
export function preparePublicDemoEnv(env: NodeJS.ProcessEnv = process.env): {
  scrubbed: string[];
  dataDir: string;
  workspacesRoot: string;
} {
  const scrubbed: string[] = [];
  for (const k of PUBLIC_DEMO_SCRUBBED_ENV) {
    if (env[k] !== undefined) {
      delete env[k];
      scrubbed.push(k);
    }
  }
  env.LOOP_USE_LLM_BRIDGE = "1";
  if (!env.LOOP_DATA_DIR || !env.LOOP_WORKSPACES_ROOT) {
    const root = mkdtempSync(join(tmpdir(), "loopgate-public-demo-"));
    env.LOOP_DATA_DIR ||= join(root, "data", "tasks");
    env.LOOP_WORKSPACES_ROOT ||= join(root, "workspaces");
  }
  env.LOOP_MAX_BODY_BYTES ||= String(publicDemoLimits(env).maxBodyBytes);
  return { scrubbed, dataDir: env.LOOP_DATA_DIR, workspacesRoot: env.LOOP_WORKSPACES_ROOT };
}

/** Public hostnames the common free hosts inject into the environment. */
export function platformHostnames(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.RENDER_EXTERNAL_HOSTNAME) out.push(env.RENDER_EXTERNAL_HOSTNAME);
  if (env.RAILWAY_PUBLIC_DOMAIN) out.push(env.RAILWAY_PUBLIC_DOMAIN);
  if (env.FLY_APP_NAME) out.push(`${env.FLY_APP_NAME}.fly.dev`);
  return out;
}

/** Separator-agnostic containment: true iff `child` is `root` or inside it. */
export function isWithinDir(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false; // different drive on win32
  return rel !== ".." && !rel.startsWith(".." + sep) && !rel.startsWith("../");
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
  } catch {
    return false;
  }
}

// ─── The demo LLM connection ────────────────────────────────────────────────

let demoLlmUrl: string | null = null;

export function demoConnection(baseUrl: string): Connection {
  if (!isLoopbackUrl(baseUrl)) {
    throw new Error(`public demo: the demo LLM must be on loopback, got ${baseUrl}`);
  }
  const now = new Date().toISOString();
  return {
    id: DEMO_CONNECTION_ID,
    name: "Demo LLM (offline)",
    description: "Deterministic fake LLM bundled with the public demo — no API key, no network.",
    providerId: "custom",
    providerType: "openai-compatible",
    baseUrl,
    hasApiKey: true,
    // Not a secret: the fake LLM ignores it. Set so the pre-flight
    // "connection has no API key" check passes.
    apiKey: "sk-public-demo",
    model: DEMO_UPSTREAM_MODEL,
    modelLabel: "Demo LLM (offline, deterministic)",
    roles: ["planning", "implementation", "review"],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Start the deterministic fake LLM from scripts/demo/ on a free loopback
 * port with its attack modes locked off. Returns the demo connection.
 */
export async function startPublicDemoLlm(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ connection: Connection; close: () => void }> {
  // Resolved relative to this module so it works from src/ (tsx) and dist/.
  const modUrl = new URL("../../scripts/demo/fake-llm.mjs", import.meta.url).href;
  const { startFakeLlm } = await import(modUrl);
  const llm = await startFakeLlm({
    port: 0,
    delayMs: intEnv(env.DEMO_LLM_DELAY_MS, 800, 0, 30_000),
    lockMode: true,
  });
  demoLlmUrl = llm.url as string;
  return { connection: demoConnection(llm.url), close: () => llm.close() };
}

/**
 * Last line of defence, called by the agent spawner before anything runs:
 * in demo mode the only acceptable target is the in-process fake LLM.
 */
export function assertPublicDemoSpawn(connection: Connection | null | undefined): void {
  const problems: string[] = [];
  if (!connection) problems.push("no connection");
  else {
    if (connection.id !== DEMO_CONNECTION_ID) problems.push(`connection ${connection.id} is not the demo LLM`);
    if (connection.providerType !== "openai-compatible") problems.push(`provider ${connection.providerType}`);
    if (!demoLlmUrl || connection.baseUrl !== demoLlmUrl) problems.push(`endpoint ${connection.baseUrl}`);
  }
  if (process.env.LOOP_USE_LLM_BRIDGE === "0") problems.push("LLM bridge disabled");
  if (process.env.LOOP_LOCAL_CLI || process.env.LOOP_MAVIS_CLI) problems.push("local CLI env set");
  if (problems.length > 0) {
    throw new Error(`public demo: refusing to spawn agent (${problems.join("; ")})`);
  }
}

/** Test hook: pretend the demo LLM runs at `url` (null to reset). */
export function __setDemoLlmUrlForTests(url: string | null): void {
  demoLlmUrl = url;
}
