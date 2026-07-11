# Loop Agent — Prototype Factory Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Loop Agent from an open-loop code generator into a closed-loop prototype factory: after the maker writes code, the orchestrator SERVES it at a local live link, EXECUTES it in a headless browser, feeds the observed console/page errors to the verifier and to the next maker attempt, and hands the user a clickable preview URL when done.

**Architecture:** All changes are backend-side additions in `backend/src/loop/` plus additive fields on existing types. Two new modules: `preview-server.ts` (one shared static HTTP server mapping `/t/<taskId>/` → task workdir) and `runtime-check.ts` (Playwright chromium smoke test producing a structured evidence object). The orchestrator wires them in between the maker and verifier phases. The maker bridge (`llm-agent.mjs`) gains multi-file output. The UI is NOT restructured — one new self-contained component is added and mounted with a single line.

**Tech Stack:** Node 24 + TypeScript (existing), Hono (existing), chokidar (existing), vitest (existing, `npm test`), Playwright (new dependency, chromium only).

---

## HARD CONSTRAINTS — read before touching anything

1. **DO NOT modify or restructure the existing UI.** The files in `ui/src/components/` and `ui/src/pages/` keep their current structure, styling, and behavior. You may ONLY: (a) create NEW component files, (b) add a SINGLE line to mount a new component, (c) add OPTIONAL fields to type definitions. If a task seems to require editing existing UI logic, stop — you're doing it wrong.
2. **All new `Task` fields are optional** (`?:`) so existing persisted task JSON in `backend/data/tasks/` keeps loading.
3. **Do not change WS message shapes** — the existing `WsServerMessage` union in `backend/src/types.ts` must remain backward compatible. New info rides on `task_update` (the whole task is already broadcast).
4. **Build & restart procedure** (used after every backend task):
   ```bash
   cd "/Users/anshmajumdar/Desktop/Loop Agent/backend" && npx tsc
   kill $(lsof -t -i :3001 -sTCP:LISTEN) 2>/dev/null; sleep 1
   nohup node dist/index.js > /tmp/loop-backend.log 2>&1 < /dev/null & disown
   sleep 2 && curl -s http://localhost:3001/api/health   # expect {"status":"ok",...}
   ```
5. **Run tests with:** `cd "/Users/anshmajumdar/Desktop/Loop Agent/backend" && npx vitest run <file>`
6. Known context (do not re-litigate): phase timeouts are already fixed (`PHASE_TIMEOUT_MS` 10 min, `MAKER_TIMEOUT_MS` 25 min in `orchestrator.ts`); the watcher (`state-sync.ts`) works and has a `ready()` gate and `awaitWriteFinish`; `llm-agent.mjs` already guards against empty LLM content (thinking-model salvage + exit 1).

## Key existing interfaces you will build against (verified 2026-07-10)

- `backend/src/types.ts` — `Task` (fields: id, title, prompt, workdir, status, attempt, maxAttempts, model?, modelOverrides?, plan?, diff?, verdict?, history, logs, agentPid?, escalationReason?, projectId?, sessionId?), `PlanSummary { steps: number; filesToTouch: string[]; criteria: string[]; risks: string[]; notes: string; rawGoal: string }`, `DiffSummary`, `Verdict`, `CreateTaskBody`.
- `backend/src/loop/parser.ts` — `parsePlanGoal(markdown): PlanSummary` (line 250), `parseStateDiff(markdown)` (line 287), `parseVerdictOutcome` (line 324).
- `backend/src/loop/orchestrator.ts` — `runLoop(taskId)`; plan saved via `updateTask(taskId, { plan })` at ~line 474; diff saved at ~line 647; verifier prompt built by `async function buildVerifierPrompt(attempt, goalContent, stateContent, workdir, diff)` at ~line 1185; maker prompt by `buildMakerPrompt` at ~line 1065; REJECT feedback carried by module-level `LAST_FEEDBACK: Map<string,string>`.
- `backend/src/loop/agent-spawner.ts` — `spawnBridgeRunner` spawns `node llm-agent.mjs --model … --workdir … --role planner|maker|verifier --output <file>`; output mapping `planner→GOAL.md, maker→index.html, verifier→STATE.md`; env `LOOP_USER_PROMPT`, `LOOP_ATTEMPT`, `LOOP_TASK_ID`.
- `backend/src/api/tasks.ts` — Hono routes; `createSchema` (zod) at top; `POST /api/tasks` calls `createTask(...)` then `void runLoop(task.id)`.
- `backend/src/store/tasks.ts` — `createTask(input)`, `getTask`, `updateTask(id, patch)` (shallow-merge patch), `appendLog`, `setStatus`.
- `backend/llm-agent.mjs` — plain Node ESM script; maker path extracts one ` ```html ` block → writes `args.output`, then appends a `## Diff Summary — Attempt N` section to STATE.md.

---

### Task 1: Live preview server

Serve every task's workdir at `http://localhost:3210/t/<taskId>/` and store the URL on the task.

**Files:**
- Create: `backend/src/loop/preview-server.ts`
- Create: `backend/src/loop/__tests__/preview-server.test.ts`
- Modify: `backend/src/types.ts` (one optional field)

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/loop/__tests__/preview-server.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPreview, stopPreviewServer } from "../preview-server.js";

