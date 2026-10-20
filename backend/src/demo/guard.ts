// HTTP gate for public demo mode. Wraps the Hono app (same `request(url,
// init)` shape the http handler drives) and, before anything reaches a
// route:
//   - DEFAULT-DENY: only the read endpoints and run controls the demo UI
//     needs are allowlisted. Connection writes, the folder browser
//     (/api/fs), prompt ratchet (arbitrary workdirs), projects/sessions
//     writes and task deletes all get 403.
//   - task/batch creation: refuses workdir / contextFiles / projectId /
//     sessionId, caps prompt + item sizes and item count, pins every role
//     to the demo LLM and forces autonomous mode (no run can park waiting
//     for a human and block the single-active-run slot for everyone).
//   - an hourly loop budget (whole instance + per client) and a cap on
//     stored tasks, so strangers can't burn the box.
//   - GET /api/demo describes the mode; other non-API GETs serve the UI.

import type { FetchApp } from "../http/handler.js";
import { DEMO_MODEL, type PublicDemoLimits } from "./publicDemo.js";

export interface PublicDemoDeps {
  limits: PublicDemoLimits;
  /** Tasks currently stored (create requests are refused past maxTasks). */
  taskCount: () => number;
  /** Items a batch resume would re-run, or undefined if there's no such batch. */
  batchRerunCount: (batchId: string) => number | undefined;
  /** Serves the built UI for non-API GET/HEAD paths; null when not built. */
  serveUi?: ((pathname: string, method: string) => Promise<Response>) | null;
  now?: () => number;
}

type Kind = "read" | "control" | "text" | "createTask" | "createBatch" | "rerunTask" | "rePrompt" | "rerunBatch";

interface Rule {
  method: "GET" | "POST";
  re: RegExp;
  kind: Kind;
  /** For kind "text" / "rePrompt": the free-text field to size-check. */
  field?: string;
}

const ID = "[A-Za-z0-9_-]{1,64}";
const rx = (s: string) => new RegExp(`^${s}$`);

export const PUBLIC_DEMO_RULES: readonly Rule[] = [
  { method: "GET", re: rx("/health"), kind: "read" },
  { method: "GET", re: rx("/api/health"), kind: "read" },
  { method: "GET", re: rx("/api/tasks"), kind: "read" },
  { method: "GET", re: rx(`/api/tasks/${ID}`), kind: "read" },
  { method: "POST", re: rx("/api/tasks"), kind: "createTask" },
  { method: "POST", re: rx(`/api/tasks/${ID}/stop`), kind: "control" },
  { method: "POST", re: rx(`/api/tasks/${ID}/(?:resume|reset)`), kind: "rerunTask" },
  { method: "POST", re: rx(`/api/tasks/${ID}/re-prompt`), kind: "rePrompt", field: "prompt" },
  { method: "POST", re: rx(`/api/tasks/${ID}/(?:confirm-plan|adjust-plan)`), kind: "text", field: "adjustments" },
  { method: "POST", re: rx(`/api/tasks/${ID}/feedback`), kind: "text", field: "feedback" },
  { method: "GET", re: rx("/api/batches"), kind: "read" },
  { method: "GET", re: rx(`/api/batches/${ID}`), kind: "read" },
  { method: "POST", re: rx("/api/batches"), kind: "createBatch" },
  { method: "POST", re: rx(`/api/batches/${ID}/cancel`), kind: "control" },
  { method: "POST", re: rx(`/api/batches/${ID}/resume`), kind: "rerunBatch" },
  { method: "GET", re: rx("/api/connections"), kind: "read" },
  { method: "GET", re: rx(`/api/connections/${ID}`), kind: "read" },
  { method: "GET", re: rx("/api/token-usage"), kind: "read" },
  { method: "GET", re: rx("/api/projects"), kind: "read" },
  { method: "GET", re: rx("/api/sessions"), kind: "read" },
  { method: "GET", re: rx("/api/insights"), kind: "read" },
  { method: "GET", re: rx("/api/improve-recipe"), kind: "read" },
];

