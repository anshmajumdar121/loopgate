# Phase 1 — Live Monitoring & Outputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- **Monitoring:** you can watch a run live, with per-node progress text and elapsed time. A page reload or a socket drop no longer loses the run.
- **Outputs:** every file the loop produces (video, audio, images, docs) can be played, previewed and downloaded in the UI.
- **Quality:** the UI keeps its current look and stops failing silently.

**Architecture:**
- **Backend (no new subsystems):**
  - Generic `progress` and `artifacts_changed` WebSocket events.
  - An artifacts listing endpoint.
  - A streaming file route with HTTP Range support.
  - The main HTTP bridge stops buffering whole responses in memory.
- **UI:**
  - Hydrates the active task on load and on reconnect.
  - Shows progress on canvas nodes.
  - Adds an Outputs section to the side panel.
  - Routes action failures to toasts.
- Everything reuses the existing visual language. See "Style contract" below.

**Tech Stack:** TypeScript, Hono 4, Node `http`/`stream`, Vitest (backend). React 18, Zustand 5, Tailwind 3, lucide-react, Vitest + Testing Library + jsdom (UI).

**Prerequisites:**
- Phase 0 (`2026-10-10-phase0-stop-the-bleeding.md`) should land first. Phase 1 doesn't depend on its code, but both edit `backend/src/index.ts`, `agent-spawner.ts` and `orchestrator.ts`, so doing Phase 0 first avoids merge conflicts.
- Task 0 below must run before any UI task.

**Live-run warning:** the backend dev server is `tsx watch`, so any backend edit kills in-flight loops. Don't run a real loop while executing this plan.

---

## Style contract (read before any UI task)

The UI has a consistent look. New UI must be indistinguishable from the existing panels. Copy from these sources; don't invent new styles.

| Element | Use exactly | Source to copy from |
|---|---|---|
| Panel container | `flex h-full w-[380px] flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950` | `NodeConfigPanel.tsx` `DonePanel` |
| Section heading | the existing `Section` component (11px, semibold, uppercase, tracking-wider, zinc-500) | `NodeConfigPanel.tsx` `Section` |
| Body text | `text-[12.5px] text-zinc-700 dark:text-zinc-300` | throughout `NodeConfigPanel.tsx` |
| Small meta text | `text-[11px] text-zinc-500 dark:text-zinc-400`, mono values `font-mono` | `Stat` |
| Cards / tiles | `rounded-md bg-zinc-50 dark:bg-zinc-900` or `rounded-lg border border-zinc-200 dark:border-zinc-800` | `Stat` |
| Accent | violet `#7c4dff` (the focus ring and pulse colour); after Task 6, Tailwind `accent-*` | `tailwind.config.js` |
| Success / warning | emerald / amber families, as in the plan and verdict panels | `PlanReviewPanel` |
| Icons | `lucide-react`, `size={14..16}`, `strokeWidth={2..2.2}` | `DonePanel` |
| Motion | existing keyframes only (`pulse-soft`, `pop`, `dash-flow`), plus `transition-colors`/`transition-[width]` | `tailwind.config.js` |
| Dark mode | every colour class needs its `dark:` pair | everywhere |

---

## File map

| File | Status | Responsibility | Task |
|---|---|---|---|
| `ui/src/lib/selectTask.ts`, its test, `backend/src/api/__tests__/tasks-list.test.ts` | Restore | Undo the breaking deletion | 0 |
| `backend/src/http/send-response.ts` | Create | Stream a fetch `Response` into a Node `ServerResponse` | 1 |
| `backend/src/index.ts` | Modify | Use `sendFetchResponse`; mount `filesApi` | 1, 3 |
| `backend/src/loop/artifacts.ts` | Create | Classify, list, path-guard and range-parse workdir files | 2 |
| `backend/src/api/files.ts` | Create | `GET /tasks/:id/artifacts`, `GET /tasks/:id/files/*` | 3 |
| `backend/src/loop/progress.ts` | Create | Parse `__LOOP_PROGRESS__:` lines | 4 |
| `backend/src/types.ts` | Modify | `progress` + `artifacts_changed` WS messages | 4 |
| `backend/src/loop/orchestrator.ts` | Modify | Route progress lines; emit `artifacts_changed` | 4 |
| `backend/llm-agent.mjs` | Modify | Emit progress lines | 5 |
| `ui/tailwind.config.js` | Modify | Define the `accent` scale and missing `ink` shades | 6 |
| `ui/src/types/loop.ts` | Modify | Mirror `Artifact`, new WS messages | 7 |
| `ui/src/lib/store.ts` | Modify | Keep logs on load; `nodeProgress`; `artifactsVersion` | 8 |
| `ui/src/lib/resyncTask.ts` | Create | Refetch the task after a reconnect | 9 |
| `ui/src/hooks/useLoopSocket.ts` | Modify | Handle new events; resync on reconnect | 9 |
| `ui/src/lib/pickLiveTask.ts` | Create | Choose the task to restore on page load | 10 |
| `ui/src/App.tsx` | Modify | Restore live task; mount `Toaster` | 10, 13 |
| `ui/src/lib/useNow.ts`, `ui/src/lib/format.ts` | Create / modify | Ticking clock; `formatElapsed`, `formatBytes` | 11 |
| `ui/src/components/canvas/WorkflowNode.tsx` | Modify | Progress label, elapsed time, percent bar | 11 |
| `ui/src/lib/artifacts.ts` | Create | `fileUrl`, `groupArtifacts` | 12 |
| `ui/src/components/OutputsPanel.tsx` | Create | Players, previews, downloads | 12 |
| `ui/src/components/NodeConfigPanel.tsx` | Modify | Outputs section; toasts instead of `console.error`; remove dead code | 12–14 |
| `ui/src/lib/toast.ts`, `ui/src/components/Toaster.tsx` | Create | Error/info toasts and `postAction` helper | 13 |
| `ui/src/components/TopBar.tsx`, `canvas/ChatbotNode.tsx`, `canvas/RunButton.tsx`, `canvas/ProgressNode.tsx`, `BottomBar.tsx` | Modify / delete | Toasts; remove dead controls | 13, 14 |

---

### Task 0: Restore the UI build

Commit `f812f7b` deleted `ui/src/lib/selectTask.ts`, which `Sidebar.tsx` still imports. `npm run build` fails with `Cannot find module '@/lib/selectTask'`. Task 10 builds on `selectTask`, so restore it.

**Files:** restores `ui/src/lib/selectTask.ts`, `ui/src/lib/selectTask.test.ts`, `backend/src/api/__tests__/tasks-list.test.ts`

- [ ] **Step 1: Get the owner's OK, then revert**

That commit was made on the owner's explicit request. Confirm in chat before reverting. Then run:
```bash
git revert --no-edit f812f7b
```

- [ ] **Step 2: Verify**

Run:
```bash
cd ui && npm run build 2>&1 | tail -3 && npx vitest run 2>&1 | tail -4
```
Expected: the build succeeds and all UI tests pass, including `selectTask.test.ts`.

---

### Task 1: Stream HTTP responses instead of buffering them

`backend/src/index.ts:70-75` does `Buffer.from(await fetchRes.arrayBuffer())` for every response. A 200 MB video would sit fully in memory, and playback couldn't start until it had. Extract a streaming sender.

**Files:**
- Create: `backend/src/http/send-response.ts`
- Create: `backend/src/http/__tests__/send-response.test.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sendFetchResponse } from "../send-response.js";

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function serve(make: () => Response): Promise<string> {
  server = createServer((_req, res) => void sendFetchResponse(res, make()));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
}

describe("sendFetchResponse", () => {
  it("streams a multi-megabyte body with status and headers intact", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const url = await serve(
      () => new Response(big, { status: 206, headers: { "content-type": "video/mp4", "x-test": "1" } })
    );
    const res = await fetch(url);
    expect(res.status).toBe(206);
    expect(res.headers.get("x-test")).toBe("1");
    expect((await res.text()).length).toBe(big.length);
  });

  it("ends cleanly when there is no body", async () => {
    const url = await serve(() => new Response(null, { status: 204 }));
    const res = await fetch(url);
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd backend && npx vitest run src/http/__tests__/send-response.test.ts`
Expected: FAIL, because `../send-response.js` doesn't exist.

- [ ] **Step 3: Implement**