describe("preview-server", () => {
  afterAll(() => stopPreviewServer());

  it("serves a registered workdir's index.html at /t/<taskId>/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview-"));
    await writeFile(join(dir, "index.html"), "<h1>hello preview</h1>", "utf8");
    const url = await registerPreview("task123", dir);
    expect(url).toMatch(/^http:\/\/localhost:\d+\/t\/task123\/$/);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello preview");
  });

  it("blocks path traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview2-"));
    await writeFile(join(dir, "index.html"), "x", "utf8");
    const url = await registerPreview("task456", dir);
    const res = await fetch(url + "..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(404);
  });

  it("404s unknown task ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "preview3-"));
    const base = (await registerPreview("known", dir)).replace("/t/known/", "");
    const res = await fetch(`${base}/t/unknown/index.html`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd "/Users/anshmajumdar/Desktop/Loop Agent/backend" && npx vitest run src/loop/__tests__/preview-server.test.ts`
Expected: FAIL — `Cannot find module '../preview-server.js'`

- [ ] **Step 3: Implement the module**

```ts
// backend/src/loop/preview-server.ts
//
// One shared static HTTP server for task previews. Each task registers its
// workdir and gets back http://localhost:<port>/t/<taskId>/ — the "live
// link" the user opens to try the prototype. Lazy-started on first
// registration so the backend doesn't hold a port when no task ran yet.
//
// Deliberately dependency-free (node:http) — a static file map is all we
// need, and the backend already avoids framework servers outside Hono.

import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve as pathResolve, normalize, extname } from "node:path";

const PREVIEW_PORT = Number(process.env.LOOP_PREVIEW_PORT || 3210);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
};

// taskId → absolute workdir
const registry = new Map<string, string>();
let server: Server | null = null;
let listening: Promise<void> | null = null;

function ensureServer(): Promise<void> {
  if (listening) return listening;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PREVIEW_PORT}`);
    // Path shape: /t/<taskId>/<rest...>  (decodeURIComponent guards %2F tricks)
    const m = decodeURIComponent(url.pathname).match(/^\/t\/([^/]+)\/(.*)$/);
    if (!m) {
      res.writeHead(404).end("not found");
      return;
    }
    const [, taskId, rest] = m;
    const workdir = registry.get(taskId);
    if (!workdir) {
      res.writeHead(404).end("unknown task");
      return;
    }
    const rel = rest === "" ? "index.html" : rest;
    const target = pathResolve(workdir, normalize(rel));
    // Traversal guard: resolved path must stay inside the workdir.
    if (!target.startsWith(pathResolve(workdir) + "/") && target !== pathResolve(workdir)) {
      res.writeHead(404).end("not found");
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store", // always serve the freshest attempt
    });
    createReadStream(target).pipe(res);
  });
  listening = new Promise<void>((resolveP, rejectP) => {
    server!.once("error", rejectP);
    server!.listen(PREVIEW_PORT, () => resolveP());
  });
  return listening;
}

/** Register (or re-register) a task's workdir. Returns the preview URL. */
export async function registerPreview(taskId: string, workdir: string): Promise<string> {
  registry.set(taskId, pathResolve(workdir));
  await ensureServer();
  return `http://localhost:${PREVIEW_PORT}/t/${taskId}/`;
}

/** Test/shutdown helper. */
export function stopPreviewServer(): void {
  server?.close();
  server = null;
  listening = null;
  registry.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/loop/__tests__/preview-server.test.ts`
Expected: 3 passed

- [ ] **Step 5: Add the optional Task field**

In `backend/src/types.ts`, inside `export interface Task { … }`, directly after the line `escalationReason?: string;` add:

```ts
  /** Live static preview of the workdir (set once the maker has produced
   *  output). Served by loop/preview-server.ts. Optional + additive so
   *  previously persisted tasks keep loading. */
  previewUrl?: string;
```

- [ ] **Step 6: Build + commit**

```bash
cd "/Users/anshmajumdar/Desktop/Loop Agent/backend" && npx tsc && cd .. && \
git add backend/src/loop/preview-server.ts backend/src/loop/__tests__/preview-server.test.ts backend/src/types.ts && \
git commit -m "feat(backend): live preview server serving task workdirs at /t/<taskId>/"
```
(If the repo is not a git repo, run `git init` at `/Users/anshmajumdar/Desktop/Loop Agent/` first and make an initial commit of the current state before starting.)

---

### Task 2: Runtime check module (headless browser execution)

Execute the prototype in headless chromium and return structured evidence: console errors, uncaught page errors, failed network requests, screenshot.

**Files:**
- Create: `backend/src/loop/runtime-check.ts`
- Create: `backend/src/loop/__tests__/runtime-check.test.ts`
- Modify: `backend/package.json` (dependency)

- [ ] **Step 1: Install Playwright (chromium only)**

```bash
cd "/Users/anshmajumdar/Desktop/Loop Agent/backend" && npm install playwright && npx playwright install chromium
```
Expected: exit 0. (~120MB download for chromium; one-time.)

- [ ] **Step 2: Write the failing test**

```ts
// backend/src/loop/__tests__/runtime-check.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPreview, stopPreviewServer } from "../preview-server.js";
import { runRuntimeCheck } from "../runtime-check.js";

describe("runtime-check", () => {
  afterAll(() => stopPreviewServer());

  it("captures a thrown script error and reports ok=false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-bad-"));
    await writeFile(
      join(dir, "index.html"),
      `<!doctype html><title>bad</title><script>throw new Error("boom-at-load")</script>`,
      "utf8"
    );
    const url = await registerPreview("rt-bad", dir);
    const result = await runRuntimeCheck(url, dir, 1);
    expect(result.ok).toBe(false);
    expect(result.pageErrors.join("\n")).toContain("boom-at-load");
  }, 60_000);

  it("reports ok=true for a clean page and takes a screenshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-good-"));
    await writeFile(
      join(dir, "index.html"),
      `<!doctype html><title>good</title><button id="b">Click</button><script>document.getElementById("b").addEventListener("click",()=>{document.title="clicked"})</script>`,
      "utf8"
    );
    const url = await registerPreview("rt-good", dir);
    const result = await runRuntimeCheck(url, dir, 1);
    expect(result.ok).toBe(true);
    expect(result.pageErrors).toEqual([]);
    expect(result.consoleErrors).toEqual([]);
    expect(result.screenshotPath).toBeTruthy();
    expect(result.interactionLog.length).toBeGreaterThan(0); // clicked the button
  }, 60_000);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/loop/__tests__/runtime-check.test.ts`
Expected: FAIL — `Cannot find module '../runtime-check.js'`

- [ ] **Step 4: Implement the module**

```ts
// backend/src/loop/runtime-check.ts
//
// The "trial" in trial-and-error. Loads the served prototype in headless
// chromium, watches for console errors / uncaught exceptions / failed
// requests, pokes the first few interactive elements, and screenshots the
// result. The returned evidence is injected verbatim into the verifier's
// prompt (Task 3) so verdicts are grounded in observed behavior instead of
// source-reading vibes. Artifacts land in <workdir>/.loop/ for the human.

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RuntimeCheckResult {
  ok: boolean;
  url: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  interactionLog: string[];
  screenshotPath: string | null;
  /** Pre-formatted markdown block for prompt injection. */
  evidenceMarkdown: string;
}

