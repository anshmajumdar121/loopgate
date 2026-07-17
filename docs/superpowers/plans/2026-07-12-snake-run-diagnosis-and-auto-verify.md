# Why the Snake game took 5 tries — full diagnosis + auto-verify connections spec

Date: 2026-07-12. Runs analyzed: v1 `yU4WZB4WoAae`, v2 `MXd-pIvTabi2`, v3 `BCVVr3bPWtGD`, v4 `x2EEzsi0zOWV`, v5 `so06eZ2zvOS8` (success — preview at `http://localhost:3210/t/so06eZ2zvOS8/`).

**The one-line answer: the orchestrator code worked correctly every time. All five delays/failures were caused by the model connections (flaky endpoint, non-compliant free model, very slow model) plus a few small orchestrator gaps that made those provider problems expensive instead of cheap.**

---

## Part A — What actually happened, version by version

| Run | Result | Time lost | Root cause | Whose fault |
|---|---|---|---|---|
| v1 | Crashed in 2s: "Missing api key" | ~0 | Task was submitted with no `modelOverrides`, and the loop has **no default connection fallback** — `llm-agent.mjs:107` requires `--api-key` or `LOOP_LLM_API_KEY`, and `resolveSpawnTarget` (orchestrator.ts) returns `connection: null` when no model id is set. | Orchestrator gap #1 |
| v2 | Planner OK (137s) but plan had 0 completion criteria → auto re-plan → re-plan call went silent twice (240s + 240s) → escalated | ~10.5 min | (a) First planner output omitted `## Completion Criteria` — the prompt template doesn't force it hard enough; (b) the **NVIDIA NIM endpoint** (`integrate.api.nvidia.com`, minimax-m3) intermittently returns nothing at all; (c) the stall re-invoke retries the **same dead connection**. | Provider + gaps #2, #3 |
| v3 | Planner went silent twice on the very first call → escalated | ~8 min | Same NIM endpoint flakiness. The watchdog worked exactly as designed (4 min detect → re-invoke → 4 min → escalate); without it this would have been a 40-minute hang. | Provider |
| v4 | Planner OK in 60s (OpenRouter `tencent/hy3:free`, 10 criteria) → maker crashed: "Failed to process successful response" | ~3 min | That error string is **not in your code** — it comes from the AI SDK inside `llm-agent.mjs`. The free tencent model returned a malformed/non-standard streaming response the SDK could not parse. Classic free-tier behavior on longer generations. | Provider |
| v5 | **Worked.** Planner 72s (tencent) → maker 602s (NIM minimax-m3) → validation ✓ → build ✓ → runtime check ✓ (0 errors) → preview link → verifier REJECT "0/0 criteria pass" | maker alone: 10 min | Success, with two leftover issues: (a) **the maker took 10 minutes** to emit one 6.7KB file — minimax-m3 is a reasoning model on a free NIM tier with very low tokens/sec; (b) the verifier verdict parsed as **"0/0 criteria pass"** — the criteria walk came back empty, a verifier prompt/parse mismatch (gap #4), so it REJECTed a page the runtime check had already proven clean. | Provider speed + gap #4 |

Also observed in v5: `build exit NaN` in the maker's diff log line (gap #5), and the task wrote `index.html` directly into `Loop Agent/backend/` because no per-task workdir is created when the API caller omits one (gap #6) — which is also why the build-runner ran the *backend's own* build/test scripts instead of the game's.

## Part B — The real problem, summarized

1. **~80% of the lost time was the model connections, not the loop.**
   - NIM (`minimax-m3`) randomly goes completely silent → killed v2 and v3.
   - `tencent/hy3:free` returns SDK-breaking responses on longer generations → killed v4.
   - `minimax-m3` generates at free-tier speed → made v5's maker take 10 minutes.
2. **The orchestrator's safety nets all fired correctly** (key-check fail-fast, criteria gate, stall watchdog ×3, validation, build-runner, runtime check, preview registration). What it lacks is *avoidance*: it retries the same bad connection instead of routing around it, and it can't tell a connection is dead until it has already burned a 4-minute stall window.

## Part C — Fix list you can do yourself, ordered by impact

1. **Get one reliable, fast connection and use it for all three roles.** A paid endpoint (Anthropic Haiku, GPT-4o-mini, or any provider with real SLAs) would make every run look like: plan ~30s → make ~60s → verify ~20s. This single change removes the v2/v3/v4 failure classes entirely and cuts v5's 12.5 minutes to ~2. Everything below is secondary to this.
2. **Connection failover on stall/crash (orchestrator.ts).** Where the stall watchdog currently re-invokes the same connection (verifier block ~line 1065; planner block from commit `48c6150`), first pick a *different* healthy connection serving the same role (from the connections store), and only escalate if none exists. Apply the same failover to the v4-style SDK-crash path.
3. **Fix the verifier "0/0 criteria pass" false-reject (gap #4).** Check the verifier prompt template and the verdict parser (`backend/src/loop/parser.ts`): the verifier must be forced to emit one line per criterion in the exact format the parser expects — same trick that fixed the planner in v3→v4 (an explicit "MUST include" instruction), plus an auto-retry when the criteria walk parses empty. Right now an empty walk becomes REJECT "0/0" even when the runtime check passed.
4. **Default per-task workdir (gap #6).** In `createTask` (backend/src/store/tasks.ts), when `workdir` is missing, create something like `~/LoopAgent-workspaces/<taskId>/` instead of defaulting to the backend folder. Prevents prototypes landing inside your orchestrator's source tree and stops the build-runner from building the backend itself.
5. **`build exit NaN` (gap #5).** The maker diff-summary parse yields `NaN` when the maker doesn't state a build exit; default it to null and display "n/a". Cosmetic, but it pollutes logs and history lines.
6. **Fail task creation loudly when no connection resolves (gap #1).** In `POST /api/tasks`, if neither `model` nor role overrides resolve to a connection with a key, return 400 with "no connection configured for planner/maker/verifier" instead of letting the planner crash two seconds later.

## Part D — Auto-verify connections (the feature you asked for)

You already have the machinery: `POST /api/connections/:id/test` (backend/src/api/connectionMeta.ts:31) is exactly what the manual "Verify" / "Verify all" buttons in ConnectionsPanel.tsx call. Automation means calling it without you. Spec:

### D1. Backend — health monitor (new file `backend/src/loop/connection-health.ts`)
- On backend startup: test every connection once, in parallel.
- Repeat every `CONN_HEALTH_INTERVAL_MS` (default 5 min, env-overridable).
- Re-test immediately whenever a connection is created or updated (hook the POST/PUT handlers in connections.ts).
- Store on each connection record (additive optional field only): `health?: { ok: boolean; latencyMs?: number; error?: string; checkedAt: string }` (ISO-8601 timestamp).
- Broadcast a `connection_health` WS message on every status change so the UI updates live.
- **Pre-flight check:** in the orchestrator, before spawning any agent, if the chosen connection's last health is `ok: false` or older than the interval, re-test first; on failure, fail over (Part C #2) or escalate with "connection <name> is unhealthy: <error>" instead of burning a 4-minute stall.

### D2. UI — ConnectionsPanel additions (additive)
- Live status dot per connection: green (ok), red (failed — error text on hover), gray (never checked), amber (checking), plus a "checked 2m ago" label.
- Keep the manual Verify / Verify-all buttons exactly as they are (they become a force-refresh).
- Small settings row: auto-verify on/off toggle + interval selector (1m / 5m / 15m), persisted in the existing settings store.

### D3. Acceptance criteria
- Backend restart → every connection shows a fresh status within ~10s, zero clicks.
- Revoke an API key → within one interval its dot turns red, and a task submitted against it fails fast at pre-flight with the connection name in the reason, instead of a silent 4-minute stall.
- All existing manual verify behavior unchanged (additive only, per the standing no-deletion rule).

### D4. Ready-to-run prompt (feed this to your loop or any coding agent)
"In /Users/anshmajumdar/Desktop/Loop Agent, implement automatic connection health checks: new backend/src/loop/connection-health.ts that runs the POST /api/connections/:id/test logic for every connection on startup, every 5 minutes (env CONN_HEALTH_INTERVAL_MS), and on connection create/update; store optional health {ok, latencyMs, error, checkedAt} on the connection record; broadcast connection_health over the existing WS; add an orchestrator pre-flight that re-tests a stale or unhealthy connection before spawning any agent and escalates with the connection name on failure; in the UI, ConnectionsPanel gets a live status dot per connection + last-checked label + an auto-verify toggle and interval selector. ADDITIVE ONLY — do not remove or change the manual Verify/Verify-all buttons or any existing field, endpoint, or WS message type. New fields must be optional so old data loads unchanged. Add tests for: startup sweep, interval re-check, re-check on connection update, and the pre-flight failure path."
