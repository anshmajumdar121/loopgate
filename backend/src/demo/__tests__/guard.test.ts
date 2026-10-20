// Public demo HTTP gate: default-deny allowlist, request rewriting, size
// caps, run budget and storage cap. The wrapped app is a recorder stub, so
// these tests pin exactly what reaches the real routes.
import { describe, it, expect, beforeEach } from "vitest";
import { createPublicDemoApp, type PublicDemoDeps } from "../guard.js";
import { DEMO_MODEL, publicDemoLimits, type PublicDemoLimits } from "../publicDemo.js";

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Headers;
}

let seen: Seen[];
let downstreamStatus: number;
let clock: number;
let taskCount: number;

const baseLimits: PublicDemoLimits = publicDemoLimits({});

function makeGate(over: Partial<PublicDemoDeps> = {}, limits: Partial<PublicDemoLimits> = {}) {
  const app = {
    request(url: URL, init: RequestInit) {
      const text = init.body ? new TextDecoder().decode(init.body as Uint8Array) : "";
      seen.push({
        method: init.method ?? "GET",
        path: url.pathname,
        body: text ? JSON.parse(text) : null,
        headers: new Headers(init.headers),
      });
      return new Response(JSON.stringify({ ok: true }), { status: downstreamStatus });
    },
  };
  return createPublicDemoApp(app, {
    limits: { ...baseLimits, ...limits },
    taskCount: () => taskCount,
    batchRerunCount: (id) => (id === "known" ? 2 : undefined),
    serveUi: async (p) => new Response(`ui:${p}`, { status: 200 }),
    now: () => clock,
    ...over,
  });
}

function call(gate: ReturnType<typeof makeGate>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  if (body !== undefined) {
    bytes = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
    h.set("content-type", "application/json");
    h.set("content-length", String(bytes.length));
  }
  return gate.request(new URL(`http://localhost${path}`), { method, headers: h, body: bytes });
}

const err = async (r: Response) => ((await r.json()) as { error: string }).error;

beforeEach(() => {
  seen = [];
  downstreamStatus = 201;
  clock = 1_000_000;
  taskCount = 0;
});

describe("public demo gate — default deny", () => {
  it.each([
    ["POST", "/api/connections"],
    ["PATCH", "/api/connections/public-demo-llm"],
    ["DELETE", "/api/connections/public-demo-llm"],
    ["POST", "/api/connections/public-demo-llm/test"],
    ["GET", "/api/fs/home"],
    ["GET", "/api/fs/list"],
    ["POST", "/api/ratchet/snapshot"],
    ["POST", "/api/ratchet/revert"],
    ["GET", "/api/ratchet/snapshots"],
    ["POST", "/api/projects"],
    ["GET", "/api/projects/by-path"],
    ["DELETE", "/api/projects/p1"],
    ["POST", "/api/sessions"],
    ["DELETE", "/api/sessions/s1"],
    ["DELETE", "/api/tasks/t1"],
    ["GET", "/api/some-future-endpoint"],
  ])("refuses %s %s without reaching the app", async (method, path) => {
    const res = await call(makeGate(), method, path, method === "GET" ? undefined : {});
    expect(res.status).toBe(403);
    expect(await err(res)).toMatch(/disabled in the public demo/);
    expect(seen).toHaveLength(0);
  });

  it.each([
    ["GET", "/health"],
    ["GET", "/api/tasks"],
    ["GET", "/api/tasks/active"],
    ["GET", "/api/batches/b1"],
    ["GET", "/api/connections"],
    ["GET", "/api/token-usage"],
    ["GET", "/api/insights"],
    ["POST", "/api/tasks/abc123/stop"],
    ["POST", "/api/batches/b1/cancel"],
  ])("passes %s %s through untouched", async (method, path) => {
    downstreamStatus = 200;
    const res = await call(makeGate(), method, path);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe(path);
  });

  it("answers /api/demo itself and serves the UI for other GETs", async () => {
    const gate = makeGate();
    const info = await (await call(gate, "GET", "/api/demo")).json();
    expect(info).toMatchObject({ publicDemo: true, model: DEMO_MODEL, limits: { maxItems: baseLimits.maxItems } });
    expect(await (await call(gate, "GET", "/batches/view")).text()).toBe("ui:/batches/view");
    expect((await call(gate, "POST", "/index.html", {})).status).toBe(405);
    expect(seen).toHaveLength(0);
  });

  it("reports a missing UI build instead of serving anything", async () => {
    const res = await call(makeGate({ serveUi: null }), "GET", "/");
    expect(res.status).toBe(404);
    expect(await err(res)).toMatch(/UI not built/);
  });
});

