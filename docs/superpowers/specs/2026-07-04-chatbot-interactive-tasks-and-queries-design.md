# Chatbot Interactive Tasks & Queries — Design Spec

**Date**: 2026-07-04
**Author**: brainstorming session with user
**Status**: Design approved (Sections 1–4). Ready for plan generation via `writing-plans` skill.

---

## 1. Overview

Add two new behaviors to the existing chatbot surface (`ui/src/components/canvas/ChatbotNode.tsx`):

1. **Persistent task card** — when a task is active, render a card inside the chatbot node (below the existing header) showing the task title, phase, attempt count, elapsed time, and two actions: **Rewrite** and **Delete**.
2. **Hybrid chatbot queries** — a new chat input + thread below the card. Free-text messages are routed by keyword matching to one of 8 canned reply shapes that pull data from `taskMirror` and render `file://` links to project files.

**Constraint**: the planner → implement → verify workflow loop is **untouched**. This feature lives entirely inside the chatbot UI surface plus two new backend endpoints (`POST /:id/re-prompt`, `DELETE /:id`).

**Intelligence model**: hybrid (keyword-matched canned replies). **No LLM is added.** This is intentional — keeps latency instant, cost zero, and determinism total.

---

## 2. Goals & Non-Goals

### Goals
- User can rewrite the active task's prompt and have the same task re-spawned with an incremented attempt counter.
- User can hard-delete the active task via a confirmation modal.
- User can ask free-text questions like *"show me the files"*, *"what's the plan?"*, *"where is the project folder"* and get an instant canned reply with `file://` links.
- Chat replies include `file://` URIs that open in Finder / default app on click.
- All 8 intents have empty-state replies that gracefully degrade when no task is active.

### Non-Goals (v1)
- Real LLM calls (intentionally not adding).
- Reading file contents from workdir (no `cat <file>` intent).
- Cross-session chat history (chat thread is component-local; cleared on refresh).
- Voice input, multi-language, or streaming.
- Promoting the persistent card to TopBar (stays inside ChatbotNode only).
- Web-deployed mode (relies on local `file://` support).

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────┐
│ ui/src/components/canvas/ChatbotNode.tsx  (modified)        │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ <PersistentTaskCard />   NEW, conditional             │   │
│ │   visible when activeTaskId is set                   │   │
│ │   actions: Rewrite (inline edit), Delete (modal)     │   │
│ ├──────────────────────────────────────────────────────┤   │
│ │ <ChatThread />           NEW — message history        │   │
│ │   renders <IntentReply /> for each user/bot pair     │   │
│ ├──────────────────────────────────────────────────────┤   │
│ │ <ChatInput />            NEW — auto-grow textarea     │   │
│ │   submits via matchIntent() (no backend call)        │   │
│ └──────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
                          │  (for Rewrite/Delete only)
                          ▼
       ┌────────────────────────────────────────┐
       │ backend/src/api/tasks.ts (modified)    │
       │  + POST /:id/re-prompt   NEW           │
       │  + DELETE /:id           NEW           │
       └────────────────────────────────────────┘
                          │
                          ▼
       ┌────────────────────────────────────────┐
       │ backend/src/loop/orchestrator.ts       │
│  + rePrompt(id, prompt) NEW            │
│  reuses: stopLoop(), runLoop()         │
       └────────────────────────────────────────┘
