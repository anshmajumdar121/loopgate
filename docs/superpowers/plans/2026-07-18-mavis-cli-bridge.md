# Mavis CLI Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Loop Agent's planner/maker/verifier roles run through the user's local MiniMax Code / Mavis daemon (the `minimax` CLI) so the loop can use their MiniMax Pro subscription instead of a pay-per-token API key.

**Architecture:** A new `mavis-cli` provider type joins the existing `local-cli` type. A new module, `backend/src/loop/mavis-bridge.ts`, implements the `AgentHandle` contract by shelling out to `minimax agent`/`minimax session` commands and polling for a completed assistant reply, then writing it to the same `outFile` the rest of the pipeline already expects. No orchestrator, parser, or UI-canvas changes — the stall watchdog (`lastActivityAt`) and downstream parsing are reused unmodified.

**Tech Stack:** TypeScript (backend, Node `child_process.spawnSync`), Vitest, Bash (test fixture shim).

**Design spec:** `docs/superpowers/specs/2026-07-18-mavis-cli-bridge-design.md`

---

### Task 1: Add `"mavis-cli"` to the provider-type unions

**Files:**
- Modify: `backend/src/types.ts:436-439`
- Modify: `ui/src/types/loop.ts:313-316`
- Test: `backend/src/api/__tests__/connections.test.ts` (create if it doesn't exist)

- [ ] **Step 1: Check whether a connections API test file already exists**

Run: `ls backend/src/api/__tests__/connections.test.ts 2>&1`

If it exists, read it first and add the new test case into it following its existing style instead of creating a new file. If it does not exist (expected `ls: ... No such file or directory`), proceed with Step 2 as written.

- [ ] **Step 2: Write the failing test**

Create `backend/src/api/__tests__/connections.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { connectionsApi } from "../connections.js";
import { loadConnectionsFromDisk } from "../../store/connections.js";

describe("connections API — mavis-cli provider type", () => {
  beforeEach(() => {
    loadConnectionsFromDisk([]);
  });

  it("accepts providerType: mavis-cli on create", async () => {
    const app = new Hono().route("/", connectionsApi);
    const res = await app.request("/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "my-mavis",
        providerType: "mavis-cli",
        baseUrl: "http://localhost/mavis-cli",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { connection: { providerType: string } };
    expect(body.connection.providerType).toBe("mavis-cli");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx vitest run src/api/__tests__/connections.test.ts`
Expected: FAIL — Zod validation rejects `providerType: "mavis-cli"` (not in the enum yet), response status is 400, not 201.

- [ ] **Step 4: Extend the backend type union**

In `backend/src/types.ts`, find:

```ts
export type ConnectionProviderType =
  | "openai-compatible"
  | "anthropic-compatible"
  | "local-cli";
```

Replace with:

```ts
export type ConnectionProviderType =
  | "openai-compatible"
  | "anthropic-compatible"
  | "local-cli"
  | "mavis-cli";
```

- [ ] **Step 5: Extend the Zod schema**

In `backend/src/api/connections.ts:36-60`, find:

```ts
  providerId: z
    .enum(["openrouter", "openai", "anthropic", "google", "ollama", "local-cli", "custom"])
    .optional(),
  providerType: z.enum(["openai-compatible", "anthropic-compatible", "local-cli"]),
```

Replace with:

```ts
  providerId: z
    .enum(["openrouter", "openai", "anthropic", "google", "ollama", "local-cli", "mavis-cli", "custom"])
    .optional(),
  providerType: z.enum(["openai-compatible", "anthropic-compatible", "local-cli", "mavis-cli"]),
```

- [ ] **Step 6: Extend the store's `PROVIDER_TYPES` export**

In `backend/src/store/connections.ts:278-282`, find:

```ts
export const PROVIDER_TYPES: readonly ConnectionProviderType[] = [
  "openai-compatible",
  "anthropic-compatible",
  "local-cli",
] as const;
```

Replace with:

```ts
export const PROVIDER_TYPES: readonly ConnectionProviderType[] = [
  "openai-compatible",
  "anthropic-compatible",
  "local-cli",
  "mavis-cli",
] as const;
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd backend && npx vitest run src/api/__tests__/connections.test.ts`
Expected: PASS

- [ ] **Step 8: Mirror the type union in the UI**

In `ui/src/types/loop.ts:313-316`, find:

```ts
export type ConnectionProviderType =
  | "openai-compatible"
  | "anthropic-compatible"
  | "local-cli";
```

Replace with:

```ts
export type ConnectionProviderType =
  | "openai-compatible"
  | "anthropic-compatible"
  | "local-cli"
  | "mavis-cli";
```

- [ ] **Step 9: Verify the UI typechecks**

Run: `cd ui && npx tsc --noEmit`
Expected: no new errors (this change only widens a union, so nothing should break).

- [ ] **Step 10: Commit**

```bash
git add backend/src/types.ts backend/src/api/connections.ts backend/src/store/connections.ts ui/src/types/loop.ts backend/src/api/__tests__/connections.test.ts
git commit -m "feat(backend): add mavis-cli provider type"
```

---

### Task 2: Add the "MiniMax Pro (Mavis CLI)" preset to the UI's Add Connection form

**Files:**
- Modify: `ui/src/lib/providerPresets.ts:127-139`

- [ ] **Step 1: Add the preset entry**

In `ui/src/lib/providerPresets.ts`, find the existing `local-cli` preset entry (around line 127):

```ts
  {
    id: "local-cli",
    name: "Local CLI (no API key)",
    description:
      "Runs the loop through your machine's `claude` CLI — no API key, no network endpoint. Uses your existing Claude Code subscription.",
    providerType: "local-cli",
    defaultBaseUrl: "http://localhost/local-cli",
    endpointHint: "(not used in CLI mode)",
    apiKeyHint: "(not needed)",
    noKey: true,
    temperatureDefault: 0.7,
    models: [],
  },
```

Add a new entry directly after it:

```ts
  {
    id: "mavis-cli",
    name: "MiniMax Pro (Mavis CLI)",
    description:
      "Runs the loop through your machine's MiniMax Code / Mavis daemon — no API key. Uses your existing MiniMax Pro subscription instead of pay-per-token billing.",
    providerType: "mavis-cli",
    defaultBaseUrl: "http://localhost/mavis-cli",
    endpointHint: "(not used — routes through the local Mavis daemon)",
    apiKeyHint: "(not needed)",
    noKey: true,
    temperatureDefault: 0.7,
    models: [],
  },
```

- [ ] **Step 2: Verify the preset list renders**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

Run: `cd ui && npx vitest run` (full suite — this file has no dedicated test today; confirms nothing else broke)
Expected: same pass/fail count as before this change (no new failures).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/providerPresets.ts
git commit -m "feat(ui): add MiniMax Pro (Mavis CLI) connection preset"
```

---

### Task 3: Export `LineCallback`/`ExitCallback` types from agent-spawner.ts

**Files:**
- Modify: `backend/src/loop/agent-spawner.ts:101-102`

The Mavis bridge module needs these two callback types. They currently exist but aren't exported.

- [ ] **Step 1: Export the types**

In `backend/src/loop/agent-spawner.ts`, find:

```ts
type LineCallback = (line: string) => void;
type ExitCallback = (code: number | null) => void;
```

Replace with:

```ts
export type LineCallback = (line: string) => void;
export type ExitCallback = (code: number | null) => void;
```

- [ ] **Step 2: Verify the backend still typechecks**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors (adding `export` to an existing type never breaks callers).

- [ ] **Step 3: Commit**

```bash
git add backend/src/loop/agent-spawner.ts
git commit -m "refactor(backend): export LineCallback/ExitCallback types for the Mavis bridge"
```

---

### Task 4: Build the Mavis bridge test fixture (fake `minimax` CLI)

**Files:**
- Create: `backend/src/loop/__tests__/fixtures/mavis-shim.sh`

This is a controllable fake of the real `minimax` CLI, used so tests never touch the user's real Mavis daemon or spend their subscription quota. Controlled via two env vars: `MAVIS_SHIM_MODE` (`success` | `stall` | `daemon-down`) and `MAVIS_SHIM_STATE_DIR` (a scratch directory for per-session poll counters).

- [ ] **Step 1: Create the fixture directory if needed**

Run: `mkdir -p backend/src/loop/__tests__/fixtures`

- [ ] **Step 2: Write the shim script**

Create `backend/src/loop/__tests__/fixtures/mavis-shim.sh`:

```bash
#!/usr/bin/env bash
# Fake `minimax` CLI for mavis-bridge.test.ts. Never touches the real Mavis
# daemon — tests must never spend the user's real subscription quota.
#
# Controlled via:
#   MAVIS_SHIM_MODE      = success (default) | stall | daemon-down
#   MAVIS_SHIM_STATE_DIR = scratch dir for per-session poll counters (required)
set -euo pipefail

MODE="${MAVIS_SHIM_MODE:-success}"
STATE_DIR="${MAVIS_SHIM_STATE_DIR:?MAVIS_SHIM_STATE_DIR must be set}"
mkdir -p "$STATE_DIR"

if [ "$MODE" = "daemon-down" ]; then
  echo "Error: could not connect to Mavis daemon" >&2
  exit 1
fi

cmd="${1:-}"
sub="${2:-}"

case "$cmd" in
  agent)
    if [ "$sub" = "list" ]; then
      echo "no agents"
      exit 0
    elif [ "$sub" = "new" ]; then
      echo "Agent '${3:-}' created."
      exit 0
    fi
    ;;
  session)
    if [ "$sub" = "new" ]; then
      session_id="mvs_test_session"
      echo "0" > "$STATE_DIR/$session_id.polls"
      echo "{\"sessionId\":\"$session_id\",\"agentName\":\"test\"}"
      exit 0
    elif [ "$sub" = "messages" ]; then
      session_id="${3:-}"
      counter_file="$STATE_DIR/$session_id.polls"
      polls=$(cat "$counter_file" 2>/dev/null || echo 0)
      polls=$((polls + 1))
      echo "$polls" > "$counter_file"

      if [ "$MODE" = "stall" ]; then
        echo "{\"messages\":[{\"role\":\"user\",\"msg_content\":\"hi\"}]}"
        exit 0
      fi

      # success mode: only answer from the 2nd poll onward, so the test
      # actually proves the poll loop loops (not just a lucky first read).
      if [ "$polls" -lt 2 ]; then
        echo "{\"messages\":[{\"role\":\"user\",\"msg_content\":\"hi\"}]}"
      else
        echo "{\"messages\":[{\"role\":\"user\",\"msg_content\":\"hi\"},{\"role\":\"assistant\",\"msg_content\":\"PONG\",\"finish_reason\":\"stop\",\"usage\":{\"total_tokens\":42}}]}"
      fi
      exit 0
    fi
    ;;
