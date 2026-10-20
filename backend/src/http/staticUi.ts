// Serves the built UI (ui/dist) from the backend process so the public demo
// is one service on one origin: the UI's relative /api and /ws URLs then
// reach this same server with no proxy. Unknown extension-less paths fall
// back to index.html (single-page app).

import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";
import { isWithinDir } from "../demo/publicDemo.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** Same-origin only; Google Fonts is the UI's one external resource. */
export const UI_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Returns a handler, or null when `root` has no index.html (UI not built). */
export async function createStaticUi(root: string) {
  const absRoot = resolve(root);
  if (!(await isFile(resolve(absRoot, "index.html")))) return null;
  const realRoot = realpathSync.native(absRoot);

  return async function serveUi(pathname: string, method: string): Promise<Response> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (decoded.includes("\0")) return new Response("bad request", { status: 400 });

    const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    let target = resolve(absRoot, normalize(rel));
    if (!isWithinDir(absRoot, target)) return new Response("not found", { status: 404 });
    if (!(await isFile(target))) {
      // SPA fallback for client-side routes; real missing assets stay 404.
      if (extname(target) !== "") return new Response("not found", { status: 404 });
      target = resolve(absRoot, "index.html");
    }
    // Symlink guard: the real file must live inside the real root too.
    if (!isWithinDir(realRoot, realpathSync.native(target))) {
      return new Response("not found", { status: 404 });
    }

    const isIndex = target === resolve(absRoot, "index.html");
    const headers: Record<string, string> = {
      ...UI_SECURITY_HEADERS,
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      // Vite fingerprints everything under assets/; the rest must revalidate.
      "cache-control":
        !isIndex && rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    };
    const body = method === "HEAD" ? null : new Uint8Array(await readFile(target));
    return new Response(body, { status: 200, headers });
  };
}
