# Loopgate — a loop orchestrator you can actually trust with repetitive work

> Delegate 'the same step, N times' to AI - every item is planned, made and independently verified, with guarantees enforced in code, not prompts.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](#quick-start)
[![trust scoreboard 11/11](https://img.shields.io/badge/trust%20scoreboard-11%2F11-brightgreen.svg)](#why-its-different-guarantees-enforced-in-code-not-in-prompts)

[![Loopgate demo: a batch of landing pages planned, made and verified item by item](docs/media/loopgate-demo.gif)](docs/media/loopgate-demo.mp4)

▶ **[Watch the full demo (MP4, 1 min 55 s, 1080p)](docs/media/loopgate-demo.mp4)**: a 4-item batch from the real UI, the verifier's results, and the 11/11 trust scoreboard. The GIF above plays at 3x speed.

## Try it in 60 seconds (no API key, no network)

```bash
cd backend && npm install && npm run demo:stack    # fake LLM + isolated backend + UI
# then open http://localhost:5174
npm run demo:trust                                 # the attack scoreboard
```

`npm install` needs the network once; the demo itself makes no network or paid API calls.

**Use your existing subscription.** A connection can be an OpenAI- or Anthropic-compatible
API, the local `claude` CLI (your Claude Code login, no API key needed) or the Mavis CLI.

---

**Delegate the job that is "the same step, N times."** Describe it once as a
template, hand Loopgate the list, and it runs every item through its own
**plan → make → independent verify** loop. Rejections feed back into the next
attempt automatically. Items that can't converge are escalated, and the rest
keep going. A crash in the middle resumes where it left off.

```
"Build a landing page for {{item}}"   ×   Acme Coffee · Nimbus Cloud · FAIL-ME Corp · Orbit Bikes
                         │
          ┌──────────────┴──────────────┐  Map node: one checkpointed loop per item
          ▼                             ▼
   ┌─────────────┐   ┌─────────────┐   ┌──────────────────────┐
   │   Planner   │──▶│    Maker    │──▶│ Verifier (independent)│──▶ APPROVE ─▶ next item
   └─────────────┘   └─────────────┘   └──────────────────────┘
          ▲                 │ writes pass the policy gate  │ REJECT + required fixes
          └─────────────────┴──────────── auto-iterate ◀────┘  (max attempts → escalate)
```

## Why it's different: guarantees enforced in code, not in prompts

Most agent loops tell the model "don't touch `.env`" and "the verifier decides"
and then hope. We audited this project's original loop and broke every one of
those promises. Each guarantee below is now enforced in code and proven by an
automated attack scoreboard (`npm run demo:trust`):

| Guarantee | How it's enforced | Proof |
|---|---|---|
| One malformed request can't kill the server | crash boundary + process guards (`src/http/`) | `GET //[` → 400, server stays up |
| No unbounded memory from requests | 10 MB body cap, 1 MB WS frames, 200-client cap | 20 MB POST → 413 |
| No LAN / DNS-rebinding / cross-site access | 127.0.0.1 bind, Host + Origin allowlist, WS `verifyClient` | foreign Host → 421, cross-origin WS → 403 |
| **"REJECT — cannot approve" is never an approval** | strict verdict parser: only the leading keyword counts, unknown → REJECT | live loop ends REJECT, not DONE |
| **An APPROVE that contradicts its own checklist is rejected** | approval gate: Scope/Intent/No-cheating FAIL, HIGH risk, failed tests/criteria → REJECT | live loop |
| **The maker can't approve its own work** | verdict read only from text the verifier appended; attempt number checked | forged verdict → escalated |
| **The maker can't write outside the plan** | write policy in the bridge: reserved orchestrator files, binding denylist, `GOAL.md → Files to touch` allowlist | `.env`, `package.json`, `auth/**` blocked |
| **Repetitive work survives crashes** | per-item checkpoints, boot-time resume | hard kill mid-batch → resumes, finished items not redone |
| No silent fake agents | mocks require `LOOP_ALLOW_MOCK=1`; the LLM bridge no longer depends on the `opencode` binary | — |
| API keys stay put | key in child env (not argv), never returned over the API; changing a connection's URL requires re-entering its key | tests |

```
$ cd backend && npm run demo:trust
PASS One malformed request can't kill the server (GET //[)
PASS Oversized request body is refused (20 MB → 413)
PASS Foreign Host header is rejected (DNS-rebinding guard)
PASS Cross-origin WebSocket is refused
PASS Happy path: plan → make → verify → approved
PASS "REJECT — cannot approve" is NOT treated as approval
PASS Contradictory APPROVE (Scope: FAIL) is downgraded to REJECT
PASS Maker cannot forge the verifier's verdict
PASS Denylisted / unplanned writes are blocked (.env, package.json, auth/**)
PASS Batch: 4 items loop autonomously; a failing item escalates, others finish
PASS Batch survives a hard kill mid-run and resumes without redoing finished items
11/11 guarantees hold
```

The scoreboard boots an **isolated** backend with temp data dirs against a
deterministic fake LLM. It never touches your data and makes no paid API calls.

## Quick start

Requires Node 20+. Verified tonight on Node 24 + Windows 11; macOS was the original development platform.

```bash
cd backend && npm install && npm run dev      # API on 127.0.0.1:3001
cd ui && npm install && npm run dev           # UI on http://localhost:5173
```

Add a connection under **Connections**: any OpenAI-compatible endpoint, Anthropic-compatible
endpoint, the local `claude` CLI or the Mavis CLI. Then either start a single task from the
canvas, or open **Batch** (sidebar or top bar) to loop a template over a list.

### Offline demo (no keys, no network)

```bash
cd backend && npm run demo:stack              # fake LLM + isolated backend + UI on http://localhost:5174
```

Open **Batch** and pick the model `fake-model — via Demo LLM (offline)`. Use the template
`Build a landing page for {{item}}` and a few items. Any item containing `FAIL-ME` is always
rejected, so you can watch the auto-iterate → escalate path while the other items finish.

## Batch API (Map node)

```http
POST /api/batches
{ "promptTemplate": "Write a vitest suite for {{item}}", "items": ["src/a.ts", "src/b.ts"],
  "model": "custom:<connId>:<model>", "maxAttempts": 3, "workdir": "optional/root" }

GET  /api/batches · GET /api/batches/:id
POST /api/batches/:id/cancel · POST /api/batches/:id/resume
```

Each item runs as a normal task in `<workdir>/item-NNN/` with `autoApprovePlan` and
`autoIterate`. Progress streams over the WebSocket as `batch_update` events, and
`BATCH_REPORT.md` summarizes the run.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `LOOP_HOST` | `3001` / `127.0.0.1` | bind address |
| `LOOP_ALLOWED_HOSTS` | — | extra Host/Origin names (LAN IP, tunnel host) |
| `LOOP_MAX_BODY_BYTES` | `10485760` | request body cap |
| `LOOP_DATA_DIR` | `backend/data/tasks` | persistence (projects/connections/batches live one level up) |
| `LOOP_WORKSPACES_ROOT` | `~/LoopAgent-workspaces` | default task/batch workdirs |
| `LOOP_ENFORCE_ALLOWLIST` | on | set `0` to allow writes outside `Files to touch` (reserved files and the denylist always apply) |
| `LOOP_ALLOW_MOCK` | off | explicit opt-in to mock agents |

## Tests

```bash
cd backend && npm test     # 217 tests; on Windows, 12 need bash-executable shims or Playwright Chromium (npx playwright install)
cd ui && npm test          # 40 tests
```

## Honest limitations and what's next

- **Agents are single LLM completions**, not tool-using agents. The maker emits whole files and
  the verifier reviews the loaded context. Real deterministic checks run where they apply:
  `npm` build/test for project-shaped work, headless-Chromium runtime evidence for pages.
  Next step: sandboxed tool-capable workers, with the verifier keeping read-only tools.
- **Batches run items sequentially**, because the orchestrator runs one loop at a time. Next steps:
  an explicit graph/run model (XState-style states with budgets and human gates) and parallel
  workers.
- The project's full audit and roadmap live in `docs/superpowers/`.

## Project docs

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, tests and PR expectations
- [SECURITY.md](SECURITY.md): threat model, known gaps and private reporting
- [docs/LAUNCH.md](docs/LAUNCH.md): launch and outreach plan
- [LICENSE](LICENSE): MIT
