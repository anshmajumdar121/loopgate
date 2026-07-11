# Loop Agent — UI Visibility Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface everything the backend's closed-loop upgrade (2026-07-10-prototype-factory-upgrade.md) already produces — runtime check screenshots, per-criterion verdict detail, actual changed filenames, and context-file input — directly in the existing UI, without restructuring any existing component.

**Architecture:** All backend data already exists (`RuntimeCheckResult`, `Verdict.criteriaWalk`, `DiffSummary.filesChanged`, `previewUrl`) — most of this plan is pure frontend rendering. One small backend addition persists a runtime-check summary onto the `Task` so the UI has something to render without re-running anything. The `.loop/` artifact directory (screenshots, raw LLM dumps) is ALREADY servable through the existing preview server at `<previewUrl>.loop/<file>` — verified live (`curl` returned HTTP 200) — so no new backend route is needed for images.

**Tech Stack:** Same as existing UI (React + Tailwind, existing `ProgressNode.tsx` canvas node pattern), Hono backend (one field addition).

---

## HARD CONSTRAINTS — read before touching anything

1. **DO NOT restructure existing UI.** Every change in this plan is either (a) a new field rendered inside an EXISTING conditional block using the EXISTING `Row`/`Row`-like patterns already in the file, or (b) a wholly new, self-contained input added to `NewTaskModal.tsx` below the existing fields. Do not reorder, rename, or reflow anything that currently renders.
2. **All new `Task` fields are optional** (`?:`) — existing persisted tasks must keep loading.
3. **Verify assumptions against the CURRENT working tree before editing** — this codebase has had two prior upgrade passes today (2026-07-10 prototype-factory-upgrade, executed and verified) and line numbers WILL have drifted. Grep for the anchor strings given in each step; don't trust line numbers as gospel, trust the grep.
4. **Build & restart** (backend):
   ```bash
   cd "/Users/anshmajumdar/Desktop/Loop Agent/backend" && npx tsc
   kill $(lsof -t -i :3001 -sTCP:LISTEN) 2>/dev/null; sleep 1
   (nohup node dist/index.js > /tmp/loop-backend.log 2>&1 < /dev/null &)
   sleep 2 && curl -s http://localhost:3001/api/health   # expect {"status":"ok",...}
   ```
5. **UI dev server:** `cd "/Users/anshmajumdar/Desktop/Loop Agent/ui" && npm run dev` (check for an existing running instance first — `lsof -i :5173` or similar — before starting a second one).
6. **Known-good live task for manual UI verification:** `BjHzrO6ibK7u` — completed successfully today with `previewUrl: http://localhost:3210/t/BjHzrO6ibK7u/`, a full `Verdict` with 6 `criteriaWalk` entries, a `DiffSummary` with 1 file, and `.loop/runtime-attempt-1.png` confirmed servable (HTTP 200) at `http://localhost:3210/t/BjHzrO6ibK7u/.loop/runtime-attempt-1.png`. Use this task to verify every UI change in this plan without spawning a new LLM run.

## Key existing interfaces (verified 2026-07-11 against the live codebase)

