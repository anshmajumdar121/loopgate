import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { startFakeLlm } from "./fake-llm.mjs";

const backendDir = fileURLToPath(new URL("../../", import.meta.url));

test("graceful IPC restart retains the demo connection after disk hydration", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-connection-restart-"));
  const llm = await startFakeLlm({ port: 0, delayMs: 0 });
  let child;
  let base;
  async function start() {
    let output = "";
    child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: backendDir,
      env: {
        ...process.env,
        PORT: "0",
        LOOP_ENGINE: "legacy",
        LOOP_PUBLIC_DEMO: "0",
        LOOP_HOST: "127.0.0.1",
        LOOP_DATA_DIR: join(root, "data", "tasks"),
        LOOP_EVENT_LOG_PATH: join(root, "data", "events.sqlite"),
        LOOP_WORKSPACES_ROOT: join(root, "workspaces"),
        LOOP_WORKDIR: join(root, "work"),
        CONN_HEALTH_INTERVAL_MS: "3600000",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    // Request the bound port through the isolated launcher's ready log.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && Number(match[1]) > 0) {
        base = `http://127.0.0.1:${match[1]}`;
        try {
          if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) return;
        } catch {}
      }
      if (child.exitCode !== null) break;
      await sleep(50);
    }
    throw new Error("isolated backend did not become ready");
  }
  async function stop() {
    const exited = once(child, "exit");
    child.send({ type: "shutdown" });
    const [code, signal] = await exited;
    assert.equal(signal, null);
    assert.equal(code, 0);
  }
  try {
    await start();
    const created = await fetch(`${base}/api/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "restart fixture", providerType: "openai-compatible", baseUrl: llm.url, apiKey: "fixture", model: "fake-model" }),
    });
    assert.equal(created.status, 201);
    const { connection } = await created.json();
    // No delay to let a fire-and-forget save happen by luck.
    await stop();
    const saved = JSON.parse(await readFile(join(root, "data", "_connections.json"), "utf8"));
    assert.ok(saved.some((entry) => entry.id === connection.id));
    await start();
    const restored = await fetch(`${base}/api/connections/${connection.id}`);
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).connection.id, connection.id);
    await stop();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    llm.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
