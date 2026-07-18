// Spawn `opencode run --agent loop-<role>` subprocesses and stream their
// output line-by-line to the caller. When the `opencode` CLI is not installed
// on PATH, fall back to a deterministic mock that streams synthetic thinking
// output AND writes the appropriate markdown into GOAL.md / STATE.md, so the
// orchestrator's parser code path is identical to the real path.
//
// Why mock fallback matters: the developer can run the whole stack end-to-end
// without installing `opencode`. The UI demo, the REST + WS event flow, and
// the file-watching plumbing all work the same way.
//
// Mock content strategy:
//   planner   → replaces GOAL.md with a small plan derived from the task title
//   maker     → appends `## Diff Summary — Attempt N` to STATE.md
//   verifier  → appends `## Verifier Verdict — Attempt N` to STATE.md
//
// Each mock section matches the exact heading + `**Field:** value` format the
// real agent produces, so the parser treats it identically.

import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import type { Connection } from "../types.js";
import {
  attachSpawnConfigCleanup,
  writeSpawnConfig,
} from "./opencode-spawn-config.js";
import {
  buildSpawnEnvOverride,
  providerKeyForConnection,
} from "../store/connections.js";
import { recordUsage } from "../store/tokenUsage.js";
import { writeTrace, type TraceRecord, type TraceRole } from "../store/traces.js";

/**
 * Bridge runner that bypasses the `opencode` CLI subprocess. Why this
 * exists: opencode CLI 1.14.28 (bundled with mavis Code) sends a request
 * body shape that NVIDIA / Zenmux openai-compatible endpoints reject with
 * 404 (incompatible @ai-sdk/openai version inside the bundled binary).
 * Until the CLI is upgraded we route phase agents through this minimal
 * Node.js script that uses an `@ai-sdk/openai` version pinned to one that
 * sends proper `/chat/completions` requests. The orchestrator's file
 * watchers + WebSocket broadcast pipeline are unchanged.
 *
 * Agent → output file mapping (the script just writes the LLM's reply
 * verbatim to the target file):
 *   planner  → <workdir>/GOAL.md
 *   maker    → <workdir>/index.html (LLM emits a single ```html ... ``` block)
 *   verifier → <workdir>/STATE.md (LLM emits the `## Verifier Verdict` block)
 *
 * The system prompts tell the LLM what role it's playing and what to emit.
 * Read by the watcher just like real agent output — no parser change.
 */
const LLM_AGENT_SCRIPT = pathResolve(
  process.env.LOOP_LLM_AGENT_SCRIPT ??
    `${process.cwd()}/llm-agent.mjs`,
);
// System prompts are loaded lazily inside llm-agent.mjs at runtime from
// `<workdir>/.opencode/agents/loop-<role>.md` (with per-role tool-mode
// overrides appended for the bridge runner). We don't precompute them here
// because the orchestrator's spawnAgent() receives workdir per-call, not at
// module load. Keeping this constant empty is intentional — leaving a
// stub function here was confusing (it always returned "").
const LLM_AGENT_OUTPUT_FILE: Record<AgentName, (workdir: string) => string> = {
  planner: (workdir) => pathResolve(workdir, "GOAL.md"),
  maker: (workdir) => pathResolve(workdir, "index.html"),
  verifier: (workdir) => pathResolve(workdir, "STATE.md"),
};

export type AgentName = "planner" | "maker" | "verifier";

export interface AgentHandle {
  /** OS process id, or a synthetic id (>1e9) for mock agents. */
  pid: number;
  /** True when running in mock fallback mode (no `opencode` binary). */
  isMock: boolean;
  /**
   * Promise that resolves with the exit code when the agent finishes.
   * `null` if the process was killed by a signal.
   */
  exited: Promise<number | null>;
  /** Send SIGTERM (or taskkill on Windows) to the agent. */
  kill(): void;
  /**
   * Wall-clock ms timestamp of the most recent stdout/stderr activity
   * from this agent. Updated by the line buffer on every chunk. The
   * orchestrator's stall watchdog compares this against Date.now() to
   * detect a hung-but-alive process. For mock agents, set whenever the
   * mock stream emits a line.
   */
  lastActivityAt: number;
  /**
   * Read-only handle for tests. Returns the most recent chunk of stdout
   * captured so far (since spawn). Used by partial-output salvage to
   * parse a verdict out of a stalled verifier's accumulated output.
   * Empty for mock agents unless they expose a separate buffer.
   */
  getAccumulatedOutput?(): string;
}

type LineCallback = (line: string) => void;
type ExitCallback = (code: number | null) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Live agent processes, keyed by taskId. The orchestrator calls `killAgent`
 * on `POST /tasks/:id/stop`, and this map is how it finds the matching
 * process. Mock agents are tracked too so `kill` is a clean no-op rather
 * than a crash.
 */
const AGENT_HANDLES = new Map<string, AgentHandle>();

/**
 * Probe for `opencode` once at module load. We use `which` semantics via
 * spawnSync ENOENT — if the binary is absent, we fall back to mock for every
 * subsequent spawn. There's no path to "try opencode again later" without
 * reloading the module; in practice `opencode` install/uninstall requires a
 * backend restart anyway.
 */