const SETTLE_MS = 2_500; // let init scripts / rAF loops run
const MAX_INTERACTIONS = 5;

export async function runRuntimeCheck(
  url: string,
  workdir: string,
  attempt: number
): Promise<RuntimeCheckResult> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const interactionLog: string[] = [];
  let screenshotPath: string | null = null;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 500));
    });
    page.on("pageerror", (err) => pageErrors.push(String(err).slice(0, 500)));
    page.on("requestfailed", (req) =>
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "?"}`)
    );

    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(SETTLE_MS);

    // Smoke interactions: click the first few visible buttons/links so
    // handlers with immediate errors get exercised. Errors they throw are
    // captured by the pageerror listener above.
    const clickables = page.locator("button:visible, [role='button']:visible, a[href='#']:visible");
    const count = Math.min(await clickables.count(), MAX_INTERACTIONS);
    for (let i = 0; i < count; i++) {
      try {
        const el = clickables.nth(i);
        const label = ((await el.textContent()) ?? "").trim().slice(0, 40) || `<element ${i}>`;
        await el.click({ timeout: 2_000 });
        interactionLog.push(`clicked "${label}" — ok`);
        await page.waitForTimeout(300);
      } catch (err) {
        interactionLog.push(`click ${i} failed: ${String(err).slice(0, 200)}`);
      }
    }

    const loopDir = join(workdir, ".loop");
    await mkdir(loopDir, { recursive: true });
    screenshotPath = join(loopDir, `runtime-attempt-${attempt}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } catch (err) {
    pageErrors.push(`runtime-check harness error: ${String(err).slice(0, 300)}`);
  } finally {
    await browser.close();
  }

  const ok = pageErrors.length === 0 && consoleErrors.length === 0;
  const fmt = (label: string, items: string[]) =>
    items.length === 0 ? `${label}: none` : `${label}:\n${items.map((i) => `  - ${i}`).join("\n")}`;
  const evidenceMarkdown = [
    `Loaded ${url} in headless chromium (viewport 1280x800, settled ${SETTLE_MS}ms).`,
    fmt("Uncaught page errors", pageErrors),
    fmt("Console errors", consoleErrors),
    fmt("Failed network requests", failedRequests),
    fmt("Smoke interactions", interactionLog),
    `Overall: ${ok ? "NO runtime errors observed" : "RUNTIME ERRORS OBSERVED — the prototype is broken as shipped"}`,
  ].join("\n");

  const result: RuntimeCheckResult = {
    ok, url, consoleErrors, pageErrors, failedRequests, interactionLog,
    screenshotPath, evidenceMarkdown,
  };
  // Persist the evidence JSON next to the screenshot for post-mortems.
  try {
    await writeFile(
      join(workdir, ".loop", `runtime-attempt-${attempt}.json`),
      JSON.stringify(result, null, 2),
      "utf8"
    );
  } catch { /* artifact write is best-effort */ }
  return result;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/loop/__tests__/runtime-check.test.ts`
Expected: 2 passed

- [ ] **Step 6: Build + commit**

```bash
npx tsc && cd .. && git add backend/src/loop/runtime-check.ts backend/src/loop/__tests__/runtime-check.test.ts backend/package.json backend/package-lock.json && \
git commit -m "feat(backend): headless-browser runtime check producing verifier evidence"
```

---

### Task 3: Wire preview + runtime check into the orchestrator

After the maker succeeds: register the preview, store `previewUrl`, run the runtime check, log it, hand the evidence to the verifier, and auto-feed errors to the next maker attempt on REJECT.

**Files:**
- Modify: `backend/src/loop/orchestrator.ts`

- [ ] **Step 1: Add imports**

Near the other imports at the top of `orchestrator.ts` (after the `state-sync.js` import at line ~49), add:

```ts
import { registerPreview } from "./preview-server.js";
import { runRuntimeCheck, type RuntimeCheckResult } from "./runtime-check.js";
```

- [ ] **Step 2: Run the check after the maker's diff is saved**

Find the maker-success block — it contains `const { diff } = parseStateDiff(stateAfterMake);` (~line 630) followed by `updateTask(taskId, { diff });` (~line 647). Directly AFTER the `updateTask(taskId, { diff })` line (and after any `diff_ready` broadcast that accompanies it), insert:

```ts
      // ─── Runtime check: serve the workdir and actually RUN the prototype.
      // The verifier gets this evidence verbatim; a broken page can no
      // longer be APPROVEd on source-reading alone.
      let runtime: RuntimeCheckResult | null = null;
      try {
        const previewUrl = await registerPreview(taskId, initialTask.workdir);
        updateTask(taskId, { previewUrl });
        const t2 = getTask(taskId);
        if (t2) broadcaster.broadcast(taskId, { type: "task_update", taskId, task: t2 });
        log("orchestrator", "info", `▶ RUNTIME CHECK — loading ${previewUrl} in headless chromium`);
        runtime = await runRuntimeCheck(previewUrl, initialTask.workdir, attempt);
        log(
          "orchestrator",
          runtime.ok ? "info" : "stderr",
          runtime.ok
            ? `✓ RUNTIME CHECK — no errors (${runtime.interactionLog.length} interactions)`
            : `✗ RUNTIME CHECK — ${runtime.pageErrors.length} page errors, ${runtime.consoleErrors.length} console errors (screenshot: ${runtime.screenshotPath})`
        );
      } catch (err) {
        log("orchestrator", "stderr", `runtime check failed to run: ${errorMsg(err)} — verifier will judge from source only`);
      }
