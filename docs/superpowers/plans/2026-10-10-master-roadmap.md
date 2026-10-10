# Loop Agent — Master Roadmap (UI + Backend)

> **For agentic workers:** this is the index, not an executable plan. Execute the per-phase plans it links to, in order, with superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Each phase must pass its gate before the next phase's plan is written or started.

**Goal:** Turn Loop Agent from a code-only plan → make → verify loop into a general loop/graph engine. The acceptance test: you hand it a job ("this podcast link + this skill + this reference → finished Shorts"), watch it work live, and get playable final outputs. The UI keeps its current look and quality throughout.

**Source of truth for the problems:** `docs/superpowers/specs/2026-10-10-loop-engine-audit.md` (findings C1–C8, H1–H7).
**Decisions already made by the owner (2026-10-10):**
- Evolve in phases; no rewrite.
- Support all four subscription CLIs: claude, codex, gemini and opencode, plus the existing mavis.
- The owner describes the job, AI drafts the recipe graph, and the owner tweaks it on the canvas.

---

## Principles (apply to every phase)

1. **Keep the look.** All new UI follows the style contract in the Phase 1 plan:
   - zinc palette with `dark:` pairs, Inter, 12.5 px body / 11 px uppercase section labels;
   - the violet accent `#7c4dff` (Tailwind `accent-*` from Phase 1 Task 6), emerald/amber for status;
   - lucide icons at 14–16 px, existing keyframes only.
   No new design system and no new UI library.
2. **Generic engine, domain in recipes.** No new special cases inside `runLoop`. Podcast/shorts, web prototype and script optimisation all become recipes (Phase 3).
3. **TDD, small commits.** Every task writes its failing test first. One commit per task.
4. **Subscriptions only through official CLIs.** Use each CLI under the owner's own login. Never scrape tokens and never automate chat websites.
5. **Agents act inside a sandboxed workspace.** Tools are allowed in the task folder. Nothing outside it, and never `--yolo` / `--dangerously-skip-permissions` outside it.
6. **Prove it in the browser.** Every phase ends with a browser check (light and dark) and screenshots, not just green tests.

---

## Phases

| # | Phase | Plan | Status | Fixes | Gate to pass before the next phase |
|---|---|---|---|---|---|
| 0 | Stop the bleeding | [`2026-10-10-phase0-stop-the-bleeding.md`](2026-10-10-phase0-stop-the-bleeding.md) | Planned | H1–H6 | Backend binds to 127.0.0.1. A restart doesn't strand tasks. No mock fallback. All tests pass. |
| 1 | Live monitoring & outputs | [`2026-10-10-phase1-live-monitoring-and-outputs.md`](2026-10-10-phase1-live-monitoring-and-outputs.md) | Planned | C5, C8, dead controls, accent colours, silent UI errors | An MP4 in a task folder plays and seeks (206) in the Outputs panel. A reload mid-run reopens the task with logs. Failed actions show toasts. |
| 2 | Agentic subscription bridges | write when Phase 1 passes | Outline below | C1, C2, H6 (build sandbox) | A maker on each installed CLI runs a shell command in its workspace and streams progress to the canvas |
| 3 | Graph engine & recipes | write when Phase 2 passes | Outline below | C3, C4, H7, best-so-far, budgets | The existing loop runs as the built-in "code" recipe. A user-edited graph changes what the backend runs. |
| 4 | Media inputs & acceptance run | write when Phase 3 passes | Outline below | C6, C7 | Podcast link + `viral-clip-shorts` skill + reference → N rendered Shorts, played in the UI |

**Work in progress elsewhere:** branch `perf/task-list-summary` (task-list summaries) is still open. Its HEAD commit `f812f7b` breaks the UI build, and Phase 1 Task 0 restores it. Merge or rebase that branch before starting Phase 0, so the phases build on one line of history.

---

## Phase 2 outline: Agentic subscription bridges

This replaces the read-only design in `2026-10-10-subscription-cli-bridges.md`. Reuse that plan's Task 1 (test data dir; already folded into Phase 0), Task 4 (one keyless rule) and Task 10 (model picker and preset fixes) unchanged.

