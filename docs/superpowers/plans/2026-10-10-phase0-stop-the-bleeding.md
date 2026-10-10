# Phase 0 — Stop the Bleeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing loop trustworthy before the graph-engine work: no network exposure, no keys in `ps`, no silent fake success, no false stall kills, no half-written verdicts, no server freezes from Mavis, and no tasks stranded by a restart.

**Architecture:** Small, independent fixes inside the current backend. No new subsystems. Each task adds one tested seam (a tiny exported helper, or one extra await) and wires it in. Spec: `docs/superpowers/specs/2026-10-10-loop-engine-audit.md` (findings H1–H6).

**Tech Stack:** TypeScript + Hono + Vitest (backend), plain ESM `llm-agent.mjs`, Vite proxy config (UI).

**Baseline (record before starting):** `cd backend && npx vitest run` → **44 files / 296 tests passed**.

**Live-run warning:** the backend dev server is `tsx watch`. Any backend edit restarts it and kills in-flight loops. Don't run a real loop while executing this plan.

---

## File map

| File | Change | Task |
|---|---|---|
| `backend/vitest.config.ts` | Create: point tests at a temp data dir | 1 |
| `backend/src/index.ts` | Bind `LOOP_HOST` (default `127.0.0.1`) | 2 |
| `backend/src/loop/preview-server.ts` | Bind `127.0.0.1` | 2 |
| `ui/vite.config.ts` | Proxy targets → `127.0.0.1` | 2 |
| `backend/src/loop/agent-spawner.ts` | `apiKeyEnv()`; `shouldUseMockAgents()`; heartbeat filtering | 3, 4, 5 |
| `backend/llm-agent.mjs` | Heartbeat while waiting; async `--cli` spawn | 5 |
| `backend/src/loop/orchestrator.ts` | `awaitPhaseOutput` waits for agent exit | 6 |
| `backend/src/loop/mavis-bridge.ts` | Async `runMavis` with timeout; no overlapping polls | 7 |
| `backend/src/store/tasks.ts` | `hasPendingEvent()`; `getActiveTask(isLive)` | 8 |
| `backend/src/api/tasks.ts` | confirm-plan resumes stranded tasks; adjust-plan 409; stranded tasks don't block creation | 8 |
| Tests | One new or extended test file per task | all |

---

### Task 1: Keep backend tests out of the real data folder

`backend/src/store/persistence.ts` reads `LOOP_DATA_DIR` at import time, and otherwise writes to `backend/data/tasks`. API tests create tasks and connections, so today they write into the user's real store.

**Files:** Create `backend/vitest.config.ts`

- [ ] **Step 1: Create the config**

```ts
// Vitest config for the backend. Its one job: point persistence at a
// throwaway directory so API tests (which create connections + tasks)
// never write into the user's real backend/data/ store.
import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  test: {
    env: {
      LOOP_DATA_DIR: join(tmpdir(), `loop-agent-test-data-${process.pid}`, "tasks"),
    },
    // tsc emits compiled copies of the tests into dist/; never run those.
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
```

- [ ] **Step 2: Verify that the tests still pass and that `backend/data` is untouched**

Run:
```bash
cd backend && ls data/tasks | wc -l > /tmp/before.txt && npx vitest run 2>&1 | tail -4 && ls data/tasks | wc -l
```
Expected: all tests pass. The file count printed at the end equals the number in `/tmp/before.txt`.

Excluding `dist/` may drop the test-file count below 44. That's fine: the dist copies were duplicates. Write down the new baseline count.

- [ ] **Step 3: Commit**

```bash
git add backend/vitest.config.ts
git commit -m "test(backend): isolate test persistence in a temp data dir"
```

---

### Task 2: Bind to localhost only

The server listens on `0.0.0.0` with no auth (`backend/src/index.ts:89`), so anyone on the Wi-Fi can create tasks that run shell builds. The preview server (`preview-server.ts:117`) also binds all interfaces. The Vite proxy targets `localhost`, which Node may resolve to `::1`; once the backend binds only `127.0.0.1`, the proxy must target `127.0.0.1` explicitly.

**Files:** Modify `backend/src/index.ts:89-91`, `backend/src/loop/preview-server.ts:117`, `ui/vite.config.ts:29,33,38`

- [ ] **Step 1: Backend listen host**

In `backend/src/index.ts`, replace:
```ts
httpServer.listen(PORT, "0.0.0.0", async () => {
  console.log(`[loop-agent-backend] listening on http://0.0.0.0:${PORT}`);
  console.log(`[loop-agent-backend] ws at ws://0.0.0.0:${PORT}/ws`);
```
with:
```ts
// Loopback only by default: the API has no auth and can start shell
// builds, so it must not be reachable from the LAN. Set LOOP_HOST=0.0.0.0
// explicitly to opt in (e.g. inside a container).
const HOST = process.env.LOOP_HOST || "127.0.0.1";

