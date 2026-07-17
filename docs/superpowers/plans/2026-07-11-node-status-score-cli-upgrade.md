# Loop Agent — Node Animation, Score, Parser Hardening, Preview Relocation, No-API CLI Mode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five reported issues: (A) canvas nodes past the first few never animate (loop looks stuck), (B) add a numeric 0–100 verifier score, (C) verdict panel shows fake numbers (0/0 criteria, build fail/NaN) because the parser is brittle, (D) Live Preview renders on the wrong node, (E) add a no-API mode that drives the loop through a local CLI agent (claude/opencode) with no API key.

**Architecture:** A is pure backend broadcast additions (the UI socket already routes any node id). B/C are parser + prompt + one type field + small UI additions. D moves two existing components. E adds a `--cli` mode to the existing bridge runner so the whole write-path stays identical.

**Tech Stack:** existing — TypeScript, Hono backend, React+Tailwind UI, vitest.

---

## HARD CONSTRAINTS

1. Additive UI only, EXCEPT Task D which explicitly relocates the PreviewLinkChip/RuntimeCheckPanel (user-requested move).
2. New Task/Verdict fields optional (`?:`).
3. Grep the given anchors before editing — line numbers drift.
4. Backend build/restart:
   ```bash
   cd "/Users/anshmajumdar/Desktop/Loop Agent/backend" && npx tsc
   kill $(lsof -t -i :3001 -sTCP:LISTEN) 2>/dev/null; sleep 1
   (nohup node dist/index.js > /tmp/loop-backend.log 2>&1 < /dev/null &)
   sleep 2 && curl -s http://localhost:3001/api/health
   ```
5. Tests: `cd backend && npx vitest run`. UI typecheck: `cd ui && npx tsc --noEmit`.
6. Working model connections (as of 2026-07-11): planning/impl = `custom:2QhUhF7RwcXL:minimaxai/minimax-m3` and `custom:d3GGtIYjVjrN:minimaxai/minimax-m3`; review = `custom:MzKQf8pdyoyx:tencent/hy3:free`. Confirm via `GET /api/connections` before any e2e run.

## VERIFIED FACTS (2026-07-11 — the plan is built on these)

- Orchestrator emits `node_status` ONLY for ids: `planner`, `plan_review`, `maker`, `verifier`, `verdict`(one "waiting"). Anchor: `grep -n 'nodeStatus(' backend/src/loop/orchestrator.ts`.
- Canvas node ids in `ui/src/data/workflow.ts`: `orchestrator`(~102), `read_state`(~127), `verdict`(~148), `retry`(~160), `done`(~171), `live_preview`(~178), `escalated`(~185), plus `task`/`planner`/`plan_review`/`maker`/`verifier`. Confirm the exact first-node id with `grep -n 'id: "' ui/src/data/workflow.ts`.
- UI socket handler routes ANY node id: `ui/src/hooks/useLoopSocket.ts` case `"node_status"` → `s.setNodeStatus(msg.nodeId, msg.status)`. No UI change needed for Task A.
- `live_preview` node is already interactive: `ui/src/components/canvas/WorkflowNode.tsx:139` — `const isLivePreviewNode = spec.id === "live_preview"; const previewClickable = isLivePreviewNode && Boolean(previewUrl);`.
- Verdict parser expects exactly: `## Verifier Verdict — Attempt N`, `**Verdict:** APPROVE|REJECT|ESCALATE_HUMAN`, `**Build:** 0 — …`, `**Tests:** 0 — 14 passed, 0 failed`, `**Criteria walk:**` with `- [x] criterion — evidence`. Parser: `backend/src/loop/parser.ts` (`parseCriteriaWalk` used ~line 403; one-line reason built ~423).
- ProgressNode currently mounts `<PreviewLinkChip url={task?.previewUrl} />` and `<RuntimeCheckPanel task={task} />` — Task D removes these from ProgressNode.
- `agent-spawner.ts`: `spawnAgent()` branches `OPENCODE_AVAILABLE` → `spawnMock` | `spawnReal`; bridge path `spawnBridgeRunner` spawns `node llm-agent.mjs --model … --base-url … --api-key … --workdir … --role … --output …`.
- `claude` CLI (Claude Code) is installed on this machine — usable for Task E.

