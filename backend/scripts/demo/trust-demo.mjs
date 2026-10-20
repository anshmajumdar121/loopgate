#!/usr/bin/env node
// Loop Agent trust scoreboard: boots an ISOLATED backend (temp data dirs,
// own ports) against a deterministic fake LLM, replays every attack and
// failure mode found in the audit, and prints PASS/FAIL per guarantee.
// Never touches backend/data and never calls a real LLM.
//
//   cd backend && node scripts/demo/trust-demo.mjs          (all checks)
//   node scripts/demo/trust-demo.mjs batch resume           (subset by keyword)
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
import WebSocket from "ws";
import { startFakeLlm } from "./fake-llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, "..", "..");
const TSX = join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs");
const PORT = Number(process.env.DEMO_PORT || 3110);
const LLM_PORT = Number(process.env.DEMO_LLM_PORT || 4011);
const B = `http://127.0.0.1:${PORT}`;
const SBX = mkdtempSync(join(tmpdir(), "loop-trust-demo-"));
const filter = process.argv.slice(2).map((s) => s.toLowerCase());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };

let backend;
function startBackend() {
  backend = spawn(process.execPath, [TSX, "src/index.ts"], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(PORT),
      LOOP_HOST: "127.0.0.1",
      LOOP_DATA_DIR: join(SBX, "data", "tasks"),
      LOOP_WORKSPACES_ROOT: join(SBX, "ws"),
      LOOP_WORKDIR: join(SBX, "work"),
      LOOP_PREVIEW_PORT: String(PORT + 80),
      LOOP_PHASE_TIMEOUT_MS: "30000",
      CONN_HEALTH_INTERVAL_MS: "3600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.log = [];
  backend.stdout.on("data", (d) => backend.log.push(String(d)));
  backend.stderr.on("data", (d) => backend.log.push(String(d)));
  return waitHealthy();
}
async function waitHealthy(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await alive()) return true;
    await sleep(300);
  }
  throw new Error("backend did not become healthy:\n" + backend.log.join("").slice(-1500));
}
async function alive() {
  try {
    return (await fetch(B + "/health", { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
function killBackendHard() {
  return new Promise((res) => {
    backend.once("exit", res);
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(backend.pid), "/T", "/F"]);
    else backend.kill("SIGKILL");
  });
}
const api = async (method, path, body) => {
  const request = () => fetch(B + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  let r;
  try {
    r = await request();
  } catch (e) {
    if (method !== "GET") throw e;
    await sleep(300);
    r = await request();
  }
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, d };
};
const raw = (text) =>
  new Promise((res) => {
    const s = net.connect(PORT, "127.0.0.1", () => s.write(text));
    let d = "";
    s.on("data", (c) => (d += c));
    s.on("close", () => res(d.split("\r\n")[0]));
    s.on("error", (e) => res("ERR " + e.code));
    setTimeout(() => { s.destroy(); res(d.split("\r\n")[0] || "TIMEOUT"); }, 4000);
  });

let llm, model;
const results = [];
async function check(name, keywords, fn) {
  if (filter.length && !filter.some((f) => keywords.includes(f) || name.toLowerCase().includes(f))) return;
  process.stdout.write(`${C.d}…${C.x} ${name}`);
  const t0 = Date.now();
  let ok = false, detail = "";
  try {
    [ok, detail] = await fn();
  } catch (e) {
    detail = "threw: " + (e?.message || e);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push({ name, ok, detail });
  process.stdout.write(`\r${ok ? C.g + "PASS" : C.r + "FAIL"}${C.x} ${name} ${C.d}(${secs}s) ${detail}${C.x}\n`);
}

async function runTask(mode, prompt, { stopWhen, timeoutMs = 60000 } = {}) {
  llm.setMode(mode);
  const wd = join(SBX, "work", mode + "-" + Date.now());
  const r = await api("POST", "/api/tasks", { prompt, model, autoApprovePlan: true, workdir: wd });
  if (r.status !== 201) throw new Error(`create ${r.status} ${JSON.stringify(r.d).slice(0, 200)}`);
  const id = r.d.task.id;
  let task;
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(400);
      task = (await api("GET", `/api/tasks/${id}`)).d.task;
      if (["done", "escalated", "cancelled"].includes(task.status)) break;
      if (stopWhen?.(task)) break;
    }
    return { task, wd };
  } finally {
    if (!["done", "escalated", "cancelled"].includes(task?.status)) {
      try {
        await api("POST", `/api/tasks/${id}/stop`);
        await sleep(800);
      } catch {}
    }
  }
}

async function waitBatch(id, pred, timeoutMs = 240000) {
  const t0 = Date.now();
  let b;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(500);
    b = (await api("GET", `/api/batches/${id}`)).d.batch;
    if (pred(b)) return b;
  }
  return b;
}

async function main() {
  console.log(`${C.b}Loop Agent — trust scoreboard${C.x}  ${C.d}(isolated sandbox: ${SBX})${C.x}\n`);
  llm = await startFakeLlm({ port: LLM_PORT, delayMs: 600 });
  await startBackend();
  const conn = await api("POST", "/api/connections", { name: "fake-llm", providerType: "openai-compatible", baseUrl: llm.url, apiKey: "sk-demo", model: "fake-model" });
  model = `custom:${conn.d.connection.id}:fake-model`;

  // ── Crash & abuse surface ────────────────────────────────────────────
  await check("One malformed request can't kill the server (GET //[)", ["crash", "server"], async () => {
    const line = await raw("GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    await sleep(500);
    return [await alive(), `response: ${line}; alive after: ${await alive()}`];
  });
  await check("Oversized request body is refused (20 MB → 413)", ["body", "server"], async () => {
    const status = await new Promise((resolve) => {
      let settled = false;
      let statusReceived = false;
      let errorTimer;
      let timeout;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(errorTimer);
        clearTimeout(timeout);
        resolve(value);
      };
      const req = http.request({
        host: "127.0.0.1",
        port: PORT,
        path: "/api/tasks",
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", "content-length": 20 * 1024 * 1024, connection: "keep-alive" },
      }, (res) => {
        statusReceived = true;
        res.on("error", () => {});
        res.resume();
        finish(res.statusCode);
      });
      timeout = setTimeout(() => {
        finish("TIMEOUT");
        req.destroy();
      }, 10_000);
      req.on("error", (e) => {
        if (!statusReceived) {
          errorTimer = setTimeout(() => {
            if (!statusReceived) finish("ERR " + e.code);
          }, 2_000);
        }
      });
      req.end(Buffer.alloc(20 * 1024 * 1024, 97));
    });
    return [status === 413, `status ${status}`];
  });
  await check("Foreign Host header is rejected (DNS-rebinding guard)", ["host", "server"], async () => {
    const line = await raw(`GET /api/fs/home HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n`);
    return [/HTTP\/1\.1 4\d\d/.test(line), line];
  });
  await check("Cross-origin WebSocket is refused", ["ws", "server"], async () => {
    const res = await new Promise((r) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Origin: "http://evil.example" } });
      w.on("open", () => { w.close(); r("accepted"); });
      w.on("error", (e) => r("refused: " + e.message));
      setTimeout(() => r("timeout"), 4000);
    });
    return [res.startsWith("refused"), res];
  });

  // ── Trust model ──────────────────────────────────────────────────────
  await check("Happy path: plan → make → verify → approved", ["happy", "loop"], async () => {
    const { task } = await runTask("happy", "Build a hello page");
    return [task.status === "done", `status ${task.status}, verdict ${task.verdict?.outcome}`];
  });
  await check("\"REJECT — cannot approve\" is NOT treated as approval", ["verdict", "trust"], async () => {
    const { task } = await runTask("reject_phrase", "Build a hello page", { stopWhen: (t) => !!t.verdict });
    return [task.status !== "done" && task.verdict?.outcome === "REJECT", `status ${task.status}, verdict ${task.verdict?.outcome}`];
  });
  await check("Contradictory APPROVE (Scope: FAIL) is downgraded to REJECT", ["gate", "trust"], async () => {
    const { task } = await runTask("contradiction", "Build a hello page", { stopWhen: (t) => !!t.verdict });
    return [task.verdict?.outcome === "REJECT" && task.status !== "done", `verdict ${task.verdict?.outcome}: ${task.verdict?.requiredFixes?.[0] ?? ""}`.slice(0, 120)];
  });
  await check("Maker cannot forge the verifier's verdict", ["forge", "trust"], async () => {
    const { task, wd } = await runTask("forge_verdict", "Build a hello page");
    const state = existsSync(join(wd, "STATE.md")) ? readFileSync(join(wd, "STATE.md"), "utf8") : "";
    return [task.status !== "done", `status ${task.status}; STATE.md write ${/Blocked writes.*STATE\.md/.test(state) ? "blocked" : "not blocked"}`];
  });
  await check("Denylisted / unplanned writes are blocked (.env, package.json, auth/**)", ["denylist", "trust"], async () => {
    const { wd } = await runTask("denylist", "Build a hello page");
    const leaked = [".env", "package.json", "auth/login.ts"].filter((f) => existsSync(join(wd, f)));
    return [leaked.length === 0 && existsSync(join(wd, "index.html")), leaked.length ? `LEAKED: ${leaked.join(", ")}` : "only index.html written"];
  });

  // ── Map node: repetitive work ────────────────────────────────────────
  await check("Batch: 4 items loop autonomously; a failing item escalates, others finish", ["batch", "map"], async () => {
    llm.setMode("happy");
    const r = await api("POST", "/api/batches", {
      title: "Landing pages",
      promptTemplate: "Build a landing page for {{item}}",
      items: ["Acme Coffee", "Nimbus Cloud", "FAIL-ME Corp", "Orbit Bikes"],
      model,
      maxAttempts: 2,
    });
    if (r.status !== 201) return [false, `create ${r.status} ${JSON.stringify(r.d).slice(0, 160)}`];
    const b = await waitBatch(r.d.batch.id, (b) => ["done", "partial", "cancelled"].includes(b.status));
    const statuses = b.items.map((i) => i.status).join(", ");
    const ok = statuses === "done, done, escalated, done" && b.reportPath && existsSync(b.reportPath);
    return [ok, `${statuses}; report ${b.reportPath ? "written" : "missing"}`];
  });
  await check("Batch survives a hard kill mid-run and resumes without redoing finished items", ["resume", "batch", "map"], async () => {
    llm.setMode("happy");
    const r = await api("POST", "/api/batches", { title: "Resume", promptTemplate: "Write a haiku page about {{item}}", items: ["rain", "snow", "wind"], model, maxAttempts: 1 });
    if (r.status !== 201) return [false, `create ${r.status}`];
    const id = r.d.batch.id;
    await waitBatch(id, (b) => b.items[0].status === "done" && b.items[1].status === "running", 120000);
    await killBackendHard();
    const before = llm.calls.filter((c) => c.role === "planner" && /rain/.test(c.task)).length;
    await startBackend();
    const b = await waitBatch(id, (b) => ["done", "partial", "cancelled"].includes(b.status), 180000);
    const after = llm.calls.filter((c) => c.role === "planner" && /rain/.test(c.task)).length;
    const statuses = b.items.map((i) => i.status).join(", ");
    return [statuses === "done, done, done" && after === before, `${statuses}; item 1 re-planned after restart: ${after - before} time(s)`];
  });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${C.b}${passed === results.length ? C.g : C.y}${passed}/${results.length} guarantees hold${C.x}`);
  return results.length - passed;
}

let failures = 1;
try {
  failures = await main();
} catch (e) {
  console.error(C.r + "demo crashed: " + (e?.stack || e) + C.x);
} finally {
  try { await killBackendHard(); } catch {}
  llm?.close();
  if (!process.env.DEMO_KEEP) rmSync(SBX, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}
