// Public demo mode below the HTTP layer: env preparation, the spawner's
// last-line check, store-level enforcement, the disabled build / preview /
// runtime-check steps and the locked fake LLM. Stores persist to a temp dir
// set BEFORE the dynamic imports so backend/data is never touched.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Connection } from "../../types.js";

const SBX = mkdtempSync(join(tmpdir(), "loop-public-demo-test-"));
process.env.LOOP_DATA_DIR = join(SBX, "data", "tasks");
process.env.LOOP_WORKSPACES_ROOT = join(SBX, "workspaces");

const demo = await import("../publicDemo.js");
const { createTask, TASK_WORKSPACES_ROOT } = await import("../../store/tasks.js");
const { createConnection, deleteConnection, installPublicDemoConnection, listConnections } = await import(
  "../../store/connections.js"
);
const { spawnAgent } = await import("../../loop/agent-spawner.js");
const { runBuildStep } = await import("../../loop/build-runner.js");
const { runRuntimeCheck } = await import("../../loop/runtime-check.js");
const { registerPreview } = await import("../../loop/preview-server.js");

const DEMO_URL = "http://127.0.0.1:45999/v1";
const noop = () => {};

function conn(over: Partial<Connection> = {}): Connection {
  return { ...demo.demoConnection(DEMO_URL), ...over };
}

afterEach(() => {
  vi.unstubAllEnvs();
  demo.__setDemoLlmUrlForTests(null);
});

