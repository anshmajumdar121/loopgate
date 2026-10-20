import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { createHttpHandler, resolveMaxBodyBytes, DEFAULT_MAX_BODY_BYTES } from "../http/handler.js";
import {
  buildAllowedHostnames,
  checkHostAndOrigin,
  hostnameFromHostHeader,
  isLoopbackAddress,
} from "../http/security.js";
import {
  installProcessGuards,
  makeUncaughtExceptionHandler,
  makeUnhandledRejectionHandler,
} from "../http/processGuards.js";

const MAX = 1024; // tiny cap so tests stay fast

function makeApp() {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.post("/echo", async (c) => {
    const text = await c.req.text();
    return c.json({ len: text.length });
  });
  app.get("/boom", () => {
    throw new Error("route exploded");
  });
  return app;
}

let server: Server;
let port: number;
const logged: unknown[][] = [];

beforeAll(async () => {
  const app = makeApp();
  // Hono's own onError would turn route throws into 500 itself; make the
  // fetch layer reject so we exercise the handler's own catch path too.
  const rejectingApp = {
    request: (url: URL, init: RequestInit) =>
      url.pathname === "/reject" ? Promise.reject(new Error("fetch layer died")) : app.request(url, init),
  };
  server = createServer(
    createHttpHandler(rejectingApp, {
      port: 0,
      allowedHosts: buildAllowedHostnames("myhost.lan"),
      maxBodyBytes: MAX,
      log: (...a) => logged.push(a),
    })
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

/** Send raw bytes, resolve with whatever the server wrote before closing. */
function rawRequest(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(payload));
    let out = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      out += d;
      if (out.includes("\r\n\r\n")) sock.end();
    });
    sock.on("end", () => resolve(out));
    sock.on("close", () => resolve(out));
    sock.on("error", reject);
    setTimeout(() => {
      sock.destroy();
      resolve(out);
    }, 3000);
  });
}

function httpReq(opts: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/health",
        headers: { host: `localhost:${port}`, ...(opts.headers ?? {}) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("http hardening: malformed request-target (crash fix)", () => {
  it("answers `GET //[ HTTP/1.1` with 400 and keeps serving", async () => {
    const out = await rawRequest(`GET //[ HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`);
    expect(out).toMatch(/^HTTP\/1\.1 400/);
    const after = await httpReq({ path: "/health" });
    expect(after.status).toBe(200);
  });

  it("turns a rejecting fetch layer into 500 instead of an unhandled rejection", async () => {
    const r = await httpReq({ path: "/reject" });
    expect(r.status).toBe(500);
    expect(logged.some((l) => String(l[0]).includes("request handler error"))).toBe(true);
    expect((await httpReq({ path: "/health" })).status).toBe(200);
  });

  it("route throws still map to 500", async () => {
    expect((await httpReq({ path: "/boom" })).status).toBe(500);
  });
});

describe("http hardening: body limit", () => {
  it("passes bodies under the cap through unchanged", async () => {
    const r = await httpReq({ method: "POST", path: "/echo", body: "x".repeat(MAX) });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ len: MAX });
  });

  it("413s immediately on an oversize Content-Length", async () => {
    const out = await rawRequest(
      `POST /echo HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Length: ${MAX * 1000}\r\n\r\n`
    );
    expect(out).toMatch(/^HTTP\/1\.1 413/);
  });

  it("413s a chunked body that grows past the cap without buffering it", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/echo",
          headers: { host: `localhost:${port}`, "transfer-encoding": "chunked" },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        }
      );
      // After the 413 the server tears the socket down; ignore write errors.
      req.on("error", () => {});
      const chunk = Buffer.alloc(512, 97);
      let sent = 0;
      const pump = () => {
        if (sent > 64) return req.end();
        sent++;
        req.write(chunk, () => setImmediate(pump));
      };
      pump();
      setTimeout(() => reject(new Error("no response")), 4000);
    });
    expect(status).toBe(413);
    expect((await httpReq({ path: "/health" })).status).toBe(200);
  });

  it("resolveMaxBodyBytes defaults to 10 MB and honours LOOP_MAX_BODY_BYTES", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(10 * 1024 * 1024);
    expect(resolveMaxBodyBytes(undefined)).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(resolveMaxBodyBytes("garbage")).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(resolveMaxBodyBytes("2048")).toBe(2048);
  });
});

describe("http hardening: Host / Origin allowlist", () => {
  it("rejects a DNS-rebinding Host with 421", async () => {
    const r = await httpReq({ headers: { host: `evil.example:${port}` } });
    expect(r.status).toBe(421);
  });

  it("rejects malformed Host headers", async () => {
    expect((await httpReq({ headers: { host: `evil.com@localhost` } })).status).toBe(421);
    expect(hostnameFromHostHeader(undefined)).toBeNull();
    expect(hostnameFromHostHeader("localhost/x")).toBeNull();
  });

  it("accepts localhost, 127.0.0.1, [::1] and LOOP_ALLOWED_HOSTS entries on any port", async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "myhost.lan:9", "LOCALHOST"]) {
      expect((await httpReq({ headers: { host } })).status, host).toBe(200);
    }
  });

  it("keeps the Vite dev proxy working (changeOrigin: Host localhost:3001, Origin :5173)", async () => {
    const r = await httpReq({
      method: "POST",
      path: "/echo",
      headers: { host: "localhost:3001", origin: "http://localhost:5173" },
      body: "{}",
    });
    expect(r.status).toBe(200);
  });

  it("rejects foreign / opaque Origins with 403", async () => {
    for (const origin of ["http://evil.example", "null", "file://", "http://localhost.evil.example"]) {
      const r = await httpReq({ method: "POST", path: "/echo", headers: { origin }, body: "{}" });
      expect(r.status, origin).toBe(403);
    }
  });

  it("checkHostAndOrigin + buildAllowedHostnames unit behaviour", () => {
    const allowed = buildAllowedHostnames(" Foo.Lan:5173 , http://bar.lan:8080, ::1 ,,");
    expect(allowed.has("foo.lan")).toBe(true);
    expect(allowed.has("bar.lan")).toBe(true);
    expect(allowed.has("[::1]")).toBe(true);
    expect(checkHostAndOrigin("foo.lan:1", "https://bar.lan", allowed)).toEqual({ ok: true });
    expect(checkHostAndOrigin("foo.lan", ["http://localhost", "http://x"], allowed)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(checkHostAndOrigin(undefined, undefined, allowed)).toMatchObject({ ok: false, status: 421 });
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.6")).toBe(false);
  });
});

describe("process guards", () => {
  it("handlers log loudly and never throw", () => {
    const log = vi.fn();
    makeUnhandledRejectionHandler(log)(new Error("x"));
    makeUncaughtExceptionHandler(log)(new Error("y"), "uncaughtException");
    const text = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("UNHANDLED PROMISE REJECTION");
    expect(text).toContain("UNCAUGHT EXCEPTION");
    const throwingLog = () => {
      throw new Error("log broke");
    };
    expect(() => makeUnhandledRejectionHandler(throwingLog)("r")).not.toThrow();
    expect(() => makeUncaughtExceptionHandler(throwingLog)(new Error("e"))).not.toThrow();
  });

  it("installProcessGuards registers both listeners exactly once", () => {
    const before = {
      rej: process.listenerCount("unhandledRejection"),
      exc: process.listenerCount("uncaughtException"),
    };
    const first = installProcessGuards(() => {});
    const second = installProcessGuards(() => {});
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rej + 1);
    expect(process.listenerCount("uncaughtException")).toBe(before.exc + 1);
  });
});