/** Fields that would point a run at the server's filesystem. */
const FORBIDDEN_TASK_FIELDS = ["workdir", "contextFiles", "projectId", "sessionId"] as const;

const HOUR_MS = 60 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 5_000;

/** Sliding one-hour budget of loop runs, whole instance + per client. */
export class LoopBudget {
  private global: Array<{ t: number; w: number }> = [];
  private clients = new Map<string, Array<{ t: number; w: number }>>();
  constructor(private perHour: number, private perClientPerHour: number) {}

  private static live(list: Array<{ t: number; w: number }>, now: number) {
    while (list.length > 0 && list[0].t <= now - HOUR_MS) list.shift();
    return list;
  }

  private static sum(list: Array<{ t: number; w: number }>) {
    return list.reduce((a, e) => a + e.w, 0);
  }

  /** Seconds until `weight` more runs fit, or 0 if they fit now. */
  retryAfter(client: string, weight: number, now: number): number {
    const g = LoopBudget.live(this.global, now);
    const c = LoopBudget.live(this.clients.get(client) ?? [], now);
    const over =
      (LoopBudget.sum(g) + weight > this.perHour && g) ||
      (LoopBudget.sum(c) + weight > this.perClientPerHour && c) ||
      null;
    if (!over) return 0;
    const oldest = over[0]?.t ?? now;
    return Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000));
  }

  record(client: string, weight: number, now: number): void {
    this.global.push({ t: now, w: weight });
    if (!this.clients.has(client) && this.clients.size >= MAX_TRACKED_CLIENTS) {
      for (const [k, v] of this.clients) if (LoopBudget.live(v, now).length === 0) this.clients.delete(k);
      // Spoofed X-Forwarded-For can mint keys; the global budget still holds.
      if (this.clients.size >= MAX_TRACKED_CLIENTS) this.clients.clear();
    }
    const list = this.clients.get(client) ?? [];
    list.push({ t: now, w: weight });
    this.clients.set(client, list);
  }
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

const deny = (status: number, error: string, extra?: Record<string, string>) =>
  json(status, { error, publicDemo: true }, extra);

/** Best-effort client key: first X-Forwarded-For hop (set by the host's proxy). */
function clientKey(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim().toLowerCase();
  return first ? first.slice(0, 64) : "direct";
}

function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function decodeBody(body: RequestInit["body"]): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return "";
}

