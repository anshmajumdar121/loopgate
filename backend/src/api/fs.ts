// REST endpoint that lists a directory on the server's filesystem so the
// UI can render a Finder-like folder picker. The browser's native
// `showDirectoryPicker()` returns a name-only handle (security) which is
// useless for our use case (we need the absolute path so the backend can
// spawn agents into it). Since the backend runs on the user's machine in
// v1, exposing listings is low-risk — we still restrict to a safe-roots
// allowlist.
//
// Endpoints:
//   GET /api/fs/home           → { home: string } — start the picker here
//   GET /api/fs/list?path=...  → { path, parent, entries: [...] }
//                                  400 if path missing / not a dir
//                                  403 if path is outside allowed roots
//                                  404 if path doesn't exist

import { Hono } from "hono";
import { homedir } from "node:os";
import { resolve as pathResolve, dirname, basename } from "node:path";
import {
  readdir,
  stat,
} from "node:fs/promises";

export const fsApi = new Hono();

interface DirEntry {
  /** Just the basename (e.g. "src", "package.json"). */
  name: string;
  /** Absolute path. Cheap for the UI to display + safe to feed back as `path`. */
  path: string;
  isDirectory: boolean;
  /** Bytes; null for directories. */
  size: number | null;
}

/**
 * Paths that the picker is allowed to navigate into. v1 is local-only so
 * this is mostly a footgun guard against typos like `path=/` or
 * `path=/etc/passwd`; for a hosted/remote deployment, replace this with
 * per-user sandbox roots.
 */
function safeRoots(): string[] {
  const home = homedir();
  return [
    home,
    "/tmp",
    // Also allow the Loop Agent workspace root so the picker can drop
    // users into their saved task workspaces.
    pathResolve(process.cwd(), "data", "workspaces"),
  ];
}

function isPathSafe(p: string): boolean {
  const resolved = pathResolve(p);
  return safeRoots().some(
    (root) =>
      resolved === root || resolved.startsWith(root + "/")
  );
}

fsApi.get("/fs/home", (c) => {
  return c.json({ home: homedir() });
});

fsApi.get("/fs/list", async (c) => {
  const raw = c.req.query("path");
  if (!raw) return c.json({ error: "path query param required" }, 400);
  const target = pathResolve(raw);
  if (!isPathSafe(target)) {
    return c.json({ error: `path ${target} is outside allowed roots` }, 403);
  }
  let st;
  try {
    st = await stat(target);
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return c.json({ error: `path does not exist: ${target}` }, 404);
    }
    return c.json(
      {
        error: `cannot stat ${target}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      500
    );
  }
  if (!st.isDirectory()) {
    return c.json({ error: `path is not a directory: ${target}` }, 400);
  }

  const names = await readdir(target).catch((err) => {
    throw new Error(
      `cannot readdir ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  });

  // Cheap stat-then-return. We do one stat per entry but the picker is
  // bound by render latency anyway, so a few hundred stats is fine.
  const entries: DirEntry[] = [];
  for (const name of names) {
    // Skip dotfiles (system cruft). The user can still type a hidden
    // path manually into the workdir input if they really need it.
    if (name.startsWith(".")) continue;
    const full = pathResolve(target, name);
    let isDir = false;
    let size: number | null = null;
    try {
      const s = await stat(full);
      isDir = s.isDirectory();
      size = isDir ? null : s.size;
    } catch {
      // Unreadable entry (permission, broken symlink, etc.). Surface as a
      // directory=false entry with size=null — UI shows it greyed.
      isDir = false;
      size = null;
    }
    entries.push({ name, path: full, isDirectory: isDir, size });
  }

  // Directories first, then files; both alphabetical. Makes scan targets
  // easier to find in long listings.
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return c.json({
    path: target,
    parent: dirname(target) === target ? null : dirname(target),
    entries,
  });
});

/** Exposed for the tests / debugging. */
export { safeRoots, isPathSafe };