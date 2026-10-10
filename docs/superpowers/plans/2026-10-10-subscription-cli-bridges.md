# Subscription CLI Bridges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each Loop Agent role (planner / maker / verifier) run on a different *subscription* plan — Claude Pro/Max, ChatGPT Plus/Pro, a Google account (Gemini), or an OpenCode-supported plan — with no API key, chosen per role from the existing Connections panel.

**Architecture:** The existing `local-cli` provider type (today hard-wired to `claude -p`) becomes a family: a connection gains an optional `cliTool` field (`claude` | `codex` | `gemini` | `opencode`; absent = `claude`, so every existing connection behaves exactly as before). `llm-agent.mjs` picks the right headless invocation from a small adapter table (`backend/cli-adapters.mjs`), feeds the prompt over **stdin** (no macOS argv limit), and emits heartbeat lines so the 4-minute stall watchdog doesn't kill long subscription runs. Per-role assignment reuses what already exists: each connection has a model + optional `roles[]`, and the per-node model picker already lists connection models.

**Tech Stack:** TypeScript + Hono + Vitest (backend), plain ESM `.mjs` (bridge runner), React 18 + Vitest + Testing Library (UI).

---

## Why this design (read before starting)

**Compliance rule — non-negotiable.** Each subscription is only ever used through *that vendor's own official CLI*, running on the user's machine, under the user's own login. Loop Agent never reads, copies, or proxies subscription OAuth tokens, and never automates a chat website. Pulling tokens out of a CLI to call the API directly, or scripting claude.ai / chatgpt.com, violates those providers' terms and gets accounts banned. Running the official CLI headless is the supported path:

| Plan the user owns | Official CLI | One-time login (user does this) |
|---|---|---|
| Claude Pro / Max | `claude` (Claude Code) | run `claude`, sign in |
| ChatGPT Plus / Pro | `codex` (OpenAI Codex CLI) | `codex login` → "Sign in with ChatGPT" |
| Google account / Google AI plan | `gemini` (Gemini CLI) | run `gemini`, "Login with Google" |
| OpenCode Go/Zen, GitHub Copilot, etc. | `opencode` | `opencode auth login` |

**What already exists (reused, not rebuilt):**
- `local-cli` connections → `llm-agent.mjs --cli` → `claude -p` (`backend/llm-agent.mjs:266-319`).
- `mavis-cli` → MiniMax Pro via `backend/src/loop/mavis-bridge.ts`. **Untouched by this plan.**
- Per-role model choice: `modelOverrides.{planning,implementation,review}` = `custom:<connId>:<model>`, set from the canvas node model picker (`ui/src/components/NodeModelPanel.tsx`, options from `dynamicModelOptions` in `ui/src/types/loop.ts:428`).
- Role dedication on a connection: `Connection.roles` (`backend/src/types.ts`).