esac

echo "unknown command: $*" >&2
exit 1
```

- [ ] **Step 3: Make it executable**

Run: `chmod +x backend/src/loop/__tests__/fixtures/mavis-shim.sh`

- [ ] **Step 4: Sanity-check the shim manually**

Run:
```bash
export MAVIS_SHIM_STATE_DIR=/tmp/mavis-shim-manual-check
rm -rf "$MAVIS_SHIM_STATE_DIR"
backend/src/loop/__tests__/fixtures/mavis-shim.sh agent list
backend/src/loop/__tests__/fixtures/mavis-shim.sh session new test-agent --from root --prompt hi --model x
backend/src/loop/__tests__/fixtures/mavis-shim.sh session messages mvs_test_session
backend/src/loop/__tests__/fixtures/mavis-shim.sh session messages mvs_test_session
```
Expected: `no agents`, then a JSON line with `sessionId`, then a JSON line with only the `user` message, then a JSON line with both `user` and `assistant` (content `"PONG"`).

- [ ] **Step 5: Commit**

```bash
git add backend/src/loop/__tests__/fixtures/mavis-shim.sh
git commit -m "test(backend): add fake minimax CLI fixture for mavis-bridge tests"
```

---

### Task 5: Write `mavis-bridge.ts` (TDD against the shim)

**Files:**
- Create: `backend/src/loop/mavis-bridge.ts`
- Test: `backend/src/loop/__tests__/mavis-bridge.test.ts`

- [ ] **Step 1: Write the failing test — success path**

Create `backend/src/loop/__tests__/mavis-bridge.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMavisBridge } from "../mavis-bridge.js";

