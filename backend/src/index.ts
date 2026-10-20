// Must stay first: fixes up the env for public demo mode before the stores
// read it at module evaluation (see demo/bootstrap.ts).
import "./demo/bootstrap.js";
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
import { batchesApi } from "./api/batches.js";
import { loadBatchesFromDisk } from "./store/batches.js";
import { resumeInterruptedBatches } from "./loop/batch-runner.js";
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
  isActiveStatus,
} from "./store/persistence.js";
import { loadProjectsFromDisk } from "./store/projects.js";
import { loadSessionsFromDisk } from "./store/sessions.js";
import { installPublicDemoConnection, loadConnectionsFromDisk } from "./store/connections.js";
import { listTasks, loadTasksFromDisk } from "./store/tasks.js";
import { getBatch } from "./store/batches.js";
import { loadUsageFromDisk } from "./store/tokenUsage.js";
import { startConnectionHealthMonitor } from "./loop/connection-health.js";
import { createHttpHandler, resolveMaxBodyBytes } from "./http/handler.js";
import { buildAllowedHostnames } from "./http/security.js";
import { installProcessGuards } from "./http/processGuards.js";
import { createVerifyClient, WS_MAX_CLIENTS, WS_MAX_PAYLOAD_BYTES } from "./http/wsGuard.js";
import { isPublicDemo, platformHostnames, publicDemoLimits, startPublicDemoLlm } from "./demo/publicDemo.js";
import { createPublicDemoApp } from "./demo/guard.js";
import { createStaticUi } from "./http/staticUi.js";
import { resolve as pathResolve } from "node:path";

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
app.route("/api", batchesApi);

const PORT = Number(process.env.PORT || 3001);
// Loopback by default: this API drives local agents with filesystem access.
// Set LOOP_HOST=0.0.0.0 (plus LOOP_ALLOWED_HOSTS) to expose it deliberately.
const HOST = process.env.LOOP_HOST || "127.0.0.1";
const PUBLIC_DEMO = isPublicDemo();
const ALLOWED_HOSTS = buildAllowedHostnames(
  [process.env.LOOP_ALLOWED_HOSTS, ...(PUBLIC_DEMO ? platformHostnames() : [])].filter(Boolean).join(",")
);
const MAX_BODY_BYTES = resolveMaxBodyBytes(process.env.LOOP_MAX_BODY_BYTES);

// Public demo mode: start the bundled fake LLM (the only model the demo can
// run), put the default-deny gate in front of every route and serve the
// built UI from this same origin. See demo/publicDemo.ts.
let fetchApp: Parameters<typeof createHttpHandler>[0] = app;
if (PUBLIC_DEMO) {
  const llm = await startPublicDemoLlm();
  installPublicDemoConnection(llm.connection);
  const uiDir = process.env.LOOP_UI_DIST || pathResolve(process.cwd(), "..", "ui", "dist");
  const serveUi = await createStaticUi(uiDir);
  console.log(
    `[loop-agent-backend] demo LLM at ${llm.connection.baseUrl}; UI ${serveUi ? `served from ${uiDir}` : `not built (${uiDir} missing) — API only`}`
  );
  fetchApp = createPublicDemoApp(app, {
    limits: publicDemoLimits(),
    taskCount: () => listTasks().length,
    batchRerunCount: (id) =>
      getBatch(id)?.items.filter((it) => it.status !== "done" && it.status !== "escalated").length,
    serveUi,
  });
}

// A stray rejection/throw must never take the backend down; log loudly instead.
installProcessGuards();

// Bridge Hono to a raw http.Server so we can also attach WebSocket on /ws.
// createHttpHandler adds Host/Origin allowlisting, a body cap (413), 400 on
// malformed request-targets and 500 on any other failure — it never rejects.
const httpServer = createServer(
  createHttpHandler(fetchApp, {
    port: PORT,
    allowedHosts: ALLOWED_HOSTS,
    maxBodyBytes: MAX_BODY_BYTES,
  })
);

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  console.error("[loop-agent-backend] http server error:", err);
  // Can't bind -> nothing to keep alive for. (Previously this crashed via the
  // unhandled wss "error" re-emit; the process guards would now swallow that.)
  if (err.code === "EADDRINUSE" || err.code === "EACCES" || err.code === "EADDRNOTAVAIL") {
    process.exit(1);
  }
});

const wss: WebSocketServer = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  maxPayload: WS_MAX_PAYLOAD_BYTES,
  verifyClient: createVerifyClient({
    allowedHosts: ALLOWED_HOSTS,
    getClientCount: () => wss.clients.size,
    maxClients: WS_MAX_CLIENTS,
  }),
});
wss.on("error", (err) => {
  console.error("[loop-agent-backend] websocket server error:", err);
});

broadcaster.attach(wss);

httpServer.listen(PORT, HOST, async () => {
  const shownHost = HOST.includes(":") ? `[${HOST}]` : HOST;
  console.log(`[loop-agent-backend] listening on http://${shownHost}:${PORT}`);
  console.log(`[loop-agent-backend] ws at ws://${shownHost}:${PORT}/ws`);
  console.log(
    `[loop-agent-backend] allowed hosts/origins: ${[...ALLOWED_HOSTS].join(", ")}; max body ${MAX_BODY_BYTES} bytes`
  );
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
    // Public demo never loads stored connections (they may hold real keys):
    // the in-memory demo LLM installed above is the only one.
    if (!PUBLIC_DEMO) loadConnectionsFromDisk(connections);
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

    // Batches (Map node): an item task cut off by the crash is closed out —
    // its batch gives the item a fresh task on resume — then every batch that
    // was mid-run resumes from its checkpoint.
    for (const task of loaded) {
      if (task.batchId && isActiveStatus(task.status)) {
        task.status = "cancelled";
        task.escalationReason = "interrupted by server restart — batch will re-run this item";
        void saveTask(task).catch(() => {});
      }
    }
    const batches = await loadBatchesFromDisk();
    const resumedBatches = resumeInterruptedBatches();
    if (batches.length > 0) {
      console.log(
        `[loop-agent-backend] loaded ${batches.length} batch(es)` +
          (resumedBatches.length > 0 ? `, resuming ${resumedBatches.length} interrupted` : "")
      );
    }
  } catch (err) {
    console.error(`[loop-agent-backend] Failed to load persisted tasks:`, err);
  }
});

export { httpServer };