#!/usr/bin/env node
// Offline demo stack: deterministic fake LLM + an isolated backend (its own
// data dir, never backend/data) + a second UI dev server pointed at it.
// Lets you drive the real canvas / Batch drawer live without API keys.
//
//   cd backend && npm run demo:stack      → open http://localhost:5174
//
// Env: DEMO_LLM_DELAY_MS (default 1500), DEMO_DATA (default <tmp>/loop-agent-demo)
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startFakeLlm } from "./fake-llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, "..", "..");
const UI = join(BACKEND, "..", "ui");
const DATA = process.env.DEMO_DATA || join(tmpdir(), "loop-agent-demo");
const API_PORT = 3101, UI_PORT = 5174, LLM_PORT = 4010;
const B = `http://127.0.0.1:${API_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function run(name, cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  const tag = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  children.push(p);
  return p;
}

const llm = await startFakeLlm({ port: LLM_PORT, delayMs: Number(process.env.DEMO_LLM_DELAY_MS || 1500) });
console.log(`[demo] fake LLM at ${llm.url}`);

run("api", process.execPath, [join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"], {
  cwd: BACKEND,
  env: {
    ...process.env,
    PORT: String(API_PORT),
    LOOP_DATA_DIR: join(DATA, "data", "tasks"),
    LOOP_WORKSPACES_ROOT: join(DATA, "workspaces"),
    LOOP_PREVIEW_PORT: "4181",
  },
});
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(B + "/health")).ok) break; } catch {}
  await sleep(500);
}

const existing = await (await fetch(B + "/api/connections")).json();
let conn = existing.connections?.find((c) => c.name === "Demo LLM (offline)");
if (!conn) {
  const r = await fetch(B + "/api/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Demo LLM (offline)", providerType: "openai-compatible", baseUrl: llm.url, apiKey: "sk-demo", model: "fake-model", roles: ["planning", "implementation", "review"] }),
  });
  conn = (await r.json()).connection;
}

run("ui", process.execPath, [join(UI, "node_modules", "vite", "bin", "vite.js"), "--port", String(UI_PORT), "--strictPort"], {
  cwd: UI,
  env: { ...process.env, LOOP_BACKEND_URL: `http://localhost:${API_PORT}` },
});

console.log(`
[demo] ───────────────────────────────────────────────────────────────
[demo]  UI:        http://localhost:${UI_PORT}
[demo]  Backend:   ${B}   (data: ${DATA})
[demo]  Model:     custom:${conn.id}:fake-model   ("Demo LLM (offline)")
[demo]  Try:       Batch → template "Build a landing page for {{item}}",
[demo]             items: Acme Coffee / Nimbus Cloud / FAIL-ME Corp / Orbit Bikes
[demo]             (items containing FAIL-ME are always rejected → escalate)
[demo]  Attacks:   npm run demo:trust   (scoreboard of every guarantee)
[demo]  Ctrl+C to stop everything.
[demo] ───────────────────────────────────────────────────────────────`);

const stop = () => {
  for (const c of children) {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"]);
    else c.kill("SIGTERM");
  }
  llm.close();
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