```

Note: this block uses `attempt`, `initialTask`, `getTask`, `broadcaster`, `updateTask`, `log`, and `errorMsg`, all already in scope in `runLoop` / module scope. Verify each name resolves (`npx tsc` will catch it). The `runtime` variable must be declared where it stays in scope for the verifier phase below (same iteration of the attempt loop).

- [ ] **Step 3: Pass evidence into the verifier prompt**

Find the verifier dispatch: `const verifierPrompt = await buildVerifierPrompt(` (~line 674). Add `runtime?.evidenceMarkdown ?? null` as a final argument:

```ts
      const verifierPrompt = await buildVerifierPrompt(
        attempt,
        currentGoalContent,
        stateAfterMake,
        initialTask.workdir,
        diff,
        runtime?.evidenceMarkdown ?? null
      );
```
(Keep whatever the existing first five arguments are — only APPEND the sixth. If the existing call passes different variable names for goal/state, leave them as-is.)

Then extend `buildVerifierPrompt` (~line 1185). Change its signature to accept the new optional param:

```ts
async function buildVerifierPrompt(
  attempt: number,
  goalContent: string,
  stateContent: string,
  workdir: string,
  diff: { filesChanged: { path: string }[] } | null,
  runtimeEvidence: string | null = null
): Promise<string> {
```

In the returned `[…].join("\n")` array, insert BEFORE the `"=== Your task ==="` element:

```ts
    "=== Runtime check (headless browser ACTUALLY executed the prototype) ===",
    "",
    runtimeEvidence ??
      "Runtime check unavailable this attempt — judge from source, and say so in your verdict.",
    "",
```

And append to the `"=== Your task ==="` instruction block (after the existing "Walk the completion criteria…" sentences, before the "Append your verdict" line):

```ts
    "",
    "RUNTIME EVIDENCE IS AUTHORITATIVE: if the runtime check section above",
    "shows ANY uncaught page error or console error, you MUST return REJECT",
    "and quote the exact error text in Required fixes — regardless of how",
    "correct the source looks. If the runtime check shows no errors, weigh",
    "that as strong evidence the prototype loads and basic interactions work.",
```

- [ ] **Step 4: Auto-feed runtime errors to the next maker attempt on REJECT**

Find the REJECT handling block (search for `LAST_FEEDBACK.set(taskId`). The existing code sets it only from user feedback. Directly after the verdict is parsed and known to be REJECT (search for where `verdict.outcome` is compared with `"REJECT"`), add — BEFORE the user-feedback wait, so it applies even on auto-continue:

```ts
        // Runtime errors are the highest-signal feedback there is — always
        // carry them into the next maker attempt, merged with any user text.
        if (runtime && !runtime.ok) {
          const auto = [
            "AUTOMATED RUNTIME FEEDBACK (headless browser, previous attempt):",
            ...runtime.pageErrors.map((e) => `- uncaught: ${e}`),
            ...runtime.consoleErrors.map((e) => `- console.error: ${e}`),
            "Fix these errors first.",
          ].join("\n");
          const existing = LAST_FEEDBACK.get(taskId);
          LAST_FEEDBACK.set(taskId, existing ? `${existing}\n\n${auto}` : auto);
        }
```

Then confirm `buildMakerPrompt` (~line 1065) already consumes `LAST_FEEDBACK` (it receives the feedback string — trace the call at ~line 588). If it does, nothing more to do; if the feedback is only added on the user path, make the maker call read `LAST_FEEDBACK.get(taskId)` the same way the user-feedback path does.

- [ ] **Step 5: Also register the preview on DONE**

Find where the loop reaches the APPROVE/done path (search for the `"done"` status emit). Add just before the done emit:

```ts
      if (!getTask(taskId)?.previewUrl) {
        try {
          const previewUrl = await registerPreview(taskId, initialTask.workdir);
          updateTask(taskId, { previewUrl });
        } catch { /* preview is best-effort */ }
      }
```
(Covers tasks resumed directly into verifying, where the maker block never ran.)

- [ ] **Step 6: Build, restart**

Run: `npx tsc` → expect clean. Then restart the backend (Hard Constraints §4).

- [ ] **Step 7: End-to-end verification**

```bash
curl -s -X POST http://localhost:3001/api/tasks -H "Content-Type: application/json" -d '{
  "title": "runtime-check e2e",
  "prompt": "Build a single-page HTML color picker: a canvas gradient, click to pick, show hex code. Single index.html, vanilla JS.",
  "workdir": "/Users/anshmajumdar/Desktop/tic-tac-toe-game"
}'
```
Watch `curl -s http://localhost:3001/api/tasks/<id>` until done/escalated (phases take 5–25 min with the current model). Expected in logs: `▶ RUNTIME CHECK — loading http://localhost:3210/t/<id>/`, then either `✓ RUNTIME CHECK` or `✗ RUNTIME CHECK`, followed by a verifier verdict that references the runtime evidence. Expected on the task JSON: `"previewUrl": "http://localhost:3210/t/<id>/"` — open it in a browser and the prototype loads.

- [ ] **Step 8: Commit**

```bash
cd .. && git add backend/src/loop/orchestrator.ts && \
git commit -m "feat(backend): closed-loop verification — serve, execute, feed runtime evidence to verifier and next maker attempt"
```

---

### Task 4: Multi-file maker output

Let the maker emit several files per attempt using ` ```file:relative/path ` fences, with the old single ` ```html ` block still working.

**Files:**
- Modify: `backend/llm-agent.mjs` (maker dispatch + `MAKER_NO_TOOLS_OVERRIDE` prompt)

- [ ] **Step 1: Update the maker tool-mode override prompt**

In `llm-agent.mjs`, replace the body of `MAKER_NO_TOOLS_OVERRIDE` (the whole template literal) with:

```js
const MAKER_NO_TOOLS_OVERRIDE = `

---

## ⚠️ Tool mode override

You are running inside the Loop Agent bridge runner. You DO NOT have access
to read_file / write_file / bash / edit_file tools in this environment.

To deliver your output, emit one fenced code block PER FILE, each opened
with the file's relative path:

\`\`\`file:index.html
<!doctype html>...
\`\`\`

\`\`\`file:js/board.js
export function ...
\`\`\`

Rules:
1. Paths are relative to the project root. No absolute paths, no "..".
2. index.html MUST be one of the files (it is the entry point the preview
   server loads).
3. Every file must be COMPLETE — no elisions, no "rest unchanged".
4. No commentary outside the blocks.
5. Prefer a single self-contained index.html when the prototype fits in
   one file; split only when it genuinely helps (workers, large modules).

Backwards-compatible fallback: a single \`\`\`html block (no file: prefix)
is treated as index.html.

The bridge saves every file, then appends a ## Diff Summary section to
STATE.md so the orchestrator advances.
`;
```

- [ ] **Step 2: Replace the maker dispatch block**

In `llm-agent.mjs`, find `if (args.role === "maker") {`. Replace everything from that line down to (but NOT including) the `} else if (args.role === "verifier") {` line with:

```js
  if (args.role === "maker") {
    // Multi-file extraction: ```file:relative/path ... ``` blocks.
    // Fallback: one ```html block → index.html (legacy single-file mode).
    const { dirname, resolve: rp, sep } = await import("node:path");
    const { mkdir } = await import("node:fs/promises");
    const workroot = rp(args.workdir);
    const files = [];
    const re = /```file:([^\n`]+)\n([\s\S]*?)\n```/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      files.push({ path: match[1].trim(), content: match[2] });
    }
    if (files.length === 0) {
      const m = text.match(/```(?:html)?\s*\n([\s\S]*?)\n```/);
      files.push({ path: "index.html", content: m ? m[1] : text });
    }
    const written = [];
    for (const f of files) {
      const abs = rp(workroot, f.path);
      if (!abs.startsWith(workroot + sep) || f.path.startsWith("/") || f.path.includes("..")) {
        process.stderr.write(`[maker] SKIPPED unsafe path: ${f.path}\n`);
        continue;
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, "utf8");
      written.push(f.path);
      process.stderr.write(`[maker] wrote ${f.content.length} chars to ${abs}\n`);
    }
    if (written.length === 0) {
      process.stderr.write("llm-agent: FAIL: maker produced no writable files\n");
      process.exit(1);
    }
    // Append a Diff Summary to STATE.md so the orchestrator's watcher
    // sees the phase advance.
    const statePath = rp(workroot, "STATE.md");
    const attempt = process.env.LOOP_ATTEMPT ?? "1";
    const summary = [
      "",
      `## Diff Summary — Attempt ${attempt}`,
      "",
      `**Files changed** (${written.length}):`,
      ...written.map((p) => `- ${p} — implemented per plan`),
      "",
      "**Build:** n/a — static files, no build step",
      "**Tests:** automated runtime check runs after this phase",
      "**Lint:** n/a",
      "",
      `**New files**: ${written.join(", ")}`,
      "",
      "**Notes for verifier:**",
      "- Static HTML/CSS/JS prototype; entry point index.html",
      "- Implements the acceptance criteria listed in GOAL.md",
    ].join("\n");
    await appendFile(statePath, summary, "utf8");
    process.stderr.write(`[maker] appended diff summary to ${statePath}\n`);
  } else if (args.role === "verifier") {
```

IMPORTANT: keep the existing top-of-file import (`import { readFile, writeFile, appendFile } from "node:fs/promises";`). The old code derived `statePath` from `args.output.replace(/index\.html$/, "STATE.md")`; the new code resolves it from `workroot` directly — same result, safer. If the current file has a `writeFileAtomic` helper used by the old maker block, call it instead of `writeFile` inside the loop (same signature).

- [ ] **Step 3: Verify the extraction regex in isolation (no LLM call needed)**

```bash
node -e '
const text = "prose\n```file:index.html\n<h1>a</h1>\n```\nmid\n```file:js/x.js\nlet a=1\n```";
const re = /```file:([^\n`]+)\n([\s\S]*?)\n```/g; let m, out=[];
while ((m = re.exec(text)) !== null) out.push([m[1].trim(), m[2]]);
console.log(JSON.stringify(out));
'
```
Expected output: `[["index.html","<h1>a</h1>"],["js/x.js","let a=1"]]`

