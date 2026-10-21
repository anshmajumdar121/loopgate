import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectMakerAttempt,
  snapshotWorkdir,
} from "../anti-cheat.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "loop-anticheat-"));
  dirs.push(dir);
  return dir;
}

async function inspectAfter(workdir: string, attemptedPaths: string[] = []) {
  const before = await snapshotWorkdir(workdir);
  return { before, inspect: async () => inspectMakerAttempt(before, await snapshotWorkdir(workdir), { attemptedPaths }) };
}

describe("v2 anti-cheat diff policy", () => {
  it("rejects deleting a test file and accepts an unchanged test file", async () => {
    const workdir = await makeWorkdir();
    await writeFile(join(workdir, "thing.test.ts"), "expect(1).toBe(1);", "utf8");
    const baseline = await snapshotWorkdir(workdir);
    expect((await inspectMakerAttempt(baseline, await snapshotWorkdir(workdir))).clean).toBe(true);
    await rm(join(workdir, "thing.test.ts"));
    expect((await inspectMakerAttempt(baseline, await snapshotWorkdir(workdir))).clean).toBe(false);
  });

  it("rejects added skip/only/todo/xit modifiers but permits ordinary test edits", async () => {
    const workdir = await makeWorkdir();
    await writeFile(join(workdir, "thing.test.ts"), "it('works', () => expect(1).toBe(1));", "utf8");
    const baseline = await snapshotWorkdir(workdir);
    await writeFile(join(workdir, "thing.test.ts"), "it.skip('works', () => expect(1).toBe(1));", "utf8");
    expect((await inspectMakerAttempt(baseline, await snapshotWorkdir(workdir))).clean).toBe(false);

    const cleanBaseline = await snapshotWorkdir(workdir);
    await writeFile(join(workdir, "thing.test.ts"), "it('works', () => expect(2).toBe(2));", "utf8");
    expect((await inspectMakerAttempt(cleanBaseline, await snapshotWorkdir(workdir))).clean).toBe(true);
  });

  it("rejects lowering expect/assert counts but accepts adding assertions", async () => {
    const workdir = await makeWorkdir();
    await writeFile(join(workdir, "thing.test.ts"), "expect(1).toBe(1); assert.equal(1, 1);", "utf8");
    const baseline = await snapshotWorkdir(workdir);
    await writeFile(join(workdir, "thing.test.ts"), "expect(1).toBe(1);", "utf8");
    expect((await inspectMakerAttempt(baseline, await snapshotWorkdir(workdir))).clean).toBe(false);

    const next = await snapshotWorkdir(workdir);
    await writeFile(join(workdir, "thing.test.ts"), "expect(1).toBe(1); expect(2).toBe(2);", "utf8");
    expect((await inspectMakerAttempt(next, await snapshotWorkdir(workdir))).clean).toBe(true);
  });

  it("rejects trivially true assertions but permits meaningful assertions", async () => {
    const workdir = await makeWorkdir();
    await writeFile(join(workdir, "thing.test.ts"), "expect(value).toBe(1);", "utf8");
    const before = await snapshotWorkdir(workdir);
    await writeFile(join(workdir, "thing.test.ts"), "expect(true).toBe(true);", "utf8");
    expect((await inspectMakerAttempt(before, await snapshotWorkdir(workdir))).clean).toBe(false);

    const cleanBefore = await snapshotWorkdir(workdir);
    await writeFile(join(workdir, "thing.test.ts"), "expect(value).toBe(2);", "utf8");
    expect((await inspectMakerAttempt(cleanBefore, await snapshotWorkdir(workdir))).clean).toBe(true);
  });

  it("rejects test config changes and package test-script/coverage edits", async () => {
    const workdir = await makeWorkdir();
    await writeFile(join(workdir, "vitest.config.ts"), "export default {};", "utf8");
    const configBefore = await snapshotWorkdir(workdir);
    await writeFile(join(workdir, "vitest.config.ts"), "export default { test: { exclude: ['**/*'] } };", "utf8");
    expect((await inspectMakerAttempt(configBefore, await snapshotWorkdir(workdir))).clean).toBe(false);

    await writeFile(join(workdir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" }, coverageThreshold: { lines: 80 } }), "utf8");
    const packageBefore = await snapshotWorkdir(workdir);
    await writeFile(join(workdir, "package.json"), JSON.stringify({ scripts: { test: "vitest run --exclude **/*" }, coverageThreshold: { lines: 0 } }), "utf8");
    expect((await inspectMakerAttempt(packageBefore, await snapshotWorkdir(workdir))).clean).toBe(false);
  });

  it("rejects snapshot edits but permits unrelated source edits", async () => {
    const workdir = await makeWorkdir();
    await mkdir(join(workdir, "__snapshots__"));
    await writeFile(join(workdir, "__snapshots__", "thing.snap"), "old", "utf8");
    const before = await snapshotWorkdir(workdir);
    await writeFile(join(workdir, "__snapshots__", "thing.snap"), "new", "utf8");
    expect((await inspectMakerAttempt(before, await snapshotWorkdir(workdir))).clean).toBe(false);

    const cleanBefore = await snapshotWorkdir(workdir);
    await writeFile(join(workdir, "source.ts"), "export const ok = true;", "utf8");
    expect((await inspectMakerAttempt(cleanBefore, await snapshotWorkdir(workdir))).clean).toBe(true);
  });

  it("rejects traversal and absolute attempted paths", async () => {
    const workdir = await makeWorkdir();
    const before = await snapshotWorkdir(workdir);
    const after = await snapshotWorkdir(workdir);
    const result = await inspectMakerAttempt(before, after, {
      attemptedPaths: ["../outside.txt", "/tmp/outside.txt", "C:\\temp\\outside.txt"],
    });
    expect(result.clean).toBe(false);
    expect(result.reasons.filter((reason) => reason.includes("unsafe path"))).toHaveLength(3);
  });

  it("rejects a symlink that resolves outside the workdir", async () => {
    const workdir = await makeWorkdir();
    const outside = await makeWorkdir();
    try {
      await symlink(outside, join(workdir, "linked"), "dir");
    } catch {
      // Windows CI without symlink privilege cannot exercise this OS feature.
      return;
    }
    const before = await snapshotWorkdir(workdir);
    await writeFile(join(workdir, "inside.ts"), "export {};", "utf8");
    const result = await inspectMakerAttempt(before, await snapshotWorkdir(workdir));
    expect(result.clean).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("symlink"))).toBe(true);
  });
});
