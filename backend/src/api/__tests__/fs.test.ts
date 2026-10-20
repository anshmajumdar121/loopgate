// Regression tests for the folder-picker path allowlist. The original
// check used `resolved.startsWith(root + "/")`, which rejected every
// subfolder of home on Windows (path.resolve returns backslashes).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, symlink, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse, dirname, resolve } from "node:path";
import { fsApi, isPathSafe, isWithin, safeRoots } from "../fs.js";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "loop-fs-api-"));
  await mkdir(join(scratch, "child", "grandchild"), { recursive: true });
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("isWithin", () => {
  it("is separator-agnostic and rejects sibling prefixes", () => {
    const root = resolve(tmpdir(), "rootdir");
    expect(isWithin(root, root)).toBe(true);
    expect(isWithin(root, join(root, "a", "b"))).toBe(true);
    expect(isWithin(root, root + "-evil")).toBe(false);
    expect(isWithin(root, dirname(root))).toBe(false);
    expect(isWithin(root, join(root, "..", "other"))).toBe(false);
    // A child literally named "..foo" is still inside.
    expect(isWithin(root, join(root, "..foo"))).toBe(true);
  });
});

describe("isPathSafe", () => {
  it("allows home and subfolders of home (native separators)", () => {
    expect(isPathSafe(homedir())).toBe(true);
    expect(isPathSafe(join(homedir(), "some", "nested", "folder"))).toBe(true);
  });

  it("allows the OS temp dir root and its subfolders", () => {
    if (process.platform === "win32") {
      expect(safeRoots()).toContain(tmpdir());
    } else {
      expect(safeRoots()).toContain("/tmp");
    }
    expect(isPathSafe(join(scratch, "child", "grandchild"))).toBe(true);
  });

  it("rejects the filesystem root and sibling-prefix paths", () => {
    expect(isPathSafe(parse(homedir()).root)).toBe(false);
    expect(isPathSafe(homedir() + "-evil")).toBe(false);
  });

  it("blocks a symlink inside an allowed root that escapes it", async () => {
    const link = join(scratch, "escape-link");
    const outside = parse(homedir()).root; // e.g. C:\ or /
    try {
      // "junction" works without admin rights on Windows; ignored elsewhere.
      await symlink(outside, link, "junction");
    } catch {
      return; // symlinks unsupported in this environment — nothing to test
    }
    try {
      expect(isPathSafe(link)).toBe(false);
    } finally {
      // Remove the link itself (never its target) before the afterAll rm.
      await unlink(link);
    }
  });
});

describe("GET /fs/list", () => {
  it("lists a subfolder of an allowed root (was 403 on Windows)", async () => {
    const res = await fsApi.request(
      `/fs/list?path=${encodeURIComponent(scratch)}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { name: string; isDirectory: boolean }[];
    };
    expect(body.entries.some((e) => e.name === "child" && e.isDirectory)).toBe(
      true
    );
  });

  it("returns 403 for a path outside allowed roots", async () => {
    const res = await fsApi.request(
      `/fs/list?path=${encodeURIComponent(parse(homedir()).root)}`
    );
    expect(res.status).toBe(403);
  });
});