**Existing bugs this plan fixes along the way (they block today's no-API path):**
1. `backend/src/api/tasks.ts:92-101` exempts only `mavis-cli` from the API-key check, so a task using a `local-cli` (Claude) connection is rejected with 400. Fixed in Task 4.
2. The `local-cli` preset has `models: []`, so a Claude CLI connection has no `model`. `dynamicModelOptions` skips connections without a model, so **it never shows up in the per-role picker**. Separately, `NewConnectionModal.tsx:146` drops a typed model when `preset.models` is empty. Fixed in Task 10.
3. Backend tests that hit the connections/tasks API write to the real `backend/data/` folder (no `LOOP_DATA_DIR` in tests). This is the source of the stray `*.tmp-*` files in `backend/data/`. Fixed in Task 1.

**Safety properties to keep:**
- The CLIs are agents with tools. The loop expects a *text reply* that `llm-agent.mjs` turns into files, so every adapter runs the CLI **read-only**: Claude `-p` auto-denies permissioned tools, Codex runs with `--sandbox read-only`, Gemini runs non-interactive (tools that need approval are excluded), and OpenCode uses its built-in read-only `plan` agent. **Never** `--yolo` or `--dangerously-skip-permissions`.
- Failover onto a subscription CLI happens **only** if the user dedicated that connection to the role (Task 9). A plain "general" CLI connection never starts silently spending a subscription quota when an API connection fails.

**Out of scope (YAGNI, possible follow-ups):** token/quota accounting for CLI runs (the CLIs don't expose remaining plan quota), streaming partial output from CLIs, auto-detecting the user's logged-in model list.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `backend/vitest.config.ts` | Create | Point tests at a temp data dir |
| `backend/src/types.ts` | Modify | `CliToolId`, `Connection.cliTool`, new provider ids |
| `backend/src/loop/cli-tools.ts` | Create | TS-side CLI registry: ids, bins, labels, keyless rule, `--version` probe, spawn config |
| `backend/src/loop/__tests__/cli-tools.test.ts` | Create | Unit tests for the above |
| `backend/src/api/connections.ts` | Modify | Zod: accept `cliTool` + new provider ids |
| `backend/src/store/connections.ts` | Modify | Persist `cliTool`; opt-in CLI failover |
| `backend/src/api/tasks.ts` | Modify | Shared keyless rule in preflight |
| `backend/src/loop/orchestrator.ts` | Modify | Shared keyless rule in `validateRefs` |
| `backend/cli-adapters.mjs` | Create | argv/stdin per CLI, async runner with heartbeat + timeout |
| `backend/llm-agent.mjs` | Modify | `--cli-tool` flag, use adapters |
| `backend/src/loop/__tests__/fixtures/cli-recorder-shim.sh` | Create | Fake CLI that records argv + stdin |
| `backend/src/loop/__tests__/fixtures/cli-slow-shim.sh` | Create | Fake CLI that takes 1s (heartbeat test) |
| `backend/src/loop/__tests__/llm-agent-cli-tools.test.ts` | Create | Per-tool invocation tests |
| `backend/src/loop/agent-spawner.ts` | Modify | Pass tool/model/bin to the bridge |
| `backend/src/api/connectionMeta.ts` | Modify | Real health probe for CLI connections |
| `ui/src/types/loop.ts` | Modify | Mirror types |
| `ui/src/lib/providerPresets.ts` | Modify | One preset per subscription CLI |
| `ui/src/components/NewConnectionModal.tsx` | Modify | Send `cliTool`; fix dropped free-text model |
| `ui/src/lib/providerPresets.test.ts` | Create | Preset invariants |
| `ui/src/components/NewConnectionModal.test.tsx` | Create | Modal sends `cliTool` |

Baseline before starting (record it): `cd backend && npx vitest run` → **44 files / 296 tests passed**; `cd ui && npx vitest run` → **31 tests passed**.

---

### Task 0: Confirm each CLI's headless flags (read-only, no quota spent)

CLI flags drift between versions. The adapter table in Task 5 was written against `claude` 2.1.214 and `opencode` 1.14.28 (both verified on this machine via `--help`) plus the documented flags for `codex` and `gemini` (not installed here yet). Confirm before writing Task 5.

**Files:** none

- [ ] **Step 1: Check which CLIs are installed**

```bash
for b in claude codex gemini opencode; do printf "%s: " $b; command -v $b >/dev/null && $b --version 2>/dev/null | head -1 || echo "not installed"; done
```

Installing `codex` (`npm i -g @openai/codex`) or `gemini` (`npm i -g @google/gemini-cli`) is the **user's** decision. Ask before installing anything.

- [ ] **Step 2: For each installed CLI, confirm the flags Task 5 relies on**

```bash
claude --help | grep -E -- "--print|--model|--output-format"
codex exec --help | grep -E -- "--sandbox|--skip-git-repo-check|--output-last-message|--color|--model|stdin"
gemini --help | grep -E -- "--prompt|--model|stdin"
opencode run --help | grep -E -- "--agent|--model"
opencode agent list | grep -E "^plan "
```

Expected: every flag in the Task 5 adapter table appears. If a flag is renamed, update **only** that tool's `case` in `backend/cli-adapters.mjs` (Task 5 Step 1) and the matching assertion in Task 6 Step 2.

---

### Task 1: Keep backend tests out of the real data folder

**Files:**
- Create: `backend/vitest.config.ts`

`backend/src/store/persistence.ts:30-31` reads `LOOP_DATA_DIR` at import time and otherwise writes to `backend/data/tasks`. The API tests (`connections.test.ts`, `tasks.test.ts`) create connections and tasks, so they currently write to the user's real store.

- [ ] **Step 1: Create the config**

```ts
// Vitest config for the backend. The only job: point persistence at a
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
  },
});
```

- [ ] **Step 2: Prove the real store is no longer touched**

Stop the `loop-agent-backend` dev server first. Its 5-minute health sweep legitimately rewrites `data/_connections.json` and would show up as a false positive.

```bash
cd backend && touch /tmp/loop-before && npx vitest run && find data -newer /tmp/loop-before | head
```

Expected: the same pass count as the baseline (296), and `find` prints **nothing**.

- [ ] **Step 3: Commit**

```bash
git add backend/vitest.config.ts
git commit -m "test(backend): isolate tests from the real data dir via LOOP_DATA_DIR"
```

---

### Task 2: `cliTool` field and new provider ids (types + API + store)

**Files:**
- Modify: `backend/src/types.ts` (`ConnectionProviderId`, `Connection`, `UpsertConnectionBody`)
- Modify: `backend/src/api/connections.ts:36-60`
- Modify: `backend/src/store/connections.ts:109-146`
- Test: `backend/src/api/__tests__/connections.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/api/__tests__/connections.test.ts`:

```ts
describe("connections API — subscription CLI tools", () => {
  beforeEach(() => {
    loadConnectionsFromDisk([]);
  });

  const app = () => new Hono().route("/", connectionsApi);
  const post = (body: object) =>
    app().request("/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("stores cliTool on a local-cli connection", async () => {
    const res = await post({
      name: "chatgpt-plus",
      providerId: "codex-cli",
      providerType: "local-cli",
      cliTool: "codex",
      baseUrl: "http://localhost/local-cli",
      model: "default",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      connection: { cliTool?: string; providerId?: string };
    };
    expect(body.connection.cliTool).toBe("codex");
    expect(body.connection.providerId).toBe("codex-cli");
  });

  it("rejects an unknown cliTool", async () => {
    const res = await post({
      name: "bad",
      providerType: "local-cli",
      cliTool: "not-a-cli",
      baseUrl: "http://localhost/local-cli",
    });
    expect(res.status).toBe(400);
  });

  it("drops cliTool on non-CLI provider types", async () => {
    const res = await post({
      name: "api",
      providerType: "openai-compatible",
      cliTool: "codex",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
    });
    const body = (await res.json()) as { connection: { cliTool?: string } };
    expect(body.connection.cliTool).toBeUndefined();
  });

  it("keeps the existing cliTool when a PATCH omits it", async () => {
    const created = (await (
      await post({
        name: "gem",
        providerType: "local-cli",
        cliTool: "gemini",
        baseUrl: "http://localhost/local-cli",
        model: "default",
      })
    ).json()) as { connection: { id: string } };
    const res = await app().request(`/connections/${created.connection.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "gem-renamed",
        providerType: "local-cli",
        baseUrl: "http://localhost/local-cli",
        model: "default",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection: { cliTool?: string; name: string } };
    expect(body.connection.name).toBe("gem-renamed");
    expect(body.connection.cliTool).toBe("gemini");
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd backend && npx vitest run src/api/__tests__/connections.test.ts`
Expected: FAIL. Zod rejects `providerId: "codex-cli"` (400 instead of 201), and `cliTool` is stripped from responses.

- [ ] **Step 3: Extend the backend types**

In `backend/src/types.ts`, replace:

```ts
export type ConnectionProviderId =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "local-cli"
  | "mavis-cli"
  | "custom";
```

with:

```ts
export type ConnectionProviderId =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "local-cli"
  | "codex-cli"
  | "gemini-cli"
  | "opencode-cli"
  | "mavis-cli"
  | "custom";

/** Which subscription CLI a `local-cli` connection drives. Each is the
 *  vendor's official CLI, run headless under the user's own login — no API
 *  key is stored. Absent on connections created before this field existed;
 *  absent means "claude" (the original local-cli behavior). */
export type CliToolId = "claude" | "codex" | "gemini" | "opencode";
```

In the `Connection` interface, directly after the `providerType: ConnectionProviderType;` line, add:

```ts
  /** Only meaningful when providerType === "local-cli". See CliToolId. */
  cliTool?: CliToolId;
```

In the `UpsertConnectionBody` interface, directly after its `providerType: ConnectionProviderType;` line, add the same two lines.

- [ ] **Step 4: Extend the Zod schema**

In `backend/src/api/connections.ts`, replace:

```ts
  providerId: z
    .enum(["openrouter", "openai", "anthropic", "google", "ollama", "local-cli", "mavis-cli", "custom"])
    .optional(),
  providerType: z.enum(["openai-compatible", "anthropic-compatible", "local-cli", "mavis-cli"]),
```

with:

```ts
  providerId: z
    .enum([
      "openrouter",
      "openai",
      "anthropic",
      "google",
      "ollama",
      "local-cli",
      "codex-cli",
      "gemini-cli",
      "opencode-cli",
      "mavis-cli",
      "custom",
    ])
    .optional(),
  providerType: z.enum(["openai-compatible", "anthropic-compatible", "local-cli", "mavis-cli"]),
  cliTool: z.enum(["claude", "codex", "gemini", "opencode"]).optional(),
```

- [ ] **Step 5: Persist `cliTool` in the store**

In `backend/src/store/connections.ts`, inside `buildConnectionRecord`, directly after `const roles = normaliseRoles(input.roles);` add:

```ts
  // Only local-cli connections carry a cliTool. A PATCH that omits it keeps
  // the stored value so an edit can never silently turn Codex into Claude.
  const cliTool =
    input.providerType === "local-cli"
      ? input.cliTool ?? existing?.cliTool
      : undefined;
```

Then in the returned object, directly after `providerType: input.providerType,` add:

```ts
    cliTool,
```

(It must be set explicitly, even when `undefined`, because the object starts from `...(existing ?? {})`.)

- [ ] **Step 6: Run the tests**

Run: `cd backend && npx vitest run src/api/__tests__/connections.test.ts`
Expected: PASS (5 tests: 1 existing + 4 new).

- [ ] **Step 7: Typecheck and commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/types.ts backend/src/api/connections.ts backend/src/store/connections.ts backend/src/api/__tests__/connections.test.ts
git commit -m "feat(backend): cliTool field on local-cli connections + subscription CLI provider ids"
```

---

### Task 3: TS-side CLI registry (`cli-tools.ts`)

**Files:**
- Create: `backend/src/loop/cli-tools.ts`
- Test: `backend/src/loop/__tests__/cli-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/loop/__tests__/cli-tools.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import {
  binForCliTool,
  cliBridgeConfig,
  cliToolOf,
  isKeylessProviderType,
  probeCliTool,
} from "../cli-tools.js";

// cwd-anchored for the same reason as llm-agent-cli.test.ts: vitest also
// picks up the compiled dist/ copy, which has no fixtures next to it.
const SHIM = resolve(process.cwd(), "src/loop/__tests__/fixtures/claude-shim.sh");

const ENV_KEYS = ["LOOP_CLI_BIN", "LOOP_CLI_BIN_CLAUDE", "LOOP_CLI_BIN_CODEX"];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("isKeylessProviderType", () => {
  it("is true only for CLI-backed provider types", () => {
    expect(isKeylessProviderType("local-cli")).toBe(true);
    expect(isKeylessProviderType("mavis-cli")).toBe(true);
    expect(isKeylessProviderType("openai-compatible")).toBe(false);
    expect(isKeylessProviderType("anthropic-compatible")).toBe(false);
  });
});

describe("cliToolOf", () => {
  it("defaults legacy local-cli connections to claude", () => {
    expect(cliToolOf({ providerType: "local-cli" })).toBe("claude");
  });
  it("returns the stored tool", () => {
    expect(cliToolOf({ providerType: "local-cli", cliTool: "gemini" })).toBe("gemini");
  });
  it("is null for non-local-cli connections", () => {
    expect(cliToolOf({ providerType: "openai-compatible", cliTool: "codex" })).toBeNull();
  });
});

describe("binForCliTool", () => {
  it("uses the default binary name", () => {
    expect(binForCliTool("codex")).toBe("codex");
  });
  it("honors a per-tool override", () => {
    process.env.LOOP_CLI_BIN_CODEX = "/opt/codex";
    expect(binForCliTool("codex")).toBe("/opt/codex");
  });
  it("keeps the legacy LOOP_CLI_BIN override for claude only", () => {
    process.env.LOOP_CLI_BIN = "/opt/claude-legacy";
    expect(binForCliTool("claude")).toBe("/opt/claude-legacy");
    expect(binForCliTool("codex")).toBe("codex");
  });
});

describe("cliBridgeConfig", () => {
  it("passes the connection's model for a local-cli connection", () => {
    expect(
      cliBridgeConfig({ providerType: "local-cli", cliTool: "codex" }, "custom:abc123:gpt-x")
    ).toEqual({ tool: "codex", model: "gpt-x", bin: "codex" });
  });
  it("falls back to claude + default model with no connection (LOOP_LOCAL_CLI=1 path)", () => {
    expect(cliBridgeConfig(null, "opencode-go/minimax-m3")).toEqual({
      tool: "claude",
      model: "default",
      bin: "claude",
    });
  });
  it("never forwards an API connection's model to a CLI", () => {
    expect(
      cliBridgeConfig({ providerType: "openai-compatible" }, "custom:abc123:z-ai/glm-5.2")
    ).toEqual({ tool: "claude", model: "default", bin: "claude" });
  });
});

describe("probeCliTool", () => {
  it("reports ok when the binary answers --version", async () => {
    process.env.LOOP_CLI_BIN_CODEX = SHIM;
    const r = await probeCliTool("codex");
    expect(r.ok).toBe(true);
  });
  it("reports a not-found error for a missing binary", async () => {
    process.env.LOOP_CLI_BIN_CODEX = "/nonexistent/codex-binary";
    const r = await probeCliTool("codex");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd backend && npx vitest run src/loop/__tests__/cli-tools.test.ts`
Expected: FAIL with `Cannot find module '../cli-tools.js'`.

- [ ] **Step 3: Implement**

Create `backend/src/loop/cli-tools.ts`:

```ts
// Registry of the subscription CLIs Loop Agent can drive with no API key.
// Each is the vendor's own official CLI, run headless on this machine under
// the user's existing login — Loop Agent never sees or stores subscription
// credentials. The per-tool argv lives in backend/cli-adapters.mjs (used by
// llm-agent.mjs); this module holds the TypeScript-side facts: binaries,
// labels, the shared "is this connection keyless" rule, and a cheap
// `--version` probe for the health monitor.

import { execFile } from "node:child_process";
import type { CliToolId, Connection, ConnectionProviderType } from "../types.js";

export const CLI_TOOLS: Record<
  CliToolId,
  { label: string; defaultBin: string; loginHint: string }
> = {
  claude: {
    label: "Claude Code",
    defaultBin: "claude",
    loginHint: "run `claude` once and sign in with your Claude Pro/Max account",
  },
  codex: {
    label: "Codex",
    defaultBin: "codex",
    loginHint: "run `codex login` and choose Sign in with ChatGPT",
  },
  gemini: {
    label: "Gemini CLI",
    defaultBin: "gemini",
    loginHint: "run `gemini` once and choose Login with Google",
  },
  opencode: {
    label: "OpenCode",
    defaultBin: "opencode",
    loginHint: "run `opencode auth login` for your provider",
  },
};

/** Provider types that authenticate through a local CLI login instead of
 *  an API key. Every API-key gate (task preflight, orchestrator
 *  validateRefs, failover candidates) must use this one rule. */
export function isKeylessProviderType(t: ConnectionProviderType): boolean {
  return t === "local-cli" || t === "mavis-cli";
}

/** The CLI a connection drives, or null when it isn't a local-cli
 *  connection. Legacy local-cli connections (no cliTool) mean claude. */
export function cliToolOf(
  c: Pick<Connection, "providerType" | "cliTool">
): CliToolId | null {
  if (c.providerType !== "local-cli") return null;
  return c.cliTool ?? "claude";
}

/** Binary to spawn. `LOOP_CLI_BIN_<TOOL>` overrides per tool (tests, odd
 *  install paths). The legacy `LOOP_CLI_BIN` keeps working for claude only,
 *  so an old override can't hijack a codex/gemini connection. */
export function binForCliTool(id: CliToolId): string {
  const specific = process.env[`LOOP_CLI_BIN_${id.toUpperCase()}`];
  if (specific) return specific;
  if (id === "claude" && process.env.LOOP_CLI_BIN) return process.env.LOOP_CLI_BIN;
  return CLI_TOOLS[id].defaultBin;
}

export interface CliBridgeConfig {
  tool: CliToolId;
  /** Model to pass the CLI, or "default" to let the CLI use its own. */
  model: string;
  bin: string;
}

/** Everything agent-spawner needs to launch llm-agent.mjs in CLI mode. The
 *  model only comes from a local-cli connection's picker id — an API
 *  model id (e.g. z-ai/glm-5.2) would make the CLI fail, so anything else
 *  becomes "default". */
export function cliBridgeConfig(
  connection: Pick<Connection, "providerType" | "cliTool"> | null,
  pickerModel: string | undefined
): CliBridgeConfig {
  const tool = (connection && cliToolOf(connection)) ?? "claude";
  let model = "default";
  if (connection?.providerType === "local-cli" && pickerModel?.startsWith("custom:")) {
    model = pickerModel.split(":").slice(2).join(":") || "default";
  }
  return { tool, model, bin: binForCliTool(tool) };
}

export type CliProbeResult =
  | { ok: true; version: string }
  | { ok: false; error: string };

/** Cheap "is it installed" check: `<bin> --version`. Spends no plan quota.
 *  It can't tell whether the user is logged in — a logged-out CLI fails
 *  on first use and the orchestrator reports its stderr. */
export function probeCliTool(id: CliToolId, timeoutMs = 5000): Promise<CliProbeResult> {
  const bin = binForCliTool(id);
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        resolve({
          ok: false,
          error:
            code === "ENOENT"
              ? `${bin} not found on PATH`
              : err.message.split("\n")[0],
        });
        return;
      }
      resolve({ ok: true, version: stdout.trim().split("\n")[0] || "unknown version" });
    });
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx vitest run src/loop/__tests__/cli-tools.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/loop/cli-tools.ts backend/src/loop/__tests__/cli-tools.test.ts
git commit -m "feat(backend): cli-tools registry for subscription CLIs"
```

---

### Task 4: One keyless rule for every API-key gate

**Files:**
- Modify: `backend/src/api/tasks.ts:86-103`
- Modify: `backend/src/loop/orchestrator.ts:628-633`
- Test: `backend/src/api/__tests__/tasks.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/src/api/__tests__/tasks.test.ts` (a new `describe` block, after the existing one):

```ts
describe("task creation — local-cli (subscription CLI) connections", () => {
  beforeEach(() => {
    // A 201 fires runLoop() in the background. Point every CLI at a binary
    // that fails instantly so this test can never spend a real subscription.
    process.env.LOOP_CLI_BIN_CLAUDE = "/usr/bin/false";
    process.env.LOOP_CLI_BIN_CODEX = "/usr/bin/false";
    loadTasksFromDisk([]);
    loadConnectionsFromDisk([
      {
        id: "clauderole1",
        name: "claude-pro",
        providerType: "local-cli",
        baseUrl: "http://localhost/local-cli",
        model: "opus",
        hasApiKey: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "codexrole1",
        name: "chatgpt-plus",
        providerType: "local-cli",
        cliTool: "codex",
        baseUrl: "http://localhost/local-cli",
        model: "default",
        hasApiKey: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
  });

  afterEach(() => {
    delete process.env.LOOP_CLI_BIN_CLAUDE;
    delete process.env.LOOP_CLI_BIN_CODEX;
  });

  it("accepts a task whose roles are split across keyless CLI connections", async () => {
    const app = new Hono().route("/", tasksApi);
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Fix the bug in sum.js",
        modelOverrides: {
          planning: "custom:clauderole1:opus",
          implementation: "custom:codexrole1:default",
          review: "custom:clauderole1:opus",
        },
      }),
    });
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd backend && npx vitest run src/api/__tests__/tasks.test.ts`
Expected: the new test FAILS with status 400 ("…which has no API key set"). This is existing bug #1.

- [ ] **Step 3: Use the shared rule in task preflight**

In `backend/src/api/tasks.ts`, replace:

```ts
      } else if (
        resolved.connection.providerType !== "mavis-cli" &&
        !resolved.connection.apiKey
      ) {
        // mavis-cli connections never have an apiKey — they authenticate
        // via the user's already-logged-in Mavis daemon, not a portable key.
```

with:

```ts
      } else if (
        !isKeylessProviderType(resolved.connection.providerType) &&
        !resolved.connection.apiKey
      ) {
        // CLI-backed connections (local-cli, mavis-cli) never have an
        // apiKey — they authenticate via the user's logged-in local CLI.
```

Add the import next to the file's other imports:

```ts
import { isKeylessProviderType } from "../loop/cli-tools.js";
```

- [ ] **Step 4: Use the shared rule in the orchestrator**

In `backend/src/loop/orchestrator.ts`, replace:

```ts
        resolved?.connection &&
        resolved.connection.providerType !== "local-cli" &&
        resolved.connection.providerType !== "mavis-cli" &&
        !resolved.connection.apiKey
```

with:

```ts
        resolved?.connection &&
        !isKeylessProviderType(resolved.connection.providerType) &&
        !resolved.connection.apiKey
```

Add the import beside the existing `./` imports at the top of `orchestrator.ts`:

```ts
import { isKeylessProviderType } from "./cli-tools.js";
```

- [ ] **Step 5: Run the tests and typecheck**

```bash
cd backend && npx vitest run src/api/__tests__/tasks.test.ts && npx tsc --noEmit
```

Expected: PASS (existing mavis test + new test); no type errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/tasks.ts backend/src/loop/orchestrator.ts backend/src/api/__tests__/tasks.test.ts
git commit -m "fix(backend): local-cli connections pass the API-key preflight like mavis-cli"
```

---

### Task 5: Adapter table + async runner (`cli-adapters.mjs`)

**Files:**
- Create: `backend/cli-adapters.mjs`

This sits next to `llm-agent.mjs` (outside `src/`, so `tsc` doesn't compile it, same as `llm-agent.mjs`). It's tested end-to-end through `llm-agent.mjs` in Task 6, the same way `llm-agent-cli.test.ts` already tests the `--cli` path.

- [ ] **Step 1: Write the module**

Create `backend/cli-adapters.mjs`:

```js
// Headless invocation for each subscription CLI llm-agent.mjs can drive.
// Every adapter runs its CLI READ-ONLY: the loop wants a text reply that
// llm-agent.mjs turns into files itself, never a CLI editing the workdir.
// Never add --yolo / --dangerously-skip-permissions here.
//
// The prompt goes over stdin wherever the CLI supports it, which avoids
// the macOS ~256KB argv limit that the old `claude -p <prompt>` hit.
//
// Flags verified against: claude 2.1.214, opencode 1.14.28 (`--help` on
// the dev machine), codex/gemini per their docs — re-check with Task 0 of
// docs/superpowers/plans/2026-10-10-subscription-cli-bridges.md when a CLI
// upgrade breaks a run.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export const CLI_DEFAULT_BINS = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
};

// opencode has no stdin prompt mode, so its prompt rides in argv.
const ARGV_PROMPT_LIMIT = 200_000;

const GEMINI_INSTRUCTION =
  "Follow the instructions in the input above exactly. Reply with only the requested output.";

const withModel = (flag, model) =>
  model && model !== "default" ? [flag, model] : [];

/**
 * @param {string} tool  claude | codex | gemini | opencode
 * @param {{ prompt: string, model?: string, lastMessageFile: string }} opts
 * @returns {{ args: string[], stdin: string, lastMessageFile?: string }}
 */
export function buildCliInvocation(tool, { prompt, model, lastMessageFile }) {
  switch (tool) {
    case "claude":
      return {
        args: ["-p", "--output-format", "text", ...withModel("--model", model)],
        stdin: prompt,
      };
    case "codex":
      return {
        args: [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          "--output-last-message",
          lastMessageFile,
          ...withModel("-m", model),
          "-", // read the prompt from stdin
        ],
        stdin: prompt,
        lastMessageFile,
      };
    case "gemini":
      return {
        args: [...withModel("-m", model), "-p", GEMINI_INSTRUCTION],
        stdin: prompt,
      };
    case "opencode":
      if (Buffer.byteLength(prompt, "utf8") > ARGV_PROMPT_LIMIT) {
        throw new Error(
          `prompt is ${Buffer.byteLength(prompt, "utf8")} bytes — too large for opencode's argv prompt (limit ${ARGV_PROMPT_LIMIT}). Use claude/codex/gemini for this role.`
        );
      }
      return {
        args: ["run", "--agent", "plan", ...withModel("-m", model), prompt],
        stdin: "",
      };
    default:
      throw new Error(
        `Unknown --cli-tool "${tool}" (expected claude|codex|gemini|opencode)`
      );
  }
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** The CLI's final answer: codex's --output-last-message file when present
 *  (its stdout also carries progress), otherwise stdout. */
export async function readCliOutput(inv, stdout) {
  if (inv.lastMessageFile) {
    try {
      const fromFile = (await readFile(inv.lastMessageFile, "utf8")).trim();
      if (fromFile) return fromFile;
    } catch {
      /* fall back to stdout */
    }
  }
  return (stdout || "").replace(ANSI, "").trim();
}

/**
 * Run a CLI asynchronously. A heartbeat callback fires every `heartbeatMs`
 * so the caller can print a line — the orchestrator's 4-minute stall
 * watchdog only sees output lines, and a subscription CLI can think for
 * longer than that. `timeoutMs` is the hard backstop for a truly hung CLI.
 *
 * Resolves (never rejects) with { error } on spawn failure, otherwise
 * { status, stdout, stderr, timedOut }.
 */
export function runCli(bin, inv, { cwd, timeoutMs, heartbeatMs, onHeartbeat }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, inv.args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ error });
      return;
    }
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const beat = setInterval(() => onHeartbeat(Date.now() - started), heartbeatMs);
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const finish = (result) => {
      if (done) return;
      done = true;
      clearInterval(beat);
      clearTimeout(killer);
      resolve(result);
    };
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => finish({ error }));
    child.on("close", (status) => finish({ status, stdout, stderr, timedOut }));
    // EPIPE when the CLI exits before reading stdin — the close handler
    // reports the real outcome.
    child.stdin.on("error", () => {});
    child.stdin.end(inv.stdin ?? "");
  });
}
```

- [ ] **Step 2: Syntax-check it**

Run: `cd backend && node --check cli-adapters.mjs && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add backend/cli-adapters.mjs
git commit -m "feat(backend): headless adapters for claude/codex/gemini/opencode CLIs"
```

---

### Task 6: `llm-agent.mjs` uses the adapters

**Files:**
- Create: `backend/src/loop/__tests__/fixtures/cli-recorder-shim.sh`
- Create: `backend/src/loop/__tests__/fixtures/cli-slow-shim.sh`
- Create: `backend/src/loop/__tests__/llm-agent-cli-tools.test.ts`
- Modify: `backend/llm-agent.mjs` (`parseArgs`, imports, the `if (args.cli)` branch at ~266-296)

The 7 existing tests in `llm-agent-cli.test.ts` must keep passing **unchanged**. They run `--cli` with no `--cli-tool`, so claude stays the default, and they assert the exact strings `llm-agent: FAIL: local CLI exit 1:` and `llm-agent: FAIL: local CLI spawn error:`.

- [ ] **Step 1: Create the fixtures**

`backend/src/loop/__tests__/fixtures/cli-recorder-shim.sh`:

```sh
#!/bin/sh
# Fake subscription CLI for llm-agent-cli-tools.test.ts. Records its argv
# (one per line) and stdin into $SHIM_RECORD_DIR, honors codex's
# --output-last-message <file>, then prints a parseable plan to stdout.
printf '%s\n' "$@" > "$SHIM_RECORD_DIR/argv.txt"
cat > "$SHIM_RECORD_DIR/stdin.txt"
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    printf '## Implementation Plan\n1. from last-message file\n## Completion Criteria\n- [ ] works\n' > "$a"
  fi
  prev="$a"
