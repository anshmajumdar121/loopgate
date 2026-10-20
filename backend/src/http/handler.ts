import type { IncomingMessage, ServerResponse } from "node:http";
import { checkHostAndOrigin } from "./security.js";

/** Default request-body cap: 10 MB. Override with LOOP_MAX_BODY_BYTES. */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export function resolveMaxBodyBytes(
  raw: string | undefined = process.env.LOOP_MAX_BODY_BYTES
): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BODY_BYTES;
}

/** Anything with a Hono-style `request(url, init)` (e.g. a Hono app). */
export interface FetchApp {
  request(input: URL, init: RequestInit): Response | Promise<Response>;
}

export interface HttpHandlerOptions {
  port: number;
  allowedHosts: Set<string>;
  maxBodyBytes: number;
  log?: (...args: unknown[]) => void;
}

const TOO_LARGE = Symbol("too-large");

function sendPlain(
  res: ServerResponse,
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {}
): void {
  if (res.headersSent || res.writableEnded) {
    // Too late for a clean status; make sure the socket doesn't hang.
    if (!res.writableEnded) res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify({ error: message }));
}

/**
 * Read the request body, refusing to buffer more than `max` bytes. On
 * overflow the stream is paused (we stop reading) and TOO_LARGE is returned.
 */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | typeof TOO_LARGE> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) {
    req.pause();
    return Promise.resolve(TOO_LARGE);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        cleanup();
        req.pause();
        chunks.length = 0;
        resolve(TOO_LARGE);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onAborted = () => {
      cleanup();
      reject(new Error("request aborted"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

/**
 * Reply 413 and tear the connection down. The request stream stays paused
 * (we stop reading the oversize body). We deliberately do NOT send
 * `Connection: close`: Node would then destroy the socket the moment the
 * response is flushed and, with unread request bytes pending, the resulting
 * RST makes the client (notably on Windows) drop the 413 before reading it.
 * Instead the socket is destroyed after a short grace period.
 */
function rejectTooLarge(req: IncomingMessage, res: ServerResponse, max: number): void {
  req.pause();
  res.on("finish", () => {
    setTimeout(() => req.socket.destroy(), 1000).unref();
  });
  sendPlain(res, 413, `request body exceeds ${max} bytes`);
}

/**
 * Bridge a raw node:http request to a Hono-style fetch app with:
 *  - Host / Origin allowlist (421 / 403)
 *  - malformed request-target -> 400 (previously an unhandled rejection that
 *    killed the process, e.g. `GET //[ HTTP/1.1`)
 *  - body cap -> 413
 *  - any other failure -> 500
 * The returned listener never throws and never returns a rejecting promise.
 */
export function createHttpHandler(app: FetchApp, opts: HttpHandlerOptions) {
  const log = opts.log ?? ((...a: unknown[]) => console.error(...a));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const access = checkHostAndOrigin(req.headers.host, req.headers.origin, opts.allowedHosts);
    if (!access.ok) {
      sendPlain(res, access.status, access.reason);
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url || "/", `http://localhost:${opts.port}`);
    } catch {
      sendPlain(res, 400, "bad request url");
      return;
    }

    const method = req.method || "GET";
    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const read = await readBody(req, opts.maxBodyBytes);
      if (read === TOO_LARGE) {
        rejectTooLarge(req, res, opts.maxBodyBytes);
        return;
      }
      body = read;
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
    res.statusCode = fetchRes.status;
    fetchRes.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(buf);
  }

  return function httpHandler(req: IncomingMessage, res: ServerResponse): void {
    handle(req, res).catch((err) => {
      log("[loop-agent-backend] request handler error:", req.method, req.url, err);
      try {
        sendPlain(res, 500, "internal server error");
      } catch (e) {
        log("[loop-agent-backend] failed to send 500:", e);
        res.destroy();
      }
    });
  };
}
