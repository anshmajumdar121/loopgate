/**
 * End-to-end check that index.ts wires the hardening in: boots the real
 * server (temp data dirs, random port — never 3001), throws the request that
 * used to kill the process at it, and checks bind address + Host guard.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const BACKEND_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

let child: ChildProcess;
let port: number;
let tmp: string;
let stdout = "";
let stderr = "";

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "loop-boot-"));
  port = await freePort();
  const previewPort = await freePort();
  child = spawn(process.execPath, ["--import", "tsx", join("src", "index.ts")], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      LOOP_PREVIEW_PORT: String(previewPort),
      LOOP_DATA_DIR: join(tmp, "data", "tasks"),
      LOOP_WORKSPACES_ROOT: join(tmp, "workspaces"),
      LOOP_WORKDIR: join(tmp, "workdir"),
      LOOP_HOST: "",
      LOOP_ALLOWED_HOSTS: "",
      LOOP_MAX_BODY_BYTES: "4096",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start:\n${stdout}\n${stderr}`)), 25_000);
    const check = () => {
      if (stdout.includes("listening on")) {
        clearTimeout(t);
        child.stdout!.off("data", check);
        res();
      }
    };
    child.stdout!.on("data", check);
    child.once("exit", (code) => rej(new Error(`server exited early (${code}):\n${stdout}\n${stderr}`)));
  });
}, 30_000);

afterAll(() => {
  child?.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows file locks — temp dir, ignore */
  }
});

function raw(payload: string, host = "127.0.0.1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, host, () => sock.write(payload));
    let out = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      out += d;
      if (out.includes("\r\n\r\n")) sock.end();
    });
    sock.on("close", () => resolve(out));
    sock.on("error", reject);
  });
}

function get(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

describe("server boot (index.ts wiring)", () => {
  it("binds to 127.0.0.1 by default", () => {
    expect(stdout).toContain(`listening on http://127.0.0.1:${port}`);
  });

  it("survives `GET //[ HTTP/1.1` (400) and keeps serving", async () => {
    const out = await raw(`GET //[ HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`);
    expect(out).toMatch(/^HTTP\/1\.1 400/);
    await new Promise((r) => setTimeout(r, 200));
    expect(child.exitCode).toBeNull();
    expect(await get("/health", { host: `localhost:${port}` })).toBe(200);
  });

  it("enforces Host/Origin allowlist and body cap", async () => {
    expect(await get("/health", { host: "evil.example" })).toBe(421);
    expect(await get("/health", { host: "localhost:3001", origin: "http://evil.example" })).toBe(403);
    expect(await get("/health", { host: "localhost:3001", origin: "http://localhost:5173" })).toBe(200);
    const out = await raw(
      `POST /api/tasks HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: 999999\r\n\r\n`
    );
    expect(out).toMatch(/^HTTP\/1\.1 413/);
  });

  it("websocket: Vite-proxied origin accepted, foreign origin rejected", async () => {
    const tryWs = (origin: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
          origin,
          headers: { host: `localhost:${port}` },
        });
        ws.once("open", () => {
          ws.close();
          resolve("open");
        });
        ws.once("unexpected-response", (_q, res) => resolve(String(res.statusCode)));
        ws.once("error", () => resolve("error"));
      });
    expect(await tryWs("http://localhost:5173")).toBe("open");
    expect(await tryWs("http://evil.example")).toBe("403");
  });
});
