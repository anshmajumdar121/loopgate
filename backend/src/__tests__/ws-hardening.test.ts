import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { Broadcaster, parseClientMessage } from "../ws/broadcaster.js";
import { createVerifyClient, WS_MAX_CLIENTS, WS_MAX_PAYLOAD_BYTES } from "../http/wsGuard.js";
import { buildAllowedHostnames } from "../http/security.js";

const MAX_CLIENTS = 3;

let server: Server;
let wss: WebSocketServer;
let port: number;
let broadcaster: Broadcaster;

beforeAll(async () => {
  server = createServer((_req, res) => res.end("ok"));
  wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    verifyClient: createVerifyClient({
      allowedHosts: buildAllowedHostnames(""),
      getClientCount: () => wss.clients.size,
      maxClients: MAX_CLIENTS,
    }),
  });
  broadcaster = new Broadcaster(MAX_CLIENTS);
  broadcaster.attach(wss);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

type Outcome =
  | { kind: "open"; ws: WebSocket; firstMessage: Promise<string> }
  | { kind: "rejected"; status: number };

function open(headers: Record<string, string> = {}, origin?: string): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { host: `localhost:${port}`, ...headers },
      ...(origin ? { origin } : {}),
    });
    const firstMessage = new Promise<string>((r) => ws.once("message", (d) => r(d.toString())));
    ws.once("open", () => resolve({ kind: "open", ws, firstMessage }));
    ws.once("unexpected-response", (_req, res: IncomingMessage) => {
      resolve({ kind: "rejected", status: res.statusCode ?? 0 });
      res.resume();
    });
    ws.once("error", (err) => {
      if (ws.readyState !== WebSocket.CLOSED) reject(err);
    });
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
    ws.once("message", (d) => {
      clearTimeout(t);
      resolve(d.toString());
    });
  });
}

function closeAndWait(ws: WebSocket): Promise<void> {
  return new Promise((r) => {
    if (ws.readyState === WebSocket.CLOSED) return r();
    ws.once("close", () => r());
    ws.close();
  });
}

describe("ws hardening: verifyClient", () => {
  it("accepts the Vite proxy shape (Host localhost:3001, Origin http://localhost:5173)", async () => {
    const o = await open({ host: "localhost:3001" }, "http://localhost:5173");
    expect(o.kind).toBe("open");
    if (o.kind === "open") {
      expect(JSON.parse(await o.firstMessage)).toEqual({ type: "pong" });
      await closeAndWait(o.ws);
    }
  });

  it("accepts a loopback client with no Origin header", async () => {
    const o = await open();
    expect(o.kind).toBe("open");
    if (o.kind === "open") await closeAndWait(o.ws);
  });

  it("rejects a foreign Origin with 403", async () => {
    const o = await open({}, "http://evil.example");
    expect(o).toEqual({ kind: "rejected", status: 403 });
  });

  it("rejects a DNS-rebinding Host with 421", async () => {
    const o = await open({ host: `evil.example:${port}` }, "http://evil.example");
    expect(o).toEqual({ kind: "rejected", status: 421 });
  });

  it(`caps concurrent clients (default ${WS_MAX_CLIENTS})`, async () => {
    expect(WS_MAX_CLIENTS).toBe(200);
    const opened: WebSocket[] = [];
    for (let i = 0; i < MAX_CLIENTS; i++) {
      const o = await open();
      expect(o.kind).toBe("open");
      if (o.kind === "open") opened.push(o.ws);
    }
    const extra = await open();
    expect(extra).toEqual({ kind: "rejected", status: 503 });
    await Promise.all(opened.map(closeAndWait));
    // wss.clients drops closed sockets asynchronously; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const again = await open();
    expect(again.kind).toBe("open");
    if (again.kind === "open") await closeAndWait(again.ws);
  });
});

describe("ws hardening: payload + message shape", () => {
  it("uses a 1 MB maxPayload and closes oversize senders with 1009", async () => {
    expect(WS_MAX_PAYLOAD_BYTES).toBe(1024 * 1024);
    const o = await open();
    if (o.kind !== "open") throw new Error("expected open");
    await o.firstMessage;
    const code = await new Promise<number>((r) => {
      o.ws.once("close", (c) => r(c));
      o.ws.send("x".repeat(WS_MAX_PAYLOAD_BYTES + 1));
    });
    expect(code).toBe(1009);
  });

  it("survives null / array / wrong-typed frames and still answers ping", async () => {
    const o = await open();
    if (o.kind !== "open") throw new Error("expected open");
    await o.firstMessage;
    for (const bad of [
      "null",
      "[]",
      "42",
      '"ping"',
      "{not json",
      '{"type":"subscribe"}',
      '{"type":"subscribe","taskId":{"x":1}}',
      '{"type":"unknown"}',
      '{"type":null}',
    ]) {
      o.ws.send(bad);
    }
    o.ws.send(JSON.stringify({ type: "ping" }));
    expect(JSON.parse(await nextMessage(o.ws))).toEqual({ type: "pong" });
    expect(o.ws.readyState).toBe(WebSocket.OPEN);

    // Subscriptions still work after the junk.
    o.ws.send(JSON.stringify({ type: "subscribe", taskId: "t-1" }));
    o.ws.send(JSON.stringify({ type: "ping" }));
    await nextMessage(o.ws);
    broadcaster.broadcast("t-1", { type: "task_deleted", taskId: "t-1" });
    expect(JSON.parse(await nextMessage(o.ws))).toEqual({ type: "task_deleted", taskId: "t-1" });
    await closeAndWait(o.ws);
  });

  it("parseClientMessage shape checks", () => {
    expect(parseClientMessage("null")).toBeNull();
    expect(parseClientMessage("[]")).toBeNull();
    expect(parseClientMessage('{"type":"subscribe","taskId":7}')).toBeNull();
    expect(parseClientMessage('{"type":"subscribe","taskId":""}')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "subscribe", taskId: "a".repeat(300) }))).toBeNull();
    expect(parseClientMessage('{"type":"ping","extra":1}')).toEqual({ type: "ping" });
    expect(parseClientMessage('{"type":"subscribe","taskId":"abc"}')).toEqual({
      type: "subscribe",
      taskId: "abc",
    });
    expect(parseClientMessage('{"type":"unsubscribe"}')).toEqual({ type: "unsubscribe", taskId: "" });
  });
});