- [ ] **Step 4: Commit**

```bash
git add backend/llm-agent.mjs && git commit -m "feat(bridge): multi-file maker output via file:path fences (single-html fallback kept)"
```

---

### Task 5: Reference context files on task creation

Give the blind planner/maker eyes: an optional `contextFiles: string[]` on task creation whose contents are inlined into their prompts (capped).

**Files:**
- Modify: `backend/src/types.ts`, `backend/src/api/tasks.ts`, `backend/src/store/tasks.ts`, `backend/src/loop/orchestrator.ts`

- [ ] **Step 1: Types.** In `Task` (after `previewUrl?`) AND in `CreateTaskBody` (after `workdir?`), add:

```ts
  /** Absolute paths of reference files whose contents are inlined into the
   *  planner and maker prompts ("here's how the existing feature works").
   *  Capped at 20KB/file, 60KB total at prompt-build time. */
  contextFiles?: string[];
```

- [ ] **Step 2: API schema.** In `backend/src/api/tasks.ts`, inside `createSchema`, after `workdir: z.string().optional(),` add:

```ts
  contextFiles: z.array(z.string()).max(10).optional(),
```

and in the `createTask({ … })` call inside the POST handler add `contextFiles: body.contextFiles,`.

- [ ] **Step 3: Store.** In `backend/src/store/tasks.ts`, add `contextFiles?: string[];` to `createTask`'s `input` type and copy it onto the created task object (`contextFiles: input.contextFiles,` next to where `workdir`/`model` are set — read the function body and mirror the existing pattern).

