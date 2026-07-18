import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { connectionsApi } from "../connections.js";
import { loadConnectionsFromDisk } from "../../store/connections.js";

describe("connections API — mavis-cli provider type", () => {
  beforeEach(() => {
    loadConnectionsFromDisk([]);
  });

  it("accepts providerType: mavis-cli on create", async () => {
    const app = new Hono().route("/", connectionsApi);
    const res = await app.request("/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "my-mavis",
        providerType: "mavis-cli",
        baseUrl: "http://localhost/mavis-cli",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { connection: { providerType: string } };
    expect(body.connection.providerType).toBe("mavis-cli");
  });
});