`backend/src/http/send-response.ts`:
```ts
// Pipes a fetch-style Response (what Hono returns) into a Node
// ServerResponse WITHOUT buffering the body. The old bridge in index.ts
// awaited arrayBuffer(), which held whole videos in memory and delayed
// the first byte until the last one was read.
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

export async function sendFetchResponse(res: ServerResponse, fetchRes: Response): Promise<void> {
  res.statusCode = fetchRes.status;
  fetchRes.headers.forEach((value, key) => res.setHeader(key, value));
  if (!fetchRes.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(fetchRes.body as unknown as NodeWebReadableStream);
  await new Promise<void>((resolve) => {
    body.on("error", () => {
      res.destroy();
      resolve();
    });
    // Client went away mid-stream (e.g. a video seek): stop reading the file.
    res.on("close", () => {
      body.destroy();
      resolve();
    });
    body.pipe(res);
  });
}
```

- [ ] **Step 4: Use it in `index.ts`**

Add `import { sendFetchResponse } from "./http/send-response.js";` to the imports in `backend/src/index.ts`. Then replace:
```ts
  const buf = Buffer.from(await fetchRes.arrayBuffer());
  // Status
  res.statusCode = fetchRes.status;
  // Headers
  fetchRes.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(buf);
```
with:
```ts
  await sendFetchResponse(res, fetchRes);
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx vitest run src/http src/api 2>&1 | tail -4`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/http backend/src/index.ts
git commit -m "perf(backend): stream HTTP responses instead of buffering whole bodies"
```

---

### Task 2: Artifact helpers (classify, list, path guard, Range parsing)

**Files:**
- Create: `backend/src/loop/artifacts.ts`
- Create: `backend/src/loop/__tests__/artifacts.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyArtifact, listArtifacts, parseRange, resolveInside } from "../artifacts.js";

describe("classifyArtifact", () => {
  it("maps media, documents and unknowns", () => {
    expect(classifyArtifact("out/clip.MP4")).toEqual({ kind: "video", mime: "video/mp4" });
    expect(classifyArtifact("a.wav").kind).toBe("audio");
    expect(classifyArtifact("thumb.png").kind).toBe("image");
    expect(classifyArtifact("PUBLISH.md").kind).toBe("document");
    expect(classifyArtifact("blob.bin")).toEqual({ kind: "other", mime: "application/octet-stream" });
  });
});

describe("resolveInside", () => {
  it("allows nested paths and rejects escapes", () => {
    expect(resolveInside("/w", "out/a.mp4")).toBe("/w/out/a.mp4");
    expect(resolveInside("/w", "../etc/passwd")).toBeNull();
    expect(resolveInside("/w", "/etc/passwd")).toBeNull();
    expect(resolveInside("/w", "")).toBeNull();
  });
});

describe("parseRange", () => {
  it("handles absent, open, closed, suffix and invalid ranges", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=5-1", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
  });
});

describe("listArtifacts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "artifacts-test-"));
    mkdirSync(join(dir, "output"));
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    mkdirSync(join(dir, ".loop"));
    writeFileSync(join(dir, "output", "short-1.mp4"), "v");
    writeFileSync(join(dir, "PUBLISH.md"), "# pack");
    writeFileSync(join(dir, "GOAL.md"), "# goal");
    writeFileSync(join(dir, "STATE.md"), "# state");
    writeFileSync(join(dir, "node_modules", "x", "i.js"), "");
    writeFileSync(join(dir, ".loop", "trace.json"), "{}");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists produced files and skips loop internals, dot-dirs and node_modules", async () => {
    const paths = (await listArtifacts(dir)).map((a) => a.path).sort();
    expect(paths).toEqual(["PUBLISH.md", "output/short-1.mp4"]);
  });

  it("reports kind, mime and size", async () => {
    const mp4 = (await listArtifacts(dir)).find((a) => a.path === "output/short-1.mp4")!;
    expect(mp4).toMatchObject({ kind: "video", mime: "video/mp4", size: 1 });
    expect(typeof mp4.modifiedAt).toBe("string");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd backend && npx vitest run src/loop/__tests__/artifacts.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement**

`backend/src/loop/artifacts.ts`:
```ts
// What a task produced, as the UI's Outputs panel sees it: every regular
// file in the task workdir except loop bookkeeping (GOAL.md, STATE.md),
// dot-folders (.loop, .opencode, .git) and dependency trees. Generic on
// purpose: a web page, a rendered MP4 and a CSV are all just artifacts.
import { readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

export type ArtifactKind = "video" | "audio" | "image" | "document" | "code" | "data" | "other";

export interface Artifact {
  /** Workdir-relative, always forward slashes. */
  path: string;
  kind: ArtifactKind;
  mime: string;
  size: number;
  modifiedAt: string;
}

const TYPES: Record<string, [ArtifactKind, string]> = {
  ".mp4": ["video", "video/mp4"],
  ".mov": ["video", "video/quicktime"],
  ".webm": ["video", "video/webm"],
  ".mkv": ["video", "video/x-matroska"],
  ".mp3": ["audio", "audio/mpeg"],
  ".wav": ["audio", "audio/wav"],
  ".m4a": ["audio", "audio/mp4"],
  ".ogg": ["audio", "audio/ogg"],
  ".png": ["image", "image/png"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".gif": ["image", "image/gif"],
  ".webp": ["image", "image/webp"],
  ".svg": ["image", "image/svg+xml"],
  ".md": ["document", "text/markdown; charset=utf-8"],
  ".txt": ["document", "text/plain; charset=utf-8"],
  ".pdf": ["document", "application/pdf"],
  ".html": ["document", "text/html; charset=utf-8"],
  ".json": ["data", "application/json; charset=utf-8"],
  ".csv": ["data", "text/csv; charset=utf-8"],
  ".srt": ["data", "text/plain; charset=utf-8"],
  ".vtt": ["data", "text/vtt; charset=utf-8"],
  ".js": ["code", "text/javascript; charset=utf-8"],
  ".ts": ["code", "text/plain; charset=utf-8"],
  ".py": ["code", "text/plain; charset=utf-8"],
  ".css": ["code", "text/css; charset=utf-8"],
  ".sh": ["code", "text/plain; charset=utf-8"],
};

export function classifyArtifact(path: string): { kind: ArtifactKind; mime: string } {
  const hit = TYPES[extname(path).toLowerCase()];
  return hit ? { kind: hit[0], mime: hit[1] } : { kind: "other", mime: "application/octet-stream" };
}

/** Absolute path of `rel` under `root`, or null if it escapes `root` or is empty. */
export function resolveInside(root: string, rel: string): string | null {
  if (!rel || rel.startsWith("/")) return null;
  const base = resolve(root);
  const full = resolve(base, rel);
  return full.startsWith(base + sep) ? full : null;
}

/** Parse a single-range `Range: bytes=…` header. null = no header (send the whole file). */
export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

const LOOP_FILES = new Set(["GOAL.md", "STATE.md"]);
const SKIP_DIRS = new Set(["node_modules", "__pycache__"]);
const MAX_DEPTH = 6;

export async function listArtifacts(workdir: string, limit = 500): Promise<Artifact[]> {
  const out: Artifact[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // workdir missing or unreadable → simply no artifacts
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || (depth === 0 && LOOP_FILES.has(entry.name))) continue;
      const info = await stat(full);
      const path = relative(workdir, full).split(sep).join("/");
      out.push({ path, ...classifyArtifact(path), size: info.size, modifiedAt: info.mtime.toISOString() });
    }
  };
  await walk(workdir, 0);
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx vitest run src/loop/__tests__/artifacts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/loop/artifacts.ts backend/src/loop/__tests__/artifacts.test.ts
git commit -m "feat(backend): artifact listing, path guard and Range parsing helpers"
```

---

### Task 3: Artifacts and file routes

Two routes:
- `GET /api/tasks/:id/artifacts` returns `{ artifacts: Artifact[] }`.
- `GET /api/tasks/:id/files/<path>` streams one file, supports `Range` for video seeking, and supports `?download=1`.

Files are served with `Content-Security-Policy: sandbox`. That stops an agent-written HTML or SVG file from running scripts against the API on the app's own origin.

**Files:**
- Create: `backend/src/api/files.ts`
- Create: `backend/src/api/__tests__/files.test.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesApi } from "../files.js";
import { loadTasksFromDisk } from "../../store/tasks.js";

let dir: string;
const app = () => new Hono().route("/", filesApi);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "files-api-test-"));
  mkdirSync(join(dir, "output"));
  writeFileSync(join(dir, "output", "clip.mp4"), "0123456789");
  writeFileSync(join(dir, "page.html"), "<script>alert(1)</script>");
  symlinkSync("/etc/hosts", join(dir, "escape.txt"));
  loadTasksFromDisk([{ id: "ft1", status: "done", workdir: dir } as never]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("files API", () => {
  it("lists artifacts", async () => {
    const res = await app().request("/tasks/ft1/artifacts");
    expect(res.status).toBe(200);
    const { artifacts } = (await res.json()) as { artifacts: Array<{ path: string }> };
    expect(artifacts.map((a) => a.path)).toContain("output/clip.mp4");
  });

  it("serves a whole file with type, length and a sandbox CSP", async () => {
    const res = await app().request("/tasks/ft1/files/output/clip.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(await res.text()).toBe("0123456789");
  });

  it("serves a byte range with 206", async () => {
    const res = await app().request("/tasks/ft1/files/output/clip.mp4", { headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
  });

  it("rejects an unsatisfiable range with 416", async () => {
    const res = await app().request("/tasks/ft1/files/output/clip.mp4", { headers: { Range: "bytes=50-" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  it("adds Content-Disposition for downloads", async () => {
    const res = await app().request("/tasks/ft1/files/output/clip.mp4?download=1");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="clip.mp4"');
  });

  it("refuses traversal and symlink escapes", async () => {
    expect((await app().request("/tasks/ft1/files/..%2F..%2Fetc%2Fhosts")).status).toBe(400);
    expect((await app().request("/tasks/ft1/files/escape.txt")).status).toBe(400);
  });

  it("404s for unknown tasks and files", async () => {
    expect((await app().request("/tasks/nope/files/a.mp4")).status).toBe(404);
    expect((await app().request("/tasks/ft1/files/missing.mp4")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd backend && npx vitest run src/api/__tests__/files.test.ts`
Expected: FAIL, because `../files.js` doesn't exist.

- [ ] **Step 3: Implement**

`backend/src/api/files.ts`:
```ts
// Task outputs over HTTP: list what a task produced, and stream any one
// file with Range support (video seeking) and an optional download
// disposition. Files are untrusted agent output, so every response carries
// `Content-Security-Policy: sandbox` (an agent-written .html/.svg can't run
// script against this origin's API) and `nosniff`.
import { Hono } from "hono";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, sep } from "node:path";
import { Readable } from "node:stream";
import { getTask } from "../store/tasks.js";
import { classifyArtifact, listArtifacts, parseRange, resolveInside } from "../loop/artifacts.js";

export const filesApi = new Hono();

filesApi.get("/tasks/:id/artifacts", async (c) => {
  const task = getTask(c.req.param("id"));
  if (!task) return c.json({ error: "task not found" }, 404);
  return c.json({ artifacts: await listArtifacts(task.workdir) });
});

filesApi.get("/tasks/:id/files/*", async (c) => {
  const task = getTask(c.req.param("id"));
  if (!task) return c.json({ error: "task not found" }, 404);

  const marker = `/tasks/${task.id}/files/`;
  const rel = decodeURIComponent(c.req.path.slice(c.req.path.indexOf(marker) + marker.length));
  const candidate = resolveInside(task.workdir, rel);
  if (!candidate) return c.json({ error: "path escapes the task folder" }, 400);

  let real: string;
  let size: number;
  try {
    real = await realpath(candidate);
    const root = await realpath(task.workdir);
    // A symlink inside the workdir must not reach outside it.
    if (!real.startsWith(root + sep)) return c.json({ error: "path escapes the task folder" }, 400);
    const info = await stat(real);
    if (!info.isFile()) return c.json({ error: "not a file" }, 404);
    size = info.size;
  } catch {
    return c.json({ error: "file not found" }, 404);
  }

  const headers: Record<string, string> = {
    "Content-Type": classifyArtifact(real).mime,
    "Accept-Ranges": "bytes",
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
  };
  if (c.req.query("download") === "1") {
    headers["Content-Disposition"] = `attachment; filename="${basename(real).replace(/"/g, "")}"`;
  }

  const range = parseRange(c.req.header("range"), size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  if (size === 0) {
    return new Response(null, { status: 200, headers: { ...headers, "Content-Length": "0" } });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body = Readable.toWeb(createReadStream(real, { start, end })) as unknown as ReadableStream;
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    },
  });
});
```

- [ ] **Step 4: Mount it**

In `backend/src/index.ts`, add `import { filesApi } from "./api/files.js";`, and add `app.route("/api", filesApi);` after `app.route("/api", ratchetApi);`.

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx vitest run src/api/__tests__/files.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/files.ts backend/src/api/__tests__/files.test.ts backend/src/index.ts
git commit -m "feat(backend): artifact list + Range-capable file route for task outputs"
```