---

### Task A: Broadcast node_status for every canvas node

**Files:** Modify `backend/src/loop/orchestrator.ts` only.

- [ ] **A1.** First check the allowed status values: `grep -n "RunStatus" ui/src/data/workflow.ts` — use only members of that union (likely `"idle" | "running" | "success" | "error" | "waiting"`). Adjust literals below if they differ.
- [ ] **A2.** At loop start (right after `await watcher.ready();` — anchor `grep -n "watcher.ready()" backend/src/loop/orchestrator.ts`), add:
```ts
  nodeStatus("task", "success");
  nodeStatus("orchestrator", "running");
```
- [ ] **A3.** Read-state node — immediately BEFORE the existing `nodeStatus("maker", "running")` (~line 1011), add:
```ts
        nodeStatus("read_state", "running");
        nodeStatus("read_state", "success");
```
(The state read is synchronous prompt assembly; back-to-back running→success gives the animation beat without lying about timing.)
- [ ] **A4.** Verdict node — before the verifier output is parsed (anchor: the `parseStateDiff(stateAfterVerify)` call), add `nodeStatus("verdict", "running");`. Then per outcome branch:
```ts
      // APPROVE path (anchor: where status "done" is emitted):
      nodeStatus("verdict", "success");
      nodeStatus("done", "success");
      nodeStatus("live_preview", "success");
      // REJECT with attempts remaining (anchor: the retry/feedback branch):
      nodeStatus("verdict", "error");
      nodeStatus("retry", "running");
      // Top of the next attempt iteration (anchor: attempt increment):
      nodeStatus("retry", "success");
      // REJECT out of attempts / ESCALATE_HUMAN (anchor: escalate() call sites in the verdict branch):
      nodeStatus("verdict", "error");
```
- [ ] **A5.** Escalated node — `escalate()` is module-level (anchor `function escalate(`), so it can't use the closure `nodeStatus`. Inside it, next to the existing broadcasts, add:
```ts
  broadcaster.broadcast(taskId, { type: "node_status", taskId, nodeId: "escalated", status: "error" });
```
- [ ] **A6.** `npx tsc` clean → restart backend → run one e2e task (Constraint-6 modelOverrides): EVERY node must light up in sequence on the canvas. Commit:
```bash
git add backend/src/loop/orchestrator.ts && git commit -m "feat(backend): broadcast node_status for all canvas nodes"
```

---

### Task B: Numeric verifier score (0–100)

**Files:** Modify `backend/src/types.ts`, `backend/src/loop/parser.ts`, `backend/src/loop/orchestrator.ts`, `ui/src/types/loop.ts`, `ui/src/components/canvas/ProgressNode.tsx`. Create `backend/src/loop/__tests__/parser-score.test.ts`.