- `backend/src/types.ts` — `Task.previewUrl?: string` (already added 2026-07-10); `DiffSummary { filesChanged: DiffFileChange[]; buildExit; testsPassed; testsFailed; ... }`; `DiffFileChange { path: string; reason: string }`; `Verdict { criteriaWalk: CriteriaWalkItem[]; outcome; risk; ... }`; `CriteriaWalkItem { criterion: string; passed: boolean; evidence: string }`.
- `backend/src/loop/runtime-check.ts` — `RuntimeCheckResult { ok: boolean; url: string; consoleErrors: string[]; pageErrors: string[]; failedRequests: string[]; interactionLog: string[]; screenshotPath: string | null; evidenceMarkdown: string }`.
- `backend/src/loop/orchestrator.ts` — the `runtime` variable (type `RuntimeCheckResult | null`) is populated right after `▶ RUNTIME CHECK` log line, in scope through the verifier phase of the same attempt loop iteration. Anchor: `grep -n "RUNTIME CHECK — loading" backend/src/loop/orchestrator.ts`.
- `ui/src/types/loop.ts` — mirrors the backend types; already has `previewUrl?: string`. Verify with grep before editing.
- `ui/src/components/canvas/ProgressNode.tsx` — `StepDetail({ stepId, plan, diff, verdict, escalationReason })` renders per-phase detail via a `Row` component (`<Row label="..." value="..." />`, simple flex li). Anchor: `function Row({ label, value }` and `function StepDetail({`.
- `ui/src/components/NewTaskModal.tsx` — `handleSubmit` builds a `CreateTaskBody` object (anchor: `const body: CreateTaskBody = {`) and POSTs to `/api/tasks`. `workdir` state field pattern (anchor: `const [workdir, setWorkdir] = useState("")`) is the template to copy for a new field.
- `PreviewLinkChip.tsx` (from the 2026-07-10 plan) — already exists, mounted at `ProgressNode.tsx` via `<PreviewLinkChip url={task?.previewUrl} />`. Copy this file's pattern (return `null` when data absent) for all new components in this plan.

---

### Task 1: Persist a runtime-check summary on the Task

Right now `RuntimeCheckResult` is used in-memory during the loop and then discarded (only its `evidenceMarkdown` reaches the verifier prompt) — nothing about it survives on the `Task` object for the UI to read later. Add a small summary field.

**Files:**
- Modify: `backend/src/types.ts`
- Modify: `backend/src/loop/orchestrator.ts`

- [ ] **Step 1: Add the type**

In `backend/src/types.ts`, find `previewUrl?: string;` inside `interface Task` (confirm with `grep -n "previewUrl" backend/src/types.ts`) and add directly after it:

```ts
  /** Summary of the most recent headless-browser runtime check (see
   *  loop/runtime-check.ts). Optional + additive. The UI uses this to show
   *  a pass/fail badge and link to the screenshot without re-running
   *  anything — the full RuntimeCheckResult lives only in orchestrator
   *  memory during the loop; this is the persisted digest. */
  runtimeCheck?: {
    attempt: number;
    ok: boolean;
    pageErrorCount: number;
    consoleErrorCount: number;
    /** Relative path from the workdir, e.g. ".loop/runtime-attempt-1.png".
     *  Combine with `previewUrl` to get a fetchable URL:
     *  `${task.previewUrl}${task.runtimeCheck.screenshotRelPath}` */
    screenshotRelPath: string | null;
  };
```

- [ ] **Step 2: Save it after the runtime check runs**

In `backend/src/loop/orchestrator.ts`, find the line logging `✓ RUNTIME CHECK` or `✗ RUNTIME CHECK` (anchor: `grep -n "RUNTIME CHECK —" backend/src/loop/orchestrator.ts`). Directly after that `log(...)` call (still inside the same `try` block that populated `runtime`), add:

```ts
        updateTask(taskId, {
          runtimeCheck: {
            attempt,
            ok: runtime.ok,
            pageErrorCount: runtime.pageErrors.length,
            consoleErrorCount: runtime.consoleErrors.length,
            screenshotRelPath: runtime.screenshotPath
              ? `.loop/${runtime.screenshotPath.split("/").pop()}`
              : null,
          },
        });
        const t3 = getTask(taskId);
        if (t3) broadcaster.broadcast(taskId, { type: "task_update", taskId, task: t3 });
```

(`updateTask`, `getTask`, `broadcaster`, `attempt`, `taskId` are all already in scope in this function — same scope as the existing `updateTask(taskId, { previewUrl })` call a few lines above this insertion point.)

- [ ] **Step 3: Build + verify**

```bash
cd "/Users/anshmajumdar/Desktop/Loop Agent/backend" && npx tsc
```
Expected: clean. Restart the backend (Hard Constraints §4). This field will populate on the NEXT task that runs through the maker→runtime-check phase — it won't backfill `BjHzrO6ibK7u` (that task completed before this change). That's fine; Tasks 2-5 below verify the UI compiles and renders correctly in the ABSENCE of the field (regression-safe), and Task 6's final acceptance step covers the live-data path once a new task exists.