---

### Task 4: `progress` and `artifacts_changed` events

This is a generic, domain-free progress protocol. Any agent or tool process can print a line like `__LOOP_PROGRESS__:{"label":"Rendering clip 3/10","percent":30}` to stdout or stderr. The orchestrator turns it into a `progress` WebSocket event for the node with that agent's name, instead of a log line. After the maker phase and at `done`, the orchestrator also broadcasts `artifacts_changed` so the Outputs panel refetches.

**Files:**
- Create: `backend/src/loop/progress.ts`
- Create: `backend/src/loop/__tests__/progress.test.ts`
- Modify: `backend/src/types.ts` (the `WsServerMessage` union, around line 357)
- Modify: `backend/src/loop/orchestrator.ts` (the `log` closure around line 533; the `diff_ready` broadcast around line 1181; the three `done` broadcasts)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseProgressLine, PROGRESS_PREFIX } from "../progress.js";

describe("parseProgressLine", () => {
  it("parses label and clamps percent", () => {
    expect(parseProgressLine(`${PROGRESS_PREFIX}{"label":"Rendering 3/10","percent":30}`))
      .toEqual({ label: "Rendering 3/10", percent: 30 });
    expect(parseProgressLine(`${PROGRESS_PREFIX}{"label":"x","percent":140}`)).toEqual({ label: "x", percent: 100 });
  });

  it("allows label-only updates", () => {
    expect(parseProgressLine(`${PROGRESS_PREFIX}{"label":"Calling model"}`)).toEqual({ label: "Calling model" });
  });

  it("ignores normal lines, bad JSON and empty labels", () => {
    expect(parseProgressLine("[maker] wrote 10 chars")).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX}{oops`)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_PREFIX}{"label":"  "}`)).toBeNull();
  });

  it("caps very long labels", () => {
    const parsed = parseProgressLine(`${PROGRESS_PREFIX}${JSON.stringify({ label: "a".repeat(500) })}`);
    expect(parsed?.label.length).toBe(120);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd backend && npx vitest run src/loop/__tests__/progress.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement the parser**

`backend/src/loop/progress.ts`:
```ts
// Generic progress protocol. Any agent/tool process may print
//   __LOOP_PROGRESS__:{"label":"Rendering clip 3/10","percent":30}
// on stdout or stderr. The orchestrator turns it into a `progress` WS event
// for that agent's canvas node instead of a log line.
export const PROGRESS_PREFIX = "__LOOP_PROGRESS__:";

export interface ProgressUpdate {
  label: string;
  percent?: number;
}

export function parseProgressLine(line: string): ProgressUpdate | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  try {
    const raw = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as { label?: unknown; percent?: unknown };
    if (typeof raw.label !== "string" || !raw.label.trim()) return null;
    const out: ProgressUpdate = { label: raw.label.trim().slice(0, 120) };
    if (typeof raw.percent === "number" && Number.isFinite(raw.percent)) {
      out.percent = Math.min(100, Math.max(0, raw.percent));
    }
    return out;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Add the WS message types**

In `backend/src/types.ts`, add two members to the `WsServerMessage` union, directly after the `| { type: "task_deleted"; taskId: string }` line:
```ts
  | { type: "progress"; taskId: string; nodeId: string; label: string; percent?: number }
  | { type: "artifacts_changed"; taskId: string }
```

- [ ] **Step 5: Wire up the orchestrator**

In `backend/src/loop/orchestrator.ts`, add `import { parseProgressLine } from "./progress.js";` to the imports. Then replace the `log` closure in `runLoop`:
```ts
  const log = (agent: AgentRole, stream: LogLevel, text: string) => {
    appendLog(taskId, agent, stream, text);
    broadcaster.broadcastLog(taskId, agent, stream, text);
  };
```
with:
```ts
  const log = (agent: AgentRole, stream: LogLevel, text: string) => {
    // Progress lines drive the node's live status text; they are not logs.
    const progress = parseProgressLine(text);
    if (progress) {
      broadcaster.broadcast(taskId, { type: "progress", taskId, nodeId: agent, ...progress });
      return;
    }
    appendLog(taskId, agent, stream, text);
    broadcaster.broadcastLog(taskId, agent, stream, text);
  };

  // Tell the Outputs panel the workdir may have new files.
  const announceArtifacts = () => {
    broadcaster.broadcast(taskId, { type: "artifacts_changed", taskId });
  };
```
Directly after the statement `broadcaster.broadcast(taskId, { type: "diff_ready", taskId, diff });` (around line 1181), add:
```ts
        announceArtifacts();
```
Directly after each of the three statements that broadcast `type: "done"` (around lines 1860, 1924 and 2020; find them with `grep -n 'type: "done"' backend/src/loop/orchestrator.ts`), add:
```ts
      announceArtifacts();
```
Match the surrounding indentation.

- [ ] **Step 6: Run the tests and the typecheck**

Run: `cd backend && npx vitest run src/loop/__tests__/progress.test.ts && npx tsc --noEmit && echo TSC_OK`
Expected: PASS, then `TSC_OK`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/loop/progress.ts backend/src/loop/__tests__/progress.test.ts backend/src/types.ts backend/src/loop/orchestrator.ts
git commit -m "feat(loop): generic progress protocol and artifacts_changed events"
```

---

### Task 5: llm-agent reports its own progress

The bridge runner now says what it's doing. Agent nodes then show "Calling MiniMax-M2.7", followed by "Wrote 3 files", instead of nothing.

**Files:**
- Modify: `backend/llm-agent.mjs`
- Modify: `backend/src/loop/__tests__/llm-agent-cli.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `llm-agent-cli.test.ts`, reusing the file's existing `runLlmAgent` helper and `CLAUDE_SHIM_MAKER` constant. Check the existing maker test for the exact argument list it passes, and copy it.
```ts
it("emits progress lines for the model call and the files written", async () => {
  workdir = await mkdtemp(join(tmpdir(), "llm-agent-progress-"));
  const result = await runLlmAgent(
    ["--model", "x", "--base-url", "http://unused", "--workdir", workdir,
      "--role", "maker", "--output", join(workdir, "index.html"), "--cli"],
    { ...process.env, LOOP_CLI_BIN: CLAUDE_SHIM_MAKER, LOOP_USER_PROMPT: "build it" }
  );
  expect(result.code).toBe(0);
  const progress = result.stderr.split("\n").filter((l) => l.startsWith("__LOOP_PROGRESS__:"));
  expect(progress[0]).toContain("Calling local CLI");
  expect(progress.some((l) => /Wrote \d+ file/.test(l))).toBe(true);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd backend && npx vitest run src/loop/__tests__/llm-agent-cli.test.ts -t "progress lines"`
Expected: FAIL, because there are no progress lines.

- [ ] **Step 3: Implement**

In `backend/llm-agent.mjs`, add this helper near the top, after the imports:
```js
// Progress protocol (see backend/src/loop/progress.ts): the orchestrator
// turns these lines into the node's live status text.
function emitProgress(label, percent) {
  const payload = percent === undefined ? { label } : { label, percent };
  process.stderr.write(`__LOOP_PROGRESS__:${JSON.stringify(payload)}\n`);
}
```
Directly above the line `if (args.cli) {` (the start of the model-call branch), add:
```js
  emitProgress(args.cli ? "Calling local CLI" : `Calling ${args.model}`);
```
In the maker branch, directly after the `for (const f of files) { … }` loop that fills `written`, add:
```js
    emitProgress(`Wrote ${written.length} file${written.length === 1 ? "" : "s"}`, 100);
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx vitest run src/loop/__tests__/llm-agent-cli.test.ts`
Expected: PASS, including all the existing CLI tests.

- [ ] **Step 5: Commit**

```bash
git add backend/llm-agent.mjs backend/src/loop/__tests__/llm-agent-cli.test.ts
git commit -m "feat(agent): report model-call and file-write progress"
```

---

### Task 6: Define the missing Tailwind colours

`Button.tsx` and `Badge.tsx` use `accent-50/500/600/700/800` and `ink-100`, but `tailwind.config.js` defines neither `accent` nor `ink.100`. Those classes generate no CSS today, so primary buttons have no background. Define the scale around the app's existing violet (`#7c4dff`, already used by `pulse-ring` and the `focus` shadow).

**Files:** Modify `ui/tailwind.config.js`

- [ ] **Step 1: Confirm the bug**

Run:
```bash
cd ui && npm run build >/dev/null 2>&1; grep -c "bg-accent-600" dist/assets/*.css
```
Expected: `0`. (If the build still fails, do Task 0 first.)

- [ ] **Step 2: Add the colours**

In `ui/tailwind.config.js`, inside `theme.extend.colors`, add `100` and `600` to `ink`, and add an `accent` scale:
```js
        ink: {
          900: "#0a0a0f",
          800: "#1a1a23",
          700: "#2a2a35",
          600: "#4a4a57",
          500: "#6b6b7a",
          400: "#9a9aa8",
          300: "#c5c5d0",
          100: "#f1f1f5",
        },
        // The app's violet (pulse-ring / focus shadow), as a full scale so
        // Button/Badge `accent-*` classes actually generate CSS.
        accent: {
          50: "#f3efff",
          100: "#e6dcff",
          200: "#cdbaff",
          300: "#b195ff",
          400: "#9670ff",
          500: "#7c4dff",
          600: "#6a35f5",
          700: "#5a27d9",
          800: "#4a20b0",
          900: "#3d1d8c",
        },
```

- [ ] **Step 3: Verify**

Run:
```bash
cd ui && npm run build >/dev/null 2>&1; grep -c "bg-accent-600" dist/assets/*.css
```
Expected: `1` or more.

- [ ] **Step 4: Commit**

```bash
git add ui/tailwind.config.js
git commit -m "fix(ui): define accent scale and ink shades used by Button and Badge"
```

---

### Task 7: Mirror the new types in the UI

**Files:** Modify `ui/src/types/loop.ts`

- [ ] **Step 1: Add the types**

Near the `TaskSummary` type, add:
```ts
/** Mirrors backend/src/loop/artifacts.ts. */
export type ArtifactKind = "video" | "audio" | "image" | "document" | "code" | "data" | "other";

export interface Artifact {
  path: string;
  kind: ArtifactKind;
  mime: string;
  size: number;
  modifiedAt: string;
}
```
In the UI's `WsServerMessage` union, after the `task_deleted` member, add:
```ts
  | { type: "progress"; taskId: string; nodeId: string; label: string; percent?: number }
  | { type: "artifacts_changed"; taskId: string }
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc -b && echo TSC_OK`
Expected: `TSC_OK`.

- [ ] **Step 3: Commit**

```bash
git add ui/src/types/loop.ts
git commit -m "feat(ui): types for artifacts and progress events"
```

---

### Task 8: Store support for progress, artifacts and hydrated logs

`loadTask` currently forces `logs: []` (`store.ts:334`), so reopening a task shows "no log entries yet" even though `task.logs` holds up to 500 lines.

**Files:**
- Modify: `ui/src/lib/store.ts`
- Create: `ui/src/lib/store.progress.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useWorkflow } from "@/lib/store";
import type { Task } from "@/types/loop";

const task = {
  id: "t1",
  status: "implementing",
  attempt: 1,
  logs: [{ ts: "2026-10-10T10:00:00.000Z", agent: "maker", stream: "stdout", text: "hello" }],
} as unknown as Task;

describe("store: progress, artifacts, logs", () => {
  beforeEach(() => useWorkflow.getState().resetTaskState());

  it("loadTask keeps the task's persisted logs", () => {
    useWorkflow.getState().loadTask(task);
    expect(useWorkflow.getState().logs.map((l) => l.text)).toEqual(["hello"]);
  });

  it("records per-node progress with a timestamp, and clears it on load", () => {
    useWorkflow.getState().setNodeProgress("maker", { label: "Rendering", percent: 40 });
    const p = useWorkflow.getState().nodeProgress.maker;
    expect(p).toMatchObject({ label: "Rendering", percent: 40 });
    expect(typeof p.at).toBe("number");
    useWorkflow.getState().loadTask(task);
    expect(useWorkflow.getState().nodeProgress).toEqual({});
  });

  it("bumpArtifacts increments the version", () => {
    const before = useWorkflow.getState().artifactsVersion;
    useWorkflow.getState().bumpArtifacts();
    expect(useWorkflow.getState().artifactsVersion).toBe(before + 1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd ui && npx vitest run src/lib/store.progress.test.ts`
Expected: FAIL, because `setNodeProgress` doesn't exist and logs is `[]`.

- [ ] **Step 3: Implement**

In `ui/src/lib/store.ts`:

1. In `interface WorkflowState`, after the `liveScore` block, add:
```ts
  /** Latest progress line per canvas node (from `progress` WS events).
   *  `at` is when that label was set, for the node's elapsed timer. */
  nodeProgress: Record<string, { label: string; percent?: number; at: number }>;
  /** Bumped on `artifacts_changed`; the Outputs panel refetches on change. */
  artifactsVersion: number;
  setNodeProgress: (nodeId: string, p: { label: string; percent?: number }) => void;
  bumpArtifacts: () => void;
```

2. In the initial state object (next to `liveScore: null,` around line 215), add:
```ts
  nodeProgress: {},
  artifactsVersion: 0,
```

3. Add the two actions next to `setLiveScore`:
```ts
  setNodeProgress: (nodeId, p) =>
    set((s) => ({ nodeProgress: { ...s.nodeProgress, [nodeId]: { ...p, at: Date.now() } } })),
  bumpArtifacts: () => set((s) => ({ artifactsVersion: s.artifactsVersion + 1 })),
```

4. In `loadTask`, replace `logs: [],` with:
```ts
      // Persisted on the task (last 500 lines). Restoring them is what makes
      // a page reload mid-run show the history instead of an empty strip.
      logs: task.logs ?? [],
      nodeProgress: {},
```

5. In the other two places that reset `logs: []` (the `setCurrentTask` action around line 300 and `resetTaskState` around line 538), add `nodeProgress: {},` beside it.

- [ ] **Step 4: Run the tests**

Run: `cd ui && npx vitest run`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/store.ts ui/src/lib/store.progress.test.ts
git commit -m "feat(ui): store node progress, artifact version, and hydrate logs on load"
```

---

### Task 9: Handle the new events and resync after a reconnect

The server doesn't replay events missed while the socket was down; the Vite dev proxy alone cycles it every 30–60 s. On every *re*connect, refetch the current task.

**Files:**
- Create: `ui/src/lib/resyncTask.ts`
- Create: `ui/src/lib/resyncTask.test.ts`
- Modify: `ui/src/hooks/useLoopSocket.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resyncTask } from "@/lib/resyncTask";
import { useWorkflow } from "@/lib/store";

const originalFetch = globalThis.fetch;

describe("resyncTask", () => {
  beforeEach(() => {
    useWorkflow.getState().resetTaskState();
    useWorkflow.setState({ currentTaskId: "t1" });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("refreshes the mirror, logs and outputs for the current task", async () => {
    const task = { id: "t1", status: "verifying", attempt: 2, logs: [{ ts: "x", agent: "verifier", stream: "stdout", text: "late line" }] };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ task }) }) as never;
    const before = useWorkflow.getState().artifactsVersion;
    await resyncTask("t1");
    const s = useWorkflow.getState();
    expect(s.taskMirror?.status).toBe("verifying");
    expect(s.logs.map((l) => l.text)).toEqual(["late line"]);
    expect(s.artifactsVersion).toBe(before + 1);
  });

  it("drops the response if the user switched tasks meanwhile", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      useWorkflow.setState({ currentTaskId: "t2" });
      return { ok: true, json: async () => ({ task: { id: "t1", status: "done", attempt: 1, logs: [] } }) };
    }) as never;
    await resyncTask("t1");
    expect(useWorkflow.getState().taskMirror).toBeNull();
  });

  it("swallows network errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline")) as never;
    await expect(resyncTask("t1")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd ui && npx vitest run src/lib/resyncTask.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement `resyncTask`**

`ui/src/lib/resyncTask.ts`:
```ts
import { useWorkflow } from "@/lib/store";
import type { Task } from "@/types/loop";

/**
 * Refetch the open task after a WebSocket reconnect. The server doesn't
 * replay events missed while the socket was down, so without this a
 * dropped connection leaves the canvas and log strip silently stale.
 */
export async function resyncTask(id: string): Promise<void> {
  try {
    const res = await fetch(`/api/tasks/${id}`);
    if (!res.ok) return;
    const { task } = (await res.json()) as { task: Task };
    const s = useWorkflow.getState();
    if (s.currentTaskId !== id) return; // user moved on while we waited
    s.setTaskMirror(task);
    s.applyTaskStatusToNodes(task.status, task.attempt);
    useWorkflow.setState({ logs: task.logs ?? [] });
    s.bumpArtifacts();
  } catch {
    /* offline: the next reconnect retries */
  }
}
```

- [ ] **Step 4: Wire up the socket**

In `ui/src/hooks/useLoopSocket.ts`:

1. Add `import { resyncTask } from "@/lib/resyncTask";` and, next to `let pendingSubscriptions`, add:
```ts
/** False until the first successful open, so the initial connect doesn't
 *  trigger a pointless resync (the task was just loaded). */
let hasConnectedBefore = false;
```

2. In `socket.onopen`, after the `for (const taskId of pendingSubscriptions)` loop, add:
```ts
      const openTaskId = useWorkflow.getState().currentTaskId;
      if (hasConnectedBefore && openTaskId) void resyncTask(openTaskId);
      hasConnectedBefore = true;
```

3. In the `switch (msg.type)`, add two cases after `case "node_status"`:
```ts
        case "progress": {
          if (msg.taskId !== s.currentTaskId) return;
          s.setNodeProgress(msg.nodeId, { label: msg.label, percent: msg.percent });
          break;
        }

        case "artifacts_changed": {
          if (msg.taskId !== s.currentTaskId) return;
          s.bumpArtifacts();
          break;
        }
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd ui && npx vitest run && npx tsc -b && echo TSC_OK`
Expected: all PASS, then `TSC_OK`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/resyncTask.ts ui/src/lib/resyncTask.test.ts ui/src/hooks/useLoopSocket.ts
git commit -m "feat(ui): handle progress/artifact events and resync the open task after reconnect"
```

---

### Task 10: Reopen the running task after a page reload

`currentTaskId` starts as `null`, so a reload mid-run shows an empty canvas until the user finds the task in the sidebar. On first load, auto-open the most recently updated live task. A newly selected task should also paint its nodes immediately, rather than waiting for the next event.

**Files:**
- Create: `ui/src/lib/pickLiveTask.ts`
- Create: `ui/src/lib/pickLiveTask.test.ts`
- Modify: `ui/src/lib/selectTask.ts`
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { pickLiveTask } from "@/lib/pickLiveTask";
import type { TaskSummary } from "@/types/loop";

const t = (id: string, status: string, updatedAt: string) => ({ id, status, updatedAt }) as unknown as TaskSummary;

describe("pickLiveTask", () => {
  it("returns null when nothing is live", () => {
    expect(pickLiveTask([t("a", "done", "2026-10-10T10:00:00Z"), t("b", "cancelled", "2026-10-10T11:00:00Z")])).toBeNull();
  });

  it("picks the most recently updated live task", () => {
    const picked = pickLiveTask([
      t("a", "plan_review", "2026-10-10T10:00:00Z"),
      t("b", "implementing", "2026-10-10T12:00:00Z"),
      t("c", "done", "2026-10-10T13:00:00Z"),
    ]);
    expect(picked?.id).toBe("b");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd ui && npx vitest run src/lib/pickLiveTask.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement**

`ui/src/lib/pickLiveTask.ts`:
```ts
import type { TaskSummary } from "@/types/loop";

const LIVE_STATUSES = new Set(["planning", "plan_review", "implementing", "verifying"]);

/** The task to reopen after a page reload: the most recently updated live one. */
export function pickLiveTask(tasks: TaskSummary[]): TaskSummary | null {
  let best: TaskSummary | null = null;
  for (const task of tasks) {
    if (!LIVE_STATUSES.has(task.status)) continue;
    if (!best || task.updatedAt > best.updatedAt) best = task;
  }
  return best;
}
```

In `ui/src/lib/selectTask.ts`, inside `selectTask` directly after `loadTask(task);`, add:
```ts
    // Paint the canvas from the task's real status right away, rather than
    // leaving every node idle until the next WS event (which may never come
    // for a task parked in plan_review).
    useWorkflow.getState().applyTaskStatusToNodes(task.status, task.attempt);
```
`useWorkflow` is already imported in that file.

In `ui/src/App.tsx`:
- Add the imports `import { useRef } from "react";` (merge it into the existing `react` import), `import { pickLiveTask } from "@/lib/pickLiveTask";` and `import { useSelectTask } from "@/lib/selectTask";`.
- Change `const { refresh: refreshTasks } = useTaskList();` to:
```ts
  const { tasks, refresh: refreshTasks } = useTaskList();
  const selectTaskById = useSelectTask();
  // Reopen the running task once, on the first task-list load after a page
  // reload, so a long unattended run is still on screen when you come back.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || tasks.length === 0) return;
    restoredRef.current = true;
    if (useWorkflow.getState().currentTaskId) return;
    const live = pickLiveTask(tasks);
    if (live) selectTaskById(live.id);
  }, [tasks, selectTaskById]);
