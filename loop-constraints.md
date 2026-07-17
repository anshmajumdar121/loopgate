# Loop Constraints (binding)

> Loaded by every loop subagent before any work begins. These rules are **not** suggestions. If a rule can be misinterpreted, rewrite it — the loop will not second-guess.

## Max retries per task: 3

After 3 consecutive REJECT verdicts, the orchestrator **must** ESCALATE to the user. Do not retry infinitely. Do not let the maker "try one more thing" past the cap.

### Script-loop exception: best-so-far return

For tasks whose plan allowlist is exactly `["script.md"]` (the short-form
script optimization loop), the max-attempts exit is **NOT** escalate.
Instead, the orchestrator returns the attempt with the highest
`criteriaWalk` pass-count and emits `done` with a score-trace summary
("Returned best-so-far (attempt N, score M) …"). The user still gets a
chance to reject via the UI; they just receive a concrete candidate to
review instead of an empty hand-off. All other tasks keep the original
escalate-on-max behavior.

### Script-loop score-driven autonomy (no human in the loop)

For script tasks, the verifier's `**Criteria walk:**` is graded on the
F1–F7 rubric and scaled to a **0–10** display. The orchestrator uses
this score to decide the loop's next action — no user feedback wait:

| Verifier outcome | Score (/10) | Loop action |
|---|---|---|
| `APPROVE` | any | `done` immediately (verifier's own gate passed) |
| `REJECT` | >= threshold (default 7) | `done` — script is good enough to ship |
| `REJECT` | < threshold | auto-iterate to next attempt with the failed criteria as feedback; no user gate |
| max attempts | any | best-so-far `done` with score trace (above) |

Threshold is `LOOP_SCRIPT_MIN_SCORE` env (default 7, range 0–10). All
other tasks keep the original REJECT → wait-for-user-feedback path.

## Path denylist (never edit without explicit human approval)

```
.env
.env.*
**/secrets/**
**/credentials/**
**/*_key*
**/*_secret*
**/migrations/**
auth/**
payments/**
billing/**
```

The maker must STOP and return `ESCALATE: denylist hit — <file>` if the implementation requires editing any of these. The verifier must REJECT any diff that touches a denylisted path.

## Verification rules

- The verifier **MUST** run the build and tests independently. Never trust the maker's claim.
- The verifier **MUST** check that every changed file is in `GOAL.md` → Files to touch. Any extra file → REJECT.
- The verifier **MUST** default to REJECT. Approval requires every checklist item passing.
- The verifier **MUST NOT** edit code. Read-only.

## Maker rules

- The maker **MUST NOT** mark its own work done. The verifier decides.
- The maker **MUST** stay within the file allowlist from `GOAL.md`.
- The maker **MUST** produce the smallest possible diff. No drive-by edits, no "while I'm here" cleanups.
- The maker **MUST NOT** disable, skip, delete, or weaken tests.
- The maker **MUST NOT** add dependencies without explicit plan approval.
- The maker **MUST NOT** use `--no-verify`, force pushes, or hook bypasses.

## Exit conditions

The loop **must** exit when any of these is true:

1. All criteria in `GOAL.md` are met AND verifier returns `APPROVE` → state = DONE.
2. `max_retries` consecutive REJECTs → state = ESCALATED, hand off to user.
3. Any agent returns `ESCALATE_HUMAN` → state = ESCALATED, hand off to user.
4. The task is ambiguous and the planner cannot produce a plan → state = ESCALATED.
5. User interrupts or sends a new task → state = DONE for current task, new loop starts.

The loop **must not** exit while a phase is in progress. Always complete the current phase, update state, then exit.

## Human gates (always require human, even if tests pass)

- Changes to `auth/**`, `payments/**`, `billing/**`, secrets, infra, or PII handling.
- Any change touching >10 files in a single attempt.
- The third consecutive REJECT on the same task.
- Any change that adds a new external dependency.

The orchestrator surfaces these to the user and waits. It does not auto-resolve.

## Token + time budget (soft)

- One loop run should target <200k tokens total (orchestrator + subagents).
- If a single subagent run exceeds ~100k tokens, the orchestrator should note it in `STATE.md` and consider tightening scope.
- The loop does not enforce hard token caps at L1. It records spend in `STATE.md` → History and exits cleanly when the task is done.

## Notification policy

- The orchestrator speaks to the user at: (1) after planning — for go/no-go, (2) after a REJECT that triggers escalation, (3) at the final exit.
- The orchestrator does **not** narrate every tool call. No "now I'm reading X", no "now I'm calling planner". Speak at decision points only.

## State hygiene

- Update `Last updated` on every phase change.
- Append to History, never overwrite it.
- Prune resolved/closed items at the end of every run.
- Never write secrets, API keys, or PII into `STATE.md`.
