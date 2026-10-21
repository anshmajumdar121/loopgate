import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Connection } from "../../types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});

// Exercise the real retry loop without wall-clock timing or Windows-only locks.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:timers/promises")>(),
  setTimeout: vi.fn(async () => undefined),
}));

const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
  "node:fs/promises"
);
let root: string;
let destination: string;
let persistence: typeof import("../persistence.js");

function connection(name = "saved"): Connection {
  return {
    id: "connection-test",
    name,
    providerType: "openai-compatible",
    baseUrl: "http://localhost:9999/v1",
    apiKey: "test-only-key",
    hasApiKey: true,
    models: [{ id: "test-model", label: "Original" }],
    health: { ok: true, checkedAt: "2026-01-01T00:00:00.000Z" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const fsError = (code: string) => Object.assign(new Error(code), { code });
const readSaved = async () => JSON.parse(await actualFs.readFile(destination, "utf8"));
const seed = async () => actualFs.writeFile(destination, JSON.stringify([connection()]));

beforeEach(async () => {
  vi.resetModules();
  vi.mocked(fs.mkdir).mockReset().mockImplementation(actualFs.mkdir);
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actualFs.writeFile);
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename);
  vi.mocked(fs.unlink).mockReset().mockImplementation(actualFs.unlink);
  vi.mocked(delay).mockClear();
  root = await actualFs.mkdtemp(join(tmpdir(), "loop-connections-persistence-"));
  destination = join(root, "_connections.json");
  // Must be set before importing persistence: DATA_ROOT is resolved at import.
  vi.stubEnv("LOOP_DATA_DIR", join(root, "tasks"));
  persistence = await import("../persistence.js");
});

afterEach(async () => {
  await persistence.flushConnectionSaves?.().catch(() => {});
  vi.unstubAllEnvs();
  await actualFs.rm(root, { recursive: true, force: true });
});

describe("connection persistence", () => {
  it("snapshots the array and nested records before the first await", async () => {
    const connections = [connection()];
    const expected = structuredClone(connections);
    const saving = persistence.saveConnections(connections);
    connections[0].name = "changed after save";
    connections[0].models![0].label = "Changed";
    connections[0].health!.ok = false;
    connections.push({ ...connection("added later"), id: "another" });
    await saving;
    expect(await readSaved()).toEqual(expected);
  });

  it("serializes concurrent saves in call order, including deletion", async () => {
    const started = gate();
    const releaseWrite = gate();
    const writes: unknown[] = [];
    const committed: unknown[] = [];
    // The temp root already exists. All calls reach writeFile deterministically
    // within one microtask turn if the save queue is accidentally removed.
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockImplementation(async (path, data, options) => {
      writes.push(JSON.parse(String(data)));
      started.release();
      await releaseWrite.promise;
      await actualFs.writeFile(path, data, options);
    });
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      await actualFs.rename(from, to);
      committed.push(await readSaved());
    });

    const saves = [persistence.saveConnections([connection("first")])];
    try {
      await started.promise;
      saves.push(persistence.saveConnections([connection("second")]));
      saves.push(persistence.saveConnections([]));
      await nextTurn();
      expect(writes).toEqual([[connection("first")]]);
    } finally {
      releaseWrite.release();
      await Promise.allSettled(saves);
    }
    await Promise.all(saves);
    expect(committed).toEqual([[connection("first")], [connection("second")], []]);
    expect(await readSaved()).toEqual([]);
    const tempPaths = vi.mocked(fs.writeFile).mock.calls.map(([path]) => String(path));
    expect(new Set(tempPaths).size).toBe(3);
    expect(tempPaths.every((path) => dirname(path) === root && path !== destination)).toBe(true);
  });

  it.each(["EPERM", "EACCES", "EBUSY"])("retries transient %s without removing the destination", async (code) => {
    await seed();
    let attempts = 0;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      expect(await readSaved()).toEqual([connection()]);
      if (++attempts < 3) throw fsError(code);
      await actualFs.rename(from, to);
    });

    await persistence.saveConnections([connection("new")]);
    expect(attempts).toBe(3);
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
    expect(await readSaved()).toEqual([connection("new")]);
    expect(vi.mocked(fs.unlink).mock.calls.some(([path]) => path === destination)).toBe(false);
    expect(await actualFs.readdir(root)).toEqual(["_connections.json"]);
  });

  it.each([
    { code: "EPERM", attempts: 6, delays: [10, 20, 40, 80, 160] },
    { code: "EIO", attempts: 1, delays: [] },
  ])("preserves the old file and surfaces $code after bounded attempts", async ({ code, attempts, delays }) => {
    await seed();
    const oldBytes = await actualFs.readFile(destination, "utf8");
    const error = fsError(code);
    vi.mocked(fs.rename).mockRejectedValue(error);

    await expect(persistence.saveConnections([connection("unsaved")])).rejects.toBe(error);
    // A caller logging/catching the save rejection must not hide it at shutdown.
    await expect(persistence.flushConnectionSaves()).rejects.toBe(error);
    expect(fs.rename).toHaveBeenCalledTimes(attempts);
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual(delays);
    expect(await actualFs.readFile(destination, "utf8")).toBe(oldBytes);
    expect(vi.mocked(fs.unlink).mock.calls.some(([path]) => path === destination)).toBe(false);
    expect(await actualFs.readdir(root)).toEqual(["_connections.json"]);
  });

  it("cleans up a failed partial temp write and never renames it", async () => {
    await seed();
    const error = fsError("ENOSPC");
    vi.mocked(fs.writeFile).mockImplementation(async (path) => {
      await actualFs.writeFile(path, '[{"partial":');
      throw error;
    });
    await expect(persistence.saveConnections([connection("unsaved")])).rejects.toBe(error);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
    expect(await readSaved()).toEqual([connection()]);
    expect(await actualFs.readdir(root)).toEqual(["_connections.json"]);
  });

  it("continues the queue after a failed save and flushes the later full snapshot", async () => {
    await seed();
    const error = fsError("EIO");
    vi.mocked(fs.rename).mockRejectedValueOnce(error);
    const failed = persistence.saveConnections([connection("failed")]);
    const rejection = expect(failed).rejects.toBe(error);
    const succeeded = persistence.saveConnections([connection("latest")]);
    await persistence.flushConnectionSaves();
    await Promise.all([rejection, succeeded]);
    expect(await readSaved()).toEqual([connection("latest")]);
  });

  it("flush waits for saves enqueued while it is draining", async () => {
    const ready = [gate(), gate()];
    const release = [gate(), gate()];
    let attempt = 0;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      const index = attempt++;
      ready[index].release();
      await release[index].promise;
      await actualFs.rename(from, to);
    });
    const saves = [persistence.saveConnections([connection("first")])];
    let flushed = false;
    const flushing = persistence.flushConnectionSaves().then(() => { flushed = true; });
    try {
      await ready[0].promise;
      saves.push(persistence.saveConnections([connection("latest")]));
      release[0].release();
      await ready[1].promise;
      await nextTurn();
      expect(flushed).toBe(false);
    } finally {
      release.forEach((g) => g.release());
      await Promise.allSettled([...saves, flushing]);
    }
    await flushing;
    expect(await readSaved()).toEqual([connection("latest")]);
  });

  it("keeps the committed file after a hard crash between temp write and rename", async () => {
    await seed();
    const oldBytes = await actualFs.readFile(destination, "utf8");
    const fixture = fileURLToPath(new URL("./connection-save-crash-child.mjs", import.meta.url));
    const child = fork(fixture, [JSON.stringify([connection("uncommitted")])], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      execArgv: ["--import", "tsx"],
      env: { ...process.env, LOOP_DATA_DIR: join(root, "tasks"), TSX_DISABLE_CACHE: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      const tmpPath = await waitForRenameBoundary(child);
      expect(dirname(tmpPath)).toBe(root);
      expect(JSON.parse(await actualFs.readFile(tmpPath, "utf8"))).toEqual([connection("uncommitted")]);
      expect(await actualFs.readFile(destination, "utf8")).toBe(oldBytes);
      child.kill("SIGKILL");
      await closed;

      // A fresh persistence module is the restart: stale temps are not loaded.
      vi.resetModules();
      persistence = await import("../persistence.js");
      expect(await persistence.loadAllConnections()).toEqual([connection()]);
      expect(await actualFs.readFile(destination, "utf8")).toBe(oldBytes);
      await persistence.saveConnections([connection("after restart")]);
      expect(await persistence.loadAllConnections()).toEqual([connection("after restart")]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }, 15_000);
});

function waitForRenameBoundary(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr!.on("data", (data) => { stderr += data; });
    const timer = setTimeout(() => finish(new Error(`child did not reach rename: ${stderr}`)), 10_000);
    const onExit = () => finish(new Error(`child exited before rename: ${stderr}`));
    const onMessage = (message: unknown) => {
      if (message && typeof message === "object" && "tmpPath" in message && typeof message.tmpPath === "string") {
        finish(undefined, message.tmpPath);
      } else {
        finish(new Error("unexpected crash-test child message"));
      }
    };
    function finish(error?: Error, path?: string) {
      clearTimeout(timer);
      child.off("error", finish);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if (error) reject(error);
      else resolve(path!);
    }
    child.once("error", finish);
    child.once("exit", onExit);
    child.once("message", onMessage);
  });
}