```

The chatbot's hybrid matcher is **pure UI logic** — no backend round-trip per query.

---

## 4. Component Spec

### 4.1 `PersistentTaskCard.tsx` (NEW, ~80 LoC)

| Aspect | Detail |
|---|---|
| Mount point | Inside `ChatbotNode.tsx`, between existing prompt textarea and `<ChatThread />` |
| Visibility | Rendered only when `taskMirror.activeTaskId` is set; returns `null` otherwise |
| Layout | `rounded-xl border border-white/10 bg-white/5 p-3`, two rows: title+actions / phase·attempts·elapsed |
| Read-only state | Title (truncated 60 chars + tooltip) · phase chip · "attempt N of 3" · elapsed mm:ss · ✎ Rewrite button · 🗑 Delete button |
| Editing state | Title becomes editable textarea (auto-focus, select-all); Save + Cancel replace action row; Save disabled when prompt empty/unchanged |
| Reused UI | `<PhaseChip />` from `NodeConfigPanel.tsx`; existing `rounded-xl / border-white/10 / bg-white/5` card style |
| Cleanup | `setInterval` for elapsed-time ticker is cleared on unmount |
| Action disabled | Buttons disabled when `taskMirror.phase` is `implementing` or `verifying`; tooltip explains "Wait for current phase to finish" |

### 4.2 `ChatThread.tsx` (NEW, ~50 LoC)

| Aspect | Detail |
|---|---|
| State | Local `useState<ChatMessage[]>` where `ChatMessage = { role: 'user' \| 'bot', content: ReactNode, timestamp: number }` |
| Lifecycle | Cleared on: page refresh; `task_deleted` WebSocket event; new task assignment (when `activeTaskId` changes to a different value). Re-prompt keeps the same `activeTaskId`, so the thread is preserved across rewrites. |
| Rendering | User messages right-aligned with subtle bg; bot messages left-aligned with the intent's `ReactNode` content |
| Empty state | Renders a centered hint "Try asking: 'plan', 'files', 'workdir', 'help'" |
| Persistence | None — explicitly ephemeral |

### 4.3 `ChatInput.tsx` (NEW, ~40 LoC)

| Aspect | Detail |
|---|---|
| Element | Auto-growing `<textarea>` (max 4 lines) + send button (▶) |
| Submit | Enter sends, Shift+Enter inserts newline; click ▶ sends |
| Empty message | Trimmed-empty input → no-op (no message appended) |
| Placeholder | "Ask me about the task or project…" when task active; "No active task — assign one above to chat" when idle |
| Accessibility | `<label htmlFor="chat-input">` for screen readers; visible focus ring |

### 4.4 `IntentReply.tsx` (NEW, ~40 LoC)

| Aspect | Detail |
|---|---|
| Purpose | Renders the JSX returned by an intent's `render()` function |
| File links | All `file://` links get `target="_blank" rel="noopener noreferrer"` + `text-sky-400 hover:text-sky-300 underline` |
| Layout | Wraps content in a bot-message bubble (left-aligned, subtle bg) |
| Reused UI | Same `<PhaseChip />` from `NodeConfigPanel.tsx` for status/verdict replies |

### 4.5 `ConfirmDeleteModal.tsx` (NEW, ~30 LoC)

| Aspect | Detail |
|---|---|
| Mount point | Rendered inside `PersistentTaskCard` (or `ChatbotNode`); shown only when delete is requested |
| Title | "Delete this task and its history?" |
| Body | "This can't be undone." |
| Buttons | Cancel (zinc) / Delete (rose-600 destructive) |
| Accessibility | Traps focus; closes on Escape; `role="alertdialog"` |
| On confirm | Calls `DELETE /api/tasks/:id`; on success, card unmounts via `task_deleted` event |

### 4.6 `chatbotIntents.ts` (NEW, ~120 LoC)

Exports `intents: ChatbotIntent[]` and `matchIntent(message, state)`. See Section 7 below for the full 8-intent spec.

### 4.7 `ChatbotNode.tsx` (MODIFIED, +60/-20 LoC)

- Imports and mounts `<PersistentTaskCard />` between existing prompt textarea and `<ChatThread />`.
- Imports and mounts `<ChatThread />` and `<ChatInput />` below the card.
- Wires `ChatInput` onSubmit → `matchIntent(message, taskMirror)` → appends `{role:'user', content: message}` then `{role:'bot', content: <IntentReply intent={matched} />}`.
- Subscribes to `task_deleted` WebSocket event → clears chat thread state.

---

## 5. Backend Changes

### 5.1 New endpoint: `POST /api/tasks/:id/re-prompt`

```ts
router.post('/:id/re-prompt', async (req, res) => {
  const { id } = req.params;
  const { prompt } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt required' });

  const task = store.get(id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  if (task.status === 'approved') {
    return res.status(409).json({ error: 'task already approved — assign a new task' });
  }

  try {
    const attempt = await orchestrator.rePrompt(id, prompt.trim());
    return res.json({ ok: true, attempt });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});
```

