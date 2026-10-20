/**
 * Host / Origin allowlist shared by the HTTP handler and the WebSocket
 * upgrade check.
 *
 * Why: the backend runs local agents with filesystem access. Without a Host
 * check a DNS-rebinding page (evil.com -> 127.0.0.1) can drive the API; without
 * an Origin check any website open in the user's browser can POST to it.
 *
 * Allowed hostnames: localhost, 127.0.0.1, [::1] plus the comma-separated
 * LOOP_ALLOWED_HOSTS env var. Ports are ignored (the UI is on :5173, the API
 * on :3001 and the Vite proxy rewrites Host to localhost:3001 while keeping
 * Origin http://localhost:5173 — both must pass).
 */

export const DEFAULT_ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** Normalize one allowlist entry: lowercase, strip scheme/port, bracket bare IPv6. */
function normalizeEntry(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  // Tolerate full origins ("http://foo:5173") in the env var.
  if (s.includes("://")) {
    try {
      return new URL(s).hostname || null;
    } catch {
      return null;
    }
  }
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    return end > 0 ? s.slice(0, end + 1) : null;
  }
  // Bare IPv6 (two or more colons) -> bracketed form, as URL.hostname reports it.
  if ((s.match(/:/g) || []).length >= 2) return `[${s}]`;
  // host:port -> host
  const colon = s.indexOf(":");
  if (colon >= 0) s = s.slice(0, colon);
  return s || null;
}

export function buildAllowedHostnames(
  extra: string | undefined = process.env.LOOP_ALLOWED_HOSTS
): Set<string> {
  const set = new Set<string>(DEFAULT_ALLOWED_HOSTNAMES);
  for (const part of (extra ?? "").split(",")) {
    const n = normalizeEntry(part);
    if (n) set.add(n);
  }
  return set;
}

// A Host header is `reg-name[:port]` or `[ipv6][:port]`. Anything else
// (userinfo, paths, whitespace) is rejected outright rather than parsed.
const HOST_RE = /^(?:[a-z0-9._~-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** Extract the hostname from a Host header, or null if malformed. */
export function hostnameFromHostHeader(host: string | undefined): string | null {
  if (!host || !HOST_RE.test(host)) return null;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Extract the hostname from an Origin header, or null if malformed / "null". */
export function hostnameFromOrigin(origin: string): string | null {
  if (!origin || origin === "null") return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export type AccessCheck =
  | { ok: true }
  | { ok: false; status: 403 | 421; reason: string };

/**
 * Validate Host (always) and Origin (when present).
 * - bad / missing / non-allowlisted Host -> 421 Misdirected Request
 * - Origin present but not allowlisted   -> 403 Forbidden
 */
export function checkHostAndOrigin(
  host: string | undefined,
  origin: string | string[] | undefined,
  allowed: Set<string>
): AccessCheck {
  const hostname = hostnameFromHostHeader(host);
  if (!hostname || !allowed.has(hostname)) {
    return { ok: false, status: 421, reason: "host not allowed" };
  }
  if (origin !== undefined) {
    if (Array.isArray(origin)) {
      return { ok: false, status: 403, reason: "origin not allowed" };
    }
    const oh = hostnameFromOrigin(origin);
    if (!oh || !allowed.has(oh)) {
      return { ok: false, status: 403, reason: "origin not allowed" };
    }
  }
  return { ok: true };
}

/** True for loopback socket addresses (IPv4 127/8, ::1, IPv4-mapped 127/8). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}