describe("public demo gate — task creation", () => {
  it.each([
    ["workdir", "C:/Windows"],
    ["workdir", "/etc"],
    ["workdir", "relative/dir"],
    ["contextFiles", ["/etc/passwd"]],
    ["projectId", "p1"],
    ["sessionId", "s1"],
  ])("refuses a %s (%j)", async (field, value) => {
    const res = await call(makeGate(), "POST", "/api/tasks", { prompt: "build a page", [field]: value });
    expect(res.status).toBe(403);
    expect(await err(res)).toContain(`"${field}" is disabled`);
    expect(seen).toHaveLength(0);
  });

  it("tolerates empty optional fields the UI sends", async () => {
    const res = await call(makeGate(), "POST", "/api/tasks", { prompt: "build a page", workdir: "", contextFiles: [] });
    expect(res.status).toBe(201);
  });

  it("pins every role to the demo LLM and forces auto-approve", async () => {
    const res = await call(makeGate(), "POST", "/api/tasks", {
      prompt: "build a page",
      model: "anthropic/claude-opus",
      modelOverrides: { planning: "custom:real-conn:gpt-4o", review: "local-cli" },
      autoApprovePlan: false,
    });
    expect(res.status).toBe(201);
    expect(seen[0].body).toMatchObject({
      prompt: "build a page",
      model: DEMO_MODEL,
      modelOverrides: { planning: DEMO_MODEL, implementation: DEMO_MODEL, review: DEMO_MODEL },
      autoApprovePlan: true,
    });
    // Body was rewritten, so the stale length must not be forwarded.
    expect(seen[0].headers.get("content-length")).toBeNull();
  });

  it("caps prompt size", async () => {
    const res = await call(makeGate(), "POST", "/api/tasks", { prompt: "x".repeat(baseLimits.maxPromptChars + 1) });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("rejects a non-object body", async () => {
    expect((await call(makeGate(), "POST", "/api/tasks", "not json")).status).toBe(400);
    expect((await call(makeGate(), "POST", "/api/tasks", [1, 2])).status).toBe(400);
  });

  it("caps re-prompt and feedback text", async () => {
    const long = "x".repeat(baseLimits.maxPromptChars + 1);
    expect((await call(makeGate(), "POST", "/api/tasks/t1/re-prompt", { prompt: long })).status).toBe(400);
    expect((await call(makeGate(), "POST", "/api/tasks/t1/feedback", { feedback: long })).status).toBe(400);
    expect((await call(makeGate(), "POST", "/api/tasks/t1/adjust-plan", { adjustments: long })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("public demo gate — batch creation", () => {
  const ok = { promptTemplate: "Build a page for {{item}}", items: ["Acme", "Nimbus"] };

  it("refuses a workdir", async () => {
    const res = await call(makeGate(), "POST", "/api/batches", { ...ok, workdir: "D:/projects" });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("caps item count, item size and template size", async () => {
    const gate = makeGate();
    const tooMany = Array.from({ length: baseLimits.maxItems + 1 }, (_, i) => `item ${i}`);
    expect((await call(gate, "POST", "/api/batches", { ...ok, items: tooMany })).status).toBe(400);
    expect((await call(gate, "POST", "/api/batches", { ...ok, items: ["x".repeat(baseLimits.maxItemChars + 1)] })).status).toBe(400);
    expect(
      (await call(gate, "POST", "/api/batches", { ...ok, promptTemplate: "{{item}}" + "x".repeat(baseLimits.maxPromptChars) })).status
    ).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("pins models and clamps maxAttempts", async () => {
    const res = await call(makeGate(), "POST", "/api/batches", { ...ok, maxAttempts: 5, model: "gpt-4o" });
    expect(res.status).toBe(201);
    expect(seen[0].body).toMatchObject({
      ...ok,
      maxAttempts: baseLimits.maxAttempts,
      model: DEMO_MODEL,
      modelOverrides: { planning: DEMO_MODEL, implementation: DEMO_MODEL, review: DEMO_MODEL },
    });
  });
});

describe("public demo gate — run budget and storage cap", () => {
  const batch = (n: number) => ({ promptTemplate: "{{item}}", items: Array.from({ length: n }, (_, i) => `i${i}`) });

  it("enforces the instance-wide hourly loop budget and frees it after an hour", async () => {
    const gate = makeGate({}, { loopsPerHour: 6, loopsPerClientPerHour: 100 });
    expect((await call(gate, "POST", "/api/batches", batch(4))).status).toBe(201);
    const blocked = await call(gate, "POST", "/api/batches", batch(3), { "x-forwarded-for": "203.0.113.9" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call(gate, "POST", "/api/tasks", { prompt: "one more" })).status).toBe(201); // 5
    expect((await call(gate, "POST", "/api/tasks/t1/reset")).status).toBe(201); // 6
    expect((await call(gate, "POST", "/api/tasks/t1/resume")).status).toBe(429);
    clock += 60 * 60 * 1000 + 1;
    expect((await call(gate, "POST", "/api/batches", batch(5))).status).toBe(201);
  });

  it("enforces a per-client budget keyed on X-Forwarded-For", async () => {
    const gate = makeGate({}, { loopsPerHour: 100, loopsPerClientPerHour: 2 });
    const a = { "x-forwarded-for": "198.51.100.1, 10.0.0.1" };
    const b = { "x-forwarded-for": "198.51.100.2" };
    expect((await call(gate, "POST", "/api/batches", batch(2), a)).status).toBe(201);
    expect((await call(gate, "POST", "/api/tasks", { prompt: "again" }, a)).status).toBe(429);
    expect((await call(gate, "POST", "/api/tasks", { prompt: "other visitor" }, b)).status).toBe(201);
  });

  it("only charges the budget for runs that actually started", async () => {
    const gate = makeGate({}, { loopsPerHour: 1 });
    downstreamStatus = 409; // e.g. another batch is running
    expect((await call(gate, "POST", "/api/tasks", { prompt: "busy" })).status).toBe(409);
    downstreamStatus = 201;
    expect((await call(gate, "POST", "/api/tasks", { prompt: "now" })).status).toBe(201);
    expect((await call(gate, "POST", "/api/tasks", { prompt: "over" })).status).toBe(429);
  });

  it("charges a batch resume for the items it will re-run", async () => {
    const gate = makeGate({}, { loopsPerHour: 3 });
    expect((await call(gate, "POST", "/api/batches/known/resume")).status).toBe(201); // 2
    expect((await call(gate, "POST", "/api/batches/known/resume")).status).toBe(429); // 2 more > 3
  });

  it("refuses new runs once the stored-task cap is reached", async () => {
    taskCount = baseLimits.maxTasks - 1;
    const gate = makeGate();
    expect((await call(gate, "POST", "/api/batches", batch(2))).status).toBe(503);
    expect((await call(gate, "POST", "/api/tasks", { prompt: "fits" })).status).toBe(201);
  });
});