- [ ] **Step 4: Commit**

```bash
cd .. && git add backend/src/types.ts backend/src/loop/orchestrator.ts && \
git commit -m "feat(backend): persist runtime-check summary on Task for UI display"
```

---

### Task 2: Mirror the new type in the UI

**Files:**
- Modify: `ui/src/types/loop.ts`

- [ ] **Step 1: Add the matching field**

```bash
grep -n "previewUrl" "/Users/anshmajumdar/Desktop/Loop Agent/ui/src/types/loop.ts"
```
Directly after that line, add the identical shape from Task 1 Step 1:

```ts
  runtimeCheck?: {
    attempt: number;
    ok: boolean;
    pageErrorCount: number;
    consoleErrorCount: number;
    screenshotRelPath: string | null;
  };
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/anshmajumdar/Desktop/Loop Agent" && git add ui/src/types/loop.ts && \
git commit -m "feat(ui): mirror runtimeCheck type from backend"
```

---

### Task 3: Runtime-check panel — screenshot + error badge

New additive component, mounted next to the existing `PreviewLinkChip`.

**Files:**
- Create: `ui/src/components/RuntimeCheckPanel.tsx`
- Modify: `ui/src/components/canvas/ProgressNode.tsx` (one import + one mount line)

- [ ] **Step 1: Create the component**

```tsx
// ui/src/components/RuntimeCheckPanel.tsx
// Additive component: shows a pass/fail badge + screenshot thumbnail for
// the most recent headless-browser runtime check. Renders NOTHING when the
// task has no runtimeCheck yet (older tasks, or tasks that haven't reached
// the implementation phase) — safe to mount unconditionally.
import type { Task } from "@/types/loop";

export function RuntimeCheckPanel({ task }: { task?: Task | null }) {
  const rc = task?.runtimeCheck;
  if (!rc || !task?.previewUrl) return null;

  const screenshotUrl = rc.screenshotRelPath
    ? `${task.previewUrl}${rc.screenshotRelPath}`
    : null;

  return (
    <div
      style={{
        marginTop: 6,
        padding: 8,
        borderRadius: 8,
        border: `1px solid ${rc.ok ? "#3fb95033" : "#f8514933"}`,
        background: rc.ok ? "#3fb95010" : "#f8514910",
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
        <span style={{ color: rc.ok ? "#3fb950" : "#f85149" }}>
          {rc.ok ? "● Runtime check passed" : "● Runtime check found errors"}
        </span>
        <span style={{ opacity: 0.6, fontWeight: 400 }}>attempt {rc.attempt}</span>
      </div>
      {!rc.ok && (
        <div style={{ marginTop: 2, opacity: 0.8 }}>
          {rc.pageErrorCount} page error{rc.pageErrorCount === 1 ? "" : "s"},{" "}
          {rc.consoleErrorCount} console error{rc.consoleErrorCount === 1 ? "" : "s"}
        </div>
      )}
      {screenshotUrl && (
        <a href={screenshotUrl} target="_blank" rel="noreferrer">
          <img
            src={screenshotUrl}
            alt="Runtime check screenshot"
            style={{
              marginTop: 6,
              maxWidth: "100%",
              maxHeight: 160,
              borderRadius: 4,
              border: "1px solid #ffffff1a",
              display: "block",
            }}
          />
        </a>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount it next to PreviewLinkChip**

```bash
grep -n "PreviewLinkChip" "/Users/anshmajumdar/Desktop/Loop Agent/ui/src/components/canvas/ProgressNode.tsx"
```
Add the import next to the existing `PreviewLinkChip` import, and mount directly below the existing `<PreviewLinkChip url={task?.previewUrl} />` line:

```tsx
import { RuntimeCheckPanel } from "@/components/RuntimeCheckPanel";
```
```tsx
        <PreviewLinkChip url={task?.previewUrl} />
        <RuntimeCheckPanel task={task} />
