# Loop Agent audit: from code loop to general loop/graph engine

**Date:** 2026-10-10
**Acceptance scenario:** "Here is a podcast link, a skill (`viral-clip-shorts`), and a reference video. Deliver finished, animated vertical Shorts while I watch progress live." Every flaw below is ranked by how much it blocks that scenario.

## Verdict

Today Loop Agent is a **fixed, code-oriented plan → make → verify loop whose agents cannot act**. Agents return text, a regex turns it into files, and a text-only verifier judges the diff. It can produce a small web page. It cannot download, run ffmpeg/python, render or check a video, or show one to you. The canvas *looks* like a graph editor, but edits are cosmetic.

## Critical (blocks the scenario)

| # | Flaw | Evidence |
|---|---|---|
| C1 | **No execution layer.** Maker and verifier are single-shot completions with tools stripped ("You DO NOT have access to … bash"). Output is ```` ```file:path ```` blocks; the Diff Summary is fabricated ("Build: n/a — static files"). | `backend/llm-agent.mjs:142-176, 366, 479-524` |
| C2 | **The subscription-bridge plan makes C1 permanent.** Every adapter runs its CLI *read-only*, so Claude/ChatGPT/Gemini subscriptions could still only emit text. None of it is implemented yet. | `docs/superpowers/plans/2026-10-10-subscription-cli-bridges.md:36` |
| C3 | **The graph isn't a graph.** One 1,540-line `runLoop` with two hardcoded `while(true)` loops. No node/edge model, no branches, no sub-loops, no fan-out. Only one task can be active (409). | `orchestrator.ts:508-2048, 697, 936`; `api/tasks.ts:129`; `agent-spawner.ts:429` |
| C4 | **Canvas is static and cosmetic.** Nodes and edges are hardcoded; user edits never reach the backend and get overwritten at runtime. | `ui/src/data/workflow.ts:93-280`; `store.ts:261, 403-523` |
| C5 | **No artifacts.** No route to list, serve, or download outputs; the server buffers whole responses; no `<video>` anywhere in the UI. The preview pill assumes `index.html` and has no Range support. | `backend/src/index.ts:46-76`; `preview-server.ts:82` |
| C6 | **Verifier can't judge media.** It reads changed files as utf8 (50 KB cap). The Playwright screenshot is never shown to a model. There is no frames/audio/reference comparison. | `orchestrator.ts:2446-2556` |
| C7 | **Inputs are text only.** No URL field, no upload, no skill picker. "Reference files" are inlined text (20 KB each, 60 KB total). Chat "Attach" sends only the filename. | `NewTaskModal.tsx:85`; `ChatbotNode.tsx:266` |
| C8 | **Monitoring breaks on reload.** No active-task restore, logs forced to `[]`, no event replay after a socket drop. There are no per-step progress, percent, or ETA events. | `store.ts:208, 334`; `useLoopSocket.ts:190` |

## High

- **H1. Restart strands tasks.** They are reset to `plan_review`/`draft` and nothing restarts them. `confirm-plan` returns ok with no waiter, and the stranded task 409s every new task. `tsx watch` kills runs on any edit. (`persistence.ts:195-229`, `api/tasks.ts:244`)
- **H2. Stall watchdog kills healthy planners.** The limit is 4 min, but the planner is non-streaming and takes 150–300 s+. The maker isn't covered at all. (`orchestrator.ts:201, 225, 249`)
- **H3. A partial verdict is accepted as final.** The phase ends after about 550 ms of file quiet mid-stream. (`state-sync.ts:135, 189`)
- **H4. Blocking `spawnSync` in the server.** Mavis polls every 3 s with no timeout and freezes HTTP and WebSocket. (`mavis-bridge.ts:15, 71, 210`)
- **H5. Silent fake success.** A missing `opencode` binary switches to mock agents, which fabricate APPROVE. (`agent-spawner.ts:439, 1291`)
- **H6. Security.** The server binds `0.0.0.0` with no auth, API keys are passed in argv (visible in `ps`), and LLM-written `package.json` scripts run unsandboxed. (`index.ts:89`, `agent-spawner.ts:208`, `build-runner.ts:49`)
- **H7. Domain hardcoding inside the engine.** The script loop (F1–F7, `/7`, "REJECT ≥7 ships"), the web-prototype path (`index.html` fallback, parse5, Playwright), and code-only prompts ("npm test"). (`orchestrator.ts:125-193, 1282-1412, 1910-2023`)

## Medium

- No best-so-far restore: the workdir keeps the *last* attempt, not the best one.
- The maker never sees its previous files and must regenerate everything (8 K token cap).
- Re-prompt burns the attempt budget. A non-script REJECT waits forever for feedback. There are no time, token, or quota caps.
- Errors are swallowed across the loop (empty `catch {}`, build crash ignored, chokidar errors dropped).
- Dead controls: Pause = Stop, the Mic toggles pause, Settings/Bell/Escalate do nothing, and chatbot replies are canned.
- Token and cost data are global only, never per task. The CLI path reports no usage at all.

## Missing (not asked for, but needed)

1. **Reusable loop recipes.** Save a graph and its skill once, then run it on new inputs ("Shorts from link").
2. **Approval gates as nodes.** Examples: "download 14 min, OK?" and "is this footage cleared for clipping?" (the skill's rights rule).
3. **Budgets.** Wall-clock, attempts, and per-subscription run caps, since CLIs don't expose quota.
4. **Batch queue.** Several episodes, or several clips in parallel.
5. **Done notifications** (desktop or phone) for long unattended runs.
6. **Event log as the source of truth**, which gives resume, replay, and audit in one mechanism.

## Target architecture

```
Recipe (graph spec: nodes + edges + skill + budgets)
   │
   ▼
