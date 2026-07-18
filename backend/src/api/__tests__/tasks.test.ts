import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { tasksApi } from "../tasks.js";
import { loadConnectionsFromDisk } from "../../store/connections.js";
import { loadTasksFromDisk } from "../../store/tasks.js";

describe("task creation — mavis-cli connections", () => {
  beforeEach(() => {
    // Task creation fires `runLoop()` in the background on success (201),
    // which would call the REAL minimax CLI via spawnMavisBridge since no
    // LOOP_MAVIS_BIN override is set. Point it at a binary that always
    // fails fast (`false`) so this test can never reach the user's actual
    // Mavis daemon, regardless of what the orchestrator does after the
    // HTTP response this test asserts on.
    process.env.LOOP_MAVIS_BIN = "/usr/bin/false";
    loadTasksFromDisk([]);
    loadConnectionsFromDisk([
      {
        id: "mavistest1",
        name: "my-mavis",
        providerType: "mavis-cli",
        baseUrl: "http://localhost/mavis-cli",
        model: "mavis",
        hasApiKey: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
  });

  afterEach(() => {
    delete process.env.LOOP_MAVIS_BIN;
  });

  it("does not require an API key when every role uses a mavis-cli connection", async () => {
    const app = new Hono().route("/", tasksApi);
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Fix the bug in sum.js",
        modelOverrides: {
          planning: "custom:mavistest1:mavis",
          implementation: "custom:mavistest1:mavis",
          review: "custom:mavistest1:mavis",
        },
      }),
    });
    // 201 (created) proves the preflight check let it through. If the check
    // still requires an apiKey for mavis-cli, this would be 400.
    expect(res.status).toBe(201);
  });
});