- [ ] **B1.** `backend/src/types.ts`, inside `interface Verdict` after `oneLineReason: string;`:
```ts
  /** 0-100 quality score. Parsed from the verifier's `**Score:** NN/100`
   *  line; falls back to round(100 * criteriaPassed/criteriaTotal) when
   *  the line is absent. Optional — older persisted verdicts lack it. */
  score?: number;
```
Mirror the identical field in `ui/src/types/loop.ts` `interface Verdict`.
- [ ] **B2.** Verifier prompt — in `buildVerifierPrompt` (anchor `grep -n "buildVerifierPrompt" backend/src/loop/orchestrator.ts`), append to the "Your task" instruction array:
```ts
    "",
    "End the verdict block with a line `**Score:** NN/100` — your overall",
    "quality score for this attempt (100 = every criterion passes cleanly,",
    "runtime check clean, no scope creep; subtract for each failure).",
```
- [ ] **B3.** Parser — in the verdict-parsing function in `backend/src/loop/parser.ts` (the one building the object with `criteriaWalk` ~403-423), add before the return:
```ts
  const scoreMatch = lines.join("\n").match(/\*\*Score:\*\*\s*(\d{1,3})\s*\/\s*100/i);
  const score = scoreMatch
    ? Math.min(100, Number(scoreMatch[1]))
    : criteriaWalk.length > 0
    ? Math.round((100 * criteriaWalk.filter((c) => c.passed).length) / criteriaWalk.length)
    : undefined;
```
and add `score,` to the returned verdict object. (If the local variable holding the section lines has a different name than `lines`, use that name.)
- [ ] **B4.** Test — create `backend/src/loop/__tests__/parser-score.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseStateDiff } from "../parser.js";

const V = (extra: string) => `## Verifier Verdict — Attempt 1
**Verdict:** APPROVE
**Criteria walk:**
- [x] a — ok
- [x] b — ok
- [ ] c — nope
${extra}`;

describe("verdict score", () => {
  it("parses explicit Score line", () => {
    const { verdict } = parseStateDiff(V("**Score:** 85/100"));
    expect(verdict?.score).toBe(85);
  });
  it("falls back to criteria ratio", () => {
    const { verdict } = parseStateDiff(V(""));
    expect(verdict?.score).toBe(67); // 2/3 → 67
  });
});
```
- [ ] **B5.** UI — `ProgressNode.tsx` verification block (anchor `label="Risk"`), add after the Risk row:
```tsx
        {typeof verdict.score === "number" && (
          <Row label="Score" value={`${verdict.score}/100`} />
        )}
```
- [ ] **B6.** `npx vitest run` green, both typechecks clean. Commit:
```bash
git add backend/src/types.ts backend/src/loop/parser.ts backend/src/loop/orchestrator.ts backend/src/loop/__tests__/parser-score.test.ts ui/src/types/loop.ts ui/src/components/canvas/ProgressNode.tsx && \
git commit -m "feat: numeric verifier score (explicit or criteria-derived) surfaced in UI"
```

---

### Task C: Parser hardening — real numbers, no more 0/0 + NaN

**Files:** Modify `backend/src/loop/parser.ts`, `ui/src/components/canvas/ProgressNode.tsx`. Create `backend/src/loop/__tests__/fixtures/state-tencent-reject.md` + `backend/src/loop/__tests__/parser-realworld.test.ts`.

- [ ] **C1.** Capture the REAL failing fixture first (not synthetic): the reject run's verifier output. Look in order: (1) `/Users/anshmajumdar/Desktop/tic-tac-toe-game/.loop/verifier-attempt-*-raw.md`, (2) the STATE.md of whichever workdir the rejected "score-test-small" run used, (3) the task's logs via `GET /api/tasks`. Save as `backend/src/loop/__tests__/fixtures/state-tencent-reject.md`.
- [ ] **C2.** Harden `parser.ts`:
  - Verdict keyword: case-insensitive, optional bold — `/\*{0,2}verdict\*{0,2}\s*:\s*\*{0,2}(APPROVE|REJECT|ESCALATE[_ ]HUMAN)/i`.
  - Criteria bullets: extend `parseCriteriaWalk` (anchor comment ~line 146) to also accept `- [X]`, `* [x]`, `- ✓ criterion`, `- ✗ criterion`.
  - Numbers: define `export const BUILD_NA = -2;` at the top of parser.ts. Wherever `buildExit`/`testsPassed`/`testsFailed` parse from text: if the value is `n/a`, `none`, missing, or non-numeric → use `BUILD_NA` for buildExit and `0` for test counts, and guarantee `Number.isNaN(x)` can never escape (`const safe = (n: number) => (Number.isNaN(n) ? BUILD_NA : n)`).