done
echo "## Implementation Plan
1. from stdout
## Completion Criteria
- [ ] works"
```

`backend/src/loop/__tests__/fixtures/cli-slow-shim.sh`:

```sh
#!/bin/sh
# Takes 1s before answering, so the heartbeat test can observe
# "waiting on … CLI" lines at a short LOOP_CLI_HEARTBEAT_MS.
cat > /dev/null
sleep 1
echo "## Implementation Plan
1. slow
## Completion Criteria
- [ ] works"
```

```bash
chmod +x backend/src/loop/__tests__/fixtures/cli-recorder-shim.sh backend/src/loop/__tests__/fixtures/cli-slow-shim.sh
```

- [ ] **Step 2: Write the failing tests**

Create `backend/src/loop/__tests__/llm-agent-cli-tools.test.ts`:

```ts
// Per-tool invocation contract for llm-agent.mjs --cli --cli-tool <id>.
// Uses a recorder shim instead of real CLIs so no subscription quota is
// spent and the test is hermetic. See cli-adapters.mjs for the argv.

import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LLM_AGENT_SCRIPT = resolve(process.cwd(), "llm-agent.mjs");
const RECORDER = resolve(process.cwd(), "src/loop/__tests__/fixtures/cli-recorder-shim.sh");
const SLOW = resolve(process.cwd(), "src/loop/__tests__/fixtures/cli-slow-shim.sh");
const PROMPT = "unique-user-prompt-7f3a";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function run(tool: string | null, model: string, bin: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const workdir = await mkdtemp(join(tmpdir(), "loop-cli-tool-"));
  const recordDir = await mkdtemp(join(tmpdir(), "loop-cli-rec-"));
  dirs.push(workdir, recordDir);
  const args = [
    "--cli",
    ...(tool ? ["--cli-tool", tool] : []),
    "--role", "planner",
    "--model", model,
    "--base-url", "x",
    "--workdir", workdir,
    "--output", join(workdir, "GOAL.md"),
  ];
  const result = await new Promise<{ code: number | null; stderr: string }>((res, rej) => {
    const child = spawn(process.execPath, [LLM_AGENT_SCRIPT, ...args], {
      env: {
        ...process.env,
        LOOP_CLI_BIN: bin,
        LOOP_USER_PROMPT: PROMPT,
        SHIM_RECORD_DIR: recordDir,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", rej);
    child.on("close", (code) => res({ code, stderr }));
  });
  const read = (f: string) => readFile(join(recordDir, f), "utf8").catch(() => "");
  return {
    ...result,
    argv: (await read("argv.txt")).split("\n").filter(Boolean),
    stdin: await read("stdin.txt"),
    goal: await readFile(join(workdir, "GOAL.md"), "utf8").catch(() => ""),
  };
}

describe("llm-agent.mjs --cli-tool", () => {
  it("claude: prompt on stdin, print mode, model alias passed", async () => {
    const r = await run("claude", "opus", RECORDER);
    expect(r.code, r.stderr).toBe(0);
    expect(r.argv).toEqual(["-p", "--output-format", "text", "--model", "opus"]);
    expect(r.stdin).toContain(PROMPT);
    expect(r.goal).toContain("from stdout");
  });

  it("claude: 'default' model omits --model; no --cli-tool still means claude", async () => {
    const r = await run(null, "default", RECORDER);
    expect(r.code, r.stderr).toBe(0);
    expect(r.argv).toEqual(["-p", "--output-format", "text"]);
  });

  it("codex: read-only exec, stdin prompt, answer from --output-last-message", async () => {
    const r = await run("codex", "default", RECORDER);
    expect(r.code, r.stderr).toBe(0);
    expect(r.argv[0]).toBe("exec");
    expect(r.argv).toContain("--skip-git-repo-check");
    expect(r.argv.join(" ")).toContain("--sandbox read-only");
    expect(r.argv).not.toContain("-m");
    expect(r.argv[r.argv.length - 1]).toBe("-");
    expect(r.stdin).toContain(PROMPT);
    expect(r.goal).toContain("from last-message file");
  });

  it("gemini: model flag + -p instruction, full prompt on stdin", async () => {
    const r = await run("gemini", "gemini-test-model", RECORDER);
    expect(r.code, r.stderr).toBe(0);
    expect(r.argv.slice(0, 3)).toEqual(["-m", "gemini-test-model", "-p"]);
    expect(r.stdin).toContain(PROMPT);
  });

  it("opencode: read-only plan agent, prompt in argv", async () => {
    const r = await run("opencode", "opencode-go/minimax-m3", RECORDER);
    expect(r.code, r.stderr).toBe(0);
    expect(r.argv.slice(0, 5)).toEqual(["run", "--agent", "plan", "-m", "opencode-go/minimax-m3"]);
    expect(r.argv.join("\n")).toContain(PROMPT);
    expect(r.stdin).toBe("");
  });

  it("rejects an unknown tool with exit 2", async () => {
    const r = await run("not-a-cli", "default", RECORDER);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown --cli-tool "not-a-cli"');
  });

  it("emits heartbeat lines while a slow CLI is working", async () => {
    const r = await run("claude", "default", SLOW, { LOOP_CLI_HEARTBEAT_MS: "200" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("waiting on claude CLI");
  });

  it("kills a CLI that exceeds LOOP_CLI_TIMEOUT_MS and reports the timeout", async () => {
    const r = await run("claude", "default", SLOW, { LOOP_CLI_TIMEOUT_MS: "200" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("timed out");
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `cd backend && npx vitest run src/loop/__tests__/llm-agent-cli-tools.test.ts`
Expected: FAIL. `--cli-tool` is an unknown flag (exit 2 for all cases), and claude argv still contains the prompt.

- [ ] **Step 4: Parse `--cli-tool`**

In `backend/llm-agent.mjs` `parseArgs`, directly after:

```js
      case "--cli":
        out.cli = true;
        break;
```

add:

```js
      case "--cli-tool":
        out.cliTool = argv[++i];
        break;
```

Update the header comment's `--cli` entry (lines 13-17) to:

```js
//   --cli                 no-API-key mode: shell out to a local subscription
//                         CLI instead of calling an OpenAI-compatible
//                         endpoint. api-key becomes optional when set.
//   --cli-tool <id>       which CLI: claude (default) | codex | gemini |
//                         opencode — see cli-adapters.mjs. Binary comes from
//                         LOOP_CLI_BIN (set by agent-spawner), else the
//                         tool's default name. LOOP_CLI_TIMEOUT_MS (25 min)
//                         and LOOP_CLI_HEARTBEAT_MS (30 s) tune the runner.
```

- [ ] **Step 5: Import the adapters**

At the top of `backend/llm-agent.mjs`, replace:

```js
import { readFile, writeFile, appendFile, rename } from "node:fs/promises";
```

with:

```js
import { readFile, writeFile, appendFile, rename, mkdir, rm } from "node:fs/promises";
import {
  CLI_DEFAULT_BINS,
  buildCliInvocation,
  readCliOutput,
  runCli,
} from "./cli-adapters.mjs";
```

- [ ] **Step 6: Replace the CLI call**

In `backend/llm-agent.mjs`, replace this whole block (inside `if (args.cli) {`):

```js
    const { spawnSync } = await import("node:child_process");
    const full =
      (systemPrompt ? systemPrompt + "\n\n---\n\n" : "") + userPrompt;
    const bin = process.env.LOOP_CLI_BIN || "claude";
    const r = spawnSync(bin, ["-p", full, "--output-format", "text"], {
      cwd: args.workdir,
      encoding: "utf8",
      timeout: 25 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
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
    text = (r.stdout || "").trim();
    process.stderr.write(
      `[${args.role}] CLI OK in ${Date.now() - t0}ms, ${text.length} chars\n`
    );
```

with:

```js
    const tool = args.cliTool || "claude";
    const full =
      (systemPrompt ? systemPrompt + "\n\n---\n\n" : "") + userPrompt;
    const loopDir = `${args.workdir}/.loop`;
    const lastMessageFile = `${loopDir}/${args.role}-cli-last-message.md`;
    let inv;
    try {
      inv = buildCliInvocation(tool, { prompt: full, model: args.model, lastMessageFile });
    } catch (err) {
      process.stderr.write(`llm-agent: FAIL: ${err.message}\n`);
      process.exit(2);
    }
    // A previous attempt's last-message file must never be mistaken for
    // this run's answer.
    await mkdir(loopDir, { recursive: true });
    await rm(lastMessageFile, { force: true });
    const bin = process.env.LOOP_CLI_BIN || CLI_DEFAULT_BINS[tool];
    const timeoutMs = Number(process.env.LOOP_CLI_TIMEOUT_MS || 25 * 60_000);
    const r = await runCli(bin, inv, {
      cwd: args.workdir,
      timeoutMs,
      heartbeatMs: Number(process.env.LOOP_CLI_HEARTBEAT_MS || 30_000),
      onHeartbeat: (ms) =>
        process.stderr.write(
          `[${args.role}] waiting on ${tool} CLI… ${Math.round(ms / 1000)}s\n`
        ),
    });
    if (r.error) {
      process.stderr.write(
        `llm-agent: FAIL: local CLI spawn error: ${r.error.message}\n`
      );
      process.exit(1);
    }
    if (r.status !== 0) {
      const why = r.timedOut ? ` (timed out after ${Math.round(timeoutMs / 1000)}s)` : "";
      process.stderr.write(
        `llm-agent: FAIL: local CLI exit ${r.status}${why}: ${(r.stderr || "").slice(0, 300)}\n`
      );
      process.exit(1);
    }
    text = await readCliOutput(inv, r.stdout);
    process.stderr.write(
      `[${args.role}] CLI OK in ${Date.now() - t0}ms, ${text.length} chars (${tool})\n`
    );
```

Leave the verifier STATE.md scaffold/append block that follows unchanged.

- [ ] **Step 7: Run the new and the existing CLI tests**

```bash
cd backend && npx vitest run src/loop/__tests__/llm-agent-cli-tools.test.ts src/loop/__tests__/llm-agent-cli.test.ts
```

Expected: PASS. 8 new tests plus all 7 existing ones, with no edits to `llm-agent-cli.test.ts`. If the existing ENOENT test fails, check that `runCli` resolves `{ error }` from the child's `error` event. Node reports a missing binary there, not as a thrown exception.

- [ ] **Step 8: Commit**

```bash
git add backend/llm-agent.mjs backend/src/loop/__tests__/llm-agent-cli-tools.test.ts backend/src/loop/__tests__/fixtures/cli-recorder-shim.sh backend/src/loop/__tests__/fixtures/cli-slow-shim.sh
git commit -m "feat(backend): llm-agent --cli-tool runs codex/gemini/opencode, stdin prompts, heartbeat"
```

---

### Task 7: Wire the connection's CLI into `agent-spawner.ts`

**Files:**
- Modify: `backend/src/loop/agent-spawner.ts` (imports; `spawnBridgeRunner` ~167-243)

`cliBridgeConfig` is already unit-tested (Task 3). This task only threads its result through.

- [ ] **Step 1: Import**

In `backend/src/loop/agent-spawner.ts`, directly after `import { spawnMavisBridge } from "./mavis-bridge.js";` add:

```ts
import { cliBridgeConfig } from "./cli-tools.js";
```

- [ ] **Step 2: Compute the CLI config**

Directly after the `useLocalCli` declaration (before the `useMavisCli` block), add:

```ts
  // Which subscription CLI + model + binary (see cli-tools.ts). Only used
  // when useLocalCli; computed here so args and env below stay in sync.
  const cli = useLocalCli ? cliBridgeConfig(connection, pickerModel) : null;
```

- [ ] **Step 3: Pass the CLI model instead of the API fallback model**

In the `args` array, replace:

```ts
    "--model",
    upstreamModel,
```

with:

```ts
    "--model",
    // CLI mode must never receive the API fallback model (z-ai/glm-5.2):
    // the CLI would reject it. "default" = the CLI's own default.
    cli ? cli.model : upstreamModel,
```

- [ ] **Step 4: Pass the tool and the binary**

Replace:

```ts
  if (useLocalCli) {
    args.push("--cli");
  }
```

with:

```ts
  if (cli) {
    args.push("--cli", "--cli-tool", cli.tool);
  }
```

In the `env` object, directly after `LOOP_BRIDGE: "1",` add:

```ts
    ...(cli ? { LOOP_CLI_BIN: cli.bin } : {}),
```

- [ ] **Step 5: Typecheck and run the full backend suite**

```bash
cd backend && npx tsc --noEmit && npx vitest run
```

Expected: no type errors; baseline 296 plus all new tests, with zero failures.

- [ ] **Step 6: Commit**

```bash
git add backend/src/loop/agent-spawner.ts
git commit -m "feat(backend): route local-cli connections to their chosen subscription CLI"
```

---

### Task 8: Honest health check for CLI connections

**Files:**
- Modify: `backend/src/api/connectionMeta.ts:82-98`
- Test: `backend/src/api/__tests__/connectionMeta-cli.test.ts` (create)

Today every `local-cli` connection reports "connected" even if the binary isn't installed. After this task the health dot is red with an actionable message, and the orchestrator's existing pre-flight re-test turns "CLI not installed" into a fast, named escalation instead of a crash mid-run.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/api/__tests__/connectionMeta-cli.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { testConnection } from "../connectionMeta.js";

const SHIM = resolve(process.cwd(), "src/loop/__tests__/fixtures/claude-shim.sh");
const base = { baseUrl: "http://localhost/local-cli" };

afterEach(() => {
  delete process.env.LOOP_CLI_BIN_CODEX;
  delete process.env.LOOP_CLI_BIN_CLAUDE;
});

describe("testConnection — local-cli", () => {
  it("is connected when the chosen CLI is installed", async () => {
    process.env.LOOP_CLI_BIN_CODEX = SHIM;
    const r = await testConnection({ ...base, providerType: "local-cli", cliTool: "codex" });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("connected");
    expect(r.message).toContain("Codex");
  });

  it("fails with an install/login hint when the CLI is missing", async () => {
    process.env.LOOP_CLI_BIN_CODEX = "/nonexistent/codex";
    const r = await testConnection({ ...base, providerType: "local-cli", cliTool: "codex" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.message).toContain("codex login");
  });

  it("probes claude for legacy local-cli connections with no cliTool", async () => {
    process.env.LOOP_CLI_BIN_CLAUDE = "/nonexistent/claude";
    const r = await testConnection({ ...base, providerType: "local-cli" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Claude Code");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd backend && npx vitest run src/api/__tests__/connectionMeta-cli.test.ts`
Expected: FAIL. `cliTool` isn't in the parameter type, and missing binaries still report connected.

- [ ] **Step 3: Implement**

In `backend/src/api/connectionMeta.ts`, change the `testConnection` parameter type from:

```ts
export async function testConnection(connection: {
  baseUrl: string;
  apiKey?: string;
  providerType: Connection["providerType"];
}): Promise<TestResult> {
```

to:

```ts
export async function testConnection(connection: {
  baseUrl: string;
  apiKey?: string;
  providerType: Connection["providerType"];
  cliTool?: Connection["cliTool"];
}): Promise<TestResult> {
```

Replace the whole `if (connection.providerType === "local-cli") { ... }` block with:

```ts
  if (connection.providerType === "local-cli") {
    // No network endpoint and no API key by design: the connection drives
    // a subscription CLI on this machine. "Healthy" = the CLI is installed.
    // `--version` spends no plan quota; login state surfaces on first use.
    const tool = cliToolOf(connection) ?? "claude";
    const meta = CLI_TOOLS[tool];
    const start = Date.now();
    const probe = await probeCliTool(tool);
    if (probe.ok) {
      return {
        ok: true,
        status: "connected",
        message: `${meta.label} CLI found (${probe.version}) — uses your logged-in subscription, no API key.`,
        latencyMs: Date.now() - start,
      };
    }
    return {
      ok: false,
      status: "failed",
      message: `${meta.label} CLI unavailable: ${probe.error}. Install it, then ${meta.loginHint}.`,
    };
  }
```

Add the import beside the file's other imports:

```ts
import { CLI_TOOLS, cliToolOf, probeCliTool } from "../loop/cli-tools.js";
```

- [ ] **Step 4: Run the tests, then the health-monitor tests**

```bash
cd backend && npx vitest run src/api/__tests__/connectionMeta-cli.test.ts src/loop/__tests__/connection-health.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/connectionMeta.ts backend/src/api/__tests__/connectionMeta-cli.test.ts
git commit -m "feat(backend): health check probes the connection's subscription CLI"
```

---

### Task 9: Opt-in failover onto subscription CLIs

**Files:**
- Modify: `backend/src/store/connections.ts:199-213` (`connectionsForRole`)
- Test: `backend/src/store/__tests__/connections-failover.test.ts` (create)

Subscription plans hit usage-window limits, and when they do the CLI exits nonzero. The orchestrator's existing failover (`pickFailoverTarget`, `orchestrator.ts:2599`) can then reroute the role to another plan, but only if that plan is a candidate. Today keyless connections never are. Make them candidates **only when dedicated to that role**, so failover never spends a plan the user didn't assign.

- [ ] **Step 1: Write the failing test**

Create `backend/src/store/__tests__/connections-failover.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { connectionsForRole, loadConnectionsFromDisk } from "../connections.js";
import type { Connection } from "../../types.js";

const now = new Date().toISOString();
const conn = (c: Partial<Connection> & Pick<Connection, "id" | "providerType">): Connection => ({
  name: c.id,
  baseUrl: "http://localhost/x",
  hasApiKey: Boolean(c.apiKey),
  createdAt: now,
  updatedAt: now,
  ...c,
});

describe("connectionsForRole — keyless CLI connections", () => {
  beforeEach(() => {
    loadConnectionsFromDisk([
      conn({ id: "api-general", providerType: "openai-compatible", apiKey: "sk-x", model: "m" }),
      conn({ id: "api-nokey", providerType: "openai-compatible", model: "m" }),
      conn({ id: "codex-impl", providerType: "local-cli", cliTool: "codex", model: "default", roles: ["implementation"] }),
      conn({ id: "claude-general", providerType: "local-cli", model: "opus" }),
      conn({ id: "mavis-general", providerType: "mavis-cli", model: "MiniMax-M2.7" }),
    ]);
  });

  it("includes a CLI connection for a role it is dedicated to, ahead of general API ones", () => {
    expect(connectionsForRole("implementation").map((c) => c.id)).toEqual([
      "codex-impl",
      "api-general",
    ]);
  });

  it("never offers undedicated CLI connections or key-less API connections", () => {
    expect(connectionsForRole("planning").map((c) => c.id)).toEqual(["api-general"]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd backend && npx vitest run src/store/__tests__/connections-failover.test.ts`
Expected: the first test FAILS (`codex-impl` is missing). The second already passes, which is intended: it pins today's behavior for undedicated connections.

- [ ] **Step 3: Implement**

In `backend/src/store/connections.ts`, replace:

```ts
  const all = listConnections().filter((c) => Boolean(c.apiKey));
```

with:

```ts
  // API connections need a key to authenticate. Keyless CLI connections
  // (subscriptions) qualify only when the user dedicated them to this
  // role — failover must never start spending a plan nobody assigned.
  const all = listConnections().filter((c) =>
    isKeylessProviderType(c.providerType)
      ? (c.roles ?? []).includes(role)
      : Boolean(c.apiKey)
  );
```

Update the doc comment's sentence "Connections without an API key are excluded" to: "API connections without a key are excluded; keyless CLI connections are included only for roles they're dedicated to."

Add the import beside the file's other imports:

```ts
import { isKeylessProviderType } from "../loop/cli-tools.js";
```

(`cli-tools.ts` imports only types and `node:child_process`, so there's no import cycle.)

- [ ] **Step 4: Run the test and the full suite**

```bash
cd backend && npx vitest run src/store/__tests__/connections-failover.test.ts && npx vitest run
```

Expected: PASS, with no regressions.

- [ ] **Step 5: Commit**

```bash
git add backend/src/store/connections.ts backend/src/store/__tests__/connections-failover.test.ts
git commit -m "feat(backend): role-dedicated subscription CLIs are failover candidates"
```

---

### Task 10: UI — one preset per subscription, modal sends `cliTool`

**Files:**
- Modify: `ui/src/types/loop.ts` (`ConnectionProviderId`, `Connection`, `UpsertConnectionBody`)
- Modify: `ui/src/lib/providerPresets.ts` (`ProviderPreset`, `local-cli` preset, new presets)
- Modify: `ui/src/components/NewConnectionModal.tsx` (props type, `handleSubmit`)
- Create: `ui/src/lib/providerPresets.test.ts`
- Create: `ui/src/components/NewConnectionModal.test.tsx`

- [ ] **Step 1: Write the failing tests**

`ui/src/lib/providerPresets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PROVIDER_PRESETS, presetFor } from "./providerPresets";

describe("subscription CLI presets", () => {
  const cli = PROVIDER_PRESETS.filter((p) => p.cliTool);

  it("offers one keyless local-cli preset per subscription CLI", () => {
    expect(cli.map((p) => p.cliTool).sort()).toEqual(["claude", "codex", "gemini", "opencode"]);
    for (const p of cli) {
      expect(p.providerType).toBe("local-cli");
      expect(p.noKey).toBe(true);
      // A model is required or the connection never shows in the role picker.
      expect(p.models.length).toBeGreaterThan(0);
    }
  });

  it("keeps the legacy local-cli id mapped to Claude", () => {
    expect(presetFor("local-cli").cliTool).toBe("claude");
  });

  it("keeps custom as the fallback (last) preset", () => {
    expect(presetFor(undefined).id).toBe("custom");
  });
});
```

`ui/src/components/NewConnectionModal.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewConnectionModal } from "./NewConnectionModal";

describe("NewConnectionModal — subscription CLI", () => {
  it("submits cliTool + local-cli + no key for the ChatGPT (Codex) preset", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewConnectionModal onClose={() => {}} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByDisplayValue("OpenRouter"), {
      target: { value: "codex-cli" },
    });
    // First text input in the form is the connection name.
    fireEvent.change(screen.getAllByRole("textbox")[0], {
      target: { value: "chatgpt-plus" },
    });
    fireEvent.click(screen.getByText("Save settings"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: "chatgpt-plus",
      providerId: "codex-cli",
      providerType: "local-cli",
      cliTool: "codex",
      model: "default",
      apiKey: undefined,
    });
  });
});
```

(`NewConnectionModal` is a named export: `NewConnectionModal.tsx:88`.)

- [ ] **Step 2: Run to confirm failure**

Run: `cd ui && npx vitest run src/lib/providerPresets.test.ts src/components/NewConnectionModal.test.tsx`
Expected: FAIL. No preset has `cliTool`, and the `codex-cli` option doesn't exist.

- [ ] **Step 3: Mirror the types**

In `ui/src/types/loop.ts`, extend `ConnectionProviderId` with `| "codex-cli" | "gemini-cli" | "opencode-cli"` (insert them after `"local-cli"`), and below that type add:

```ts
/** Which subscription CLI a `local-cli` connection drives (mirrors
 *  backend/src/types.ts). Absent = "claude". */
export type CliToolId = "claude" | "codex" | "gemini" | "opencode";
```

In both `Connection` and `UpsertConnectionBody`, directly after `providerType: ConnectionProviderType;`, add:

```ts
  /** Only meaningful when providerType === "local-cli". */
  cliTool?: CliToolId;
```

- [ ] **Step 4: Presets**

In `ui/src/lib/providerPresets.ts`, change the type import to:

```ts
import type { CliToolId, ConnectionProviderId, ConnectionProviderType } from "@/types/loop";
```

Add to the `ProviderPreset` interface, after `noKey?: boolean;`:

```ts
  /** Set for subscription-CLI presets: which local CLI the connection
   *  drives. The modal sends it as the connection's `cliTool`. */
  cliTool?: CliToolId;
```

Replace the entire existing `local-cli` preset object with these four. Keep the id `local-cli` for Claude so existing connections still open on the right preset:

```ts
  {
    id: "local-cli",
    name: "Claude Pro / Max (Claude Code CLI)",
    description:
      "Uses your Claude subscription through the official `claude` CLI on this machine — no API key. Install Claude Code and sign in once.",
    providerType: "local-cli",
    cliTool: "claude",
    defaultBaseUrl: "http://localhost/local-cli",
    endpointHint: "(not used — runs the local CLI)",
    apiKeyHint: "(not needed)",
    noKey: true,
    temperatureDefault: 0.7,
    models: [
      { id: "sonnet", label: "Claude Sonnet (latest)" },
      { id: "opus", label: "Claude Opus (latest)" },
      { id: "haiku", label: "Claude Haiku (latest)" },
    ],
  },
  {
    id: "codex-cli",
    name: "ChatGPT Plus / Pro (Codex CLI)",
    description:
      "Uses your ChatGPT subscription through OpenAI's official `codex` CLI — no API key. Install it and run `codex login` → Sign in with ChatGPT.",
    providerType: "local-cli",
    cliTool: "codex",
    defaultBaseUrl: "http://localhost/local-cli",
    endpointHint: "(not used — runs the local CLI)",
    apiKeyHint: "(not needed)",
    noKey: true,
    temperatureDefault: 0.7,
    models: [{ id: "default", label: "Codex default model" }],
  },
  {
    id: "gemini-cli",
    name: "Google account (Gemini CLI)",
    description:
      "Uses your Google account / Google AI plan through the official `gemini` CLI — no API key. Install it and choose Login with Google once.",
    providerType: "local-cli",
    cliTool: "gemini",
    defaultBaseUrl: "http://localhost/local-cli",
    endpointHint: "(not used — runs the local CLI)",
    apiKeyHint: "(not needed)",
    noKey: true,
    temperatureDefault: 0.7,
    models: [{ id: "default", label: "Gemini CLI default model" }],
  },
  {
    id: "opencode-cli",
    name: "OpenCode plan (OpenCode CLI)",
    description:
      "Uses whatever plan you've logged into `opencode` (OpenCode Go/Zen, GitHub Copilot, …) — no API key. Model ids are provider/model.",
    providerType: "local-cli",
    cliTool: "opencode",
    defaultBaseUrl: "http://localhost/local-cli",
    endpointHint: "(not used — runs the local CLI)",
    apiKeyHint: "(not needed)",
    noKey: true,
    temperatureDefault: 0.7,
    models: [
      { id: "default", label: "OpenCode default model" },
      { id: "opencode-go/minimax-m3", label: "MiniMax-M3 (OpenCode Go)" },
    ],
  },
```

The `custom` preset must stay **last** in the array, because `presetFor` falls back to the last entry.

- [ ] **Step 5: Modal sends `cliTool` and keeps free-text models**

In `ui/src/components/NewConnectionModal.tsx`:

1. In `NewConnectionModalProps["onSubmit"]`'s input type, after `providerType: Connection["providerType"];` add:

```ts
    cliTool?: Connection["cliTool"];
```

2. In `handleSubmit`, replace:

```ts
    const finalModel = useCustomModel ? customModel.trim() : model.trim();
```

with:

```ts
    // Presets with no curated models render the free-text input bound to
    // customModel, so read it there too (previously the typed id was lost).
    const finalModel =
      useCustomModel || preset.models.length === 0
        ? customModel.trim()
        : model.trim();
```

3. In the `onSubmit({...})` call, directly after `providerType: preset.providerType,` add:

```ts
        cliTool: preset.cliTool,
```

No change is needed in `ConnectionsPanel.tsx`: it passes `input` straight to `create`/`update`.

- [ ] **Step 6: Run the UI tests, typecheck, and build**

```bash
cd ui && npx vitest run && npm run build
```

Expected: all tests pass (31 baseline plus 4 new), and `tsc -b && vite build` exits 0.

- [ ] **Step 7: Commit**

```bash
git add ui/src/types/loop.ts ui/src/lib/providerPresets.ts ui/src/components/NewConnectionModal.tsx ui/src/lib/providerPresets.test.ts ui/src/components/NewConnectionModal.test.tsx
git commit -m "feat(ui): subscription CLI presets (Claude, ChatGPT/Codex, Gemini, OpenCode)"
```

---

### Task 11: Full regression pass

**Files:** none

- [ ] **Step 1: Backend**

```bash
cd backend && npx tsc --noEmit && npx vitest run
```

Expected: 0 type errors, 0 failures, and the test count is at least 296 plus the new tests.

- [ ] **Step 2: UI**

```bash
cd ui && npx vitest run && npm run build
```

Expected: 0 failures, and the build exits 0.

- [ ] **Step 3: Data dir untouched**

Re-run Task 1 Step 2, with the dev server stopped. Expected: `find` prints nothing.

---

### Task 12: Manual smoke test with real subscriptions (spends a little real quota)

Deliberately **not automated**. Every step spends real plan quota, so the user runs it, or explicitly OKs Claude running it.

- [ ] **Step 1: Log in to each CLI the user owns**

`claude` (sign in), `codex login`, `gemini` (Login with Google), `opencode auth login`. Each is a one-time interactive login done by the user.

- [ ] **Step 2: Restart the backend**

The `tsx watch` backend restarts on save and **kills in-flight loops**, so make sure no task is running first. Then restart the `loop-agent-backend` dev server.

- [ ] **Step 3: Create one connection per plan**

Go to Connections → Add, and pick each new preset. Suggested starting split (the user decides; change it freely):

| Role | Suggested plan | Why |
|---|---|---|
| Planning | Claude Pro/Max — `opus` | careful long-form reasoning for the plan |
| Implementation | ChatGPT Plus (Codex) — `default` | Codex is tuned for writing code |
| Review | Gemini CLI — `default` | a different model family catches different mistakes; generous free usage |

Tick the matching **Dedicated to** role on each connection, which also makes it a failover candidate for that role. Each health dot should turn green with "<CLI> CLI found (version)".

- [ ] **Step 4: Assign per role and run**

On the canvas, set each node's model (Planner / Maker / Verifier) to the matching connection, then run the fixture task from `docs/superpowers/plans/2026-07-18-mavis-cli-bridge.md` Task 8 Step 5 (recreate the `verify-loop` repo if it's gone).

Expected: the log shows `CLI OK … (claude)` for the planner, `(codex)` for the maker, `(gemini)` for the verifier, and `waiting on … CLI` heartbeats during long phases. The run ends with APPROVE or a REJECT that has real build/test numbers.

- [ ] **Step 5: Failover check (optional)**

Temporarily break the maker's CLI: edit the connection to the Gemini preset with model `nonexistent-model`, and dedicate a second connection to Implementation. Expected: the maker crashes, and the log shows a failover onto the second dedicated connection, not onto an undedicated plan.

---

## Self-review

- **Spec coverage:** use subscriptions without API → Tasks 2, 3, 5-7, 10. Up to N different plans → one connection per plan (Task 10 presets) with no limit on how many. Each role uses the plan it's best at → existing per-role model picker plus `roles` dedication, now reachable because CLI presets carry models (Task 10). Don't break anything → `cliTool` is optional and defaults to claude, mavis-cli is untouched, the existing CLI tests stay unchanged (Task 6 Step 7), full regression (Task 11), test data isolation (Task 1). Better ideas → opt-in plan failover (Task 9), honest health checks (Task 8), heartbeat vs the stall watchdog (Task 6).
- **Placeholder scan:** none. Every code step has full code. Flag drift is handled by Task 0 with a concrete edit location.
- **Type consistency:** `CliToolId`, `cliTool`, `isKeylessProviderType`, `cliToolOf`, `binForCliTool`, `cliBridgeConfig` → `{tool, model, bin}`, `probeCliTool` → `{ok, version | error}`, `CLI_TOOLS[id].{label, defaultBin, loginHint}` are used with the same names in Tasks 3, 4, 7, 8 and 9. `buildCliInvocation`, `readCliOutput`, `runCli` and `CLI_DEFAULT_BINS` match between Tasks 5 and 6.