### 5.2 Modify existing endpoint: `DELETE /api/tasks/:id`

**Correction (post-approval):** the `DELETE /api/tasks/:id` endpoint **already exists** at `backend/src/api/tasks.ts:213-219`. It uses `stopLoop(id)` + `removeTask(id)` and returns 404 on missing. **No new endpoint needed** — modify the existing handler to emit `task_deleted` after the row is removed.

```ts
// backend/src/api/tasks.ts (existing handler, modified)
tasksApi.delete("/tasks/:id", (c) => {
  const id = c.req.param("id");
  if (isLoopRunning(id)) stopLoop(id);
  const removed = removeTask(id);
  if (!removed) return c.json({ error: "task not found" }, 404);
  // NEW: broadcast deletion so UI can clean up card + chat thread + sidebar
  broadcaster.broadcast(id, { type: "task_deleted", taskId: id });
  return c.json({ ok: true });
});
```

### 5.3 New orchestrator function: `rePrompt(taskId, newPrompt)`

**Reuses** the existing `stopLoop()`, `updateTask()`, `setStatus()`, and `runLoop()` helpers. The shape mirrors `resetTask` (line 194) but additionally overwrites `prompt`.

```ts
// backend/src/loop/orchestrator.ts (new function, exported)
export function rePrompt(taskId: string, newPrompt: string): boolean {
  const task = getTask(taskId);
  if (!task) return false;
  if (task.status === "approved" || task.status === "done") {
    // Terminal — don't allow rewrite; user should assign a new task.
    return false;
  }

  // 1. Stop current loop if running (graceful — same path as POST /:id/stop)
  if (isLoopRunning(taskId)) stopLoop(taskId);

  // 2. Overwrite prompt + bump attempt counter + reset plan/diff/verdict
  const nextAttempt = (task.attempt ?? 0) + 1;
  updateTask(taskId, {
    prompt: newPrompt,
    attempt: nextAttempt,
    status: "draft",
    plan: undefined,
    diff: undefined,
    verdict: undefined,
    escalationReason: undefined,
    history: [],
    logs: [],
  });

  // 3. Broadcast task_update so the UI sees the cleared state immediately
  const updated = getTask(taskId);
  if (updated) {
    broadcaster.broadcast(taskId, { type: "task_update", taskId, task: updated });
    // 4. NEW: broadcast dedicated re-prompt event so the UI can collapse the
    //    card and clear chat thread without diffing the task_update payload
    broadcaster.broadcast(taskId, {
      type: "task_re_prompted",
      taskId,
      prompt: newPrompt,
      attempt: nextAttempt,
    });
  }

  // 5. Re-spawn the loop (fire-and-forget; runLoop handles errors internally)
  void runLoop(taskId).catch((err) => {
    console.error(`[orchestrator] re-prompt loop ${taskId} crashed:`, err);
  });

  return true;
}
```

> **Field-name correction (post-approval)**: the spec originally wrote `attempt` and `task.cancel()`; the actual schema uses `attempt` (no `Count` suffix) and the orchestrator uses `stopLoop()` (not `cancel()`). Adjusted to match reality.

### 5.4 Delete task: reuse existing `removeTask`

**Correction (post-approval):** the store helper `removeTask(taskId)` **already exists** at `backend/src/store/tasks.ts`. It removes the row from the in-memory map and broadcasts the deletion. **No new store helper needed.**

### 5.5 New WebSocket message types

Add two new variants to the `WsServerMessage` discriminated union in `backend/src/types.ts:169-180`:

```ts
export type WsServerMessage =
  | { type: "pong" }
  | { type: "task_update"; taskId: string; task: Task }
  | { type: "log"; taskId: string; entry: LogEntry }
  | { type: "phase_change"; taskId: string; from: TaskStatus; to: TaskStatus }
  | { type: "node_status"; taskId: string; nodeId: string; status: string }
  | { type: "plan_ready"; taskId: string; plan: PlanSummary }
  | { type: "diff_ready"; taskId: string; diff: DiffSummary }
  | { type: "verdict"; taskId: string; verdict: Verdict }
  | { type: "escalation"; taskId: string; reason: string }
  | { type: "done"; taskId: string; summary: string }
  | { type: "error"; taskId: string; message: string }
  | { type: "task_re_prompted"; taskId: string; prompt: string; attempt: number }  // NEW
  | { type: "task_deleted"; taskId: string };                                       // NEW
```