```
The `useEffect` must sit after `selectTaskById` is defined and before the `return`. Hooks may not run conditionally, so keep it at the top level of `App` (it already runs after the `/chatbot-lab` early return, as the existing hooks do).

- [ ] **Step 4: Run the tests and the build**

Run: `cd ui && npx vitest run && npm run build 2>&1 | tail -3`
Expected: all PASS, and the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/pickLiveTask.ts ui/src/lib/pickLiveTask.test.ts ui/src/lib/selectTask.ts ui/src/App.tsx
git commit -m "feat(ui): reopen the running task after a page reload"
```

---

### Task 11: Live progress on canvas nodes

While a node is running, its subtitle line shows the latest progress label and how long it has been on that step, for example "Calling MiniMax-M2.7 · 1:12". A thin accent bar fills when a percent is known. Everything stays within the pill's existing layout and colours.

**Files:**
- Create: `ui/src/lib/useNow.ts`
- Modify: `ui/src/lib/format.ts`
- Create: `ui/src/lib/format.progress.test.ts`
- Modify: `ui/src/components/canvas/WorkflowNode.tsx`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { formatElapsed, formatBytes } from "@/lib/format";

describe("formatElapsed", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(72_000)).toBe("1:12");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("formatBytes", () => {
  it("uses B, KB, MB, GB with one decimal above KB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd ui && npx vitest run src/lib/format.progress.test.ts`
Expected: FAIL, because the functions don't exist.

- [ ] **Step 3: Implement the helpers**

Append to `ui/src/lib/format.ts`:
```ts
/** 72_000 → "1:12", 3_725_000 → "1:02:05". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
```
`ui/src/lib/useNow.ts`:
```ts
import { useEffect, useState } from "react";

/** Current time, re-rendering every `everyMs` while `active`. Idle nodes don't tick. */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [active, everyMs]);
  return now;
}
```

- [ ] **Step 4: Show progress in the node**

In `ui/src/components/canvas/WorkflowNode.tsx`:

1. Add the imports:
```ts
import { useWorkflow } from "@/lib/store";
import { useNow } from "@/lib/useNow";
import { formatElapsed } from "@/lib/format";
```
(skip any that are already imported).

2. In `WorkflowNodeImpl`, after the line that defines `isRunning`, add:
```ts
  const progress = useWorkflow((s) => s.nodeProgress[spec.id]);
  const now = useNow(isRunning && Boolean(progress));
  const liveLine =
    isRunning && progress ? `${progress.label} · ${formatElapsed(now - progress.at)}` : null;
```

3. Replace the subtitle block:
```tsx
          {spec.subtitle && (
            <p
              className={cn(
                "truncate text-[10.5px] transition-colors",
                selected
                  ? "text-blue-700/80 dark:text-sky-300/80"
                  : "text-zinc-500 dark:text-zinc-400"
              )}
            >
              {spec.subtitle}
            </p>
          )}
```
with:
```tsx
          {(liveLine || spec.subtitle) && (
            <p
              title={liveLine ?? undefined}
              className={cn(
                "truncate text-[10.5px] transition-colors",
                liveLine && "font-medium tabular-nums",
                selected
                  ? "text-blue-700/80 dark:text-sky-300/80"
                  : liveLine
                  ? "text-accent-600 dark:text-accent-300"
                  : "text-zinc-500 dark:text-zinc-400"
              )}
            >
              {liveLine ?? spec.subtitle}
            </p>
          )}
```

4. Add the percent bar as the **last child of the pill's root element** (the element whose className holds the pill's border and rounded classes). If that root lacks `relative`, add `relative` to its className.
```tsx
        {isRunning && progress?.percent !== undefined && (
          <div className="pointer-events-none absolute inset-x-3 bottom-1 h-0.5 overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-700/60">
            <div
              className="h-full rounded-full bg-accent-500 transition-[width] duration-500"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        )}
```

- [ ] **Step 5: Run the tests and the build**

Run: `cd ui && npx vitest run && npm run build 2>&1 | tail -3`
Expected: all PASS, and the build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/useNow.ts ui/src/lib/format.ts ui/src/lib/format.progress.test.ts ui/src/components/canvas/WorkflowNode.tsx
git commit -m "feat(ui): live progress label, elapsed time and percent bar on canvas nodes"
```

---

### Task 12: Outputs panel

This adds an "Outputs" section to the task panel, while the task is running and when it's done:
- Videos get an inline player. Portrait Shorts stay portrait (`object-contain`, max 360 px tall).
- Audio gets a player, and images get a thumbnail.
- Everything else is a compact file row.
- Every item has Open and Download.
- The list refetches whenever `artifactsVersion` changes.

**Files:**
- Create: `ui/src/lib/artifacts.ts`
- Create: `ui/src/lib/artifacts.test.ts`
- Create: `ui/src/components/OutputsPanel.tsx`
- Create: `ui/src/components/OutputsPanel.test.tsx`
- Modify: `ui/src/components/NodeConfigPanel.tsx`

- [ ] **Step 1: Write the failing tests**

`ui/src/lib/artifacts.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { fileUrl, groupArtifacts } from "@/lib/artifacts";
import type { Artifact } from "@/types/loop";

const a = (path: string, kind: Artifact["kind"]): Artifact => ({ path, kind, mime: "", size: 1, modifiedAt: "" });

describe("fileUrl", () => {
  it("encodes each path segment but keeps the slashes", () => {
    expect(fileUrl("t1", "output/my clip#1.mp4")).toBe("/api/tasks/t1/files/output/my%20clip%231.mp4");
    expect(fileUrl("t1", "a.mp4", true)).toBe("/api/tasks/t1/files/a.mp4?download=1");
  });
});

describe("groupArtifacts", () => {
  it("splits playable media from other files, keeping order", () => {
    const { media, files } = groupArtifacts([a("x.md", "document"), a("v.mp4", "video"), a("i.png", "image"), a("s.wav", "audio")]);
    expect(media.map((m) => m.path)).toEqual(["v.mp4", "i.png", "s.wav"]);
    expect(files.map((f) => f.path)).toEqual(["x.md"]);
  });
});
```

`ui/src/components/OutputsPanel.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { OutputsPanel } from "@/components/OutputsPanel";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockArtifacts(artifacts: unknown[]) {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ artifacts }) }) as never;
}