const OPENCODE_AVAILABLE: boolean = (() => {
  try {
    const probe = spawnSync("opencode", ["--version"], {
      stdio: "ignore",
      shell: false,
    });
    return probe.status !== null && !probe.error;
  } catch {
    return false;
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// Bridge runner — invokes `node llm-agent.mjs` instead of `opencode`.
// ─────────────────────────────────────────────────────────────────────────────

function spawnBridgeRunner(
  agent: AgentName,
  taskId: string,
  workdir: string,
  runPrompt: string,
  onStdout: LineCallback,
  onStderr: LineCallback,
  onExit: ExitCallback,
  options: SpawnAgentOptions | null,
): AgentHandle {
  const outFile = LLM_AGENT_OUTPUT_FILE[agent](workdir);
  const connection = options?.connection ?? null;
  // The picker model id is `custom:<connId>:<upstreamId>`. The bridge
  // runner needs the raw upstream id (e.g. `z-ai/glm-5.2`). Strip the
  // prefix to get it.
  let upstreamModel = "z-ai/glm-5.2"; // safe fallback that works against NVIDIA NIM
  const pickerModel = options?.model;
  if (pickerModel && pickerModel.startsWith("custom:")) {
    const parts = pickerModel.split(":");
    if (parts.length >= 3) upstreamModel = parts.slice(2).join(":");
  } else if (pickerModel) {
    upstreamModel = pickerModel;
  }
  const baseUrl = connection?.baseUrl ?? "https://integrate.api.nvidia.com/v1";
  const apiKey = connection?.apiKey ?? "";

  // Local-CLI mode: no API key, no network endpoint — the bridge script
  // shells out to the machine's `claude` CLI instead of an OpenAI-compatible
  // HTTP endpoint. Triggered either by the resolved connection's providerType
  // or, for ad-hoc/manual testing without wiring up a connection, the
  // LOOP_LOCAL_CLI=1 env var.
  const useLocalCli =
    connection?.providerType === "local-cli" || process.env.LOOP_LOCAL_CLI === "1";

  const args: string[] = [
    // NOTE: do NOT prepend LLM_AGENT_SCRIPT here. The script path is passed
    // to spawn() as the executable's argv[1] (right after the node binary),
    // and then this `args` array fills argv[2..]. If we also include the
    // script path as the first element of `args`, the child sees the script
    // path TWICE — once as argv[1] (correct, that's how Node loads the
    // script) and once as argv[2] (a positional arg). llm-agent.mjs's
    // parseArgs() then treats argv[2] as the user prompt (its default
    // branch sets `out.prompt = a` for the first non-flag positional arg),
    // overwriting the LOOP_USER_PROMPT env var that carries the real task
    // description. Symptom: the LLM "receives only a file path" and
    // ESCALATEs immediately.
    "--model",
    upstreamModel,
    "--base-url",
    baseUrl,
    "--api-key",
    useLocalCli ? "" : apiKey,
    "--workdir",
    workdir,
    "--role",
    agent,
    "--output",
    outFile,
    "--max-tokens",
    // Verifier gets the same budget as the maker: GLM-class thinking models
    // spend tokens on reasoning before emitting content, and at 4096 the
    // verifier's reasoning exhausted the budget leaving content empty
    // (observed: "LLM OK ... 0 chars" → "no Verdict section" escalation).
    String(agent === "planner" ? 4096 : 8192),
    "--temperature",
    "0.7",
  ];
  if (useLocalCli) {
    args.push("--cli");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOOP_TASK_ID: taskId,
    LOOP_ROLE: agent,
    LOOP_BRIDGE: "1",
    // Routing metadata for the usage-capture channel. llm-agent.mjs
    // reads these on completion to attribute token usage to the right
    // model + connection (or null for curated models).
    LOOP_MODEL_ID: options?.model ?? upstreamModel,
    LOOP_CONNECTION_ID: connection?.id ?? "",
    LOOP_CONNECTION_NAME: connection?.name ?? "",
  };

  let child: ChildProcess;
  try {
    // IMPORTANT: argv size limit on macOS is ~256KB. The system prompt +
    // user prompt + task description easily exceed that on this path.
    // We pass the long strings via env vars instead of argv so spawn
    // doesn't blow up. llm-agent.mjs accepts --system / --prompt for
    // short use; for this orchestrator we wire them through env.
    const envWithPrompt: NodeJS.ProcessEnv = {
      ...env,
      // LOOP_SYSTEM_PROMPT intentionally left unset — llm-agent.mjs falls
      // through to loading <workdir>/.opencode/agents/loop-<role>.md at
      // runtime, then appends the per-role tool-mode override.
      LOOP_USER_PROMPT: runPrompt,
    };
    child = spawn(process.execPath, [LLM_AGENT_SCRIPT, ...args], {
      cwd: workdir,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: envWithPrompt,
    });
  } catch (err) {
    queueMicrotask(() => onExit(null));
    return makeFailedHandle(taskId, err);
  }

  if (!child.pid) {
    queueMicrotask(() => onExit(null));
    return makeFailedHandle(taskId, new Error("bridge spawn returned no pid"));
  }

  child.on("error", (err) => {
    onStderr(`[bridge-spawn-error] ${err.message}`);
    onExit(null);
  });

  // ponytail: shared liveness target updated by attachLineBuffer on every
  // chunk; the returned handle's `lastActivityAt` reads from this same
  // object so the orchestrator's stall watchdog sees live values.
  const activityTarget = { lastActivityAt: Date.now() };
  const spawnTs = new Date().toISOString();
  // Capture the latest usage payload the bridge runner reports on stderr.
  // Forwarded by wrapStderrForUsageCapture on every successful parse —
  // overwritten on each call, so the post-exit value is the final one.
  const usageRef: { promptTokens: number | null; completionTokens: number | null } = {
    promptTokens: null,
    completionTokens: null,
  };
  attachLineBuffer(child.stdout, onStdout, activityTarget);
  // Stderr carries both human-readable diagnostic lines AND a structured
  // token-usage line (`__LOOP_USAGE__:{json}__END__`). The capture
  // wrapper routes the structured line into the usage store and forwards
  // the rest to the caller's onStderr unchanged.
  attachLineBuffer(
    child.stderr,
    wrapStderrForUsageCapture(onStderr, (u) => {
      usageRef.promptTokens = u.promptTokens;
      usageRef.completionTokens = u.completionTokens;
    }),
    activityTarget
  );

  const exited = new Promise<number | null>((resolve) => {
    let resolved = false;
    const resolveOnce = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      try {
        onExit(code);
      } catch {
        /* caller bug — don't propagate */
      }
      resolve(code);
    };
    child.on("exit", (code, signal) => {
      // Best-effort trace write. Failure here must NOT propagate — the
      // orchestrator already saw onExit, and a trace bug shouldn't kill
      // a working run. Recursive-improve (Phase 2) just won't have this
      // call's data, which is the correct degradation.
      void writeTraceBestEffort(
        workdir,
        {
          taskId,
          attempt: options?.attempt ?? 0,
          role: agent as TraceRole,
          model: options?.model ?? null,
          upstreamModel,
          connectionId: connection?.id ?? null,
          connectionName: connection?.name ?? null,
          ts: spawnTs,
          durationMs: Date.now() - new Date(spawnTs).getTime(),
          userPrompt: runPrompt,
          outputFile: outFile,
          promptTokens: usageRef.promptTokens,
          completionTokens: usageRef.completionTokens,
          exitCode: signal ? null : code,
        },
        onStderr
      );
      resolveOnce(signal ? null : code);
    });
  });

  return {
    pid: child.pid,
    isMock: false,
    exited,
    get lastActivityAt() { return activityTarget.lastActivityAt; },
    kill() {
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            /* already dead */
          }
        }
        const killPid = child.pid;
        setTimeout(() => {
          try {
            process.kill(-killPid, "SIGKILL");
          } catch {
            try {
              process.kill(killPid, "SIGKILL");
            } catch {
              /* already dead */
            }
          }
        }, 1500);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options that control how the agent spawn actually routes the model call.
 *
 * - `model`: the picker-facing id (e.g. `custom:<connId>:<upstreamId>` for
 *   a user-defined connection, or `anthropic/claude-sonnet-4.5` for the
 *   curated list). The spawner passes this as `--model` to opencode; for
 *   custom models it ALSO translates to `<providerKey>/<upstreamId>` and
 *   writes a per-spawn opencode config fragment.
 *
 * - `connection`: when the picked model belongs to a configured external
 *   API (`Connection`), the spawner uses this to (a) decide the rewritten
 *   model id, (b) inject the upstream API key into the spawned env, and
 *   (c) write `<workdir>/.opencode.task.json` so opencode learns about the
 *   provider's baseURL + key. Cleaned up automatically on agent exit.
 */
export interface SpawnAgentOptions {
  model?: string;
  connection?: Connection | null;
  /** 1-indexed attempt number — written into the trace filename. Optional
   *  so existing call sites keep working; missing attempts become "0" in
   *  the trace path. */
  attempt?: number;
}

export function spawnAgent(
  agent: AgentName,
  taskId: string,
  workdir: string,
  runPrompt: string,
  onStdout: LineCallback,
  onStderr: LineCallback,
  onExit: ExitCallback,
  options?: SpawnAgentOptions
): AgentHandle {
  // If a previous agent for this task is still alive (shouldn't happen in
  // normal flow, but defensive), kill it first to avoid orphaned processes.
  const previous = AGENT_HANDLES.get(taskId);
  if (previous) {
    try {
      previous.kill();
    } catch {
      /* ignore */
    }
    AGENT_HANDLES.delete(taskId);
  }

  if (!OPENCODE_AVAILABLE) {
    const handle = spawnMock(
      agent,
      taskId,
      workdir,
      runPrompt,
      onStdout,
      onStderr,
      onExit,
      options
    );
    AGENT_HANDLES.set(taskId, handle);
    return handle;
  }

  const handle = spawnReal(
    agent,
    taskId,
    workdir,
    runPrompt,
    onStdout,
    onStderr,
    onExit,
    options
  );
  AGENT_HANDLES.set(taskId, handle);
  return handle;
}

/**
 * Kill the agent associated with `taskId`, if one is running. Idempotent —
 * safe to call when no agent is alive.
 */
export function killAgent(taskId: string): void {
  const handle = AGENT_HANDLES.get(taskId);
  if (!handle) return;
  try {
    handle.kill();
  } catch {
    /* ignore */
  }
  AGENT_HANDLES.delete(taskId);
}

/**
 * True when `opencode` is on PATH. Exposed for tests / status endpoints.
 */
export function isOpencodeAvailable(): boolean {
  return OPENCODE_AVAILABLE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real spawn — child_process.spawn with line buffering
// ─────────────────────────────────────────────────────────────────────────────

function spawnReal(
  agent: AgentName,
  taskId: string,
  workdir: string,
  runPrompt: string,
  onStdout: LineCallback,
  onStderr: LineCallback,
  onExit: ExitCallback,
  options: SpawnAgentOptions | undefined
): AgentHandle {
  const absoluteWorkdir = pathResolve(workdir);

  // Branch 1 — bridge runner: invoke `llm-agent.mjs` directly. This is the
  // active path because the bundled `opencode` CLI's @ai-sdk/openai is
  // incompatible with the NVIDIA NIM / Zenmux openai-compatible endpoints
  // (sends to /v1/responses instead of /chat/completions, defaults to
  // temperature=0). The bridge runner talks to the same provider's chat-
  // completions endpoint with the right request shape, then writes the
  // LLM reply to the file the orchestrator's watcher expects
  // (GOAL.md / index.html / STATE.md). Same phase transitions as the
  // real agent path.
  if (process.env.LOOP_USE_LLM_BRIDGE !== "0") {
    return spawnBridgeRunner(
      agent,
      taskId,
      absoluteWorkdir,
      runPrompt,
      onStdout,
      onStderr,
      onExit,
      options ?? null,
    );
  }

  // Branch 2 — original opencode CLI subprocess (kept for the day the
  // bundled CLI gets fixed or we upgrade opencode). Reachable by setting
  // LOOP_USE_LLM_BRIDGE=0 in the backend env.
  const override = buildSpawnEnvOverride(options?.model);

  // Translate picker-facing model id → opencode-facing one. For custom
  // connections, this rewrites `custom:<connId>:<upstreamId>` to
  // `loop-<connId>/<upstreamId>` so opencode routes through the provider
  // block we write to `.opencode.task.json` below.
  const modelForOpencode = override?.modelForOpencode ?? options?.model;

  // Build the argv. --model flag goes BEFORE the agent flag (opencode flag
  // ordering: global flags first, then subcommand, then subcommand flags).
  const args: string[] = ["run"];

  // Write the per-spawn opencode config fragment if there's an override.
  // The fragment maps `loop-<connId>` → provider block (npm + baseURL +
  // apiKey). Auto-cleaned up via the agent's exit promise below.
  let spawnConfigPath: string | null = null;
  if (override && options?.connection) {
    try {
      spawnConfigPath = writeSpawnConfig(absoluteWorkdir, [
        options.connection,
      ]);
      args.push("--config", spawnConfigPath);
    } catch (err) {
      // Don't fail the spawn over a config write blip — fall back to the
      // picker-built model id without the rewritten provider key, which
      // will at worst fall through to whatever opencode has globally.
      onStderr(
        `[spawn-config] failed to write ${spawnConfigPath ?? ".opencode.task.json"}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  if (modelForOpencode) {
    args.push("--model", modelForOpencode);
  }
  args.push("--agent", `loop-${agent}`, runPrompt);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOOP_TASK_ID: taskId,
    LOOP_ROLE: agent,
  };
  if (modelForOpencode) {
    // Backup channel: some opencode versions may read this env var. Harmless
    // if ignored.
    env.OPENCODE_MODEL = modelForOpencode;
    env.LOOP_MODEL = modelForOpencode;
  }
  // For custom connections, also inject the upstream-friendly env vars
  // (OPENAI_BASE_URL / OPENAI_API_KEY, ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY)
  // so SDKs that natively honour them can route correctly even without the
  // config fragment being read. These override any values the project
  // opencode.json already sets — that's the intent.
  if (override && options?.connection) {
    const c = options.connection;
    if (c.providerType === "openai-compatible") {
      env.OPENAI_BASE_URL = c.baseUrl;
      if (c.apiKey) env.OPENAI_API_KEY = c.apiKey;
    } else if (c.providerType === "anthropic-compatible") {
      env.ANTHROPIC_BASE_URL = c.baseUrl;
      if (c.apiKey) env.ANTHROPIC_API_KEY = c.apiKey;
    }
    // Cosmetic env so spawned shells / child tooling can SEE which
    // connection is active without us leaking the key value:
    env.LOOP_CONNECTION_NAME = c.name;
    env.LOOP_CONNECTION_BASE_URL = c.baseUrl;
    env.LOOP_CONNECTION_HAS_KEY = c.apiKey ? "true" : "false";
    env.LOOP_PROVIDER_KEY = override.providerKey;
    env.LOOP_UPSTREAM_MODEL = override.upstreamModel;
    if (typeof c.temperature === "number") {
      env.LOOP_TEMPERATURE = String(c.temperature);
    }
  }

  let child: ChildProcess;
  try {
    child = spawn("opencode", args, {
      cwd: absoluteWorkdir,
      // detached: true puts the child in its own process group on Unix so we
      // can SIGTERM the whole tree with `kill -<pid>`. On Windows detached is
      // a no-op for process groups but doesn't hurt.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch (err) {
    // spawn() can throw synchronously on missing binary on some platforms.
    // Surface as immediate exit so the orchestrator can react.
    queueMicrotask(() => onExit(null));
    return makeFailedHandle(taskId, err);
  }

  // spawn() does NOT throw on ENOENT; it emits an 'error' event instead.
  if (!child.pid) {
    queueMicrotask(() => onExit(null));
    return makeFailedHandle(taskId, new Error("spawn returned no pid"));
  }

  child.on("error", (err) => {
    // ENOENT here means `opencode` was deleted between our init probe and
    // this spawn — treat as a clean exit. Anything else, log via stderr.
    onStderr(`[spawn-error] ${err.message}`);
    onExit(null);
  });

  // ponytail: same liveness target as the bridge runner — see above.
  const activityTarget = { lastActivityAt: Date.now() };
  attachLineBuffer(child.stdout, onStdout, activityTarget);
  attachLineBuffer(child.stderr, onStderr, activityTarget);

  const exited = new Promise<number | null>((resolve) => {
    let resolved = false;
    const resolveOnce = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      try {
        onExit(code);
      } catch {
        /* caller bug — don't propagate */
      }
      resolve(code);
    };
    child.on("exit", (code, signal) => {
      // When killed by signal, code is null and signal is the signal name.
      // Treat both as null exit so the orchestrator's check `code !== 0`
      // catches a crash.
      resolveOnce(signal ? null : code);
    });
  });

  // Auto-cleanup of the per-spawn config fragment.
  if (spawnConfigPath) {
    attachSpawnConfigCleanup(absoluteWorkdir, exited);
  }

  return {
    pid: child.pid,
    isMock: false,
    exited,
    get lastActivityAt() { return activityTarget.lastActivityAt; },
    kill() {
      if (!child.pid) return;
      if (process.platform === "win32") {
        // taskkill /T walks the tree, /F forces. We use /F (not /T alone)
        // because the child must die promptly even if a shell wraps it.
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        // Negate the pid to address the process group created by
        // `detached: true`. Fall back to the child itself if the group
        // leader has already exited (race during shutdown).
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            /* already dead */
          }
        }
        // Give the agent a short grace period, then SIGKILL.
        const killPid = child.pid;
        setTimeout(() => {
          if (killPid === undefined) return;
          try {
            process.kill(-killPid, "SIGKILL");
          } catch {
            try {
              process.kill(killPid, "SIGKILL");
            } catch {
              /* already dead */
            }
          }
        }, 1500);
      }
    },
  };
}

function attachLineBuffer(
  stream: NodeJS.ReadableStream | null,
  onLine: LineCallback,
  activityTarget: { lastActivityAt: number }
): void {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    // ponytail: every chunk of agent output is a liveness signal — the
    // orchestrator's stall watchdog polls `activityTarget.lastActivityAt`
    // to detect a hung-but-alive process. Cheap (one Date.now call) and
    // covers both stdout AND stderr (where token-usage lines land).
    activityTarget.lastActivityAt = Date.now();
    buffer += chunk;
    let nlIdx = buffer.indexOf("\n");
    while (nlIdx >= 0) {
      const line = buffer.slice(0, nlIdx).replace(/\r$/, "");
      buffer = buffer.slice(nlIdx + 1);
      onLine(line);
      nlIdx = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      onLine(buffer);
      buffer = "";
    }
  });
}

/**
 * Wrap a stderr line callback so structured token-usage lines written by
 * the bridge runner are routed into the usage store instead of the UI log.
 * Format: `__LOOP_USAGE__:{json}__END__`. The wrapper is defensive —
 * malformed payloads (no terminator, bad JSON) are forwarded to the
 * original callback so the user can still see them in the log strip.
 *
 * Buffering: a single payload is expected to land on a single line, but
 * if a chunk boundary splits the `__END__` we still parse the start.
 * Worst case we lose one usage record and log a warning.
 *
 * If `onUsage` is supplied, the latest parsed payload is forwarded to it
 * before being recorded. The spawner uses this to capture per-call tokens
 * for the trace record without re-parsing stderr.
 */
function wrapStderrForUsageCapture(
  downstream: LineCallback,
  onUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
  }) => void
): LineCallback {
  return (line: string) => {
    const startIdx = line.indexOf("__LOOP_USAGE__:");
    if (startIdx === -1) {
      downstream(line);
      return;
    }
    const afterPrefix = line.slice(startIdx + "__LOOP_USAGE__:".length);
    const endIdx = afterPrefix.indexOf("__END__");
    if (endIdx === -1) {
      // Partial line — let it through unmodified. The next line is
      // unlikely to also start with this prefix; if it does, we'll
      // silently drop the second one to avoid double-counting.
      downstream(line);
      return;
    }
    const json = afterPrefix.slice(0, endIdx);
    try {
      const payload = JSON.parse(json) as {
        modelId?: string;
        upstreamModel?: string;
        connectionId?: string | null;
        connectionName?: string | null;
        baseUrl?: string | null;
        promptTokens?: number;
        completionTokens?: number;
      };
      const prompt = Number(payload.promptTokens ?? 0);
      const completion = Number(payload.completionTokens ?? 0);
      if (prompt <= 0 && completion <= 0) {
        // No usage to record; still swallow the line so the UI log
        // doesn't show a JSON blob the user can't parse.
        return;
      }
      recordUsage({
        modelId: payload.modelId ?? payload.upstreamModel ?? "unknown",
        upstreamModel: payload.upstreamModel ?? payload.modelId ?? "unknown",
        connectionId: payload.connectionId || null,
        connectionName: payload.connectionName || null,
        baseUrl: payload.baseUrl || null,
        promptTokens: prompt,
        completionTokens: completion,
      });
      onUsage?.({ promptTokens: prompt, completionTokens: completion });
    } catch (err) {
      // Malformed JSON — forward to the UI log so the user can see it
      // (and we keep parity with how a non-structured line is treated).
      downstream(`[usage-parse] failed to parse usage line: ${
        err instanceof Error ? err.message : String(err)
      } — raw: ${line}`);
    }
  };
}

function makeFailedHandle(taskId: string, _err: unknown): AgentHandle {
  return {
    pid: -1,
    isMock: false,
    exited: Promise.resolve(null),
    lastActivityAt: Date.now(),
    kill() {
      AGENT_HANDLES.delete(taskId);
    },
  };
}

/**
 * Write a trace record to disk, swallowing every error. Used by the bridge
 * runner's exit handler so a trace bug can never crash a live run. The
 * `response` field is filled in by reading the agent's output file —
 * the bridge runner is required to have flushed it by exit time (the
 * orchestrator's chokidar watcher depends on the same invariant).
 */
async function writeTraceBestEffort(
  workdir: string,
  record: Omit<TraceRecord, "response">,
  onStderr: LineCallback
): Promise<void> {
  try {
    const response = await readFile(record.outputFile, "utf8").catch(
      () => ""
    );
    await writeTrace(workdir, { ...record, response });
  } catch (err) {
    onStderr(
      `[trace-write] ${record.taskId}/${record.attempt}-${record.role}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Emit a synthetic __LOOP_USAGE__ line from the mock agent. Numbers are
 * derived deterministically from the agent + model id so the user sees
 * distinct "models" producing different token counts in the dev UI.
 */
function emitMockUsageLine(
  onStderr: LineCallback,
  model: string | undefined,
  connection: Connection | null
): void {
  const fallback = "mock-default";
  const upstreamModel = model ?? fallback;
  // Distinct rough per-call shapes so different models accumulate
  // different totals in the panel.
  const profile = modelProfile(upstreamModel);
  const baseByAgent = profile.label === "claude"
    ? { prompt: 1200, completion: 380 }
    : profile.label === "gpt"
    ? { prompt: 1500, completion: 520 }
    : profile.label === "gemini"
    ? { prompt: 1100, completion: 410 }
    : profile.label === "local"
    ? { prompt: 950, completion: 280 }
    : { prompt: 1300, completion: 440 };
  const payload = {
    modelId: connection ? `custom:${connection.id}:${upstreamModel}` : upstreamModel,
    upstreamModel,
    connectionId: connection?.id ?? null,
    connectionName: connection?.name ?? null,
    baseUrl: connection?.baseUrl ?? null,
    promptTokens: baseByAgent.prompt,
    completionTokens: baseByAgent.completion,
  };
  onStderr(`__LOOP_USAGE__:${JSON.stringify(payload)}__END__`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock spawn — fires fake but realistic agent output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synthetic PID for mock agents. Use a high range to avoid collisions with
 * real pids and to make mock runs obvious in logs.
 */
function mockPid(): number {
  return 1_000_000_000 + Math.floor(Math.random() * 1_000_000);
}

function spawnMock(
  agent: AgentName,
  taskId: string,
  workdir: string,
  runPrompt: string,
  onStdout: LineCallback,
  onStderr: LineCallback,
  onExit: ExitCallback,
  options: SpawnAgentOptions | undefined
): AgentHandle {
  const pid = mockPid();
  const absoluteWorkdir = pathResolve(workdir);
  const attempt = parseAttempt(runPrompt) ?? 1;

  // ponytail: mock agents run on a setTimeout chain with `stepDelayMs`
  // gaps. Each onStdout/onStderr call IS a liveness event, so wrap them
  // to update lastActivityAt — the orchestrator's stall watchdog stays
  // satisfied during normal mock flow and only fires on a real hang.
  const activityTarget = { lastActivityAt: Date.now() };
  const origStdout = onStdout;
  const origStderr = onStderr;
  onStdout = (line) => {
    activityTarget.lastActivityAt = Date.now();
    origStdout(line);
  };
  onStderr = (line) => {
    activityTarget.lastActivityAt = Date.now();
    origStderr(line);
  };
  const title = parseTaskTitle(runPrompt) ?? "the task";

  // Resolve the routing override so the mock can show the user exactly
  // which endpoint + model the task would hit if opencode were installed.
  const override = buildSpawnEnvOverride(options?.model);
  const displayModel = override
    ? `${override.upstreamModel} (via "${override.connectionName}", ${override.baseUrl})`
    : (options?.model ?? "default (from opencode.json)");

  // Per-model mock timing. Different models = different "feels" so the picker
  // isn't purely decorative. MiniMax-M3 is the baseline; Sonnet feels
  // snappier; GPT-5/Gemini feel "deliberate"; Ollama is slow (local CPU).
  const profile = modelProfile(options?.model);

  let killed = false;
  let exitCode: number | null = null;
  let resolveExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });

  const deliverExit = (code: number | null) => {
    if (exitCode !== null) return;
    exitCode = code;
    try {
      onExit(code);
    } catch {
      /* caller bug */
    }
    resolveExit(code);
    AGENT_HANDLES.delete(taskId);
  };

  // Announce the mock so the live log makes sense.
  onStdout(`[mock-agent] opencode CLI not found — using fallback for loop-${agent}`);
  onStdout(`[mock-agent] workdir: ${absoluteWorkdir}`);
  onStdout(`[mock-agent] attempt: ${attempt}`);
  onStdout(`[mock-agent] model: ${displayModel}`);
  if (override && options?.connection) {
    onStdout(
      `[mock-agent] provider: ${providerKeyForConnection(
        options.connection
      )} (${options.connection.providerType})`
    );
    onStdout(
      `[mock-agent] using API key: ${options.connection.apiKey ? "***set***" : "NOT SET — opencode would 401"}`
    );
  }

  // Run the mock in microtask + setTimeout chains so the spawn() call returns
  // synchronously (matching the real spawn) and the file write happens on a
  // later tick (matching an actual agent's latency).
  const isKilled = () => killed;
  void (async () => {
    try {
      const plan = await streamPlan(agent, title, profile, onStdout, isKilled);
      if (killed) return deliverExit(null);

      // Write the markdown file the parser expects.
      const writeResult = await writeMockOutput(
        agent,
        absoluteWorkdir,
        attempt,
        title,
        plan
      );
      if (!writeResult.ok) {
        onStderr(`[mock-agent] write failed: ${writeResult.error}`);
        return deliverExit(1);
      }
      onStdout(`[mock-agent] wrote ${writeResult.path}`);

      // Emit a synthetic usage line so the dev-time token counter has
      // something to show. Real LLM calls go through llm-agent.mjs and
      // emit the same `__LOOP_USAGE__:{json}__END__` format.
      emitMockUsageLine(
        onStderr,
        options?.model,
        options?.connection ?? null
      );

      await streamDone(agent, profile, onStdout, isKilled);
      if (killed) return deliverExit(null);

      deliverExit(0);
    } catch (err) {
      onStderr(
        `[mock-agent] crashed: ${err instanceof Error ? err.message : String(err)}`
      );
      deliverExit(1);
    }
  })();

  return {
    pid,
    isMock: true,
    exited,
    get lastActivityAt() { return activityTarget.lastActivityAt; },
    kill() {
      killed = true;
      deliverExit(null);
    },
  };
}

/**
 * Per-model mock profile. `stepDelayMs` is the time between thinking lines;
 * `tag` is what the planner/maker/verifier announce instead of a generic
 * "Reading…". Different rhythms let the user perceive model differences in
 * the live log.
 */
interface ModelProfile {
  stepDelayMs: number;
  label: string;
  tag: string;
}

function modelProfile(model: string | undefined): ModelProfile {
  if (!model) return { stepDelayMs: 150, label: "default", tag: "" };
  const m = model.toLowerCase();
  if (m.includes("claude") || m.includes("sonnet"))
    return { stepDelayMs: 90, label: "claude", tag: "▸ claude-fast" };
  if (m.includes("gpt"))
    return { stepDelayMs: 220, label: "gpt", tag: "▸ gpt-deliberate" };
  if (m.includes("gemini"))
    return { stepDelayMs: 130, label: "gemini", tag: "▸ gemini-balanced" };
  if (m.includes("ollama") || m.includes("local"))
    return { stepDelayMs: 380, label: "local", tag: "▸ local-slow" };
  // Default MiniMax-M3 / others
  return { stepDelayMs: 150, label: "default", tag: "▸ baseline" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock content generation
// ─────────────────────────────────────────────────────────────────────────────

interface MockPlan {
  steps: string[];
  files: string[];
  criteria: string[];
  risks: string[];
  notes: string;
}

async function streamPlan(
  agent: AgentName,
  title: string,
  profile: ModelProfile,
  onStdout: LineCallback,
  isKilled: () => boolean
): Promise<MockPlan> {
  const THINKING: Record<AgentName, string[]> = {
    planner: [
      "Reading task prompt…",
      "Exploring workdir layout…",
      "Reading GOAL.md template…",
      "Identifying files relevant to the request…",
      "Drafting plan…",
    ],
    maker: [
      "Reading GOAL.md and STATE.md…",
      "Identifying changed file allowlist…",
      "Implementing changes…",
      "Running build (npm run build)…",
      "Running tests (npm test)…",
      "Capturing diff summary…",
    ],
    verifier: [
      "Reading GOAL.md, STATE.md, and loop-constraints.md…",
      "Re-running build independently…",
      "Re-running tests independently…",
      "Walking completion criteria…",
      "Checking scope + intent + no-cheating checklist…",
      "Writing verdict…",
    ],
  };

  const lines = THINKING[agent];
  for (const line of lines) {
    if (isKilled()) throw new Error("killed");
    await sleep(profile.stepDelayMs);
    onStdout(profile.tag ? `${profile.tag} ${line}` : line);
  }

  return makeMockPlan(agent, title);
}

async function streamDone(
  agent: AgentName,
  profile: ModelProfile,
  onStdout: LineCallback,
  isKilled: () => boolean
): Promise<void> {
  const DONE: Record<AgentName, string[]> = {
    planner: ["PLAN READY"],
    maker: ["READY FOR VERIFICATION"],
    verifier: ["Verdict written."],
  };
  for (const line of DONE[agent]) {
    if (isKilled()) throw new Error("killed");
    await sleep(Math.round(profile.stepDelayMs * 0.7));
    onStdout(profile.tag ? `${profile.tag} ${line}` : line);
  }
}

function makeMockPlan(agent: AgentName, title: string): MockPlan {
  // The mock is intentionally generic so it can stand in for any task. The
  // shape matches what a real planner would write, which is what the parser
  // expects.
  if (agent === "planner") {
    return {
      steps: [
        "Read existing code under the workdir to ground the change in reality.",
        `Implement: ${title}.`,
        "Run the documented build and tests; ensure both pass.",
      ],
      files: ["src/index.ts", "src/utils/handlers.ts"],
      criteria: [
        "`npm run build` exits 0",
        "`npm test` passes (all tests green)",
        "Diff is minimal — only allowlisted files touched",
      ],
      risks: ["Minimal scope — no architectural change"],
      notes:
        "Build command: `npm run build`\nTest command: `npm test`\nLint command: `npm run lint`",
    };
  }
  if (agent === "maker") {
    return {
      steps: [],
      files: ["src/index.ts", "src/utils/handlers.ts"],
      criteria: [],
      risks: [],
      notes: "Mock fallback — install `opencode` CLI for real implementation.",
    };
  }
  // verifier
  return {
    steps: [],
    files: [],
    criteria: [
      "`npm run build` exits 0",
      "`npm test` passes (all tests green)",
      "Diff is minimal — only allowlisted files touched",
    ],
    risks: [],
    notes: "Mock fallback verification.",
  };
}

interface WriteResult {
  ok: boolean;
  path?: string;
  error?: string;
}

async function writeMockOutput(
  agent: AgentName,
  absoluteWorkdir: string,
  attempt: number,
  title: string,
  plan: MockPlan
): Promise<WriteResult> {
  try {
    if (agent === "planner") {
      const path = pathResolve(absoluteWorkdir, "GOAL.md");
      const content = renderMockGoal(title, plan);
      writeFileSync(path, content, "utf8");
      return { ok: true, path };
    }
    if (agent === "maker") {
      const path = pathResolve(absoluteWorkdir, "STATE.md");
      const content = renderMockDiff(attempt, plan);
      if (!existsSync(path)) {
        writeFileSync(path, scaffoldStateFile(), "utf8");
      }
      appendFileSync(path, "\n" + content, "utf8");
      return { ok: true, path };
    }
    // verifier
    const path = pathResolve(absoluteWorkdir, "STATE.md");
    const content = renderMockVerdict(attempt, plan);
    if (!existsSync(path)) {
      writeFileSync(path, scaffoldStateFile(), "utf8");
    }
    appendFileSync(path, "\n" + content, "utf8");
    return { ok: true, path };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function renderMockGoal(title: string, plan: MockPlan): string {
  const criteriaLines = plan.criteria.map((c) => `- [ ] ${c}`).join("\n");
  const stepsLines = plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const filesLines = plan.files.map((f) => `- ${f}`).join("\n");
  const risksLines = plan.risks.map((r) => `- ${r}`).join("\n");

  return `# Current Goal

> Written by \`loop-planner\`. Read by \`loop-maker\` and \`loop-verifier\`.

## Task

${title}

## Completion Criteria

${criteriaLines}

## Implementation Plan

${stepsLines}

## Files to touch

${filesLines}

## Files NOT to touch (denylist)

- .env, .env.*
- **/secrets/**
- **/credentials/**
- **/*_key*
- **/*_secret*

## Risks

${risksLines}

## Notes for the maker

${plan.notes}
`;
}

function renderMockDiff(attempt: number, plan: MockPlan): string {
  const fileLines = plan.files
    .map((f) => `- ${f} — ${plan.notes || "Mock change."}`)
    .join("\n");
  return `## Diff Summary — Attempt ${attempt}

**Files changed** (${plan.files.length}):
${fileLines}

**Build:** \`npm run build\` → exit 0
**Tests:** \`npm test\` → 5 passed, 0 failed
**Lint:** \`npm run lint\` → exit 0

**Notes for verifier:**
- ${plan.notes || "Mock fallback — minimal scope."}
`;
}

function renderMockVerdict(attempt: number, plan: MockPlan): string {
  const criteriaLines = plan.criteria
    .map((c) => `- [x] ${c} — PASS`)
    .join("\n");
  return `## Verifier Verdict — Attempt ${attempt}

**Verdict:** APPROVE

**Build:** 0 — exit 0, 0 errors
**Tests:** 0 — 5 passed, 0 failed

**Scope:** PASS — only allowlisted files touched
**Intent:** PASS — diff addresses the task
**No cheating:** PASS — no skipped tests, no \`as any\`, no swallowed errors
**Risk:** LOW — minimal scope

**Criteria walk:**
${criteriaLines}

**Required fixes** (if REJECT):
- (none)
`;
}

function scaffoldStateFile(): string {
  return `# Loop State

> Written by \`loop-orchestrator\` after every phase.

Task: <filled by orchestrator>
Started: ${new Date().toISOString()}
Last updated: ${new Date().toISOString()}

## Current Phase: PLAN | IMPLEMENT | VERIFY | DONE | ESCALATED
## Attempt: 0 / 3

## Last Verifier Verdict: (none | APPROVE | REJECT | ESCALATE_HUMAN)

## Last Verifier Feedback

—

## History

- ${isoDate()} PLAN — orchestrator dispatched planner
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isoDate(): string {
  return new Date().toISOString();
}

/** Extract "Attempt N of M" or "Attempt N." from the orchestrator's run prompt. */
function parseAttempt(prompt: string): number | null {
  const m = prompt.match(/Attempt\s+(\d+)\s*(?:of\s+\d+)?/i);
  return m ? Number(m[1]) : null;
}

/**
 * Extract the task title from the run prompt. The orchestrator's planner
 * prompt looks like:
 *
 *   Task: <title>
 *
 *   Read GOAL.md (currently has template), explore...
 */
function parseTaskTitle(prompt: string): string | null {
  const m = prompt.match(/^\s*Task:\s*(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}