- [ ] **Step 4: Prompt injection.** In `orchestrator.ts`, add this helper near `buildMakerPrompt` (~line 1065):

```ts
/** Inline the task's reference files into a prompt section. Missing files
 *  become a one-line note instead of an error — the task should still run. */
async function readTaskContextFiles(task: Task): Promise<string> {
  const paths = task.contextFiles ?? [];
  if (paths.length === 0) return "";
  const PER_FILE_CAP = 20_000;
  const TOTAL_CAP = 60_000;
  let total = 0;
  const parts: string[] = ["", "=== Reference context files (read-only, from the user's codebase) ===", ""];
  for (const p of paths) {
    if (total >= TOTAL_CAP) { parts.push(`(remaining files skipped — ${TOTAL_CAP} byte budget reached)`); break; }
    try {
      let content = await readFile(pathResolve(p), "utf8");
      if (content.length > PER_FILE_CAP) content = content.slice(0, PER_FILE_CAP) + "\n…(truncated)";
      total += content.length;
      parts.push(`--- ${p} ---`, "", content, "");
    } catch {
      parts.push(`--- ${p} --- (could not read; proceed without it)`, "");
    }
  }
  return parts.join("\n");
}
```
(`readFile` and `pathResolve` are already imported at the top of orchestrator.ts — lines 51-52.)

Then: where the planner prompt is built (~line 428, `const plannerPrompt = isReplan ? … : …`), append the block:

```ts
      const contextBlock = await readTaskContextFiles(initialTask);
      const plannerPrompt = (isReplan
        ? buildAdjustPlannerPrompt(initialTask.prompt, currentAdjustments, currentGoalContent)
        : buildPlannerPrompt(initialTask.prompt)) + contextBlock;
```
and for the maker (~line 588): `const makerPrompt = buildMakerPrompt(…existing args…) + (await readTaskContextFiles(initialTask));`

- [ ] **Step 5: Build + verify + commit**

`npx tsc` → clean. Restart the backend. Verify with a creation round-trip:
```bash
curl -s -X POST http://localhost:3001/api/tasks -H "Content-Type: application/json" \
  -d '{"prompt":"test ctx","workdir":"/tmp","contextFiles":["/etc/hosts"]}' | python3 -c "import json,sys; t=json.load(sys.stdin)['task']; print(t.get('contextFiles'))"
```
Expected: `['/etc/hosts']`. Then `POST /tasks/<id>/stop` to halt the throwaway task.

```bash
git add backend/src/types.ts backend/src/api/tasks.ts backend/src/store/tasks.ts backend/src/loop/orchestrator.ts && \
git commit -m "feat(backend): contextFiles — inline reference code into planner/maker prompts"
```

---

### Task 6: Plan-quality gate (0 criteria → automatic re-plan)

A plan with zero completion criteria gives the verifier nothing to verify (this happened live: "✓ PLAN READY — 8 steps, criteria: 0"). Auto re-plan before accepting.

**Files:**
- Modify: `backend/src/loop/orchestrator.ts`

- [ ] **Step 1: Insert the gate**

Find `const plan: PlanSummary = parsePlanGoal(goalContent);` (~line 473). Insert BETWEEN that line and `updateTask(taskId, { plan });`:

```ts
      // Plan-quality gate: a plan without completion criteria is
      // unverifiable — the verifier would be reduced to vibes. Re-plan
      // automatically with explicit instructions; only escalate to the user
      // when the adjust budget runs out.
      if (plan.criteria.length === 0 && planAdjustCount < MAX_PLAN_ADJUSTS) {
        log(
          "orchestrator",
          "stderr",
          "✗ plan has 0 completion criteria — auto re-planning with explicit format instructions"
        );
        currentAdjustments =
          "Your previous plan was REJECTED automatically: it contained no " +
          "'## Completion Criteria' section (or the section was empty). " +
          "Re-emit the FULL GOAL.md including a '## Completion Criteria' " +
          "section with 5-10 concrete, checkable bullet criteria " +
          "(e.g. '- clicking cell 5 places X in the center').";
        currentGoalContent = goalContent;
        planAdjustCount++;
        continue;
      }
```
This reuses the existing `while (true)` re-plan machinery (`planAdjustCount`, `currentAdjustments`, `currentGoalContent`, `buildAdjustPlannerPrompt`, `MAX_PLAN_ADJUSTS`) — all declared at ~lines 84 and 398-400. Verify the exact names against the surrounding code and match them.