const SHIM = join(__dirname, "fixtures", "mavis-shim.sh");

describe("spawnMavisBridge", () => {
  let workdir: string;
  let stateDir: string;
  let outFile: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "mavis-bridge-test-"));
    stateDir = mkdtempSync(join(tmpdir(), "mavis-shim-state-"));
    outFile = join(workdir, "GOAL.md");
    process.env.LOOP_MAVIS_BIN = SHIM;
    process.env.MAVIS_SHIM_STATE_DIR = stateDir;
    process.env.LOOP_MAVIS_POLL_INTERVAL_MS = "20";
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.LOOP_MAVIS_BIN;
    delete process.env.MAVIS_SHIM_STATE_DIR;
    delete process.env.LOOP_MAVIS_POLL_INTERVAL_MS;
    delete process.env.MAVIS_SHIM_MODE;
  });

  it("polls until the assistant replies, writes outFile, emits usage", async () => {
    process.env.MAVIS_SHIM_MODE = "success";
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let exitCode: number | null | undefined;

    const handle = spawnMavisBridge(
      "planner",
      "task-1",
      workdir,
      "Reply with PONG",
      outFile,
      "You are a test planner.",
      (l) => stdoutLines.push(l),
      (l) => stderrLines.push(l),
      (c) => {
        exitCode = c;
      }
    );

    await handle.exited;

    expect(exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    expect(readFileSync(outFile, "utf8")).toBe("PONG");
    expect(stderrLines.some((l) => l.includes("__LOOP_USAGE__"))).toBe(true);
    const usageLine = stderrLines.find((l) => l.includes("__LOOP_USAGE__"))!;
    const json = usageLine.slice(
      usageLine.indexOf("__LOOP_USAGE__:") + "__LOOP_USAGE__:".length,
      usageLine.indexOf("__END__")
    );
    const usage = JSON.parse(json) as { completionTokens: number; promptTokens: number };
    expect(usage.completionTokens).toBe(42);
    expect(usage.promptTokens).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/loop/__tests__/mavis-bridge.test.ts`
Expected: FAIL — `Cannot find module '../mavis-bridge.js'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `backend/src/loop/mavis-bridge.ts`:

```ts
// Bridge that runs an agent role through the user's local MiniMax Code /
// Mavis daemon (the `minimax` CLI) instead of an HTTP API connection. Lets
// the loop run against a MiniMax Pro subscription instead of a pay-per-token
// API key. See docs/superpowers/specs/2026-07-18-mavis-cli-bridge-design.md.
//
// Contract: same as the rest of agent-spawner.ts — write the LLM's final
// reply to `outFile`, emit a `__LOOP_USAGE__:{json}__END__` line on stderr,
// and only update `lastActivityAt` when the Mavis session genuinely
// produces new output. That last part matters: the orchestrator's stall
// watchdog polls `lastActivityAt` generically (see `raceStall` in
// orchestrator.ts) — because this module only bumps it on real progress,
// the existing stall/retry/escalate logic works unmodified. No bespoke
// stall handling lives here.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { AgentHandle, AgentName, LineCallback, ExitCallback } from "./agent-spawner.js";

const MAVIS_BIN =
  process.env.LOOP_MAVIS_BIN ?? `${process.env.HOME}/.mavis/bin/minimax`;

const POLL_INTERVAL_MS = Number(process.env.LOOP_MAVIS_POLL_INTERVAL_MS || 3000);

interface MavisMessage {
  role?: string;
  msg_content?: string;
  finish_reason?: string;
  usage?: { total_tokens?: number };
}

interface MavisRunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runMavis(args: string[]): MavisRunResult {
  const result = spawnSync(MAVIS_BIN, args, { encoding: "utf8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

/**
 * Ensure the role's persistent Mavis agent exists. Idempotent by
 * construction: we don't check `agent new`'s exit code, so a concurrent
 * "already exists" race from another role's startup is a no-op, not a
 * failure (see design spec §4, "Agent creation race").
 */
function ensureAgent(agentName: string, systemPrompt: string): void {
  const list = runMavis(["agent", "list"]);
  if (list.status === 0 && list.stdout.includes(agentName)) return;
  runMavis([
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

function makeImmediateFailureHandle(
  exited: Promise<number | null>,
  activityTarget: { lastActivityAt: number },
  finish: (code: number | null) => void
): AgentHandle {
  queueMicrotask(() => finish(1));
  return {
    pid: -1,
    isMock: false,
    exited,
    get lastActivityAt() {
      return activityTarget.lastActivityAt;
    },
    kill() {
      /* already finishing */
    },
  };
}

export function spawnMavisBridge(
  agent: AgentName,
  _taskId: string,
  _workdir: string,
  runPrompt: string,
  outFile: string,
  systemPrompt: string,
  onStdout: LineCallback,
  onStderr: LineCallback,
  onExit: ExitCallback
): AgentHandle {
  const agentName = `loop-${agent}`;
  const activityTarget = { lastActivityAt: Date.now() };
  let killed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSeenMessageCount = 0;
  let lastPartialContent = "";

  let resolveExited: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    resolveExited = resolve;
  });

  const finish = (code: number | null) => {
    if (timer) clearInterval(timer);
    timer = null;
    try {
      onExit(code);
    } catch {
      /* caller bug — don't propagate */
    }
    resolveExited(code);
  };

  onStdout(`[mavis-bridge] starting session for ${agentName}`);
  ensureAgent(agentName, systemPrompt);

  const created = runMavis([
    "session",
    "new",
    agentName,
    "--from",
    "root",
    "--prompt",
    runPrompt,
    "--model",
    "minimax/MiniMax-M2.7",
  ]);
  if (created.status !== 0) {
    onStderr(
      `[mavis-bridge] session new failed (exit ${created.status}): ${created.stderr.trim()}`
    );
    return makeImmediateFailureHandle(exited, activityTarget, finish);
  }

  let sessionId: string;
  try {
    const parsed = JSON.parse(created.stdout) as { sessionId?: string };
    if (!parsed.sessionId) throw new Error("no sessionId in response");
    sessionId = parsed.sessionId;
  } catch (err) {
    onStderr(
      `[mavis-bridge] could not parse session id: ${
        err instanceof Error ? err.message : String(err)
      } — raw: ${created.stdout}`
    );
    return makeImmediateFailureHandle(exited, activityTarget, finish);
  }

  onStdout(`[mavis-bridge] session ${sessionId} started`);

  const poll = () => {
    if (killed) return;
    const result = runMavis(["session", "messages", sessionId]);
    if (result.status !== 0) {
      onStderr(`[mavis-bridge] poll failed (exit ${result.status}): ${result.stderr.trim()}`);
      return; // transient — try again next tick; the orchestrator's stall
              // watchdog decides if this has gone on too long.
    }
    let messages: MavisMessage[];
    try {
      messages = (JSON.parse(result.stdout) as { messages?: MavisMessage[] }).messages ?? [];
    } catch {
      return; // malformed JSON on this poll — try again next tick.
    }

    if (messages.length > lastSeenMessageCount) {
      lastSeenMessageCount = messages.length;
      activityTarget.lastActivityAt = Date.now();
    }

    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    const last = assistantMsgs[assistantMsgs.length - 1];
    if (last?.msg_content) lastPartialContent = last.msg_content;
    if (!last || !last.finish_reason) return; // still working — poll again

    if (timer) clearInterval(timer);
    timer = null;
    try {
      writeFileSync(outFile, last.msg_content ?? "", "utf8");
      onStdout(`[mavis-bridge] wrote ${(last.msg_content ?? "").length} chars to ${outFile}`);
    } catch (err) {
      onStderr(
        `[mavis-bridge] failed to write ${outFile}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      finish(1);
      return;
    }
    const totalTokens = last.usage?.total_tokens ?? 0;
    if (totalTokens > 0) {
      // Mavis reports only a combined total, not a prompt/completion split.
      // Recording the whole amount as completionTokens keeps the total
      // accurate in the token-usage panel; splitting it would be a guess
      // either way.
      onStderr(
        `__LOOP_USAGE__:${JSON.stringify({
          modelId: "mavis-cli",
          upstreamModel: "minimax/MiniMax-M2.7",
          connectionId: null,
          connectionName: agentName,
          baseUrl: null,
          promptTokens: 0,
          completionTokens: totalTokens,
        })}__END__`
      );
    }
    finish(0);
  };

  timer = setInterval(poll, POLL_INTERVAL_MS);
  poll(); // fire once immediately rather than waiting a full interval

  return {
    pid: -1,
    isMock: false,
    exited,
    get lastActivityAt() {
      return activityTarget.lastActivityAt;
    },
    getAccumulatedOutput() {
      return lastPartialContent;
    },
    kill() {
      killed = true;
      if (timer) clearInterval(timer);
      timer = null;
      finish(null);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/loop/__tests__/mavis-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test — stall path**

Add to `backend/src/loop/__tests__/mavis-bridge.test.ts`, inside the same `describe` block:

```ts
  it("does not advance lastActivityAt once only the user message exists, and kill() stops polling", async () => {
    process.env.MAVIS_SHIM_MODE = "stall";
    let exitCode: number | null | undefined = "not-called" as unknown as number;

    const handle = spawnMavisBridge(
      "planner",
      "task-2",
      workdir,
      "Reply with PONG",
      outFile,
      "You are a test planner.",
      () => {},
      () => {},
      (c) => {
        exitCode = c;
      }
    );

    const firstActivity = handle.lastActivityAt;
    await new Promise((r) => setTimeout(r, 100)); // several poll cycles at 20ms
    const laterActivity = handle.lastActivityAt;
    expect(laterActivity).toBe(firstActivity); // user-only message count never grows

    handle.kill();
    await handle.exited;
    expect(exitCode).toBeNull();
    expect(existsSync(outFile)).toBe(false);
  });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && npx vitest run src/loop/__tests__/mavis-bridge.test.ts`
Expected: PASS immediately — the implementation from Step 3 already satisfies this (only bumping `lastActivityAt` when `messages.length` grows, and `kill()` already stops the timer and resolves `exited` with `null`). This step exists to lock the stall-safety behavior in with a regression test, not to drive new implementation.

- [ ] **Step 7: Write the failing test — daemon not running**

Add to the same `describe` block:

```ts
  it("fails fast when the Mavis daemon is not running", async () => {
    process.env.MAVIS_SHIM_MODE = "daemon-down";
    let exitCode: number | null | undefined = "not-called" as unknown as number;
    const stderrLines: string[] = [];

    const handle = spawnMavisBridge(
      "planner",
      "task-3",
      workdir,
      "Reply with PONG",
      outFile,
      "You are a test planner.",
      () => {},
      (l) => stderrLines.push(l),
      (c) => {
        exitCode = c;
      }
    );

    await handle.exited;
    expect(exitCode).toBe(1);
    expect(stderrLines.some((l) => l.includes("session new failed"))).toBe(true);
  });
```

- [ ] **Step 8: Run the full test file**

Run: `cd backend && npx vitest run src/loop/__tests__/mavis-bridge.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 9: Commit**

```bash
git add backend/src/loop/mavis-bridge.ts backend/src/loop/__tests__/mavis-bridge.test.ts
git commit -m "feat(backend): mavis-bridge module — run agent roles through the Mavis CLI"
```

---

### Task 6: Wire the Mavis bridge into `agent-spawner.ts`

**Files:**
- Modify: `backend/src/loop/agent-spawner.ts:139-236` (inside `spawnBridgeRunner`)

- [ ] **Step 1: Add the `useMavisCli` branch**

In `backend/src/loop/agent-spawner.ts`, find the existing `useLocalCli` declaration inside `spawnBridgeRunner`:

```ts
  // Local-CLI mode: no API key, no network endpoint — the bridge script
  // shells out to the machine's `claude` CLI instead of an OpenAI-compatible
  // HTTP endpoint. Triggered either by the resolved connection's providerType
  // or, for ad-hoc/manual testing without wiring up a connection, the
  // LOOP_LOCAL_CLI=1 env var.
  const useLocalCli =
    connection?.providerType === "local-cli" || process.env.LOOP_LOCAL_CLI === "1";
```

Directly after it, add:

```ts
  // Mavis-CLI mode: routes through the user's local MiniMax Code / Mavis
  // daemon instead of an HTTP endpoint or `claude -p`. See mavis-bridge.ts
  // for the actual session/poll implementation.
  const useMavisCli =
    connection?.providerType === "mavis-cli" || process.env.LOOP_MAVIS_CLI === "1";
  if (useMavisCli) {
    return spawnMavisBridge(
      agent,
      taskId,
      workdir,
      runPrompt,
      outFile,
      loadSystemPromptForRole(agent, workdir),
      onStdout,
      onStderr,
      onExit
    );
  }
```

- [ ] **Step 2: Add the import**

In `backend/src/loop/agent-spawner.ts`, find the existing imports near the top:

```ts
import { recordUsage } from "../store/tokenUsage.js";
import { writeTrace, type TraceRecord, type TraceRole } from "../store/traces.js";
```

Add directly after:

```ts
import { spawnMavisBridge } from "./mavis-bridge.js";
```

- [ ] **Step 3: Add the `loadSystemPromptForRole` helper**

The Mavis bridge needs a system prompt string to create each role's persistent agent. The bridge runner already loads this lazily inside `llm-agent.mjs` at runtime from `<workdir>/.opencode/agents/loop-<role>.md` — mirror that same lookup here so both paths stay consistent.

In `backend/src/loop/agent-spawner.ts`, add this function near the bottom of the "Bridge runner" section (right after `spawnBridgeRunner`'s closing brace, before the "Public API" section divider):

```ts
/**
 * Load the role's system prompt from `<workdir>/.opencode/agents/loop-<role>.md`,
 * the same file llm-agent.mjs reads at runtime for the HTTP/local-cli bridge
 * paths. Falls back to a minimal generic prompt if the file is missing —
 * this only affects Mavis-CLI mode's one-time agent creation, not the
 * per-call prompt (which is `runPrompt`, passed separately).
 */
function loadSystemPromptForRole(agent: AgentName, workdir: string): string {
  try {
    const path = pathResolve(workdir, ".opencode", "agents", `loop-${agent}.md`);
    if (existsSync(path)) {
      return readFileSync(path, "utf8");
    }
  } catch {
    /* fall through to default */
  }
  return `You are the ${agent} role in an autonomous plan/implement/verify loop.`;
}
```

- [ ] **Step 4: Add the missing `readFileSync` import**

In `backend/src/loop/agent-spawner.ts`, find:

```ts
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
```

Replace with:

```ts
import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
```

- [ ] **Step 5: Verify the backend typechecks**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full backend test suite**

Run: `cd backend && npx vitest run`
Expected: same pass count as before this task, plus the new Task 5 tests — no regressions.

- [ ] **Step 7: Commit**

```bash
git add backend/src/loop/agent-spawner.ts
git commit -m "feat(backend): route mavis-cli connections through the Mavis bridge"
```

---

### Task 7: Let task creation skip the API-key check for `mavis-cli`

**Files:**
- Modify: `backend/src/api/tasks.ts:69-108`
- Test: `backend/src/api/__tests__/tasks.test.ts` (create if it doesn't exist — check first)

- [ ] **Step 1: Check whether a tasks API test file already exists**

Run: `ls backend/src/api/__tests__/tasks.test.ts 2>&1`

If it exists, read it and add the new case into it following its existing style. If not, create it as written in Step 2.

- [ ] **Step 2: Write the failing test**

Create (or add to) `backend/src/api/__tests__/tasks.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { tasksApi } from "../tasks.js";
import { loadConnectionsFromDisk } from "../../store/connections.js";
import { loadTasksFromDisk } from "../../store/tasks.js";

describe("task creation — mavis-cli connections", () => {
  beforeEach(() => {
    loadTasksFromDisk([]);
    loadConnectionsFromDisk([
      {
        id: "mavistest1",
        name: "my-mavis",
        providerType: "mavis-cli",
        baseUrl: "http://localhost/mavis-cli",
        hasApiKey: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
  });

  it("does not require an API key when every role uses a mavis-cli connection", async () => {
    const app = new Hono().route("/", tasksApi);
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Fix the bug in sum.js",
        modelOverrides: {
          planning: "custom:mavistest1:mavis",
          implementation: "custom:mavistest1:mavis",
          review: "custom:mavistest1:mavis",
        },
      }),
    });
    // 201 (created) proves the preflight check let it through. If the check
    // still requires an apiKey for mavis-cli, this would be 400.
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx vitest run src/api/__tests__/tasks.test.ts`
Expected: FAIL — 400 response, because `connectionProblemForTask` doesn't yet know `mavis-cli` connections don't need an `apiKey`.

- [ ] **Step 4: Update `connectionProblemForTask`**

In `backend/src/api/tasks.ts`, find:

```ts
    if (model.startsWith("custom:")) {
      const resolved = resolveConnectionModel(model);
      if (!resolved) {
        problems.push(
          `${agent} (${key}) uses model "${model}" but its connection no longer exists`
        );
      } else if (!resolved.connection.apiKey) {
        problems.push(
          `${agent} (${key}) uses connection "${resolved.connection.name}" which has no API key set`
        );
      }
      continue;
    }
```

Replace with:

```ts
    if (model.startsWith("custom:")) {
      const resolved = resolveConnectionModel(model);
      if (!resolved) {
        problems.push(
          `${agent} (${key}) uses model "${model}" but its connection no longer exists`
        );
      } else if (
        resolved.connection.providerType !== "mavis-cli" &&
        !resolved.connection.apiKey
      ) {
        // mavis-cli connections never have an apiKey — they authenticate
        // via the user's already-logged-in Mavis daemon, not a portable key.
        problems.push(
          `${agent} (${key}) uses connection "${resolved.connection.name}" which has no API key set`
        );
      }
      continue;
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run src/api/__tests__/tasks.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full backend test suite**

Run: `cd backend && npx vitest run`
Expected: no regressions from before this task.

- [ ] **Step 7: Commit**

```bash
git add backend/src/api/tasks.ts backend/src/api/__tests__/tasks.test.ts
git commit -m "fix(backend): task-creation preflight accepts mavis-cli connections without an API key"
```

---

### Task 8: Manual smoke test against the real Mavis daemon

This is deliberately **not automated** — it would spend the user's real MiniMax Pro subscription quota on every test run. Run this once by hand after Tasks 1–7 are merged.

**Files:** none (manual verification only)

- [ ] **Step 1: Confirm the Mavis daemon is running**

Run: `~/.mavis/bin/minimax status`
Expected: `"status": "running"`. If not, run `~/.mavis/bin/minimax start` first.

- [ ] **Step 2: Restart the Loop Agent backend** (picks up the new code)

Stop and restart the `loop-agent-backend` dev server (however it's currently running — e.g. via the preview tool's `preview_stop` + `preview_start`, or `Ctrl-C` + `npm run dev` in `backend/`).

- [ ] **Step 3: Add the connection through the UI**

In the running app: Connections → Add connection → pick the "MiniMax Pro (Mavis CLI)" preset → Name it (e.g. `minimax-pro`) → Save. No API key field should be required.

- [ ] **Step 4: Assign it to all three roles**

Workflow tab → click the Planner node → in the model picker's "Your connections" section, pick the Mavis CLI connection's model entry → Save. Repeat for the Maker node (Implementation group) and Verifier node (Review group).

- [ ] **Step 5: Re-run the fixture task**

Create a new task pointed at the same fixture used earlier this session (working directory `/private/tmp/claude-501/-Users-anshmajumdar/ad0277de-083b-41a8-a493-49230083b8bc/scratchpad/verify-loop`, prompt: "The sum(a, b) function in src/sum.js has a bug and is failing its tests. Fix the implementation so all tests in test/ pass. Do not modify the tests.").

If that scratch directory no longer exists, recreate it:
```bash
mkdir -p /private/tmp/claude-501/-Users-anshmajumdar/ad0277de-083b-41a8-a493-49230083b8bc/scratchpad/verify-loop/{src,test}
cd /private/tmp/claude-501/-Users-anshmajumdar/ad0277de-083b-41a8-a493-49230083b8bc/scratchpad/verify-loop
cat > src/sum.js <<'EOF'
export function sum(a, b) {
  return a - b; // BUG: should add, not subtract
}
EOF
cat > test/sum.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert";
import { sum } from "../src/sum.js";
test("sum adds two numbers", () => { assert.strictEqual(sum(2, 3), 5); });
test("sum handles negatives", () => { assert.strictEqual(sum(-1, -1), -2); });
EOF
cat > package.json <<'EOF'
{"name":"verify-loop-fixture","version":"1.0.0","private":true,"type":"module","scripts":{"test":"node --test test/*.test.js"}}
EOF
git init -q && git add -A && git commit -q -m "Initial fixture with intentional bug"
```

- [ ] **Step 6: Watch it run**

Expected: Planning phase completes noticeably faster than the ~193s the free NVIDIA NIM connection took earlier this session (MiniMax's subscription-backed endpoint answered a trivial prompt in ~5s during this session's manual CLI test). The loop should proceed through Maker → Verifier and reach either `Done` (verifier APPROVE) or a `REJECT` with real, non-zero build/test numbers — either outcome proves the Mavis path works; only a stall/escalation with no real LLM activity would indicate a problem.

- [ ] **Step 7: Clean up the test agents (optional)**

Run: `~/.mavis/bin/minimax agent delete loop-planner && ~/.mavis/bin/minimax agent delete loop-maker && ~/.mavis/bin/minimax agent delete loop-verifier`

(Only if you don't want these persistent agents hanging around — leaving them is also fine, they'll just be reused on the next task.)

---

## Plan Self-Review

**Spec coverage:**
- §Goals "mavis-cli connection type" → Task 1, 2.
- §Goals "one persistent agent per role, session new → poll session messages → write outFile" → Task 5.
- §Goals "stall detection matches existing pattern" → satisfied by design (Task 5's `lastActivityAt` semantics), verified by Task 5 Step 5/6's stall test.
- §Goals "connectionProblemForTask recognizes mavis-cli" → Task 7.
- §Non-goals (no UI beyond Add Connection preset, no child-session support, no argv-size fix, no session cleanup, coexists with local-cli) → all respected; nothing in this plan violates them.
- §Error handling (daemon not running, agent-creation race, stall reuses existing pattern) → Task 5's tests cover daemon-not-running and the race is handled by construction (not checking `agent new`'s exit code).
- §Testing (shim fixture, no live-account CI test) → Task 4 (shim), Task 8 (manual-only real-account test).

**Type consistency:** `spawnMavisBridge`'s signature (`agent, taskId, workdir, runPrompt, outFile, systemPrompt, onStdout, onStderr, onExit`) is used identically in Task 5's tests and Task 6's call site. `AgentHandle`, `LineCallback`, `ExitCallback` are the exact names exported in Task 3 and imported in Task 5.

**No placeholders:** every step has complete, runnable code — no TBD/TODO markers.