describe("preparePublicDemoEnv", () => {
  it("scrubs keys / CLI switches, forces the bridge and confines data to a temp dir", () => {
    const env: NodeJS.ProcessEnv = {
      LOOP_PUBLIC_DEMO: "1",
      LOOP_LLM_API_KEY: "sk-real",
      LOOP_LOCAL_CLI: "1",
      LOOP_MAVIS_CLI: "1",
      LOOP_ALLOW_MOCK: "1",
      LOOP_USE_LLM_BRIDGE: "0",
      LOOP_WORKDIR: "C:/Users/someone",
      LOOP_LLM_AGENT_SCRIPT: "/tmp/evil.mjs",
    };
    const r = demo.preparePublicDemoEnv(env);
    expect(r.scrubbed.sort()).toEqual(
      ["LOOP_ALLOW_MOCK", "LOOP_LLM_AGENT_SCRIPT", "LOOP_LLM_API_KEY", "LOOP_LOCAL_CLI", "LOOP_MAVIS_CLI", "LOOP_WORKDIR"].sort()
    );
    for (const k of demo.PUBLIC_DEMO_SCRUBBED_ENV) expect(env[k]).toBeUndefined();
    expect(env.LOOP_USE_LLM_BRIDGE).toBe("1");
    expect(demo.isWithinDir(tmpdir(), env.LOOP_DATA_DIR!)).toBe(true);
    expect(demo.isWithinDir(tmpdir(), env.LOOP_WORKSPACES_ROOT!)).toBe(true);
    expect(env.LOOP_MAX_BODY_BYTES).toBe(String(64 * 1024));
  });

  it("keeps data dirs the operator set explicitly", () => {
    const env: NodeJS.ProcessEnv = { LOOP_DATA_DIR: "/srv/demo/tasks", LOOP_WORKSPACES_ROOT: "/srv/demo/ws" };
    demo.preparePublicDemoEnv(env);
    expect(env.LOOP_DATA_DIR).toBe("/srv/demo/tasks");
    expect(env.LOOP_WORKSPACES_ROOT).toBe("/srv/demo/ws");
  });

  it("parses limits with defaults and clamps", () => {
    expect(demo.publicDemoLimits({}).maxItems).toBe(5);
    expect(demo.publicDemoLimits({ LOOP_DEMO_MAX_ITEMS: "9999" }).maxItems).toBe(50);
    expect(demo.publicDemoLimits({ LOOP_DEMO_MAX_ITEMS: "abc" }).maxItems).toBe(5);
    expect(demo.publicDemoLimits({ LOOP_DEMO_MAX_ATTEMPTS: "0" }).maxAttempts).toBe(1);
  });

  it("picks up the hostnames free hosts inject", () => {
    expect(
      demo.platformHostnames({ RENDER_EXTERNAL_HOSTNAME: "loopgate.onrender.com", FLY_APP_NAME: "loopgate", RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" })
    ).toEqual(["loopgate.onrender.com", "x.up.railway.app", "loopgate.fly.dev"]);
  });
});

describe("demo connection + spawn check", () => {
  it("refuses a non-loopback demo LLM", () => {
    expect(() => demo.demoConnection("https://api.openai.com/v1")).toThrow(/loopback/);
  });

  it("accepts only the in-process fake LLM", () => {
    demo.__setDemoLlmUrlForTests(DEMO_URL);
    expect(() => demo.assertPublicDemoSpawn(conn())).not.toThrow();
    expect(() => demo.assertPublicDemoSpawn(null)).toThrow(/no connection/);
    expect(() => demo.assertPublicDemoSpawn(conn({ id: "real" }))).toThrow(/not the demo LLM/);
    expect(() => demo.assertPublicDemoSpawn(conn({ providerType: "local-cli" }))).toThrow(/provider/);
    expect(() => demo.assertPublicDemoSpawn(conn({ providerType: "mavis-cli" }))).toThrow(/provider/);
    expect(() => demo.assertPublicDemoSpawn(conn({ providerType: "anthropic-compatible" }))).toThrow(/provider/);
    expect(() => demo.assertPublicDemoSpawn(conn({ baseUrl: "https://api.openai.com/v1" }))).toThrow(/endpoint/);
    vi.stubEnv("LOOP_LOCAL_CLI", "1");
    expect(() => demo.assertPublicDemoSpawn(conn())).toThrow(/local CLI/);
  });

  it("is wired into spawnAgent: nothing but the demo LLM can start", () => {
    vi.stubEnv("LOOP_PUBLIC_DEMO", "1");
    demo.__setDemoLlmUrlForTests(DEMO_URL);
    const real = conn({ id: "my-openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-real" });
    expect(() => spawnAgent("planner", "t-demo", SBX, "plan", noop, noop, noop, { connection: real })).toThrow(/public demo/);
    expect(() => spawnAgent("maker", "t-demo", SBX, "make", noop, noop, noop, {})).toThrow(/public demo/);
  });
});

describe("store-level enforcement", () => {
  it("connections are read-only and the demo LLM replaces stored ones", () => {
    vi.stubEnv("LOOP_PUBLIC_DEMO", "1");
    expect(() =>
      createConnection({ name: "x", providerType: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "k" })
    ).toThrow(/read-only/);
    expect(() => deleteConnection("anything")).toThrow(/read-only/);
    installPublicDemoConnection(conn());
    expect(listConnections().map((c) => c.id)).toEqual([demo.DEMO_CONNECTION_ID]);
  });

  it("tasks are pinned to the demo LLM, autonomous, and sandboxed", () => {
    vi.stubEnv("LOOP_PUBLIC_DEMO", "1");
    const t = createTask({
      prompt: "build a page",
      model: "gpt-4o",
      modelOverrides: { planning: "custom:real:gpt-4o" },
      projectId: "p1",
      sessionId: "s1",
      contextFiles: ["/etc/passwd"],
      autoApprovePlan: false,
    });
    expect(t.model).toBe(demo.DEMO_MODEL);
    expect(t.modelOverrides).toEqual({ planning: demo.DEMO_MODEL, implementation: demo.DEMO_MODEL, review: demo.DEMO_MODEL });
    expect(t.autoApprovePlan).toBe(true);
    expect(t.autoIterate).toBe(true);
    expect(t.contextFiles).toBeUndefined();
    expect(t.projectId).toBeUndefined();
    expect(demo.isWithinDir(TASK_WORKSPACES_ROOT, t.workdir)).toBe(true);
  });

  it("refuses a task workdir outside the demo workspace root", () => {
    vi.stubEnv("LOOP_PUBLIC_DEMO", "1");
    expect(() => createTask({ prompt: "escape", workdir: resolve(SBX, "..") })).toThrow(/outside/);
    expect(() => createTask({ prompt: "escape", workdir: join(TASK_WORKSPACES_ROOT, "..", "x") })).toThrow(/outside/);
    expect(() => createTask({ prompt: "inside", workdir: join(TASK_WORKSPACES_ROOT, "batches", "b1", "item-001") })).not.toThrow();
  });
});

describe("disabled steps", () => {
  it("never runs npm install/build/test, previews or the headless browser", async () => {
    vi.stubEnv("LOOP_PUBLIC_DEMO", "1");
    const wd = mkdtempSync(join(SBX, "wd-"));
    writeFileSync(join(wd, "package.json"), JSON.stringify({ scripts: { build: "echo pwned" } }));
    expect(await runBuildStep(wd)).toBeUndefined();
    await expect(registerPreview("t1", wd)).rejects.toThrow(/disabled in the public demo/);
    await expect(runRuntimeCheck("http://127.0.0.1:1/", wd, 1)).rejects.toThrow(/disabled in the public demo/);
  });
});

describe("fake LLM hardening", () => {
  const fakeLlmUrl = pathToFileURL(
    resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "scripts", "demo", "fake-llm.mjs")
  ).href;

  it("locks mode switching and escapes task text in generated pages", async () => {
    const { startFakeLlm } = await import(fakeLlmUrl);
    const llm = await startFakeLlm({ port: 0, delayMs: 0, lockMode: true });
    try {
      expect(llm.url).not.toContain(":0/");
      const base = llm.url.replace(/\/v1$/, "");
      expect((await fetch(`${base}/__mode/denylist`)).status).toBe(403);
      const res = await fetch(`${llm.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fake-model",
          messages: [
            { role: "system", content: "You are the maker. emit one fenced code block PER FILE." },
            { role: "user", content: "Task: <script>alert(1)</script> ``` `x`" },
          ],
        }),
      });
      const out = (await res.json()).choices[0].message.content as string;
      expect(out).toContain("```file:index.html");
      expect(out).not.toContain("<script>");
      expect(out).toContain("&#60;script&#62;");
      // Still the happy path: no .env / package.json smuggled in.
      expect(out).not.toMatch(/file:(\.env|package\.json)/);
    } finally {
      llm.close();
    }
  });
});
