import { WebSocketServer, WebSocket } from "ws";
import type { WsClientMessage, WsServerMessage } from "../types.js";

/** How often the server pings connected clients. The client's pong-deadline
 *  is PONG_TIMEOUT_MS in useLoopSocket.ts (60s) — this interval must be
 *  comfortably shorter so the client always sees at least one ping per
 *  deadline window.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

interface Subscriber {
  ws: WebSocket;
  taskId: string | null; // null = broadcast-all mode (not used today)
}

class Broadcaster {
  private subscribers = new Map<WebSocket, Subscriber>();
  /** Per-socket heartbeat timer. WeakMap so the timer doesn't pin the
   *  WebSocket in memory after disconnect. */
  private heartbeatTimers = new WeakMap<WebSocket, NodeJS.Timeout>();
  private wss?: WebSocketServer;

  attach(wss: WebSocketServer): void {
    this.wss = wss;
    wss.on("connection", (ws, _req) => this.handleConnection(ws));
  }

  private handleConnection(ws: WebSocket): void {
    const sub: Subscriber = { ws, taskId: null };
    this.subscribers.set(ws, sub);

    ws.on("message", (raw) => this.handleClientMessage(ws, raw.toString()));
    ws.on("close", () => {
      const timer = this.heartbeatTimers.get(ws);
      if (timer) {
        clearInterval(timer);
        this.heartbeatTimers.delete(ws);
      }
      this.subscribers.delete(ws);
    });
    ws.on("error", () => {
      const timer = this.heartbeatTimers.get(ws);
      if (timer) {
        clearInterval(timer);
        this.heartbeatTimers.delete(ws);
      }
      this.subscribers.delete(ws);
    });

    // Start heartbeat — ping every HEARTBEAT_INTERVAL_MS. The ws library
    // auto-replies with a pong frame; the client's "pong" event handler
    // treats that as proof of liveness.
    const timer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(timer);
        return;
      }
      try {
        ws.ping();
      } catch {
        // onclose will fire and clean up
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimers.set(ws, timer);

    // Greet
    this.send(ws, { type: "pong" });
  }

  private handleClientMessage(ws: WebSocket, raw: string): void {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(raw) as WsClientMessage;
    } catch {
      return;
    }

    const sub = this.subscribers.get(ws);
    if (!sub) return;

    switch (msg.type) {
      case "ping":
        this.send(ws, { type: "pong" });
        break;
      case "subscribe":
        sub.taskId = msg.taskId;
        break;
      case "unsubscribe":
        sub.taskId = null;
        break;
    }
  }

  /** Send to one socket */
  private send(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* swallow broken pipe */
    }
  }

  /** Broadcast to every socket subscribed to a task */
  broadcast(taskId: string, msg: WsServerMessage): void {
    for (const [, sub] of this.subscribers) {
      if (sub.taskId === taskId) {
        this.send(sub.ws, msg);
      }
    }
  }

  /** Broadcast to EVERY connected socket, regardless of task subscription.
   *  Used for non-task-scoped events (connection_health) — the Connections
   *  panel has no task to subscribe to. */
  broadcastAll(msg: WsServerMessage): void {
    for (const [, sub] of this.subscribers) {
      this.send(sub.ws, msg);
    }
  }

  /** Broadcast to a task AND fire on every listener — sugar for log+update */
  broadcastLog(
    taskId: string,
    agent: import("../types.js").AgentRole,
    stream: import("../types.js").LogLevel,
    text: string
  ): void {
    const entry = {
      ts: new Date().toISOString(),
      agent,
      stream,
      text,
    };
    this.broadcast(taskId, { type: "log", taskId, entry });
  }

  /** Subscribe to internal events for testing */
  onConnection?: (sub: Subscriber) => void;
}

export const broadcaster = new Broadcaster();