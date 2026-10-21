#!/usr/bin/env node
// Records a REAL Loopgate run for the static GitHub Pages preview.
//
//   cd backend && node --import tsx scripts/demo/record-static-demo.mjs
//
// Boots the backend in-process in public demo mode (bundled fake LLM, temp
// dirs), runs the README batch, and captures every WebSocket broadcast plus
// REST snapshots of what the UI polls. Writes ui/src/staticDemo/recording.json
// with local paths scrubbed. The Pages build (VITE_STATIC_DEMO=1) replays it
// in the browser — see ui/src/staticDemo/player.ts.
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, "..", "..");
const REPO = resolve(BACKEND, "..");
const OUT = join(REPO, "ui", "src", "staticDemo", "recording.json");
const TITLE = "Landing pages";
const TEMPLATE = "Build a landing page for {{item}}";
const ITEMS = ["Acme Coffee", "Nimbus Cloud", "FAIL-ME Corp", "Orbit Bikes"];

const freePort = () =>
  new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = mkdtempSync(join(tmpdir(), "loopgate-record-"));
const PORT = await freePort();
Object.assign(process.env, {
  LOOP_PUBLIC_DEMO: "1",
  PORT: String(PORT),
  LOOP_HOST: "127.0.0.1",
  LOOP_PREVIEW_PORT: String(await freePort()),
  LOOP_DATA_DIR: join(ROOT, "data", "tasks"),
  LOOP_WORKSPACES_ROOT: join(ROOT, "workspaces"),
  CONN_HEALTH_INTERVAL_MS: "3600000",
  DEMO_LLM_DELAY_MS: process.env.DEMO_LLM_DELAY_MS || "700",
});

// Wrap the broadcaster BEFORE the server boots so nothing is missed (a client
// socket only sees one subscribed task, and only after it subscribes).
let T0 = null;
const rel = () => (T0 === null ? -1 : Date.now() - T0);
const events = [];
const { broadcaster } = await import("../../src/ws/broadcaster.js");
const origBroadcast = broadcaster.broadcast.bind(broadcaster);
const origAll = broadcaster.broadcastAll.bind(broadcaster);
// Clone at send time: the server serializes immediately, task objects mutate later.
const clone = (m) => JSON.parse(JSON.stringify(m));
broadcaster.broadcast = (taskId, msg) => {
  if (T0 !== null) events.push({ t: rel(), taskId, msg: clone(msg) });
  return origBroadcast(taskId, msg);
};
broadcaster.broadcastAll = (msg) => {
  if (T0 !== null) events.push({ t: rel(), msg: clone(msg) });
  return origAll(msg);
};

await import("../../src/index.ts");
const B = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(B + "/health")).ok) break;
  } catch {}
  await sleep(250);
}

// REST snapshots: only stored when the body changed.
const snapshots = [];
const last = new Map();
async function snap(path) {
  const r = await fetch(B + path);
  const text = await r.text();
  const key = `${r.status}:${text}`;
  if (last.get(path) === key) return null;
  last.set(path, key);
  const isJson = (r.headers.get("content-type") || "").includes("json");
  snapshots.push({ t: Math.max(0, rel()), path, status: r.status, ...(isJson ? { body: JSON.parse(text) } : { text }) });
  return isJson ? JSON.parse(text) : text;
}
const detailSeen = new Map();
async function tick() {
  await snap("/api/tasks/active");
  await snap("/api/batches");
  const list = (await (await fetch(B + "/api/tasks")).json()).tasks ?? [];
  await snap("/api/tasks");
  for (const t of list) {
    const sig = `${t.status}:${t.attempt}:${t.updatedAt}`;
    if (detailSeen.get(t.id) === sig) continue;
    detailSeen.set(t.id, sig);
    await snap(`/api/tasks/${t.id}`);
  }
}

T0 = Date.now();
await tick();
const res = await fetch(B + "/api/batches", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: TITLE, promptTemplate: TEMPLATE, items: ITEMS, maxAttempts: 2 }),
});
if (res.status !== 201) throw new Error(`batch create failed: ${res.status} ${await res.text()}`);
const { batch } = await res.json();
console.log(`[record] batch ${batch.id} started`);
for (;;) {
  await tick();
  const b = (await (await fetch(`${B}/api/batches/${batch.id}`)).json()).batch;
  if (["done", "partial", "cancelled"].includes(b.status)) break;
  if (rel() > 10 * 60_000) throw new Error("recording timed out");
  await sleep(200);
}
await sleep(1500);
await tick();
const durationMs = rel();

// Endpoints that don't change during the run: captured once, at the end.
const statics = {};
for (const p of ["/api/connections", "/api/token-usage", "/api/projects", "/api/sessions", "/api/insights", "/api/improve-recipe"]) {
  const r = await fetch(B + p);
  const text = await r.text();
  statics[p] = (r.headers.get("content-type") || "").includes("json")
    ? { status: r.status, body: JSON.parse(text) }
    : { status: r.status, text };
}

let json = JSON.stringify({
  version: 1,
  recordedAt: new Date().toISOString(),
  durationMs,
  batch: { title: TITLE, promptTemplate: TEMPLATE, items: ITEMS },
  events,
  snapshots,
  statics,
});

// Scrub machine-specific paths (they'd leak the recorder's username) and
// the fake LLM's random port. Longest prefixes first.
const jsonEsc = (s) => JSON.stringify(s).slice(1, -1);
const replacements = [
  [ROOT, "/sandbox"],
  [REPO, "/loopgate"],
  [homedir(), "/home/demo"],
  [tmpdir(), "/tmp"],
].sort((a, b) => b[0].length - a[0].length);
for (const [from, to] of replacements) {
  for (const form of new Set([jsonEsc(from), jsonEsc(from.replace(/\\/g, "/")), jsonEsc(from.toLowerCase())])) {
    json = json.split(form).join(to);
  }
}
// Windows separators inside the scrubbed paths → "/" (JSON-escaped "\\").
json = json.replace(/\/(?:sandbox|loopgate|home\/demo|tmp)[^"]*/g, (m) => m.replace(/\\\\/g, "/"));
json = json.replace(/http:\/\/127\.0\.0\.1:\d+\/v1/g, "http://127.0.0.1:4010/v1");
const user = userInfo().username;
if (user && user.length > 2 && json.toLowerCase().includes(user.toLowerCase())) {
  throw new Error(`recording still contains the username "${user}" — extend the scrub list`);
}

writeFileSync(OUT, json + "\n");
console.log(
  `[record] ${events.length} events, ${snapshots.length} snapshots, ${(durationMs / 1000).toFixed(1)}s, ` +
    `${(json.length / 1024).toFixed(0)} KB → ${OUT}`
);
process.exit(0);