**Note on naming**: the existing message variants use snake_case (`task_update`, `phase_change`, `plan_ready`). The new variants follow the same convention: `task_re_prompted` and `task_deleted`. The spec originally wrote `task_re_prompted` and `task_deleted` — corrected to match the existing event-naming convention.

| Event | Payload | Emitted by | UI reaction |
|---|---|---|---|
| `task_re_prompted` | `{ taskId, prompt, attempt }` | `orchestrator.rePrompt` | Card collapses to read-only, clears plan/diff/verdict display, increments attempts |
| `task_deleted` | `{ taskId }` | modified DELETE handler | Card unmounts, chat thread clears, sidebar entry removed |

All other events (`task_update`, `plan_ready`, `diff_ready`, `verdict`, `phase_change`, `log`) are **reused as-is**.

### 5.6 Schema

**No schema changes.** Every field already exists on `Task`:
- `prompt: string` — overwriteable.
- `attempt?: number` — incrementable.
- `phase: 'planning' \| ...` — resettable.
- `status: 'running' \| ...` — resettable.
- `plan?, diff?, verdict?, error?` — clearable.

---

## 6. Frontend Changes

| File | Status | LoC | Purpose |
|---|---|---|---|
| `ui/src/components/canvas/chatbotIntents.ts` | NEW | ~120 | Intent array `{ keywords, render }` × 8; `matchIntent()` |
| `ui/src/components/canvas/ChatbotNode.tsx` | MODIFIED | +60 / −20 | Mount card, thread, input; wire onSubmit → intent match; subscribe to `task_deleted` |
| `ui/src/components/canvas/PersistentTaskCard.tsx` | NEW | ~80 | Card UI; Rewrite inline editor; elapsed-time ticker; Delete modal trigger |
| `ui/src/components/canvas/ChatThread.tsx` | NEW | ~50 | Renders message array with role-aware styling |
| `ui/src/components/canvas/IntentReply.tsx` | NEW | ~40 | Renders one intent's JSX reply with `file://` link styling |
| `ui/src/components/canvas/ChatInput.tsx` | NEW | ~40 | Auto-growing textarea + send button |
| `ui/src/components/canvas/ConfirmDeleteModal.tsx` | NEW | ~30 | Destructive confirmation modal |
| `ui/src/components/canvas/chatbotIntents.test.ts` | NEW | ~80 | Unit tests for `matchIntent` |

Total new lines: ~440. Modified `ChatbotNode.tsx`: net +40.

---

## 7. Hybrid Intent Set (8 intents)

### 7.1 Intent shape

```ts
export interface ChatbotIntent {
  id: string;
  keywords: (string | RegExp)[];       // matched case-insensitive against user message
  render: (state: TaskMirror) => ReactNode;
  description: string;                  // for the help listing
}

export function matchIntent(message: string, state: TaskMirror): ChatbotIntent {
  const lower = message.toLowerCase().trim();
  return (
    intents.find(intent =>
      intent.keywords.some(kw =>
        typeof kw === 'string' ? lower.includes(kw) : kw.test(lower)
      )
    ) ?? helpIntent                       // fallback
  );
}
```

### 7.2 The 8 intents (in order — first-match-wins)

| # | ID | Keywords | Canned reply | Empty-state reply |
|---|---|---|---|---|
| 1 | `help` | `help`, `?`, `commands`, "what can you do" | Bulleted list of all 8 intents | works regardless |
| 2 | `status` | `status`, `phase`, `progress`, "what's happening", "is it done", "where are we" | Phase chip · "attempt N of 3" · elapsed mm:ss | "No active task — assign one above to get started." |
| 3 | `plan` | `plan`, "what's the plan", "show plan", `roadmap`, `approach` | Plan phases list + filesToTouch with `file://` links | "No active task." |
| 4 | `files` | `files`, "list files", "what files", "which files" | Bullet list of `filesToTouch` with `file://` hrefs | "No active task." |
| 5 | `diff` | `diff`, "what changed", "show diff", `changes` | Diff headline + files changed with `file://` hrefs | "No active task." |
| 6 | `verdict` | `verdict`, `approved`, `rejected`, "passed?", "failed?" | Verdict badge + blockers + mustFix list | "No active task." |
| 7 | `workdir` | `workdir`, `folder`, `where`, "project folder" | workdir path with `file://` href | "No active task — assign one to see its workdir." |
| 8 | `logs` | `logs`, "show logs", "what just happened", `activity` | Last 20 log lines in monospace block | "No active task." |