- [ ] **C3.** UI n/a rendering — grep `buildExit` in `ui/src`; at each render site replace the binary pass/fail with:
```tsx
          value={diff.buildExit === 0 ? "✓ pass" : diff.buildExit === -2 ? "n/a" : "✗ fail"}
```
and guard the tests row: `` value={diff.testsPassed + diff.testsFailed === 0 ? "n/a" : `${diff.testsPassed}/${diff.testsPassed + diff.testsFailed}`} ``. Apply the same to the verdict block's build/tests rows if present.
- [ ] **C4.** Fixture test — `backend/src/loop/__tests__/parser-realworld.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseStateDiff } from "../parser.js";

describe("real-world tencent verdict", () => {
  it("extracts outcome and never yields NaN", () => {
    const md = readFileSync(new URL("./fixtures/state-tencent-reject.md", import.meta.url), "utf8");
    const { verdict } = parseStateDiff(md);
    expect(verdict).not.toBeNull();
    expect(Number.isNaN(verdict!.buildExit)).toBe(false);
  });
});
```
- [ ] **C5.** All tests green. Commit:
```bash
git add backend/src/loop/parser.ts backend/src/loop/__tests__ ui/src/components/canvas/ProgressNode.tsx && \
git commit -m "fix(parser): tolerate verdict format variants + n/a build/tests (no more 0/0 and NaN)"
```

---

### Task D: Live Preview + runtime check on the live_preview node

**Files:** Modify `ui/src/components/canvas/ProgressNode.tsx` (remove two mounts + imports), `ui/src/components/canvas/WorkflowNode.tsx`, `ui/src/components/RuntimeCheckPanel.tsx` (props refactor).

- [ ] **D1.** In `ProgressNode.tsx` delete `<PreviewLinkChip url={task?.previewUrl} />`, `<RuntimeCheckPanel task={task} />`, and both imports.
- [ ] **D2.** Refactor `RuntimeCheckPanel` to plain props (it has exactly one call site, created 2026-07-11 — safe):
```tsx
export function RuntimeCheckPanel({ previewUrl, runtimeCheck }: {
  previewUrl?: string;
  runtimeCheck?: { attempt: number; ok: boolean; pageErrorCount: number; consoleErrorCount: number; screenshotRelPath: string | null } | null;
}) {
  const rc = runtimeCheck;
  if (!rc || !previewUrl) return null;
  // …body unchanged, replace task.previewUrl with previewUrl…
}
```
- [ ] **D3.** In `WorkflowNode.tsx` (anchor `isLivePreviewNode` ~139): trace how `previewUrl` reaches this component (`grep -n "previewUrl" ui/src/components/canvas/WorkflowNode.tsx ui/src/hooks` — likely from the useWorkflow store). Mirror that exact path for `runtimeCheck` (add it to the store where `previewUrl` lives, set from the same `task_update` message). Then inside the live_preview node's render, below the pill label:
```tsx
      {isLivePreviewNode && (
        <RuntimeCheckPanel previewUrl={previewUrl} runtimeCheck={runtimeCheck} />
      )}
```
- [ ] **D4.** Typecheck clean; visual check on any task with populated `runtimeCheck`: badge + screenshot render ON the live_preview node; ProgressNode shows neither. Commit:
```bash
git add ui/src && git commit -m "refactor(ui): move Live Preview chip + runtime panel to the live_preview canvas node"
```

---

### Task E: No-API mode — local CLI runner (`claude -p`)

**Files:** Modify `backend/llm-agent.mjs` (add `--cli` mode), `backend/src/loop/agent-spawner.ts`, `backend/src/loop/orchestrator.ts` (`validateRefs` exemption), `backend/src/types.ts` + `ui/src/types/loop.ts` (`ConnectionProviderType` union member), Connections UI (one additive `<option>`). Create `backend/src/loop/__tests__/fixtures/claude-shim.sh`.