httpServer.listen(PORT, HOST, async () => {
  console.log(`[loop-agent-backend] listening on http://${HOST}:${PORT}`);
  console.log(`[loop-agent-backend] ws at ws://${HOST}:${PORT}/ws`);
```

- [ ] **Step 2: Preview server host**

In `backend/src/loop/preview-server.ts`, change `server!.listen(PREVIEW_PORT, () => {` to:
```ts
    server!.listen(PREVIEW_PORT, "127.0.0.1", () => {
```

- [ ] **Step 3: Vite proxy targets**

In `ui/vite.config.ts`, replace each `localhost:3001` with `127.0.0.1:3001`. There are three: two `http://` targets and one `ws://` target.

- [ ] **Step 4: Verify**

Run: `cd backend && npx vitest run src/loop/__tests__/preview-server.test.ts 2>&1 | tail -4`
Expected: PASS.

Then start both dev servers (preview_start `loop-agent-backend`, then `loop-agent-ui`), open `http://localhost:5173`, and confirm the task list loads (`GET /api/tasks` returns 200 in the network panel). Also run:
```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
```
Expected: the address column shows `127.0.0.1:3001`, not `*:3001`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.ts backend/src/loop/preview-server.ts ui/vite.config.ts
git commit -m "fix(security): bind backend and preview server to loopback only"
```

---

### Task 3: Pass API keys via env, never argv

`spawnBridgeRunner` passes `--api-key <key>` on the command line (`agent-spawner.ts:208-211`), so any local process can read it with `ps`. `llm-agent.mjs:115` already falls back to `process.env.LOOP_LLM_API_KEY`.

**Files:** Modify `backend/src/loop/agent-spawner.ts`. Create `backend/src/loop/__tests__/api-key-env.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { apiKeyEnv } from "../agent-spawner.js";

describe("apiKeyEnv", () => {
  it("puts a connection key in LOOP_LLM_API_KEY", () => {
    expect(apiKeyEnv("sk-test-123", false)).toEqual({ LOOP_LLM_API_KEY: "sk-test-123" });
  });

  it("adds nothing for an empty key, so the inherited env key still applies", () => {
    expect(apiKeyEnv("", false)).toEqual({});
  });

  it("adds nothing in local-CLI mode", () => {
    expect(apiKeyEnv("sk-test-123", true)).toEqual({});
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd backend && npx vitest run src/loop/__tests__/api-key-env.test.ts`
Expected: FAIL. `apiKeyEnv` is not exported.

- [ ] **Step 3: Implement**

In `backend/src/loop/agent-spawner.ts`, add above `function spawnBridgeRunner(`:
```ts
/**
 * Env additions that carry a connection's API key to llm-agent.mjs. The key
 * travels in the child's env (LOOP_LLM_API_KEY, which llm-agent.mjs already
 * reads as its fallback), never argv, because argv is world-readable via `ps`.
 * An empty key (or local-CLI mode) adds nothing, so an inherited
 * LOOP_LLM_API_KEY keeps working exactly as before.
 */
export function apiKeyEnv(apiKey: string, useLocalCli: boolean): NodeJS.ProcessEnv {
  return !useLocalCli && apiKey ? { LOOP_LLM_API_KEY: apiKey } : {};
}
```

In `spawnBridgeRunner`'s `args` array, delete these three lines:
```ts
    "--api-key",
    useLocalCli ? "" : apiKey,
```

In the `env` object right below, add the spread after `...process.env,`:
```ts
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...apiKeyEnv(apiKey, useLocalCli),
    LOOP_TASK_ID: taskId,
```

- [ ] **Step 4: Run the new test and the bridge tests**

Run: `cd backend && npx vitest run src/loop/__tests__/api-key-env.test.ts src/loop/__tests__/llm-agent-cli.test.ts`
Expected: PASS.

Also run `grep -n '"--api-key"' backend/src/loop/agent-spawner.ts`. Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add backend/src/loop/agent-spawner.ts backend/src/loop/__tests__/api-key-env.test.ts
git commit -m "fix(security): pass connection API keys via env instead of argv"
```

---

### Task 4: No silent mock fallback

`spawnAgent` routes every role to `spawnMock` whenever `opencode` isn't on PATH (`agent-spawner.ts:439`), even though the default bridge path doesn't use opencode. The mock fabricates an APPROVE verdict, so a misconfigured machine reports success. Mocks must be explicit opt-in. When the opencode CLI path is selected and the binary is missing, the run must fail loudly.

**Files:** Modify `backend/src/loop/agent-spawner.ts`. Create `backend/src/loop/__tests__/mock-gate.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { shouldUseMockAgents } from "../agent-spawner.js";

describe("shouldUseMockAgents", () => {
  it("is off by default, even when opencode is missing", () => {
    expect(shouldUseMockAgents({})).toBe(false);
  });

  it("is on only with LOOP_MOCK_AGENTS=1", () => {
    expect(shouldUseMockAgents({ LOOP_MOCK_AGENTS: "1" })).toBe(true);
    expect(shouldUseMockAgents({ LOOP_MOCK_AGENTS: "true" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd backend && npx vitest run src/loop/__tests__/mock-gate.test.ts`
Expected: FAIL. `shouldUseMockAgents` is not exported.

- [ ] **Step 3: Implement**

Add near `OPENCODE_AVAILABLE` in `agent-spawner.ts`:
```ts
/**
 * Mock agents fabricate an APPROVE verdict, so they must never switch on
 * implicitly (they used to whenever `opencode` was missing, even though the
 * default bridge path doesn't need opencode). Explicit opt-in only.
 */
export function shouldUseMockAgents(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOOP_MOCK_AGENTS === "1";
}
```

In `spawnAgent`, change:
```ts
  if (!OPENCODE_AVAILABLE) {
    const handle = spawnMock(
```
to:
```ts
  if (shouldUseMockAgents()) {
    onStderr("[spawner] LOOP_MOCK_AGENTS=1 — using MOCK agents (fake output, not a real run)");
    const handle = spawnMock(
```

Then, in `spawnReal`, immediately after the `if (process.env.LOOP_USE_LLM_BRIDGE !== "0") { ... }` block returns (the "Branch 2" comment), insert:
```ts
  if (!OPENCODE_AVAILABLE) {
    onStderr(
      "[spawner] LOOP_USE_LLM_BRIDGE=0 selects the opencode CLI path, but `opencode` is not on PATH — install it or unset LOOP_USE_LLM_BRIDGE"
    );
    queueMicrotask(() => onExit(1));
    return makeFailedHandle(taskId, new Error("opencode not installed"));
  }
```

`spawnReal`'s parameter names must match `onStderr`, `onExit` and `taskId`. Check the signature at the top of `spawnReal` and adjust the names if they differ.

- [ ] **Step 4: Run the new test and the full suite**

Run: `cd backend && npx vitest run 2>&1 | tail -4`
Expected: all pass. If a test relied on the implicit mock, set `process.env.LOOP_MOCK_AGENTS = "1"` in that test's `beforeEach` and delete it in `afterEach`. Don't weaken any assertion.

- [ ] **Step 5: Commit**

```bash
git add backend/src/loop/agent-spawner.ts backend/src/loop/__tests__/mock-gate.test.ts
git commit -m "fix(backend): mock agents are explicit opt-in, never a silent fallback"
```

---

### Task 5: Heartbeats so the stall watchdog stops killing healthy agents

The planner and maker call non-streaming `generateText`, so nothing is printed for the 150–300 s+ a planner normally takes. The 4-minute stall watchdog (`orchestrator.ts:225`) then kills healthy runs. The `--cli` path uses `spawnSync`, which blocks llm-agent's own event loop, so it can't emit anything while it waits. Fix both:
- llm-agent prints `__LOOP_HEARTBEAT__` to stderr every `LOOP_HEARTBEAT_MS` (default 30 s) while a non-streaming call is in flight.
- The `--cli` call becomes an async `spawn`.
- The spawner counts heartbeat lines as activity but keeps them out of the UI log.

The outer `PHASE_TIMEOUT_MS` / `MAKER_TIMEOUT_MS` still bound a truly hung call.

**Files:**
- Modify `backend/llm-agent.mjs` (the `if (args.cli) {…}` block and the `else { result = await generateText(…) }` block, about lines 266-390)
- Modify `backend/src/loop/agent-spawner.ts` (`attachLineBuffer`, about line 714)
- Create `backend/src/loop/__tests__/fixtures/claude-shim-slow.sh`
- Create `backend/src/loop/__tests__/heartbeat.test.ts`

- [ ] **Step 1: Slow CLI fixture**

Create `backend/src/loop/__tests__/fixtures/claude-shim-slow.sh` and `chmod +x` it:
```sh
#!/bin/sh
# Like claude-shim.sh, but takes ~1s, so heartbeat emission can be observed.
sleep 1
echo "## Implementation Plan
1. Step one
## Completion Criteria
- [ ] works"
```

- [ ] **Step 2: Write the failing tests**

```ts
// Heartbeat contract: llm-agent.mjs emits __LOOP_HEARTBEAT__ on stderr
// while a non-streaming call is in flight, and the spawner treats it as
// liveness only (never shown in the UI log).
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isHeartbeatLine, HEARTBEAT_LINE } from "../agent-spawner.js";

const LLM_AGENT_SCRIPT = resolve(process.cwd(), "llm-agent.mjs");
const SLOW_SHIM = resolve(process.cwd(), "src/loop/__tests__/fixtures/claude-shim-slow.sh");

let workdir: string | null = null;
afterEach(async () => {
  if (workdir) await rm(workdir, { recursive: true, force: true });
  workdir = null;
});

describe("heartbeat", () => {
  it("llm-agent --cli emits heartbeats while the CLI runs, then writes output", async () => {
    workdir = await mkdtemp(join(tmpdir(), "heartbeat-test-"));
    const out = join(workdir, "GOAL.md");
    const child = spawn(
      process.execPath,
      [LLM_AGENT_SCRIPT, "--model", "x", "--base-url", "http://unused", "--workdir", workdir,
        "--role", "planner", "--output", out, "--cli"],
      {
        cwd: workdir,
        env: { ...process.env, LOOP_CLI_BIN: SLOW_SHIM, LOOP_HEARTBEAT_MS: "200", LOOP_USER_PROMPT: "plan it" },
      }
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code: number | null = await new Promise((r) => child.on("exit", r));
    expect(code).toBe(0);
    const beats = stderr.split("\n").filter((l) => l === HEARTBEAT_LINE).length;
    expect(beats).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("isHeartbeatLine matches only the exact sentinel", () => {
    expect(isHeartbeatLine("__LOOP_HEARTBEAT__")).toBe(true);
    expect(isHeartbeatLine("[agent] __LOOP_HEARTBEAT__")).toBe(false);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `cd backend && npx vitest run src/loop/__tests__/heartbeat.test.ts`
Expected: FAIL. `isHeartbeatLine` is not exported, and no heartbeat lines appear.

- [ ] **Step 4: Spawner side**

In `backend/src/loop/agent-spawner.ts`, add above `function attachLineBuffer(`:
```ts
/** Liveness sentinel printed by llm-agent.mjs while a non-streaming LLM/CLI
 *  call is in flight. It bumps lastActivityAt like any output, but it is
 *  noise, so it is never forwarded to the task log. */
export const HEARTBEAT_LINE = "__LOOP_HEARTBEAT__";

export function isHeartbeatLine(line: string): boolean {
  return line === HEARTBEAT_LINE;
}
```

Inside `attachLineBuffer`'s `while (nlIdx >= 0)` loop, change `onLine(line);` to:
```ts
      if (!isHeartbeatLine(line)) onLine(line);
```

- [ ] **Step 5: llm-agent side: heartbeat helper**

In `backend/llm-agent.mjs`, add just above the `if (args.cli) {` line:
```js
  // Liveness heartbeat for non-streaming calls. The orchestrator's stall
  // watchdog kills agents that print nothing for LOOP_STALL_TIMEOUT_MS
  // (default 4 min), but a healthy planner can legitimately think for 5+ min.
  // The spawner swallows this exact line (agent-spawner.ts isHeartbeatLine).
  const HEARTBEAT_MS = Number(process.env.LOOP_HEARTBEAT_MS || 30_000);
  const withHeartbeat = async (promise) => {
    const timer = setInterval(() => process.stderr.write("__LOOP_HEARTBEAT__\n"), HEARTBEAT_MS);
    try {
      return await promise;
    } finally {
      clearInterval(timer);
    }
  };
```

- [ ] **Step 6: llm-agent side: async CLI call**

Replace the `spawnSync` block inside `if (args.cli) {` (from `const { spawnSync } = await import("node:child_process");` through the `if (r.status !== 0) { … }` block) with:
```js
    const { spawn } = await import("node:child_process");
    const full =
      (systemPrompt ? systemPrompt + "\n\n---\n\n" : "") + userPrompt;
    const bin = process.env.LOOP_CLI_BIN || "claude";
    // Async (not spawnSync) so the heartbeat interval can fire while the
    // CLI works. The 25-minute cap matches the old spawnSync timeout.
    const r = await withHeartbeat(
      new Promise((resolveRun) => {
        const child = spawn(bin, ["-p", full, "--output-format", "text"], {
          cwd: args.workdir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const killer = setTimeout(() => child.kill("SIGTERM"), 25 * 60_000);
        child.on("error", (error) => {
          clearTimeout(killer);
          resolveRun({ error, status: null, stdout, stderr });
        });
        child.on("close", (status) => {
          clearTimeout(killer);
          resolveRun({ error: null, status, stdout, stderr });
        });
      })
    );
    if (r.error) {
      process.stderr.write(
        `llm-agent: FAIL: local CLI spawn error: ${r.error.message}\n`
      );
      process.exit(1);
    }
    if (r.status !== 0) {
      process.stderr.write(
        `llm-agent: FAIL: local CLI exit ${r.status}: ${(r.stderr || "").slice(0, 300)}\n`
      );
      process.exit(1);
    }
```
Leave the following lines (`text = (r.stdout || "").trim();` onward) unchanged.

- [ ] **Step 7: llm-agent side: wrap generateText**

In the final `else {` branch, change `result = await generateText({` to `result = await withHeartbeat(generateText({`, and close it with `}));` instead of `});`.

- [ ] **Step 8: Run the tests**

Run: `cd backend && npx vitest run src/loop/__tests__/heartbeat.test.ts src/loop/__tests__/llm-agent-cli.test.ts src/loop/__tests__/stall-watchdog.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/llm-agent.mjs backend/src/loop/agent-spawner.ts backend/src/loop/__tests__/heartbeat.test.ts backend/src/loop/__tests__/fixtures/claude-shim-slow.sh
git commit -m "fix(loop): heartbeat during non-streaming agent calls so the stall watchdog stops killing healthy planners"
```

---

### Task 6: Don't accept a half-written verdict

The verifier streams chunks into STATE.md. `awaitPhaseOutput` (`orchestrator.ts:2073`) returns as soon as the watcher reports a change, and `state-sync` debounces at about 550 ms of quiet. A pause mid-stream therefore ends the phase with a partial verdict. Fix: when the file wins the race, also wait for the agent process to exit, then return the latest content. The stall watchdog and phase timeout still wrap this call, so a hung agent is killed, not waited on forever.

**Files:** Modify `backend/src/loop/orchestrator.ts` (`awaitPhaseOutput`). Create `backend/src/loop/__tests__/await-phase-output.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { awaitPhaseOutput } from "../orchestrator.js";
import type { AgentHandle } from "../agent-spawner.js";
import { loadTasksFromDisk } from "../../store/tasks.js";

// Fake watcher: reports a change with PARTIAL content immediately, while
// the "agent" keeps streaming and only exits 150 ms later with FULL content.
function fakeWatcher(state: { content: string }) {
  let gen = 0;
  return {
    getGeneration: () => gen,
    awaitChange: async () => {
      gen++;
      return "## Verifier Verdict\n**Verdict:** APP"; // partial
    },
    getLatestContent: () => state.content,
  };
}

describe("awaitPhaseOutput", () => {
  it("waits for the agent to exit and returns the final content, not the first chunk", async () => {
    loadTasksFromDisk([
      { id: "t-await", status: "verifying" } as never, // isCancelled only reads status
    ]);
    const state = { content: "## Verifier Verdict\n**Verdict:** APP" };
    const exited = new Promise<number | null>((r) =>
      setTimeout(() => {
        state.content = "## Verifier Verdict\n**Verdict:** APPROVE\n";
        r(0);
      }, 150)
    );
    const agent: AgentHandle = {
      pid: 1, isMock: false, exited, lastActivityAt: Date.now(), kill: () => {},
    };
    const out = await awaitPhaseOutput(
      fakeWatcher(state) as never, "STATE.md", agent, 5_000, "t-await"
    );
    expect(out).toContain("APPROVE");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd backend && npx vitest run src/loop/__tests__/await-phase-output.test.ts`
Expected: FAIL. `awaitPhaseOutput` is not exported. Once it is exported, the test still fails because the output is the partial `APP`.

If `loadTasksFromDisk` needs more Task fields to type-check or run, build the fixture with whatever minimal task helper the other orchestrator tests use (see `rePrompt.test.ts`).

- [ ] **Step 3: Implement**

In `orchestrator.ts`, change `async function awaitPhaseOutput(` to `export async function awaitPhaseOutput(`. Then replace:
```ts
  // File change won the race.
  if (typeof winner === "string") {
    return winner;
  }
```
with:
```ts
  // File change won the race. That only proves the agent STARTED writing:
  // the verifier streams STATE.md chunk by chunk, and the watcher's debounce
  // can fire during a pause mid-stream. Wait for the agent to exit before
  // trusting the content. The stall watchdog wrapping this call (and the
  // phase timeout below) still kill a hung agent.
  if (typeof winner === "string") {
    await Promise.race([exitPromise, sleep(timeoutMs), cancelPromise]);
    if (isCancelled(taskId)) {
      throw new Error("task cancelled");
    }
    const latest = watcher.getLatestContent(filename);
    return latest && latest.length > 0 ? latest : winner;
  }
```

- [ ] **Step 4: Run the test and the orchestrator-adjacent suites**

Run: `cd backend && npx vitest run src/loop/__tests__/await-phase-output.test.ts src/loop/__tests__/state-sync.test.ts src/loop/__tests__/stall-watchdog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/loop/orchestrator.ts backend/src/loop/__tests__/await-phase-output.test.ts
git commit -m "fix(loop): wait for agent exit before parsing phase output (no half-written verdicts)"
```

---

### Task 7: Make the Mavis bridge async

`runMavis` uses `spawnSync` with no timeout (`mavis-bridge.ts:70`) inside the server process. Every `agent list/update/new`, `session new` and 3-second poll freezes HTTP and WebSocket, and a hung `minimax` call hangs the whole server. Convert it to an async `execFile` with a timeout, guard against overlapping polls, and make `finish` idempotent.

**Files:**
- Modify `backend/src/loop/mavis-bridge.ts`
- Modify `backend/src/loop/__tests__/fixtures/mavis-shim.sh`
- Modify `backend/src/loop/__tests__/mavis-bridge.test.ts`

- [ ] **Step 1: Add a slow mode to the shim**

In `mavis-shim.sh`, add right after `mkdir -p "$STATE_DIR"`:
```bash
# MAVIS_SHIM_SLOW_SECONDS=<s>: every call sleeps first, simulating a busy
# daemon. Used to prove the bridge never blocks the backend event loop.
if [ -n "${MAVIS_SHIM_SLOW_SECONDS:-}" ]; then
  sleep "$MAVIS_SHIM_SLOW_SECONDS"
fi
```

- [ ] **Step 2: Write the failing test**

Append inside the `describe("spawnMavisBridge", …)` block in `mavis-bridge.test.ts`. Also add `delete process.env.MAVIS_SHIM_SLOW_SECONDS;` to `afterEach`.
```ts
  it("never blocks the event loop while the CLI is slow", async () => {
    process.env.MAVIS_SHIM_MODE = "success";
    process.env.MAVIS_SHIM_SLOW_SECONDS = "0.4";
    let last = Date.now();
    let worstGap = 0;
    const ticker = setInterval(() => {
      const now = Date.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
    }, 25);
    const handle = spawnMavisBridge(
      "planner", "task-slow", workdir, "Reply with PONG", outFile,
      "You are a test planner.", () => {}, () => {}, () => {}
    );
    await handle.exited;
    clearInterval(ticker);
    // With spawnSync each 0.4s CLI call froze the loop (gap >= 400ms).
    expect(worstGap).toBeLessThan(250);
    expect(readFileSync(outFile, "utf8")).toBe("PONG");
  }, 20_000);
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd backend && npx vitest run src/loop/__tests__/mavis-bridge.test.ts -t "never blocks"`
Expected: FAIL with `worstGap` ≥ 400.

- [ ] **Step 4: Implement async runMavis**

In `mavis-bridge.ts`, replace the import line `import { spawnSync } from "node:child_process";` with:
```ts
import { execFile } from "node:child_process";
```
Add below `sessionRetryDelayMs()`:
```ts
/** Hard cap per CLI call, so a wedged daemon can't hang a phase forever. */
function callTimeoutMs(): number {
  return Number(process.env.LOOP_MAVIS_CALL_TIMEOUT_MS || 120_000);
}
```
Replace `runMavis` with:
```ts
// Async on purpose: this runs inside the backend server process, and a
// spawnSync here froze every HTTP request and WebSocket for the duration
// of each CLI call (and forever on a hung daemon).
function runMavis(args: string[]): Promise<MavisRunResult> {
  return new Promise((resolve) => {
    execFile(
      mavisBin(),
      args,
      { encoding: "utf8", timeout: callTimeoutMs(), maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException).code === "number"
            ? ((error as unknown as { code: number }).code)
            : error
            ? 1
            : 0;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr || (error && !stdout ? error.message : "") || "",
          status: code,
        });
      }
    );
  });
}
```
Replace `ensureAgent` with an async version:
```ts
async function ensureAgent(agentName: string, systemPrompt: string): Promise<void> {
  const list = await runMavis(["agent", "list"]);
  if (list.status === 0 && list.stdout.includes(agentName)) {
    await runMavis(["agent", "update", agentName, "--system-prompt", systemPrompt]);
    return;
  }
  await runMavis([
    "agent",
    "new",
    agentName,
    "--engine",
    "opencode",
    "--system-prompt",
    systemPrompt,
    "--display-name",
    agentName,
  ]);
}
```

- [ ] **Step 5: Make spawnMavisBridge use them safely**

Inside `spawnMavisBridge`:

1. Make `finish` idempotent. Add `let finished = false;` next to `let killed = false;`, and start `finish` with:
```ts
    if (finished) return;
    finished = true;
```

2. Delete the synchronous `ensureAgent(agentName, systemPrompt);` call that follows `onStdout(...starting session...)`.

3. Make `tryCreateSession` async. Change `const tryCreateSession = (attemptsLeft: number) => {` to `const tryCreateSession = async (attemptsLeft: number) => {`, and `const created = runMavis([` to `const created = await runMavis([`. Right after that await, add:
```ts
    if (killed) return;
```
In the retry branch, change `setTimeout(() => tryCreateSession(attemptsLeft - 1), sessionRetryDelayMs());` to:
```ts
        setTimeout(() => void tryCreateSession(attemptsLeft - 1), sessionRetryDelayMs());
```
Change the two lines that start polling to:
```ts
    timer = setInterval(() => void poll(), pollIntervalMs());
    void poll(); // fire once immediately rather than waiting a full interval
```

4. Make `poll` async and non-overlapping. Add `let polling = false;` next to `let lastPartialContent = "";`. Change the head of `poll` to:
```ts
  const poll = async () => {
    if (killed || !sessionId || polling) return;
    polling = true;
    let result: MavisRunResult;
    try {
      result = await runMavis(["session", "messages", sessionId]);
    } finally {
      polling = false;
    }
    if (killed) return;
```
and delete the old `const result = runMavis(["session", "messages", sessionId]);` line. The rest of `poll` stays the same.

5. Replace the deferred start `queueMicrotask(() => tryCreateSession(sessionNewTries()));` with:
```ts
  // Deferred so the caller always holds the handle before any finish()
  // callback can fire. ensureAgent now runs here (async) instead of
  // synchronously inside spawnMavisBridge.
  queueMicrotask(() => {
    void (async () => {
      await ensureAgent(agentName, systemPrompt);
      if (killed) return;
      await tryCreateSession(sessionNewTries());
    })();
  });
```

- [ ] **Step 6: Run all Mavis tests**

Run: `cd backend && npx vitest run src/loop/__tests__/mavis-bridge.test.ts`
Expected: all PASS, including the existing ones: create agent, update agent, retry session new, stall, daemon-down.

- [ ] **Step 7: Commit**

```bash
git add backend/src/loop/mavis-bridge.ts backend/src/loop/__tests__/mavis-bridge.test.ts backend/src/loop/__tests__/fixtures/mavis-shim.sh
git commit -m "fix(mavis): async CLI calls with timeout so the bridge never freezes the server"
```

---

### Task 8: A restart must not strand tasks

On restart, `recoverFromRestart` (`persistence.ts:195`) moves executing tasks to `plan_review`. No orchestrator is waiting on them, which causes three problems:
- `confirm-plan` calls `resolveEvent`, gets `false`, and still returns `{ok:true}`, so nothing happens.
- `adjust-plan` silently does nothing.
- The stranded `plan_review` task counts as "active", so every new task gets a 409 until the user finds Stop.

Fixes:
- confirm-plan restarts the loop from the saved plan when no waiter exists. `runLoop`'s resume-skip path already handles `status === "plan_review"` with a plan.
- adjust-plan returns 409 with an explanation.
- Task creation ignores active-status tasks that have no live loop and no pending waiter.

**Files:**
- Modify `backend/src/store/tasks.ts`
- Modify `backend/src/api/tasks.ts`
- Create `backend/src/api/__tests__/tasks-stranded.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { tasksApi } from "../tasks.js";
import { loadTasksFromDisk, getTask } from "../../store/tasks.js";
import { loadConnectionsFromDisk } from "../../store/connections.js";

// A task left in plan_review by recoverFromRestart: it has a saved plan,
// but no orchestrator is parked in waitForEvent for it.
function strandedTask() {
  const now = new Date().toISOString();
  return {
    id: "stranded1",
    title: "Stranded",
    prompt: "Fix sum.js",
    status: "plan_review",
    workdir: "/tmp/loop-stranded-test",
    attempt: 0,
    maxAttempts: 3,
    logs: [],
    history: [],
    plan: { steps: 1, filesToTouch: ["sum.js"], criteria: [], rawGoal: "# Goal" },
    createdAt: now,
    updatedAt: now,
  } as never;
}

describe("tasks stranded by a restart", () => {
  beforeEach(() => {
    process.env.LOOP_MAVIS_BIN = "/usr/bin/false";
    loadConnectionsFromDisk([
      {
        id: "mavistest1", name: "my-mavis", providerType: "mavis-cli",
        baseUrl: "http://localhost/mavis-cli", model: "mavis", hasApiKey: false,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    loadTasksFromDisk([strandedTask()]);
  });
  afterEach(() => {
    delete process.env.LOOP_MAVIS_BIN;
  });

  const app = () => new Hono().route("/", tasksApi);

  it("does not block creating a new task", async () => {
    const res = await app().request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Another task",
        modelOverrides: {
          planning: "custom:mavistest1:mavis",
          implementation: "custom:mavistest1:mavis",
          review: "custom:mavistest1:mavis",
        },
      }),
    });
    expect(res.status).toBe(201);
  });

  it("confirm-plan resumes the loop instead of silently doing nothing", async () => {
    const res = await app().request("/tasks/stranded1/confirm-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, resumed: true });
  });

  it("adjust-plan explains that the loop is not running", async () => {
    const res = await app().request("/tasks/stranded1/adjust-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adjustments: "use a loop" }),
    });
    expect(res.status).toBe(409);
    expect(getTask("stranded1")?.status).toBe("plan_review");
  });
});
```

The task fixture must satisfy whatever fields `runLoop`'s `validateRefs` reads. If the confirm-plan test fails inside `runLoop` (rather than on the HTTP response), add `modelOverrides` pointing at `custom:mavistest1:mavis` to the fixture, matching what POST /tasks stores.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd backend && npx vitest run src/api/__tests__/tasks-stranded.test.ts`
Expected: three FAILs. They are 409, `resumed` missing, and 200 respectively.

- [ ] **Step 3: Store helpers**

In `backend/src/store/tasks.ts`, replace `getActiveTask` with:
```ts
/**
 * First task in an active status. `isLive` filters out tasks that look
 * active on disk but have no orchestrator behind them (e.g. left in
 * plan_review by a restart), which must not block new tasks.
 */
export function getActiveTask(isLive: (task: Task) => boolean = () => true): Task | undefined {
  for (const task of store.tasks.values()) {
    if (isActiveStatus(task.status) && isLive(task)) return task;
  }
  return undefined;
}
```
Add below `resolveEvent`:
```ts
/** True when an orchestrator is parked in waitForEvent for this task. */
export function hasPendingEvent(taskId: string): boolean {
  const map = store.pendingResolvers.get(taskId);
  return Boolean(map && map.size > 0);
}
```

- [ ] **Step 4: API changes**

In `backend/src/api/tasks.ts`, add `hasPendingEvent` to the import from `../store/tasks.js`, and add this helper below the imports:
```ts
/** A task is live when its orchestrator is running or parked on a user event. */
const isLiveTask = (t: { id: string }) => isLoopRunning(t.id) || hasPendingEvent(t.id);
```
In `POST /tasks`, change `const active = getActiveTask();` to:
```ts
  const active = getActiveTask(isLiveTask);
```
In `POST /tasks/:id/confirm-plan`, replace:
```ts
  resolveEvent(id, "confirm-plan", { adjustments: body.adjustments ?? "" });
  return c.json({ ok: true });
```
with:
```ts
  if (resolveEvent(id, "confirm-plan", { adjustments: body.adjustments ?? "" })) {
    return c.json({ ok: true });
  }
  // No orchestrator is waiting (the server restarted while this task was
  // mid-run). Restart the loop: runLoop's resume-skip path picks up the
  // saved plan when status is plan_review.
  if (!task.plan) {
    return c.json({ error: "no saved plan to resume — reset the task instead" }, 409);
  }
  if (!isLoopRunning(id)) {
    void runLoop(id).catch((err) => {
      console.error(`[tasks] resume after restart failed for ${id}:`, err);
    });
  }
  return c.json({ ok: true, resumed: true });
```
In `POST /tasks/:id/adjust-plan`, find its `resolveEvent(id, "adjust-plan", …)` call. Replace that statement and the `return c.json({ ok: true })` after it with:
```ts
  if (!resolveEvent(id, "adjust-plan", { adjustments })) {
    return c.json(
      { error: "the loop for this task is not running (server restarted) — approve the plan to resume, or reset the task" },
      409
    );
  }
  return c.json({ ok: true });
```
Keep the exact payload object the existing call passes. Only wrap it in the `if`.

- [ ] **Step 5: Run the new tests and all API tests**

Run: `cd backend && npx vitest run src/api/__tests__`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/store/tasks.ts backend/src/api/tasks.ts backend/src/api/__tests__/tasks-stranded.test.ts
git commit -m "fix(loop): tasks stranded by a restart resume on approve and no longer block new tasks"
```

---

### Task 9: Full regression and a live smoke check

**Files:** none

- [ ] **Step 1: Full backend suite and typecheck**

Run:
```bash
cd backend && npx vitest run 2>&1 | tail -4 && npx tsc --noEmit && echo TSC_OK
```
Expected: every test passes. The count is the Task 1 baseline plus the new tests. `TSC_OK` is printed.

- [ ] **Step 2: UI suite and build**

Run: `cd ui && npx vitest run 2>&1 | tail -4 && npm run build 2>&1 | tail -3`
Expected: 31 tests pass, and the build exits 0.

- [ ] **Step 3: Live smoke check (no paid run)**

Start `loop-agent-backend` and `loop-agent-ui` with preview_start, then:
1. `lsof -nP -iTCP:3001 -sTCP:LISTEN` shows `127.0.0.1:3001`.
2. The UI at `http://localhost:5173` loads the task list, and the WebSocket connects (no console errors).
3. Restart the backend (touch `backend/src/index.ts`). Any task that was `plan_review` stays visible. Creating a new task is not blocked by it, and clicking Approve on it resumes the loop (status leaves `plan_review`).

- [ ] **Step 4: Update the audit doc**

In `docs/superpowers/specs/2026-10-10-loop-engine-audit.md`, append ` — **fixed in Phase 0**` to the H1, H2, H3, H4, H5 and H6 bullets. For H6, note that the unsandboxed `package.json` build is still open and moves to Phase 2.

```bash
git add docs/superpowers/specs/2026-10-10-loop-engine-audit.md
git commit -m "docs: mark Phase 0 findings fixed in the engine audit"
```

---

## Self-review notes

- **Spec coverage:** H1 → Task 8. H2 → Task 5. H3 → Task 6. H4 → Task 7. H5 → Task 4. H6 → Tasks 2 and 3; the build sandbox is deferred to Phase 2, as stated in Task 9.
- **Known limits, deferred on purpose:**
  - Heartbeats make the stall watchdog blind to a hung *HTTP* request, which is now bounded by the 20/25-minute phase timeouts instead. Phase 2's streaming agent runtime restores fine-grained liveness.
  - Adjustments typed on a stranded task's Approve are ignored on resume; the plan as saved is used.