Graph runner ── append-only event log (persisted) ──► WebSocket ──► Canvas (rendered FROM the spec)
   │                                                               Outputs gallery (video/audio/img)
   ├─ agent node  → tool-using CLI agent (claude / codex / gemini / opencode / mavis)
   │                in a per-task workspace, scoped permissions, streaming JSON → live progress
   ├─ tool node   → deterministic command (yt-dlp, ffmpeg, ffprobe, qa.sh)
   ├─ check node  → deterministic checks + vision-model review against the reference/rubric
   ├─ gate node   → human approval
   └─ loop edge   → retry with feedback until pass / score ≥ X / budget; restores best-so-far
```

- **Agent runtime.** Each subscription CLI runs in *agentic* mode inside the task workspace. Permissions are scoped to that folder plus an allowlisted command set, and output streams as JSON. Never `--yolo` outside the workspace. This keeps the compliance rule from the bridge plan (official CLI, user's own login, no token scraping) and drops the read-only restriction.
- **Skills are first-class.** A recipe references a SKILL.md, and its `scripts/` and `reference/` become workspace inputs.
- **The existing loop becomes a recipe.** planner → maker → verifier is shipped as the default "code" recipe. The script loop and web prototype become recipes too, taken out of `runLoop`.

## Phased roadmap

| Phase | Scope | Proves |
|---|---|---|
| 0. Stop the bleeding | Bind localhost; pass keys via env; make Mavis async; fix restart recovery; fix the watchdog and partial-verdict bugs; no mock fallback. | The current loop is trustworthy. |
| 1. Events + artifacts | Persisted event log; reload/reconnect hydration; `progress`/`artifact` events; Range file route; Outputs panel with player and download. | You can watch and receive results. |
| 2. Agentic bridges | Rewrite the bridge plan: CLIs in workspace-scoped agentic mode with streaming. Reuse plan Tasks 1, 4 and 10 as-is. | Subscriptions can actually *do* work. |
| 3. Graph engine | Recipe spec, runner, canvas rendered from the spec, loop edges with best-so-far, gates, budgets. | Loop/graph engineering. |
| 4. Media acceptance | URL + upload inputs, skill picker, media check nodes (ffprobe, frame sheet, vision review vs reference), "Shorts from podcast" recipe, end-to-end run. | The acceptance scenario. |
