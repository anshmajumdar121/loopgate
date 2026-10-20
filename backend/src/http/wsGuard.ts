import type { IncomingMessage } from "node:http";
import { checkHostAndOrigin, isLoopbackAddress } from "./security.js";

/** Max size of a single inbound WebSocket message (ws default is 100 MB). */
export const WS_MAX_PAYLOAD_BYTES = 1024 * 1024;
/** Max concurrent WebSocket clients. */
export const WS_MAX_CLIENTS = 200;

export interface VerifyClientOptions {
  allowedHosts: Set<string>;
  /** Current number of connected clients (e.g. () => wss.clients.size). */
  getClientCount: () => number;
  maxClients?: number;
}

type VerifyInfo = { origin: string; secure: boolean; req: IncomingMessage };
type VerifyCallback = (
  res: boolean,
  code?: number,
  message?: string,
  headers?: Record<string, string>
) => void;

/**
 * ws `verifyClient` (callback form, so we can choose status codes):
 *  - Host must be allowlisted                          -> else 421
 *  - Origin, if present, must be allowlisted            -> else 403
 *  - no Origin header: only from a loopback socket      -> else 403
 *  - at most `maxClients` concurrent connections        -> else 503
 */
export function createVerifyClient(opts: VerifyClientOptions) {
  const max = opts.maxClients ?? WS_MAX_CLIENTS;
  return (info: VerifyInfo, cb: VerifyCallback): void => {
    try {
      const req = info.req;
      const origin = req.headers.origin;
      const access = checkHostAndOrigin(req.headers.host, origin, opts.allowedHosts);
      if (!access.ok) {
        cb(false, access.status, access.reason);
        return;
      }
      if (origin === undefined && !isLoopbackAddress(req.socket.remoteAddress)) {
        cb(false, 403, "origin required");
        return;
      }
      if (opts.getClientCount() >= max) {
        cb(false, 503, "too many websocket clients");
        return;
      }
      cb(true);
    } catch {
      cb(false, 400, "bad request");
    }
  };
}