**Backend**
- `backend/src/loop/cli-tools.ts`: a registry for claude, codex, gemini and opencode. Each entry has:
  - the binary and its version probe;
  - the agentic flags, scoped to the workspace;
  - the streaming-JSON output flag;
  - an event parser that maps CLI stream events to `log` and `__LOOP_PROGRESS__`.

  Run Task 0 first: confirm every flag with `<cli> --help` on this machine, and install codex/gemini only after the owner says so.
- `backend/src/loop/agent-runner.ts`: one async runner for all CLIs. It feeds the prompt over stdin, writes a heartbeat, and stops on kill or timeout. The verdict and file output come from the CLI's final message, *and* from the files the agent actually wrote. The fabricated Diff Summary goes away.
- Workspace sandbox:
  - the agent's cwd is the task folder;
  - permission flags allow tools only there;
  - a command allowlist file per recipe (Phase 3 makes it recipe-driven; Phase 2 ships a default list of ffmpeg, ffprobe, yt-dlp, python3, node, npm and git);
  - `build-runner.ts` runs inside the same restrictions.
- Quota guard: a per-connection runs-per-hour cap and a wall-clock cap, shown in Connections. The CLIs don't expose remaining quota.

**UI**
- One provider preset per CLI, with a health badge driven by the version probe plus a login check.
- Each role's model picker lists the CLI connections.
- A "What can this agent do?" disclosure on the node panel, listing the allowed tools.

**Gate:** on each installed CLI, a maker creates `out/hello.txt` with a shell command. Its progress lines appear on the canvas, and the file appears in Outputs.

---

## Phase 3 outline: Graph engine & recipes

**Backend**
- `backend/src/graph/spec.ts`: a zod schema for a recipe.
  - Nodes: `agent`, `tool`, `check`, `gate` and `loop`, each with inputs, outputs and a retry policy.
  - Edges: with conditions such as pass, fail and `score >= x`.
  - Recipe-level fields: budgets, skill reference, command allowlist.
- `backend/src/graph/runner.ts`: executes a spec.
  - It is event-sourced: an append-only `events/<taskId>.jsonl` gives resume after a crash and replay on reconnect, replacing Phase 1's snapshot resync.
  - It supports parallel fan-out.
  - Loop edges keep the best-so-far snapshot of the workdir and can restore it.
- `backend/src/graph/recipes/`:
  - `code.json` (today's planner → maker → verifier);
  - `script.json` (today's script loop, moved out of `runLoop`);
  - `web-prototype.json` (Playwright runtime check as a `check` node).

  `runLoop` becomes a thin adapter that runs `code.json`, then is deleted once parity tests pass.
- Recipe drafting: a `planner`-style agent turns the owner's description into a spec. It is validated by the zod schema and shown for approval, which replaces plan review.

**UI**
- The canvas is rendered from the task's spec. `data/workflow.ts` remains only as the code recipe's layout seed.
- Canvas editing (add node, connect, delete, node settings) edits the spec, and the backend runs exactly that spec.
- A recipe library in the sidebar: save, duplicate and run on new inputs.
- Gate nodes render as an approval card in the side panel.

**Gate:** existing tests pass unchanged against the `code` recipe. Adding a `check` node on the canvas changes the next run's behaviour.

---

## Phase 4 outline: Media inputs & acceptance run

**Backend**
- Inputs:
  - URL fields;
  - file upload into `<workdir>/inputs/` (streaming, with a size cap);
  - a skill picker that copies a skill's `SKILL.md`, `scripts/` and `reference/` into the workspace.
- Media check nodes:
  - `ffprobe` (duration, resolution, audio present);
  - a frame-sheet generator;
  - a vision-model review against the reference and the skill's rubric, with a score fed to the loop edge.
- The "Shorts from podcast" recipe: transcript → candidates → approval gate (download minutes and rights) → section download → render → QA check → publish pack.

**UI**
- The New Task modal gains a URL field, file drop, skill picker and recipe picker. The chat Attach button actually uploads.
- Outputs gains a side-by-side "reference vs. result" view for video.
- A desktop notification fires on done or escalation.

**Gate (the owner's acceptance test):** podcast link + `viral-clip-shorts` + reference → the requested number of Shorts, each playable in Outputs, with a publish pack. The whole run is watchable live, and nothing is hardcoded outside the recipe.
