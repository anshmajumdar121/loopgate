import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { tasksApi } from "./api/tasks.js";
import { projectsApi } from "./api/projects.js";
import { sessionsApi } from "./api/sessions.js";
import { connectionsApi } from "./api/connections.js";
import { connectionMetaApi } from "./api/connectionMeta.js";
import { fsApi } from "./api/fs.js";
import { insightsApi } from "./api/insights.js";
import { ratchetApi } from "./api/ratchet.js";
import { broadcaster } from "./ws/broadcaster.js";
import {
  loadAllProjects,
  loadAllSessions,
  loadAllConnections,
  loadAllTasks,
  loadAllTokenUsage,
  recoverFromRestart,
  saveTask,
  TASK_DATA_DIR,
} from "./store/persistence.js";
import { loadProjectsFromDisk } from "./store/projects.js";
import { loadSessionsFromDisk } from "./store/sessions.js";
import { loadConnectionsFromDisk } from "./store/connections.js";
import { loadTasksFromDisk } from "./store/tasks.js";
import { loadUsageFromDisk } from "./store/tokenUsage.js";
import { startConnectionHealthMonitor } from "./loop/connection-health.js";

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }));
app.route("/api", tasksApi);
app.route("/api", projectsApi);
app.route("/api", sessionsApi);
app.route("/api", connectionsApi);
app.route("/api", connectionMetaApi);
app.route("/api", fsApi);
app.route("/api", insightsApi);
app.route("/api", ratchetApi);

const PORT = Number(process.env.PORT || 3001);

// Bridge Hono to a raw http.Server so we can also attach WebSocket on /ws.
const httpServer = createServer(async (req, res) => {
  // @hono/node-server's `serve` returns a server; we instead mount Hono
  // manually by replaying requests through its fetch handler.
  const url = new URL(req.url || "", `http://0.0.0.0:${PORT}`);
  const method = req.method || "GET";
  // Read request body for non-GET methods
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
  }
  const fetchRes = await app.request(url, {
    method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
  });
  const buf = Buffer.from(await fetchRes.arrayBuffer());
  // Status
  res.statusCode = fetchRes.status;
  // Headers
  fetchRes.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(buf);
});

httpServer.on("error", (err) => {
  console.error("[loop-agent-backend] http server error:", err);
});

const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
});

broadcaster.attach(wss);

httpServer.listen(PORT, "0.0.0.0", async () => {
  console.log(`[loop-agent-backend] listening on http://0.0.0.0:${PORT}`);
  console.log(`[loop-agent-backend] ws at ws://0.0.0.0:${PORT}/ws`);
  console.log(`[loop-agent-backend] task persistence dir: ${TASK_DATA_DIR}`);

  // Load persisted tasks and recover from any active-state crashes.
  try {
    const [loaded, projects, sessions, connections, usage] = await Promise.all([
      loadAllTasks(),
      loadAllProjects(),
      loadAllSessions(),
      loadAllConnections(),
      loadAllTokenUsage(),
    ]);
    const recovered = recoverFromRestart(loaded);
    loadTasksFromDisk(loaded);
    loadProjectsFromDisk(projects);
    loadSessionsFromDisk(sessions);
    loadConnectionsFromDisk(connections);
    loadUsageFromDisk(usage);
    console.log(
      `[loop-agent-backend] loaded ${loaded.length} task(s), ${projects.length} project(s), ${sessions.length} session(s), ${connections.length} connection(s), ${usage.length} token-usage entry(s) from disk` +
        (recovered.length > 0
          ? ` (recovered ${recovered.length} from active state)`
          : "")
    );
    // Persist the recovered tasks back so the next start doesn't re-recover.
    for (const task of recovered) {
      void saveTask(task).catch((err) =>
        console.error(`[loop-agent-backend] failed to persist recovered task:`, err)
      );
    }
    // Auto-verify connections: startup sweep now + re-check every
    // CONN_HEALTH_INTERVAL_MS (see loop/connection-health.ts). Must run
    // AFTER loadConnectionsFromDisk so the sweep sees the real records.
    startConnectionHealthMonitor();
  } catch (err) {
    console.error(`[loop-agent-backend] Failed to load persisted tasks:`, err);
  }
});

export { httpServer };