/** Parse a JSON object body; {} when empty, null when not a JSON object. */
function parseObject(body: RequestInit["body"]): Record<string, unknown> | null {
  const text = decodeBody(body);
  if (text.trim() === "") return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pinToDemoModel(body: Record<string, unknown>): void {
  body.model = DEMO_MODEL;
  body.modelOverrides = { planning: DEMO_MODEL, implementation: DEMO_MODEL, review: DEMO_MODEL };
}

export function publicDemoInfo(limits: PublicDemoLimits) {
  return {
    publicDemo: true,
    model: DEMO_MODEL,
    limits: {
      maxItems: limits.maxItems,
      maxItemChars: limits.maxItemChars,
      maxPromptChars: limits.maxPromptChars,
      maxAttempts: limits.maxAttempts,
      loopsPerHour: limits.loopsPerHour,
      loopsPerClientPerHour: limits.loopsPerClientPerHour,
    },
    hint: "Items containing FAIL-ME are always rejected by the verifier — watch the loop retry, then escalate.",
  };
}

export function createPublicDemoApp(app: FetchApp, deps: PublicDemoDeps): FetchApp {
  const L = deps.limits;
  const now = deps.now ?? Date.now;
  const budget = new LoopBudget(L.loopsPerHour, L.loopsPerClientPerHour);

  async function request(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const readMethod = method === "GET" || method === "HEAD";
    const path = url.pathname;
    const isApi = path === "/health" || path === "/api" || path.startsWith("/api/");

    if (path === "/api/demo" && readMethod) return json(200, publicDemoInfo(L));
    if (!isApi) {
      if (!readMethod) return deny(405, "method not allowed");
      if (path === "/ws") return app.request(url, init);
      if (deps.serveUi) return deps.serveUi(path, method);
      return deny(404, "UI not built — run `npm run build` in ui/");
    }

    const matchMethod = method === "HEAD" ? "GET" : method;
    const rule = PUBLIC_DEMO_RULES.find((r) => r.method === matchMethod && r.re.test(path));
    if (!rule) return deny(403, `${method} ${path} is disabled in the public demo`);
    if (rule.kind === "read" || rule.kind === "control") return app.request(url, init);

    const body = parseObject(init.body);
    if (body === null) return deny(400, "expected a JSON object body");
    let weight = 0;
    let creates = false;

    switch (rule.kind) {
      case "text":
      case "rePrompt": {
        const v = body[rule.field!];
        if (typeof v === "string" && v.length > L.maxPromptChars) {
          return deny(400, `${rule.field} is limited to ${L.maxPromptChars} characters in the public demo`);
        }
        if (rule.kind === "rePrompt") weight = 1;
        break;
      }
      case "rerunTask":
        weight = 1;
        break;
      case "rerunBatch": {
        const id = path.split("/")[3];
        weight = deps.batchRerunCount(id) ?? 0;
        break;
      }
      case "createTask": {
        for (const f of FORBIDDEN_TASK_FIELDS) {
          if (present(body[f])) {
            return deny(403, `"${f}" is disabled in the public demo — every run gets a throwaway sandbox`);
          }
        }
        if (typeof body.prompt === "string" && body.prompt.length > L.maxPromptChars) {
          return deny(400, `prompt is limited to ${L.maxPromptChars} characters in the public demo`);
        }
        if (typeof body.title === "string") body.title = body.title.slice(0, 120);
        pinToDemoModel(body);
        body.autoApprovePlan = true;
        weight = 1;
        creates = true;
        break;
      }
      case "createBatch": {
        if (present(body.workdir)) {
          return deny(403, `"workdir" is disabled in the public demo — every run gets a throwaway sandbox`);
        }
        const items = body.items;
        if (Array.isArray(items)) {
          if (items.length > L.maxItems) {
            return deny(400, `the public demo runs at most ${L.maxItems} items per batch (got ${items.length})`);
          }
          if (items.some((i) => typeof i === "string" && i.length > L.maxItemChars)) {
            return deny(400, `each item is limited to ${L.maxItemChars} characters in the public demo`);
          }
        }
        if (typeof body.promptTemplate === "string" && body.promptTemplate.length > L.maxPromptChars) {
          return deny(400, `promptTemplate is limited to ${L.maxPromptChars} characters in the public demo`);
        }
        if (typeof body.maxAttempts === "number" && body.maxAttempts > L.maxAttempts) {
          body.maxAttempts = L.maxAttempts;
        }
        pinToDemoModel(body);
        weight = Array.isArray(items) ? Math.max(1, items.length) : 1;
        creates = true;
        break;
      }
    }

    const client = clientKey(new Headers(init.headers));
    if (weight > 0) {
      if (creates && deps.taskCount() + weight > L.maxTasks) {
        return deny(503, "the public demo is full — it resets when the server restarts");
      }
      const wait = budget.retryAfter(client, weight, now());
      if (wait > 0) {
        return deny(429, `public demo run budget used up — try again in ~${Math.ceil(wait / 60)} min`, {
          "retry-after": String(wait),
        });
      }
    }

    const headers = new Headers(init.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    const res = await app.request(url, {
      ...init,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : new TextEncoder().encode(JSON.stringify(body)),
    });
    if (weight > 0 && res.ok) budget.record(client, weight, now());
    return res;
  }

  return { request };
}
