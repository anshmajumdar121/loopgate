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