`help` is special — fallback if no other intent matches, and reachable explicitly.

### 7.3 Ordering rationale

Specific intents go first because keywords can overlap:
- `help` first so `?` doesn't accidentally match `verdict` ("approved?")
- `status` before `plan` (status words like "phase" overlap with plan queries)
- `files` before `diff` (file queries can contain "diff" accidentally)

### 7.4 `file://` link format

```tsx
<a
  href={`file://${state.workdir}/${filePath}`}
  target="_blank"
  rel="noopener noreferrer"
  className="underline text-sky-400 hover:text-sky-300"
>
  {filePath}
</a>
```

Works on local Electron. If ever web-deployed, swap to backend proxy (out of scope for v1).

---

## 8. Data Flow

### 8.1 Rewrite

1. User clicks ✎ Rewrite on PersistentTaskCard.
2. Card morphs into editable textarea (auto-focus, select-all).
3. User edits, hits Save → `POST /api/tasks/:id/re-prompt { prompt }`.
4. Backend: `stopLoop(taskId)` (graceful, 5s timeout, SIGKILL fallback) → update prompt + `attempt++` + reset phase → emit `task_re_prompted` → `runLoop(taskId)` (fire-and-forget).
5. UI: card collapses to read-only; existing WebSocket events (`task:phase`, `task:plan`, etc.) flow normally.

### 8.2 Delete

1. User clicks 🗑 Delete on PersistentTaskCard.
2. `<ConfirmDeleteModal />` opens over the chatbot node.
3. On confirm → `DELETE /api/tasks/:id`.
4. Backend: `stopLoop(taskId)` → `removeTask(id)` (hard-delete + unlink from projects) → emit `task_deleted`.
5. UI: card unmounts; chat thread clears; sidebar entry removed.

### 8.3 Free-text query

1. User types in `<ChatInput />`, hits Enter or ▶.
2. `ChatbotNode` calls `matchIntent(message, taskMirror)`.
3. First-match-wins over the 8 intents.
4. Matched intent's `render(taskMirror)` returns JSX.
5. `ChatThread` appends `{ role: 'user', content: message }` then `{ role: 'bot', content: <IntentReply /> }`.
6. **No state mutation, no backend call.**

---

## 9. Acceptance Criteria

| # | Criterion |
|---|---|
| AC1 | After assigning a task, the PersistentTaskCard renders below the existing prompt textarea with title, phase chip, attempt counter, elapsed time, and Rewrite / Delete buttons. |
| AC2 | Clicking ✎ Rewrite converts the card to an editable textarea pre-filled with the current prompt; Save is disabled when prompt is empty or unchanged. |
| AC3 | Saving a rewrite sends `POST /api/tasks/:id/re-prompt`; the same task id is reused, attempt counter increments, and the loop re-spawns with a new plan emitted within 5s. |
| AC4 | Clicking 🗑 Delete opens `<ConfirmDeleteModal />`; on confirm, `DELETE /api/tasks/:id` succeeds, card disappears, chat thread clears, and the sidebar entry is removed. |
| AC5 | The chat input below the card accepts free-text queries; sending routes via `matchIntent` to one of 8 canned replies. |
| AC6 | Canned replies include `file://` links for workdir, plan files, and diff files; clicking opens the file in Finder. |
| AC7 | When no task is active, every intent (except `help`) renders a graceful "No active task" message. |
| AC8 | Sending a message that matches no keyword falls through to the `help` reply (which lists all 8 intents). |
| AC9 | `POST /:id/re-prompt` on an `approved` task returns 409 with a clear error message. |
| AC10 | `DELETE /:id` on an already-deleted task returns 404 (idempotent — UI treats as success). |
| AC11 | The existing planner → implement → verify workflow loop is unchanged (no edits to `loop/orchestrator.ts` except for the new `rePrompt()` function). |
| AC12 | The existing `taskMirror` Zustand store continues to drive all UI state; no parallel state store is introduced. |

