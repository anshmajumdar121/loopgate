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
import { loadConnectionsFromDisk } from "./store/connections.js";
import { loadTasksFromDisk } from "./store/tasks.js";
import { loadUsageFromDisk } from "./store/tokenUsage.js";
import { startConnectionHealthMonitor } from "./loop/connection-health.js";
import { stopConnectionHealthMonitor } from "./loop/connection-health.js";
import { closeEngineResources, stopAllLoops } from "./loop/orchestrator.js";
import { stopPreviewServer } from "./loop/preview-server.js";
import {
  installShutdownHandlers,
  ShutdownCoordinator,
} from "./loop/v2/shutdown-coordinator.js";
import { createHttpHandler, resolveMaxBodyBytes } from "./http/handler.js";
import { buildAllowedHostnames } from "./http/security.js";
import { installProcessGuards } from "./http/processGuards.js";
import { createVerifyClient, WS_MAX_CLIENTS, WS_MAX_PAYLOAD_BYTES } from "./http/wsGuard.js";

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
const ALLOWED_HOSTS = buildAllowedHostnames(process.env.LOOP_ALLOWED_HOSTS);
const MAX_BODY_BYTES = resolveMaxBodyBytes(process.env.LOOP_MAX_BODY_BYTES);

// A stray rejection/throw must never take the backend down; log loudly instead.
installProcessGuards();

// Bridge Hono to a raw http.Server so we can also attach WebSocket on /ws.
// createHttpHandler adds Host/Origin allowlisting, a body cap (413), 400 on
// malformed request-targets and 500 on any other failure — it never rejects.
const httpServer = createServer(
  createHttpHandler(app, {
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

// Shutdown is explicit and idempotent. The coordinator aborts the shared
// signal first, then closes loop resources and servers without leaving child
// agents or health-check timers behind on SIGINT/SIGTERM.
export const shutdownCoordinator = new ShutdownCoordinator();
shutdownCoordinator.register(() => stopAllLoops());
shutdownCoordinator.register(() => closeEngineResources());
shutdownCoordinator.register(() => stopConnectionHealthMonitor());
shutdownCoordinator.register(() => stopPreviewServer());
shutdownCoordinator.register(
  () =>
    new Promise<void>((resolve, reject) => {
      try {
        for (const client of wss.clients) client.terminate();
        wss.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    })
);
shutdownCoordinator.register(
  () =>
    new Promise<void>((resolve, reject) => {
      if (!httpServer.listening) {
        resolve();
        return;
      }
      httpServer.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        resolve();
      });
    })
);
installShutdownHandlers(shutdownCoordinator, {
  onError: (error) => console.error("[loop-agent-backend] shutdown failed:", error),
});

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
