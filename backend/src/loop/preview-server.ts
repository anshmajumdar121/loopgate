// One shared static HTTP server for task previews. Each task registers its
// workdir and gets back http://localhost:<port>/t/<taskId>/ — the "live
// link" the user opens to try the prototype. Lazy-started on first
// registration so the backend doesn't hold a port when no task ran yet.
//
// Deliberately dependency-free (node:http) — a static file map is all we
// need, and the backend already avoids framework servers outside Hono.

import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import {
  resolve as pathResolve,
  relative as pathRelative,
  isAbsolute,
  normalize,
  extname,
  sep,
} from "node:path";
import { isPublicDemo } from "../demo/publicDemo.js";

const PREVIEW_PORT = Number(process.env.LOOP_PREVIEW_PORT || 3210);
/** Loopback only — previews are for the local user, never the LAN. */
const PREVIEW_HOST = "127.0.0.1";

/** Separator-agnostic containment (works with win32 backslashes). */
function isWithin(root: string, child: string): boolean {
  const rel = pathRelative(root, child);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false; // different drive on win32
  return rel !== ".." && !rel.startsWith(".." + sep) && !rel.startsWith("../");
}

function realOr(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

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
/** Port the server actually bound to. With `LOOP_PREVIEW_PORT=0` the OS
 *  picks; we read it back via server.address() and use it in the returned
 *  URL (otherwise the URL would say `:0` and connect attempts would land
 *  on `ERR_UNSAFE_PORT` in Chromium / `EADDRNOTAVAIL` in Node fetch). */
let actualPort: number = PREVIEW_PORT;
/** True after the server has crashed / closed and we're due for a restart
 *  on the next ensureServer() call. The flag is the signal: it tells
 *  callers (orchestrator.ts) that a restart happened so they can log
 *  + re-broadcast, and it short-circuits the early-return in
 *  ensureServer() so the next caller actually re-binds. */
let needsRestart = false;
/** Monotonic counter — incremented every time ensureServer() actually
 *  creates a new server (initial bind OR restart). Callers can read the
 *  counter before/after a registerPreview() call to detect a restart
 *  event. Reset only by stopPreviewServer (intentional teardown). */
let bindCount = 0;

function ensureServer(): Promise<void> {
  // If a previous run died (crash, manual kill, OOM) the cached
  // `listening` promise was rejected or the server stopped — drop the
  // stale references so the next call rebuilds. Without this, the
  // module-level `listening` would forever resolve successfully and
  // the user would be stranded with a dead Live Preview link.
  if (needsRestart) {
    server = null;
    listening = null;
    needsRestart = false;
  }
  if (listening) return listening;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${actualPort}`);
    // Path shape: /t/<taskId>/<rest...>  (decodeURIComponent guards %2F tricks)
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    const m = decoded.match(/^\/t\/([^/]+)\/(.*)$/);
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
    const root = pathResolve(workdir);
    const target = pathResolve(root, normalize(rel));
    // Traversal guard: resolved path must stay inside the workdir.
    if (!isWithin(root, target)) {
      res.writeHead(404).end("not found");
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    // Symlink guard: the real file must also live inside the real workdir.
    if (!isWithin(realOr(root), realOr(target))) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store", // always serve the freshest attempt
    });
    createReadStream(target).pipe(res);
  });
  // Self-heal: when the server emits `error` or `close` outside of an
  // intentional stop, flip the restart flag so the next ensureServer()
  // call re-binds. `stopPreviewServer` clears the flag via the explicit
  // path (server is set to null there), so intentional teardown doesn't
  // trigger a restart on the next request.
  const onDead = () => {
    if (server) {
      // The server reference is still live, meaning the death was
      // unintentional (crash / external kill). Mark for restart.
      needsRestart = true;
      server = null;
      listening = null;
    }
  };
  server!.on("error", onDead);
  server!.on("close", onDead);
  listening = new Promise<void>((resolveP, rejectP) => {
    server!.once("error", rejectP);
    server!.listen(PREVIEW_PORT, PREVIEW_HOST, () => {
      const addr = server!.address();
      if (addr && typeof addr === "object") actualPort = addr.port;
      bindCount++;
      resolveP();
    });
  });
  return listening;
}

/**
 * Read the monotonic bind counter. Callers can compare before/after
 * a `registerPreview()` to detect a restart event (counter went up).
 * Exposed read-only because the counter is the simplest signal that
 * survives a single ensureServer() call without races — the value is
 * just an integer, callers don't mutate it.
 */
export function getPreviewServerBindCount(): number {
  return bindCount;
}

/** Register (or re-register) a task's workdir. Returns the preview URL. */
export async function registerPreview(taskId: string, workdir: string): Promise<string> {
  // Public demo: the loopback preview port isn't reachable by visitors and
  // its pages would feed the (disabled) runtime check. Callers treat the
  // preview as best-effort and log this.
  if (isPublicDemo()) throw new Error("previews are disabled in the public demo");
  registry.set(taskId, pathResolve(workdir));
  await ensureServer();
  return `http://localhost:${actualPort}/t/${taskId}/`;
}

/** Test/shutdown helper. */
export function stopPreviewServer(): void {
  server?.close();
  server = null;
  listening = null;
  needsRestart = false;
  bindCount = 0;
  registry.clear();
}
