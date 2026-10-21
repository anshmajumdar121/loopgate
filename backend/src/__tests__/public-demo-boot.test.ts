/**
 * End-to-end check of LOOP_PUBLIC_DEMO=1: boots the real server (random
 * port, temp dirs, a stub UI build), verifies the gate, the host allowlist
 * pickup from the platform env, UI serving, and that a task requested with
 * a "real" model runs to done on the bundled fake LLM.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

/** Raw GET with a chosen Host header (fetch won't let us override Host). */
function getWithHost(port: number, path: string, host: string): Promise<number> {
  return new Promise((res, rej) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (r) => {
      r.resume();
      res(r.statusCode ?? 0);
    });
    req.on("error", rej);
    req.end();
  });
}

let child: ChildProcess;
let port: number;
let tmp: string;
let stdout = "";
let stderr = "";
const B = () => `http://127.0.0.1:${port}`;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "loop-public-demo-boot-"));
  const ui = join(tmp, "ui-dist");
  mkdirSync(ui);
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>stub ui</title>");
  port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOOP_PUBLIC_DEMO: "1",
    PORT: String(port),
    LOOP_PREVIEW_PORT: String(await freePort()),
    LOOP_HOST: "",
    LOOP_ALLOWED_HOSTS: "",
    LOOP_UI_DIST: ui,
    LOOP_DATA_DIR: join(tmp, "data", "tasks"),
    LOOP_WORKSPACES_ROOT: join(tmp, "workspaces"),
    DEMO_LLM_DELAY_MS: "0",
    CONN_HEALTH_INTERVAL_MS: "3600000",
    RENDER_EXTERNAL_HOSTNAME: "loopgate-test.onrender.com",
    // Must be scrubbed, never honoured:
    LOOP_LLM_API_KEY: "sk-must-not-be-used",
    LOOP_LOCAL_CLI: "1",
  };
  child = spawn(process.execPath, ["--import", "tsx", join("src", "index.ts")], {
    cwd: BACKEND_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start:\n${stdout}\n${stderr}`)), 40_000);
    const check = () => {
      if (stdout.includes("listening on")) {
        clearTimeout(t);
        child.stdout!.off("data", check);
        res();
      }
    };
    child.stdout!.on("data", check);
    child.on("exit", (code) => rej(new Error(`server exited ${code}:\n${stdout}\n${stderr}`)));
  });
}, 60_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once("exit", r));
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else child.kill("SIGKILL");
    await exited;
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a handle briefly — temp dir, harmless */
  }
});

describe("public demo boot", () => {
  it("announces the mode and ignores dangerous env", () => {
    expect(stdout).toContain("PUBLIC DEMO MODE");
    expect(stdout).toMatch(/ignored in public demo mode: .*LOOP_LLM_API_KEY/);
    expect(stdout).toMatch(/ignored in public demo mode: .*LOOP_LOCAL_CLI/);
  });

  it("exposes only the demo LLM and refuses the dangerous endpoints", async () => {
    const info = await (await fetch(`${B()}/api/demo`)).json();
    expect(info.publicDemo).toBe(true);
    const { connections } = await (await fetch(`${B()}/api/connections`)).json();
    expect(connections.map((c: { id: string }) => c.id)).toEqual(["public-demo-llm"]);
    expect(JSON.stringify(connections)).not.toContain("apiKey\"");
    const post = await fetch(`${B()}/api/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", providerType: "local-cli", baseUrl: "http://localhost/cli" }),
    });
    expect(post.status).toBe(403);
    expect((await fetch(`${B()}/api/fs/home`)).status).toBe(403);
    const t = await fetch(`${B()}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "read my files", workdir: BACKEND_DIR }),
    });
    expect(t.status).toBe(403);
  });

  it("serves the UI with security headers from the same origin", async () => {
    const res = await fetch(`${B()}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("stub ui");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("accepts the platform hostname and still rejects foreign hosts", async () => {
    expect(await getWithHost(port, "/health", "loopgate-test.onrender.com")).toBe(200);
    expect(await getWithHost(port, "/health", "evil.example")).toBe(421);
  });

  it("runs a task on the fake LLM even when a real model is requested", async () => {
    const res = await fetch(`${B()}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build a landing page for Acme Coffee", model: "gpt-4o" }),
    });
    expect(res.status).toBe(201);
    const { task } = await res.json();
    expect(task.model).toBe("custom:public-demo-llm:fake-model");
    let status = task.status;
    const t0 = Date.now();
    while (!["done", "escalated", "cancelled"].includes(status) && Date.now() - t0 < 100_000) {
      await new Promise((r) => setTimeout(r, 1_000));
      status = (await (await fetch(`${B()}/api/tasks/${task.id}`)).json()).task.status;
    }
    expect(status, `task ended ${status}\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`).toBe("done");
  }, 120_000);
});
