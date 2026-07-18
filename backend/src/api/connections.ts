// REST endpoints for Connections. A Connection is a user-configured external
// API endpoint whose models are exposed in the model picker.
//
// Security: the apiKey is part of every internal Connection record (the
// backend owns it) but is NEVER returned over the wire. The list/show
// endpoints strip it to `hasApiKey: boolean`. Create/Update responses also
// strip it — the client never needs to see the key again after it's set.
//
// Why we keep apiKey in the body of POST/PATCH even though clients can't
// read it back: the creator (or editor) of the connection obviously supplied
// the key themselves. There's no need to hide it during the same request
// lifecycle where they just typed it in. Wire stripping applies to
// READ-side responses.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  createConnection,
  deleteConnection,
  getConnectionSummary,
  listConnectionSummaries,
  updateConnection,
} from "../store/connections.js";
import { onConnectionDeleted } from "./connectionMeta.js";
import { checkConnectionHealth } from "../loop/connection-health.js";

export const connectionsApi = new Hono();

const modelSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().max(120).optional(),
  contextWindow: z.number().int().positive().optional(),
});

const connectionSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  providerId: z
    .enum(["openrouter", "openai", "anthropic", "google", "ollama", "local-cli", "custom"])
    .optional(),
  providerType: z.enum(["openai-compatible", "anthropic-compatible", "local-cli"]),
  baseUrl: z
    .string()
    .url("must be a full URL like https://api.example.com/v1")
    .max(500),
  apiKey: z.string().max(2000).optional(),
  // New single-model shape (preferred):
  model: z.string().max(200).optional(),
  modelLabel: z.string().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  // Role dedication: which agent role(s) this connection serves. Empty
  // array or omitted means "general use" (no dedicated badge).
  roles: z
    .array(z.enum(["planning", "implementation", "review"]))
    .max(3)
    .optional(),
  // Legacy multi-model shape (back-compat for older clients):
  models: z.array(modelSchema).max(100).optional(),
});

// Always strip apiKey from a connection-like object before returning.
function summarise<T extends { apiKey?: string }>(c: T) {
  const { apiKey: _omit, ...rest } = c;
  return { ...rest, hasApiKey: Boolean(_omit) };
}

connectionsApi.get("/connections", (c) => {
  return c.json({ connections: listConnectionSummaries() });
});

connectionsApi.get("/connections/:id", (c) => {
  const id = c.req.param("id");
  const conn = getConnectionSummary(id);
  if (!conn) return c.json({ error: "connection not found" }, 404);
  return c.json({ connection: conn });
});

connectionsApi.post(
  "/connections",
  zValidator("json", connectionSchema),
  (c) => {
    const body = c.req.valid("json") as Parameters<typeof createConnection>[0];
    const created = createConnection(body);
    // Auto-verify: test the brand-new connection in the background so the
    // health dot is populated without any click (Part D1).
    void checkConnectionHealth(created.id);
    return c.json({ connection: summarise(created) }, 201);
  }
);

connectionsApi.patch(
  "/connections/:id",
  zValidator("json", connectionSchema),
  (c) => {
    const id = c.req.param("id");
    const existing = getConnectionSummary(id);
    if (!existing) return c.json({ error: "connection not found" }, 404);
    const body = c.req.valid("json") as Parameters<typeof updateConnection>[1];
    const updated = updateConnection(id, body);
    if (!updated) return c.json({ error: "connection not found" }, 404);
    // Auto-verify: the key/URL may have changed — re-test in the background
    // so the stored health never describes the previous credentials.
    void checkConnectionHealth(id);
    return c.json({ connection: summarise(updated) });
  }
);

connectionsApi.delete("/connections/:id", (c) => {
  const id = c.req.param("id");
  const ok = deleteConnection(id);
  if (!ok) return c.json({ error: "connection not found" }, 404);
  // Drop persisted token-usage rows tied to this connection so the UI
  // doesn't show stale entries for a deleted provider.
  onConnectionDeleted(id);
  return c.json({ ok: true });
});
