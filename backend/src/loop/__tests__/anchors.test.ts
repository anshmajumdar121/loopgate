// Tests for the deterministic top-K anchor retrieval used by the
// short-form script optimization loop. Covers: top-K sort by save_rate,
// post_id tie-break, empty/malformed dataset graceful handling, the
// markdown block shape, and round-trip through a temp file. No LLM, no
// real dataset — hermetic.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retrieveAnchors, formatAnchorsBlock } from "../anchors.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "loop-anchors-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function writeDataset(rows: unknown[]): Promise<string> {
  const path = join(workdir, "posts.json");
  await writeFile(path, JSON.stringify(rows), "utf8");
  return path;
}

describe("retrieveAnchors", () => {
  it("sorts by save_rate DESC and takes the top K", async () => {
    const path = await writeDataset([
      { post_id: "a", script: "low", save_rate: 0.1, niche: "x" },
      { post_id: "b", script: "high", save_rate: 0.9, niche: "x" },
      { post_id: "c", script: "mid", save_rate: 0.5, niche: "x" },
    ]);
    const anchors = await retrieveAnchors(path, 2);
    expect(anchors.map((a) => a.post_id)).toEqual(["b", "c"]);
    expect(anchors[0].save_rate).toBe(0.9);
    expect(anchors[0].script).toBe("high");
  });

  it("breaks ties by post_id ASC for determinism", async () => {
    const path = await writeDataset([
      { post_id: "z", script: "a", save_rate: 0.5, niche: "x" },
      { post_id: "a", script: "b", save_rate: 0.5, niche: "x" },
      { post_id: "m", script: "c", save_rate: 0.5, niche: "x" },
    ]);
    const anchors = await retrieveAnchors(path, 3);
    expect(anchors.map((a) => a.post_id)).toEqual(["a", "m", "z"]);
  });

  it("defaults K to 5 when not specified", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      post_id: `p${i}`,
      script: `s${i}`,
      save_rate: 1 - i * 0.1,
      niche: "x",
    }));
    const path = await writeDataset(rows);
    const anchors = await retrieveAnchors(path);
    expect(anchors).toHaveLength(5);
    expect(anchors[0].post_id).toBe("p0");
  });

  it("skips rows missing script or save_rate", async () => {
    const path = await writeDataset([
      { post_id: "ok", script: "valid", save_rate: 0.7, niche: "x" },
      { post_id: "no-script", save_rate: 0.9, niche: "x" }, // missing script
      { post_id: "no-rate", script: "x", niche: "x" }, // missing save_rate
      { post_id: "broken", script: 42, save_rate: "not-a-number", niche: "x" },
    ]);
    const anchors = await retrieveAnchors(path, 10);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].post_id).toBe("ok");
  });

  it("preserves the original row in `raw` for downstream fields", async () => {
    const path = await writeDataset([
      {
        post_id: "p1",
        script: "x",
        save_rate: 0.5,
        niche: "fitness",
        saves: 1234, // extra field the loop doesn't read but might surface later
      },
    ]);
    const anchors = await retrieveAnchors(path, 1);
    expect(anchors[0].raw).toMatchObject({ saves: 1234 });
  });

  it("throws a clear error on non-JSON input", async () => {
    const path = join(workdir, "bad.json");
    await writeFile(path, "not json", "utf8");
    await expect(retrieveAnchors(path)).rejects.toThrow(/not valid JSON/);
  });

  it("throws on a JSON object (not array)", async () => {
    const path = join(workdir, "obj.json");
    await writeFile(path, '{"foo": "bar"}', "utf8");
    await expect(retrieveAnchors(path)).rejects.toThrow(/must be a JSON array/);
  });

  it("returns an empty array when the dataset is empty", async () => {
    const path = await writeDataset([]);
    const anchors = await retrieveAnchors(path, 5);
    expect(anchors).toEqual([]);
  });
});

describe("formatAnchorsBlock", () => {
  it("renders each anchor with ordinal, save_rate, niche, and a fenced script", () => {
    const block = formatAnchorsBlock([
      {
        post_id: "p1",
        script: "line one\nline two",
        save_rate: 0.42,
        niche: "fitness",
        raw: {},
      },
    ]);
    expect(block).toContain("Top 1 past posts");
    expect(block).toContain("### Anchor #1 — p1");
    expect(block).toContain("save_rate: 0.42");
    expect(block).toContain("niche: fitness");
    expect(block).toContain("```");
    expect(block).toContain("line one");
    expect(block).toContain("line two");
  });

  it("renders a graceful placeholder for an empty set", () => {
    const block = formatAnchorsBlock([]);
    expect(block).toContain("no anchors available");
  });
});
