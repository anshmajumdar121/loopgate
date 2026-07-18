# Mavis CLI Bridge — Design Spec

**Date**: 2026-07-18
**Author**: brainstorming session with user
**Status**: Design approved. Ready for plan generation via `writing-plans` skill.

---

## 1. Overview

Add a new agent-spawner backend, `"mavis-cli"`, so Loop Agent's planner/maker/verifier roles can run through the user's local **MiniMax Code / Mavis daemon** (`minimax` CLI, already installed at `~/.mavis/bin/minimax`) instead of an HTTP API connection. This lets the user drive the loop with their MiniMax Pro subscription instead of paying per-token against a public API key.

**Why this is needed**: the two API connections available this session (NVIDIA NIM free tier, OpenRouter free tier) are slow and stalled a real run. The user has a MiniMax Pro subscription but no API key and doesn't want to pay per-token. Mavis's own auth to MiniMax is masked even in its own local config (`minimax config show` prints `apiKey: "****"`) — there is no key to copy into a normal HTTP connection. The only integration point is the `minimax` CLI itself.

**Constraint**: this must slot into the *existing* agent-spawner contract — same `outFile` write, same stall/escalate semantics the orchestrator already expects from `backend/src/loop/agent-spawner.ts`. No changes to the orchestrator, the parser, or the UI.

---

## 2. Goals & Non-Goals

### Goals
- A `mavis-cli`-typed connection (or `LOOP_MAVIS_CLI=1` env var, mirroring the existing `LOOP_LOCAL_CLI=1` escape hatch) routes an agent role's calls through the `minimax` CLI.
- One persistent Mavis agent per Loop Agent role (`loop-planner`, `loop-maker`, `loop-verifier`), created lazily and reused.
- Each LLM call becomes: `minimax session new <role-agent> --from root --prompt "<prompt>" --model minimax/MiniMax-M2.7` → poll `minimax session messages <sessionId>` until an assistant message with a `finish_reason` appears → write `msg_content` to `outFile`.
- Stall detection: no assistant message within ~300s → treat as stalled, one retry, then escalate (matching the existing planner stall/salvage pattern).
- `connectionProblemForTask` (the task-creation preflight check in `backend/src/api/tasks.ts`) recognizes `mavis-cli` connections as valid without requiring `apiKey`/`LOOP_LLM_API_KEY`.

### Non-Goals (v1)
- No UI changes — the model picker's "Your connections" list already renders whatever `providerType` a connection has; adding `mavis-cli` as a selectable type in the Add Connection form is in scope, but no new UI surface beyond that.
- No support for Mavis's child-session/spawn features (`--from <sessionId>`) — every call is a fresh root session.
- No handling yet for prompts near/over the ~256KB argv ceiling (same limitation the existing `claude -p` bridge has for API-key mode; flagged as a known follow-up, not solved here).
- No automatic cleanup/compression of old Mavis sessions after a task completes (they accumulate in Mavis's own session list; acceptable for v1, revisit if it becomes noisy).
- Not replacing or deprecating the existing `local-cli` (`claude -p`) path — both coexist as alternative no-API-key backends.

---

## 3. Architecture

### 3.1 Provider type
Extend the `providerType` enum (`backend/src/store/connections.ts`, `backend/src/api/connections.ts`) with `"mavis-cli"`, alongside the existing `"local-cli"`. A connection of this type needs no `apiKey`/`baseUrl` — just a `name` and optionally a `model` override (defaults to `minimax/MiniMax-M2.7`).

### 3.2 Spawn path
In `backend/src/loop/agent-spawner.ts`, alongside the existing `useLocalCli` check:

```ts
const useMavisCli =
  connection?.providerType === "mavis-cli" || process.env.LOOP_MAVIS_CLI === "1";
```

When `useMavisCli` is true, skip the existing `spawn(node, [LLM_AGENT_SCRIPT, ...args])` path entirely and instead spawn a small new bridge module (`backend/src/loop/mavis-bridge.ts`) that:

1. Resolves the Mavis binary path (`~/.mavis/bin/minimax`, overridable via `LOOP_MAVIS_BIN` env var for testability).
2. Ensures the role's persistent agent exists: run `minimax agent list --json` (need to confirm a `--json`/machine-readable flag exists; fall back to name-matching plain output if not), create via `minimax agent new <role-agent> --engine opencode --system-prompt "<role's existing system prompt>"` if missing.
3. Runs `minimax session new <role-agent> --from root --prompt "<full prompt>" --model <resolved model>`, captures the printed `sessionId` from its JSON output.
4. Polls `minimax session messages <sessionId>` every 3s (reusing the existing stall-detection clock: no new assistant message within ~300s → one retry of the poll loop, then propagate a stall exactly like the existing planner stall path in `orchestrator.ts`).
5. On success, writes the assistant message's `msg_content` to `outFile` in the same shape `llm-agent.mjs` already writes (so the downstream parser is untouched).
6. Surfaces `usage.total_tokens` into the same token-usage capture channel the existing bridge uses (`LOOP_MODEL_ID`/`LOOP_CONNECTION_ID` env pattern), so cost/usage tracking stays consistent even though this path is subscription-billed, not pay-per-token.

### 3.3 Preflight check
In `backend/src/api/tasks.ts`, `connectionProblemForTask` currently only special-cases `model.startsWith("custom:")`. Add a branch: if the resolved connection's `providerType === "mavis-cli"`, skip the `apiKey` check entirely (no key ever exists for this path) — just confirm the connection still exists.

---

## 4. Error handling

- **Mavis daemon not running**: `minimax session new` will fail immediately (non-zero exit). Surface this as a clear log line + escalation reason ("Mavis daemon not running — run `minimax start`"), not a generic stall.
- **Agent creation race**: two roles could try to create the same lazily-created agent concurrently on a fresh install. Treat "agent already exists" errors from `agent new` as success, not failure.
- **Session poll timeout**: reuse the existing planner stall/salvage pattern verbatim (stall once → retry once → escalate on second stall) rather than inventing new semantics.

---

## 5. Testing

- Unit test `mavis-bridge.ts`'s message-polling logic against a fake `minimax` binary (shell script fixture, same pattern as the existing `claude-shim*.sh` fixtures used for `local-cli` tests) — covers: normal completion, stall-then-recover, stall-twice-then-escalate, daemon-not-running.
- No live-account integration test (that would spend the user's real subscription quota on every CI run) — mirrors how the existing `local-cli` tests use a shim instead of a real `claude` login.