```
(Match whatever variable name the existing `PreviewLinkChip` mount uses for the task object — it may be `task`, `data.task`, or similar; use that exact same reference for consistency, don't introduce a second way of accessing the task.)

- [ ] **Step 3: Manual verification against the known-good live task**

Once the UI dev server is running and pointed at task `BjHzrO6ibK7u`: this task predates Task 1's backend change, so `runtimeCheck` will be `undefined` and the panel correctly renders nothing — confirm no crash, no empty box. To see the panel actually render, run ONE new small task through the loop after Task 1's backend change is live (any trivial single-page prompt) and open it in the UI — expect the green "● Runtime check passed" badge with a clickable screenshot thumbnail.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/RuntimeCheckPanel.tsx ui/src/components/canvas/ProgressNode.tsx && \
git commit -m "feat(ui): runtime-check pass/fail badge + screenshot thumbnail (additive)"
```

---

### Task 4: Per-criterion verdict detail

`Verdict.criteriaWalk` already carries pass/fail + evidence per criterion (confirmed live: `BjHzrO6ibK7u`'s verdict has 6 populated entries) but `StepDetail`'s verification block only shows aggregate counts. Add the itemized list.

**Files:**
- Modify: `ui/src/components/canvas/ProgressNode.tsx`

- [ ] **Step 1: Find the verification block**

```bash
grep -n 'stepId === "verification"' "/Users/anshmajumdar/Desktop/Loop Agent/ui/src/components/canvas/ProgressNode.tsx"
```

- [ ] **Step 2: Add the criteria list inside the existing verification `<ul>`**

Find the closing `</ul>` of the verification block's existing `Row` list (the one with `label="Risk"` — confirm with `grep -n 'label="Risk"' ui/src/components/canvas/ProgressNode.tsx`). Directly BEFORE that closing `</ul>`, add:

```tsx
        {verdict.criteriaWalk.length > 0 && (
          <li className="mt-1 space-y-0.5">
            {verdict.criteriaWalk.map((c, i) => (
              <div
                key={i}
                style={{ display: "flex", gap: 4, alignItems: "flex-start", fontSize: 10 }}
                title={c.evidence}
              >
                <span style={{ color: c.passed ? "#3fb950" : "#f85149", flexShrink: 0 }}>
                  {c.passed ? "✓" : "✗"}
                </span>
                <span className="text-zinc-500 dark:text-zinc-400" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.criterion}
                </span>
              </div>
            ))}
          </li>
        )}
```
(Uses `verdict` — already in scope as the function parameter of `StepDetail`, guarded by the existing `if (!verdict) return null;` directly above this block in the verification branch.)

- [ ] **Step 3: Manual verification**

Open task `BjHzrO6ibK7u` in the UI, expand the verification step. Expect 6 green checkmarks, each showing the criterion text, each with a hover tooltip showing the evidence string (from `c.evidence`).

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/canvas/ProgressNode.tsx && \
git commit -m "feat(ui): per-criterion pass/fail detail in verification step (additive)"
```

---

### Task 5: Show actual changed filenames in the implementation step

Currently the implementation `StepDetail` block only shows build/test pass-fail counts — not which files changed. `DiffSummary.filesChanged: DiffFileChange[]` already carries `{ path, reason }` per file (confirmed live: `BjHzrO6ibK7u`'s diff has `index.html` with a real reason string).

**Files:**
- Modify: `ui/src/components/canvas/ProgressNode.tsx`

- [ ] **Step 1: Find the implementation block**

```bash
grep -n 'stepId === "implementation"' "/Users/anshmajumdar/Desktop/Loop Agent/ui/src/components/canvas/ProgressNode.tsx"
```

- [ ] **Step 2: Add the file list before the closing `</ul>` of that block**

```tsx
        {diff.filesChanged.length > 0 && (
          <li className="mt-1 space-y-0.5">
            {diff.filesChanged.map((f, i) => (
              <div
                key={i}
                className="font-mono text-zinc-500 dark:text-zinc-400"
                style={{ fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={f.reason}
              >
                {f.path}
              </div>
            ))}
          </li>
        )}
```
(Uses `diff` — already in scope, same pattern as the existing `diff.buildExit` / `diff.testsPassed` reads two lines above in the same block.)

- [ ] **Step 3: Manual verification**

Open task `BjHzrO6ibK7u`, expand the implementation step. Expect `index.html` listed with a monospace font, truncated with ellipsis if long, full reason on hover.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/canvas/ProgressNode.tsx && \
git commit -m "feat(ui): list actual changed filenames in implementation step (additive)"
```

---

### Task 6: contextFiles input in the New Task modal

The backend's `contextFiles` field (2026-07-10 plan, Task 5) has no UI input — it only worked via raw `curl`. Add a simple textarea, one path per line.

**Files:**
- Modify: `ui/src/components/NewTaskModal.tsx`

- [ ] **Step 1: Add the state field**

```bash
grep -n 'useState("")' "/Users/anshmajumdar/Desktop/Loop Agent/ui/src/components/NewTaskModal.tsx"
```
Find `const [workdir, setWorkdir] = useState("");` and add directly after it:

```tsx
  const [contextFilesRaw, setContextFilesRaw] = useState("");
```

- [ ] **Step 2: Include it in the submit body**

```bash
grep -n "const body: CreateTaskBody = {" "/Users/anshmajumdar/Desktop/Loop Agent/ui/src/components/NewTaskModal.tsx"
```
Inside that object literal, add a field:

```tsx
        contextFiles: contextFilesRaw
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 10),
```
(The backend's zod schema already caps this at 10 — `contextFiles: z.array(z.string()).max(10).optional()` — matching `.slice(0, 10)` here just avoids a wasted round-trip on an over-long paste.)

- [ ] **Step 3: Add the textarea to the form**

Find the existing workdir input's JSX block (search for the `value={workdir}` line). Directly after the closing tag of that input's wrapping block (before the next form field or the submit button — read the surrounding JSX to find the right sibling position), add:

```tsx
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Reference files (optional)
            </label>
            <textarea
              value={contextFilesRaw}
              onChange={(e) => setContextFilesRaw(e.target.value)}
              placeholder={"One absolute path per line, e.g.\n/Users/you/project/src/Editor/SplitMask.tsx"}
              rows={3}
              className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1 text-xs font-mono"
            />
            <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
              Contents are inlined into the planner and maker prompts (capped at 20KB/file, 60KB total).
            </p>
          </div>
```
(Match the exact className conventions used by the workdir input immediately above it — copy its actual classes rather than inventing new ones; the block above is illustrative of the DATA WIRING, not a mandate to use different Tailwind classes than the rest of the form.)

- [ ] **Step 4: Manual verification**

Open the New Task modal, type two lines into the new textarea, submit, then `curl -s http://localhost:3001/api/tasks/<new-id> | python3 -c "import json,sys;print(json.load(sys.stdin)['task'].get('contextFiles'))"` — expect a 2-element array matching what was typed. Stop the task immediately after confirming (`POST /api/tasks/<id>/stop`) to avoid spending LLM budget on a throwaway verification task.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/NewTaskModal.tsx && \
git commit -m "feat(ui): contextFiles textarea input in New Task modal (additive)"
```

---

## Final acceptance run

- [ ] `cd "/Users/anshmajumdar/Desktop/Loop Agent/backend" && npx tsc` → clean.
- [ ] `cd "/Users/anshmajumdar/Desktop/Loop Agent/ui" && npx tsc --noEmit` (or the UI's typecheck script per `package.json`) → clean.
- [ ] Open the UI, load task `BjHzrO6ibK7u`:
  - Live Preview chip still renders (unaffected by this plan — regression check).
  - Verification step shows 6 itemized criteria with checkmarks (Task 4).
  - Implementation step shows `index.html` as a filename (Task 5).
  - Runtime check panel renders nothing (task predates the field) — no crash (Task 3 regression check).
- [ ] Submit one new task via the New Task modal with 1-2 context file paths filled in; confirm via API that `contextFiles` round-tripped (Task 6), then stop it.
- [ ] Once any NEW task completes a full maker→verify cycle: confirm the Runtime Check panel now renders with a real screenshot thumbnail that opens full-size on click (Task 3 full path).