Design: keep EVERY write path identical by adding a `--cli` flag to the existing bridge script — when set, the LLM call is replaced by shelling the local `claude` CLI; the per-role output dispatch (planner→GOAL.md verbatim, maker→```file: extraction, verifier→STATE.md append) runs unchanged. The orchestrator/watcher/parser never know the difference.

- [ ] **E1.** `llm-agent.mjs` — add to `parseArgs`: `case "--cli": out.cli = true; break;`. Change the api-key requirement to `if (!apiKey && !args.cli) { … exit(2) }`. Replace the `generateText` call site with:
```js
let text, usage = null, finishReason = "stop", reasoning = "";
if (args.cli) {
  const { spawnSync } = await import("node:child_process");
  const full = (systemPrompt ? systemPrompt + "\n\n---\n\n" : "") + userPrompt;
  const bin = process.env.LOOP_CLI_BIN || "claude";
  const t0 = Date.now();
  const r = spawnSync(bin, ["-p", full, "--output-format", "text"], {
    cwd: args.workdir, encoding: "utf8", timeout: 25 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    process.stderr.write(`llm-agent: FAIL: local CLI exit ${r.status}: ${(r.stderr || "").slice(0, 300)}\n`);
    process.exit(1);
  }
  text = (r.stdout || "").trim();
  process.stderr.write(`[${args.role}] CLI OK in ${Date.now() - t0}ms, ${text.length} chars\n`);
} else {
  const result = await generateText({ /* existing args unchanged */ });
  // existing destructuring/empty-content-salvage block unchanged
}
// existing per-role dispatch continues, operating on `text`
```
Preserve the existing empty-content guard for BOTH branches (empty CLI stdout must also exit 1) and the artifact dump (works for both — it only needs `text`).
- [ ] **E2.** `agent-spawner.ts` `spawnBridgeRunner` — when the resolved connection has `providerType === "local-cli"` OR env `LOOP_LOCAL_CLI=1`, append `"--cli"` to the `args` array and pass `--api-key ""`.
- [ ] **E3.** `orchestrator.ts` `validateRefs` (anchor `grep -n "validateRefs" backend/src/loop/orchestrator.ts`) — exempt connections with `providerType === "local-cli"` from the "has no API key" escalation.
- [ ] **E4.** Types — add `"local-cli"` to `ConnectionProviderType` in `backend/src/types.ts` AND `ui/src/types/loop.ts`. Connections UI: add one `<option value="local-cli">Local CLI (no API key)</option>` to the providerType select in `ConnectionsPanel.tsx`/`NewConnectionModal.tsx` (grep `providerType` there to find the select). Backend create-connection schema: confirm it accepts the new value (grep the zod schema in `src/api/connections.ts`; extend the enum if it's constrained).
- [ ] **E5.** Shim test — `backend/src/loop/__tests__/fixtures/claude-shim.sh`:
```bash
#!/bin/sh
echo "## Implementation Plan
1. Step one
## Completion Criteria
- [ ] works"
```
`chmod +x` it, then test: `LOOP_CLI_BIN=<abs path to shim> node llm-agent.mjs --cli --role planner --model x --base-url x --workdir /tmp --output /tmp/GOAL-cli-test.md` with `LOOP_USER_PROMPT="test"` → expect exit 0 and `/tmp/GOAL-cli-test.md` containing the shim output. (Wire `LOOP_CLI_BIN` through as shown in E1.)
- [ ] **E6.** Real e2e: create a `local-cli` connection via the API, create a task with all three roles pointed at it, run — expect GOAL.md written by the local `claude` with zero API keys. NOTE: uses the machine's Claude Code subscription; latency profile differs from the HTTP APIs but the 20/25-min timeouts already cover it. Commit:
```bash
git add backend/llm-agent.mjs backend/src/loop/agent-spawner.ts backend/src/loop/orchestrator.ts backend/src/types.ts ui/src backend/src/api/connections.ts backend/src/loop/__tests__ && \
git commit -m "feat: local-CLI runner mode — run the loop with zero API keys via claude -p"
```

---

## Final acceptance

- [ ] Backend `npx tsc` + `npx vitest run` green; UI `npx tsc --noEmit` green.
- [ ] E2E run (API mode): every canvas node animates in order (A); verdict shows real criteria numbers + a Score (B/C); Live Preview + runtime panel render on the live_preview node only (D).
- [ ] E2E run (no-API mode): task completes on a `local-cli` connection with zero keys (E).
- [ ] A REJECT run's side panel shows real criteria walk + required fixes — no 0/0 unless genuinely zero, no NaN anywhere (C).