---

## 10. Test Scenarios

### 10.1 Unit tests (`chatbotIntents.test.ts`)

```ts
describe('matchIntent', () => {
  const empty = makeEmptyTaskMirror();
  it.each([
    ["what's the plan?", 'plan'],
    ['show me the files', 'files'],
    ['approved?', 'verdict'],
    ['where is the project', 'workdir'],
    ['logs', 'logs'],
    ['asdfgh', 'help'],            // fallback
    ['HELP', 'help'],              // case-insensitive
    ['is it done?', 'status'],
    ['? what can you do', 'help'],
    ['show diff', 'diff'],
    ['changes', 'diff'],
  ])('routes "%s" → %s', (msg, expected) => {
    expect(matchIntent(msg, empty).id).toBe(expected);
  });
});
```

### 10.2 Integration tests (manual or Playwright)

| # | Setup | Action | Expected |
|---|---|---|---|
| IT1 | Idle task | POST /re-prompt with new prompt | 200, attempt=1, phase=planning, planner emits events |
| IT2 | Task running in `implementing` | POST /re-prompt | cancel → 5s wait → re-spawn → new plan emitted within 10s |
| IT3 | task.status=approved | POST /re-prompt | 409 with error message |
| IT4 | Task running | DELETE | cancel → row deleted → `task_deleted` event → UI unmounts card |
| IT5 | Task already deleted | DELETE | 404 (idempotent) |
| IT6 | UI: assign task → click Rewrite mid-flight | edit prompt → Save | card collapses; new attempt; new plan arrives in chat thread within 5s |
| IT7 | UI: assign task → click Delete | confirm in modal | card disappears; chat thread clears; sidebar entry gone |
| IT8 | UI: type "show me files" | send | bot reply lists filesToTouch with `file://` hrefs; clicking opens Finder |
| IT9 | UI: type "asdfgh" | send | bot reply = help listing |
| IT10 | UI: type "?" | send | bot reply = help listing |

### 10.3 Visual smoke

- Dev-only `/chatbot-lab` route (Vite tree-shaken from prod) mounts `<ChatThread />` with URL-param-driven synthetic state.
- Reuses the `dev-only component-lab route` pattern: `/<component>-lab` in `routes.ts` gated behind `import.meta.env.DEV`.

---

## 11. Open Questions

**None.** All clarifying questions resolved in the brainstorming session:
- Chatbot intelligence: hybrid (option 2)
- File links: `file://` URIs (option 1)
- Rewrite semantics: same task, prompt edit + restart (option 2)
- Delete semantics: cancel + remove with confirmation modal (option 1)
- Card placement: inside ChatbotNode, below existing header (option 1)
- Intent set: 8 intents (status, plan, files, diff, verdict, workdir, logs, help)
- Architecture: separate intents module (option 2)

---

## 12. Out of Scope / Future Work

- **Real LLM** — would replace `chatbotIntents.ts` with a backend proxy that calls an LLM with `taskMirror` as context. ~3 days of work.
- **Workdir file reads** — `cat <file>` intent requires a backend endpoint that reads from `workdir`. Adds security review.
- **Cross-session chat history** — persist `ChatMessage[]` to localStorage keyed by `activeTaskId`.
- **Streaming replies** — only meaningful with an LLM; not applicable to hybrid.
- **Multi-language** — add `i18n` keys for all intent labels and replies.
- **TopBar chip** — promote the persistent card to a compact chip in `TopBar.tsx` so it's visible even when `ChatbotNode` is removed from canvas.
- **Voice input** — Web Speech API; needs permission flow.

---

## 13. Transition

This spec is approved by the user (Sections 1–4 each got explicit "ok"/"done" approval). Next step: **transition to `writing-plans` skill** to generate the implementation plan, which will decompose the above into ordered, executable tasks for the implementation agent.