- [ ] **Step 2: Build + commit**

```bash
npx tsc && cd .. && git add backend/src/loop/orchestrator.ts && \
git commit -m "feat(backend): auto re-plan when the planner returns zero completion criteria"
```

---

### Task 7: Workdir hygiene at fresh start

STATE.md currently accumulates duplicate `## Diff Summary` sections across runs (observed live: 4 duplicates), bloating verifier prompts with stale context. Reset it when a task starts a FRESH planning run.

**Files:**
- Modify: `backend/src/loop/orchestrator.ts`

- [ ] **Step 1: Insert the reset**

In `runLoop`, the hygiene block must run BEFORE `const watcher: FileWatcher = watchFiles(initialTask.workdir);` (~line 332) — the watcher's `ignoreInitial: true` then makes the reset write invisible to phase detection. Insert immediately before the `watchFiles(...)` line:

```ts
  // Fresh-run hygiene: a brand-new planning run must not inherit the
  // previous task's Diff Summaries / verdicts in STATE.md — they bloat
  // and confuse the verifier prompt. Resume paths (saved plan or diff)
  // intentionally keep STATE.md.
  if (!initialTask.plan && !initialTask.diff && initialTask.status !== "plan_review") {
    try {
      const { writeFile: wf, rm } = await import("node:fs/promises");
      await wf(
        pathResolve(initialTask.workdir, "STATE.md"),
        `# Loop State\n\nTask: ${initialTask.title}\nStarted: ${new Date().toISOString()}\n`,
        "utf8"
      );
      await rm(pathResolve(initialTask.workdir, ".loop"), { recursive: true, force: true });
      appendLog(taskId, "orchestrator", "info", "workdir hygiene: reset STATE.md and cleared .loop artifacts");
    } catch { /* hygiene is best-effort */ }
  }
```
(Uses `appendLog` directly because the `log` closure is defined after this point — check the current declaration order; if `log` is already defined where you insert, use `log(...)` instead.)

- [ ] **Step 2: Build + commit**

```bash
npx tsc && cd .. && git add backend/src/loop/orchestrator.ts && \
git commit -m "fix(backend): reset STATE.md + .loop artifacts on fresh runs (stale Diff Summary accumulation)"
```

---

### Task 8: Fix resume losing plan/diff after escalation

Observed live: a task that had `plan` saved (orchestrator ~line 474) and `diff` saved (~line 647) resumed into `planning` instead of `verifying` — meaning `plan`/`diff` were dropped somewhere between escalation and resume. Diagnose, then fix.

**Files:**
- Modify: `backend/src/loop/orchestrator.ts` and/or `backend/src/store/persistence.ts` (depends on findings)

- [ ] **Step 1: Locate the state loss**

```bash
cd "/Users/anshmajumdar/Desktop/Loop Agent/backend"
sed -n '167,290p' src/loop/orchestrator.ts     # resumeLoop / resetTask / rePrompt — updateTask calls at ~189/230/270
sed -n '/export function updateTask/,/^}/p' src/store/tasks.ts
grep -n "plan\|diff" src/store/persistence.ts | head -20
```
You are looking for one of two bugs: **(a)** an `updateTask(taskId, { plan: undefined, diff: undefined, … })` (or a rebuild-object pattern that omits them) in `resumeLoop` that clears the fields on resume; or **(b)** the persistence layer not serializing `plan`/`diff`, so a backend restart between escalation and resume loses them. Check (b) directly against a real task file:
```bash
python3 -c "import json;d=json.load(open('data/tasks/BcRECrAPet0E.json'));print('plan' in d, 'diff' in d, sorted(d.keys()))"
```

- [ ] **Step 2: Fix per finding**

- If (a): remove `plan`/`diff` from the clearing patch in `resumeLoop` — they must survive resume; only `escalationReason` should reset there. If the clearing lives in `resetTask`/`rePrompt`, leave those alone: reset and re-prompt SHOULD clear state. Only `resumeLoop` must preserve.
- If (b): add `plan`, `diff`, `verdict`, `previewUrl`, `contextFiles` to the serialized task shape in `persistence.ts`, mirroring how `history`/`logs` are persisted.

- [ ] **Step 3: Verify with the acceptance test**

```bash
# Pick any escalated task whose logs contain "✓ IMPLEMENT":
curl -s http://localhost:3001/api/tasks | python3 -c "import json,sys; [print(t['id'],t['status']) for t in json.load(sys.stdin)['tasks']]"
curl -s -X POST http://localhost:3001/api/tasks/<escalated-id>/resume
sleep 2
curl -s http://localhost:3001/api/tasks/<escalated-id> | python3 -c "import json,sys; print(json.load(sys.stdin)['task']['status'])"
```
Expected: `verifying` (task had a diff) or `plan_review` (plan only) — NOT `planning`. Stop the task afterwards with `POST /tasks/<id>/stop`.

- [ ] **Step 4: Build + commit**

```bash
npx tsc && cd .. && git add -A backend/src && \
git commit -m "fix(backend): preserve plan/diff through escalation so resume continues instead of restarting"
```

---

### Task 9: Per-attempt raw LLM artifacts

Every LLM response gets dumped to `<workdir>/.loop/` so a stuck stage is diagnosable without grepping backend logs.

**Files:**
- Modify: `backend/llm-agent.mjs`, `backend/src/loop/orchestrator.ts`

- [ ] **Step 1: Add the dump in llm-agent.mjs**

Directly after the `[role] LLM OK in …` stderr write and the empty-content salvage/guard block (both exist as of 2026-07-10), add:

```js
// Artifact dump: raw response + metadata per attempt. First place to look
// when a phase produces an unparseable file — you see exactly what the
// model said before any extraction logic touched it.
try {
  const { mkdir: mkdirA } = await import("node:fs/promises");
  const loopDir = `${args.workdir}/.loop`;
  await mkdirA(loopDir, { recursive: true });
  const attemptN = process.env.LOOP_ATTEMPT ?? "1";
  await writeFile(
    `${loopDir}/${args.role}-attempt-${attemptN}-raw.md`,
    [
      `<!-- role=${args.role} attempt=${attemptN} model=${args.model} -->`,
      `<!-- finish=${finishReason ?? "?"} textChars=${text.length} reasoningChars=${reasoning.length} -->`,
      "",
      text,
    ].join("\n"),
    "utf8"
  );
} catch { /* artifact write is best-effort */ }
```
(`finishReason`, `reasoning`, `text` are already in scope from the empty-content guard; `writeFile` is already imported.)

- [ ] **Step 2: Point escalations at the artifacts**

In `orchestrator.ts`, find `function escalate(` (~line 1254) and the `updateTask(taskId, { escalationReason: reason })` inside it (~line 1283). Change to:

```ts
  const hinted = `${reason} — raw LLM outputs + runtime artifacts: ${getTask(taskId)?.workdir ?? "<workdir>"}/.loop/`;
  updateTask(taskId, { escalationReason: hinted });
```
(If nearby lines broadcast/log `reason` after this point, switch them to `hinted`.)

- [ ] **Step 3: Build + commit**

```bash
npx tsc && cd .. && git add backend/llm-agent.mjs backend/src/loop/orchestrator.ts && \
git commit -m "feat: per-attempt raw LLM artifact dumps in <workdir>/.loop + escalation pointer"
```

---

### Task 10: Additive UI — preview link chip

One NEW component + one mount line + one optional type field. Nothing existing changes.

**Files:**
- Create: `ui/src/components/PreviewLinkChip.tsx`
- Modify: ONE existing file with a ONE-LINE addition (located in Step 2)
- Modify: the UI's Task type — one optional field (located in Step 3)

- [ ] **Step 1: Create the component**

```tsx
// ui/src/components/PreviewLinkChip.tsx
// Additive component: renders a "Live Preview" link when the task has a
// previewUrl. Renders NOTHING otherwise — safe to mount unconditionally.
export function PreviewLinkChip({ url }: { url?: string }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        textDecoration: "none",
        border: "1px solid #3fb95044",
        background: "#3fb95014",
        color: "#3fb950",
      }}
      title="Open the live prototype"
    >
      ● Live Preview
    </a>
  );
}
```
(Inline styles on purpose — zero coupling to the existing CSS system.)

- [ ] **Step 2: Find the mount point and add ONE line**

```bash
grep -rn "escalationReason" "/Users/anshmajumdar/Desktop/Loop Agent/ui/src" | head -5
```
Pick the component that renders task detail/status (where `escalationReason` or `task.status` is displayed — check `TopBar.tsx`, `BottomBar.tsx`, and `ui/src/pages/`). In that file, add the import `import { PreviewLinkChip } from "../components/PreviewLinkChip";` (adjust the relative path), and next to where the task title or status badge is rendered, add exactly one JSX line:

```tsx
<PreviewLinkChip url={task.previewUrl} />
```
Do not move, wrap, restyle, or delete anything already there.

- [ ] **Step 3: Add the type field**

```bash
grep -rn "escalationReason" "/Users/anshmajumdar/Desktop/Loop Agent/ui/src/types" "/Users/anshmajumdar/Desktop/Loop Agent/ui/src/lib" 2>/dev/null | head -3
```
In the UI's Task interface (mirror of the backend type), add after `escalationReason?: string;`:
```ts
  previewUrl?: string;
