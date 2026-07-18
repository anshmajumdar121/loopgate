# Current Goal
## Task
Verify the chatbot node model fix — add a unit test confirming `ChatbotNode.handleSend()` includes `modelOverrides` with `planning`, `implementation`, and `review` keys from the `nodeModels` store when POSTing `/api/tasks`.

## Completion Criteria
- [ ] `ui/src/components/canvas/__tests__/ChatbotNode.test.tsx` exists and passes `npm test`
- [ ] `npm run build` in `ui/` exits 0 (no TypeScript errors introduced)
- [ ] Test uses a mock `globalThis.fetch` that intercepts the `POST /api/tasks` call and asserts `modelOverrides` is present with all three keys (`planning`, `implementation`, `review`) in the request body
- [ ] Test confirms the `modelOverrides` values are the exact strings read from the Zustand `nodeModels` slice
- [ ] `npm test` in `ui/` passes (all existing tests still pass)

## Implementation Plan
1. **Create `ui/src/components/canvas/__tests__/ChatbotNode.test.tsx`** — unit test file for `ChatbotNode` model fix verification.
2. **Mock `globalThis.fetch`** with `vi.fn` in `beforeEach`, restore in `afterEach` (same pattern as `ImprovePanel.test.tsx`).
3. **Mock the Zustand `useWorkflow` store** using `vi.mock` for `@/lib/store` so the component renders in the jsdom environment without needing localStorage.
4. **Render `ChatbotNode`** with minimal valid `NodeProps` data (id: `"chatbot"`, spec with kind: `"chatbot"`, icon, status: `"idle"`).
5. **Assert the POST body** — interact with the component to trigger `handleSend` (fill prompt, click send), then assert `JSON.parse(fetch.mock.calls[0][1]?.body)`.`modelOverrides` has keys `planning`, `implementation`, `review` with values matching the mocked store's `nodeModels`.
6. **Run `npm test`** in `ui/` — verify the new test passes and all existing tests still pass.
7. **Run `npm run build`** in `ui/` — verify zero TypeScript errors.

## Files to touch
- `ui/src/components/canvas/__tests__/ChatbotNode.test.tsx` — **new file** (test only)
- `ui/src/components/canvas/ChatbotNode.tsx` — **read-only** (do not edit; the fix is already committed in `708e203`)

## Files NOT to touch (denylist)
- `.env`, `.env.*`, `**/secrets/**`, `**/credentials/**`, `**/*_key*`, `**/*_secret*`, `**/migrations/**`, `auth/**`, `payments/**`, `billing/**`
- `ui/src/lib/store.ts` — do not edit
- `ui/src/types/loop.ts` — do not edit
- `package.json` (any workspace) — do not add dependencies
- `vitest.config.ts` — do not edit

## Notes for the maker
- The fix is already applied in commit `708e203` (`fix(ui): send modelOverrides from the canvas quick-create chatbot input`). This task adds a **regression test** so the fix doesn't regress.
- The mock pattern follows `ImprovePanel.test.tsx` exactly: save `originalFetch`, replace `globalThis.fetch` with `vi.fn`, restore in `afterEach`.
- The Zustand store has module-level initialization (`loadNodeModelsFromStorage()` at module level) that reads `localStorage` — this breaks in jsdom. Use `vi.mock("@/lib/store", ...)` to return a minimal store shape.
- `DEFAULT_MODEL_ID` from `@/types/loop` is `"opencode-go/minimax-m3"` — use this as the expected default value in the mock store's `nodeModels`.
- The `modelOverrides` shape is `{ planning: string, implementation: string, review: string }` (matches `CreateTaskBody` in `backend/src/types.ts`).
- Test commands: `cd /Users/anshmajumdar/Desktop/Loop\ Agent/ui && npm test` and `npm run build`.