describe("OutputsPanel", () => {
  it("renders a video player and a download link for an mp4", async () => {
    mockArtifacts([{ path: "output/short-1.mp4", kind: "video", mime: "video/mp4", size: 2048, modifiedAt: "2026-10-10T10:00:00Z" }]);
    const { container } = render(<OutputsPanel taskId="t1" version={0} />);
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/tasks/t1/files/output/short-1.mp4");
    expect(screen.getByText("short-1.mp4")).toBeTruthy();
    expect(screen.getByRole("link", { name: /download short-1.mp4/i }).getAttribute("href")).toBe(
      "/api/tasks/t1/files/output/short-1.mp4?download=1"
    );
  });

  it("shows the empty state when there are no outputs", async () => {
    mockArtifacts([]);
    render(<OutputsPanel taskId="t1" version={0} />);
    await waitFor(() => expect(screen.getByText(/No outputs yet/i)).toBeTruthy());
  });

  it("refetches when the version changes", async () => {
    mockArtifacts([]);
    const { rerender } = render(<OutputsPanel taskId="t1" version={0} />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    rerender(<OutputsPanel taskId="t1" version={1} />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd ui && npx vitest run src/lib/artifacts.test.ts src/components/OutputsPanel.test.tsx`
Expected: FAIL, because the modules don't exist.

- [ ] **Step 3: Implement the helpers**

`ui/src/lib/artifacts.ts`:
```ts
import type { Artifact } from "@/types/loop";

export function fileUrl(taskId: string, path: string, download = false): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/api/tasks/${taskId}/files/${encoded}${download ? "?download=1" : ""}`;
}

const MEDIA = new Set<Artifact["kind"]>(["video", "image", "audio"]);

/** Playable media (shown large) vs. everything else (compact rows). */
export function groupArtifacts(artifacts: Artifact[]): { media: Artifact[]; files: Artifact[] } {
  return {
    media: artifacts.filter((a) => MEDIA.has(a.kind)),
    files: artifacts.filter((a) => !MEDIA.has(a.kind)),
  };
}
```

- [ ] **Step 4: Implement the component**

`ui/src/components/OutputsPanel.tsx`:
```tsx
import { useEffect, useState } from "react";
import { Download, ExternalLink, FileText, FileCode2, FileAudio, Film, ImageIcon, File as FileIcon } from "lucide-react";
import { fileUrl, groupArtifacts } from "@/lib/artifacts";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Artifact } from "@/types/loop";

const KIND_ICON = {
  video: Film,
  audio: FileAudio,
  image: ImageIcon,
  document: FileText,
  code: FileCode2,
  data: FileCode2,
  other: FileIcon,
} as const;

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Everything the task produced: players for media, rows for the rest. */
export function OutputsPanel({ taskId, version }: { taskId: string; version: number }) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tasks/${taskId}/artifacts`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { artifacts: list } = (await res.json()) as { artifacts: Artifact[] };
        if (!cancelled) {
          setArtifacts(list);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, version]);

  if (error) {
    return <p className="text-[12px] text-amber-700 dark:text-amber-300">Couldn't load outputs: {error}</p>;
  }
  if (!artifacts) {
    return <p className="animate-pulse-soft text-[12px] text-zinc-400">Loading outputs…</p>;
  }
  if (artifacts.length === 0) {
    return (
      <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
        No outputs yet. Files the loop creates will appear here.
      </p>
    );
  }

  const { media, files } = groupArtifacts(artifacts);
  return (
    <div className="space-y-3">
      {media.map((a) => (
        <figure
          key={a.path}
          className="overflow-hidden rounded-lg border border-zinc-200 bg-white animate-pop dark:border-zinc-800 dark:bg-zinc-900"
        >
          {a.kind === "video" && (
            <video
              controls
              preload="metadata"
              src={fileUrl(taskId, a.path)}
              className="max-h-[360px] w-full bg-black object-contain"
            />
          )}
          {a.kind === "image" && (
            <img src={fileUrl(taskId, a.path)} alt={baseName(a.path)} className="max-h-[360px] w-full bg-zinc-50 object-contain dark:bg-zinc-950" />
          )}
          {a.kind === "audio" && (
            <div className="px-3 pt-3">
              <audio controls preload="metadata" src={fileUrl(taskId, a.path)} className="w-full" />
            </div>
          )}
          <ArtifactRow taskId={taskId} artifact={a} className="border-t-0" />
        </figure>
      ))}
      {files.length > 0 && (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {files.map((a) => (
            <li key={a.path}>
              <ArtifactRow taskId={taskId} artifact={a} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArtifactRow({ taskId, artifact, className }: { taskId: string; artifact: Artifact; className?: string }) {
  const Icon = KIND_ICON[artifact.kind];
  const name = baseName(artifact.path);
  return (
    <div className={cn("flex items-center gap-2 px-3 py-2", className)}>
      <Icon size={14} strokeWidth={2} className="shrink-0 text-zinc-400" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">{name}</div>
        <div className="truncate font-mono text-[10.5px] text-zinc-400" title={artifact.path}>
          {formatBytes(artifact.size)} · {artifact.path}
        </div>
      </div>
      <a
        href={fileUrl(taskId, artifact.path)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${name}`}
        className="grid h-7 w-7 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <ExternalLink size={14} strokeWidth={2} />
      </a>
      <a
        href={fileUrl(taskId, artifact.path, true)}
        aria-label={`Download ${name}`}
        className="grid h-7 w-7 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-accent-50 hover:text-accent-700 dark:hover:bg-accent-500/15 dark:hover:text-accent-300"
      >
        <Download size={14} strokeWidth={2} />
      </a>
    </div>
  );
}
```

- [ ] **Step 5: Add Outputs to the task panels**

In `ui/src/components/NodeConfigPanel.tsx`, add `import { OutputsPanel } from "@/components/OutputsPanel";`. Then:

1. In `DonePanel`, add `const taskId = useWorkflow((s) => s.currentTaskId);` and `const artifactsVersion = useWorkflow((s) => s.artifactsVersion);`. Put this as the **first** child of its scrolling `<div className="flex-1 overflow-y-auto px-4 py-4">`:
```tsx
        {taskId && (
          <Section label="Outputs">
            <OutputsPanel taskId={taskId} version={artifactsVersion} />
          </Section>
        )}
```

2. In `TaskOverviewPanel`, add the same two selectors and the same `Section` block. Place it as the **last** section in that panel's scroll area, so the live status stays on top while the run is in progress.

- [ ] **Step 6: Run the tests and the build**

Run: `cd ui && npx vitest run && npm run build 2>&1 | tail -3`
Expected: all PASS, and the build succeeds.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/artifacts.ts ui/src/lib/artifacts.test.ts ui/src/components/OutputsPanel.tsx ui/src/components/OutputsPanel.test.tsx ui/src/components/NodeConfigPanel.tsx
git commit -m "feat(ui): Outputs panel with video/audio/image players and downloads"
```

---

### Task 13: Toasts instead of silent failures

Seven user actions report failures only to the console:
- `NodeConfigPanel.tsx`: confirm plan (about line 76), adjust plan (about line 100), and feedback (about line 669).
- `TopBar.tsx`: resume (lines 73 and 76) and reset (lines 98 and 101).

Several also never check `res.ok`. After Phase 0, `adjust-plan` can return a 409 with a useful message, and today the user never sees it.

**Files:**
- Create: `ui/src/lib/toast.ts`
- Create: `ui/src/lib/toast.test.ts`
- Create: `ui/src/components/Toaster.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/NodeConfigPanel.tsx`
- Modify: `ui/src/components/TopBar.tsx`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useToasts, toastError, postAction } from "@/lib/toast";

const originalFetch = globalThis.fetch;
beforeEach(() => useToasts.setState({ toasts: [] }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("toasts", () => {
  it("pushes, caps at 4, and auto-dismisses", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 6; i++) toastError(`e${i}`);
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(["e2", "e3", "e4", "e5"]);
    vi.advanceTimersByTime(6_000);
    expect(useToasts.getState().toasts).toEqual([]);
  });
});

describe("postAction", () => {
  it("resolves on 2xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }) as never;
    await expect(postAction("/api/x", { a: 1 })).resolves.toEqual({ ok: true });
  });

  it("throws the server's error message on failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "loop is not running" }) }) as never;
    await expect(postAction("/api/x")).rejects.toThrow("loop is not running");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd ui && npx vitest run src/lib/toast.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement**

`ui/src/lib/toast.ts`:
```ts
import { create } from "zustand";

export interface Toast {
  id: number;
  tone: "error" | "info";
  message: string;
}

interface ToastState {
  toasts: Toast[];
  push: (tone: Toast["tone"], message: string) => void;
  dismiss: (id: number) => void;
}

const MAX_TOASTS = 4;
const TOAST_MS = 6_000;
let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (tone, message) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, tone, message }].slice(-MAX_TOASTS) }));
    setTimeout(() => useToasts.getState().dismiss(id), TOAST_MS);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toastError = (message: string) => useToasts.getState().push("error", message);
export const toastInfo = (message: string) => useToasts.getState().push("info", message);

/** POST JSON; resolve with the parsed body, or throw with the server's `error` text. */
export async function postAction(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const message = (parsed as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new Error(message);
  }
  return parsed;
}
```

`ui/src/components/Toaster.tsx`:
```tsx
import { AlertTriangle, Info, X } from "lucide-react";
import { useToasts } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Bottom-right stack, above the live log strip. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-16 right-4 z-50 flex w-[340px] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-white px-3 py-2.5 shadow-card animate-pop dark:bg-zinc-900",
            t.tone === "error"
              ? "border-amber-200 dark:border-amber-500/30"
              : "border-zinc-200 dark:border-zinc-800"
          )}
        >
          {t.tone === "error" ? (
            <AlertTriangle size={15} strokeWidth={2.2} className="mt-0.5 shrink-0 text-amber-500" />
          ) : (
            <Info size={15} strokeWidth={2.2} className="mt-0.5 shrink-0 text-accent-500" />
          )}
          <p className="flex-1 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">{t.message}</p>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Mount it and replace the silent failures**

In `ui/src/App.tsx`, add `import { Toaster } from "@/components/Toaster";`, and render `<Toaster />` directly after `<LiveLogStrip />`.

At each of the seven sites below, replace the `fetch(...)` call with `await postAction(url, body)`, using the same URL and body as the existing call. Then replace the `console.error(...)` in the `catch` with the matching `toastError(...)`. Import `postAction` and `toastError` from `@/lib/toast` in both files. The pattern, shown for confirm plan:
```ts
    try {
      await postAction(`/api/tasks/${currentTaskId}/confirm-plan`, {});
    } catch (e) {
      toastError(`Couldn't approve the plan: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
```
Keep any existing `finally` / state resets exactly as they are. The messages for the other sites:

| Site | Message prefix |
|---|---|
| NodeConfigPanel adjust plan | `Couldn't send plan changes:` |
| NodeConfigPanel feedback | `Couldn't send feedback:` |
| TopBar resume (both `console.error` calls collapse into one catch) | `Couldn't resume the task:` |
| TopBar reset (both `console.error` calls collapse into one catch) | `Couldn't reset the task:` |

In TopBar, the existing `if (!res.ok) console.error(...)` branches disappear, because `postAction` throws on non-2xx.

- [ ] **Step 5: Verify**

Run:
```bash
cd ui && npx vitest run && npm run build 2>&1 | tail -3 && grep -n "console.error" src/components/NodeConfigPanel.tsx src/components/TopBar.tsx
```
Expected: tests pass, the build succeeds, and grep prints nothing.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/toast.ts ui/src/lib/toast.test.ts ui/src/components/Toaster.tsx ui/src/App.tsx ui/src/components/NodeConfigPanel.tsx ui/src/components/TopBar.tsx
git commit -m "feat(ui): surface failed actions as toasts instead of console errors"
```

---

### Task 14: Remove dead and misleading controls

These controls look interactive but do nothing, or do something other than their label says. Remove or relabel each one. Find them by the text in the "Locate by" column; line numbers may have drifted.

**Files:** `ui/src/components/canvas/ChatbotNode.tsx`, `ui/src/components/TopBar.tsx`, `ui/src/components/canvas/RunButton.tsx`, `ui/src/components/canvas/ProgressNode.tsx`, `ui/src/components/NodeConfigPanel.tsx`, `ui/src/components/BottomBar.tsx`

| Control | Locate by | Action |
|---|---|---|
| Chatbot "Pause" button that actually opens Stop | `ChatbotNode.tsx` around line 459, the button dispatching `loop:requestStop` | Change its label and `aria-label`/`title` from "Pause" to "Stop". Change its icon to lucide `Square` |
| Chatbot Mic button that toggles `paused` | `ChatbotNode.tsx` around line 637, the button rendering `<Mic` | Delete the button. Delete the `Mic` import if unused. Delete the `paused` state if nothing else reads it |
| TopBar Settings and Bell icons | `TopBar.tsx` around lines 223-236, the buttons rendering `<Settings` and `<Bell` | Delete both buttons and their unused imports |
| RunButton "AI Assistant" | `RunButton.tsx` around line 50 | Delete the button and its unused imports |
| ProgressNode "Back" chevron | `ProgressNode.tsx` around line 312, the button with no `onClick` | Delete it |
| FeedbackPanel "Escalate" with no handler | `NodeConfigPanel.tsx` around line 735 | Delete the button |
| `DefaultNodeConfig` (unreachable, fake "nexusflow" HTTP-request data) | `NodeConfigPanel.tsx` around line 1087, `function DefaultNodeConfig` | Delete the function and any helpers only it used |
| `BottomBar.tsx` (never imported) | `grep -rn "BottomBar" ui/src` shows only its own file | `git rm ui/src/components/BottomBar.tsx` |

- [ ] **Step 1: Make the removals listed above**

- [ ] **Step 2: Verify nothing references the removed code**

Run:
```bash
cd ui && grep -rn "BottomBar\|DefaultNodeConfig" src; npx tsc -b && npx vitest run 2>&1 | tail -4 && npm run build 2>&1 | tail -3
```
Expected: grep prints nothing, the typecheck passes, all tests pass, and the build succeeds. TypeScript's `noUnusedLocals`, if enabled, will flag leftover imports. Remove them.

- [ ] **Step 3: Commit**

```bash
git add -A ui/src
git commit -m "chore(ui): remove dead controls and unreachable panels"
```

---

### Task 15: End-to-end verification in the browser

**Files:** none. Uses a throwaway fixture task.

- [ ] **Step 1: Full suites**

Run:
```bash
cd backend && npx vitest run 2>&1 | tail -4 && npx tsc --noEmit && echo BE_OK
cd ../ui && npx vitest run 2>&1 | tail -4 && npm run build 2>&1 | tail -2 && echo UI_OK
```
Expected: `BE_OK` and `UI_OK`.

- [ ] **Step 2: Fixture task with real media**

Start `loop-agent-backend` and `loop-agent-ui` with preview_start. Create a task, then stop it straight away so no model is called. Write a 6-second portrait test video and a markdown file into its workdir:
```bash
FF=~/.viral-clip-shorts/bin/ffmpeg   # installed by the viral-clip-shorts skill; any ffmpeg works
ID=$(curl -s -X POST http://127.0.0.1:3001/api/tasks -H 'Content-Type: application/json' \
  -d '{"prompt":"Phase 1 outputs fixture"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).task.id')
curl -s -X POST http://127.0.0.1:3001/api/tasks/$ID/stop >/dev/null
WD=$(curl -s http://127.0.0.1:3001/api/tasks/$ID | node -pe 'JSON.parse(require("fs").readFileSync(0)).task.workdir')
mkdir -p "$WD/output"
$FF -loglevel error -f lavfi -i testsrc=size=1080x1920:rate=30:duration=6 -f lavfi -i sine=frequency=440:duration=6 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WD/output/short-1.mp4"
printf '# Publish pack\n\nTitle: test\n' > "$WD/PUBLISH.md"
echo "$ID"
```
If POST /tasks needs `modelOverrides` in this setup, pass the same body the UI's NewTaskModal sends.

- [ ] **Step 3: Check the UI**

In the browser pane, at `http://localhost:5173`:
1. Open the fixture task. The Outputs section lists `short-1.mp4` with a portrait player, and `PUBLISH.md` as a row.
2. Play the video and seek to 4 s. `read_network_requests` shows `GET /api/tasks/<id>/files/output/short-1.mp4` answered with **206** and a `Content-Range` header.
3. The Download icon's URL ends in `?download=1`, and the response has `Content-Disposition: attachment`.
4. Reload the page while a task is live (a fresh task in `planning` will do). The canvas reopens on that task, and the log strip shows earlier lines.
5. Trigger an error: with the backend stopped, click Resume. An amber toast appears bottom-right.
6. Toggle dark mode with `resize_window colorScheme: "dark"` and the app's theme toggle. Every new element (Outputs rows, toasts, node progress text) has proper dark colours. Then reset with `resize_window preset: "desktop"`.
7. Take one screenshot of the Outputs panel in light mode and one in dark mode as proof.

- [ ] **Step 4: Update the audit**

In `docs/superpowers/specs/2026-10-10-loop-engine-audit.md`, append ` — **fixed in Phase 1**` to C5 and C8, and to the "Dead controls" medium item. For C4, note that the canvas now shows live progress, but the graph itself is still static (Phase 3).

```bash
git add docs/superpowers/specs/2026-10-10-loop-engine-audit.md
git commit -m "docs: mark Phase 1 findings fixed in the engine audit"
```

---

## Self-review notes

- **Spec coverage:**

  | Audit finding | Covered by |
  |---|---|
  | C5 (no artifacts, buffering, no Range, no player) | Tasks 1, 2, 3 and 12 |
  | C8 (reload and reconnect lose state; no progress) | Tasks 4, 5, 8, 9, 10 and 11 |
  | "Errors swallowed" (UI side) | Task 13 |
  | Dead controls | Task 14 |
  | Inconsistent styling (accent classes generate no CSS) | Task 6 |
  | C1–C4, C6, C7 | Deliberately out of scope; see the master roadmap (Phases 2–4) |

- **Type consistency:**
  - `Artifact` and `ArtifactKind` are identical in `backend/src/loop/artifacts.ts` and `ui/src/types/loop.ts`.
  - The `progress` and `artifacts_changed` message shapes are identical in both `WsServerMessage` unions.
  - Store names are used consistently: `setNodeProgress`, `bumpArtifacts`, `nodeProgress`, `artifactsVersion`.
- **Known limits:**
  - Progress text comes only from processes that print `__LOOP_PROGRESS__` lines. Today that is llm-agent's own two milestones; Phase 2's tool-running agents and Phase 4's tool nodes will report much more.
  - Missed events are recovered by snapshot (the task record), not replay. The persisted event journal arrives with the Phase 3 graph runner.