```

- [ ] **Step 4: Verify + commit**

Run the UI dev server as usual (`cd ui && npm run dev`, or reuse the running one). Open a task that finished after Task 3 was deployed. Expected: a green "● Live Preview" chip appears; clicking opens `http://localhost:3210/t/<id>/` with the prototype. Tasks without `previewUrl` render nothing new.

```bash
git add ui/src && git commit -m "feat(ui): additive Live Preview chip (renders nothing without previewUrl)"
```

---

## Final acceptance run (whole-plan verification)

- [ ] Create a fresh task with an interactive prompt:

```bash
curl -s -X POST http://localhost:3001/api/tasks -H "Content-Type: application/json" -d '{
  "title": "final acceptance — closed loop",
  "prompt": "Build a video-editor-style timeline strip prototype: a horizontal track, draggable clip blocks, a playhead that moves on Space. Single-page HTML/CSS/JS.",
  "workdir": "/Users/anshmajumdar/Desktop/tic-tac-toe-game"
}'
```

- [ ] Confirm ALL of the following as it runs (total wall clock 10–40 min at current model speeds):
  1. If the plan parses with 0 criteria → `auto re-planning` log line appears and a second plan is produced (Task 6).
  2. STATE.md starts fresh — exactly one `## Diff Summary` after the maker (Task 7).
  3. `▶ RUNTIME CHECK — loading http://localhost:3210/t/…` appears after IMPLEMENT (Tasks 1+3).
  4. `<workdir>/.loop/` contains `planner-attempt-*-raw.md`, `maker-attempt-*-raw.md`, `runtime-attempt-1.png`, `runtime-attempt-1.json` (Tasks 2+9).
  5. The verifier verdict references the runtime evidence (Task 3).
  6. If REJECT happens: the next maker attempt carries `AUTOMATED RUNTIME FEEDBACK` (Task 3 Step 4 — visible in backend logs or `.loop/maker-attempt-2-raw.md`).
  7. The task JSON has `previewUrl`; it opens in a browser and the prototype loads (Tasks 1+10).
  8. `npx vitest run` in `backend/` — all suites pass.
