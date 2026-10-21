import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PublicDemoBanner } from "./PublicDemoBanner.js";

function stubFetch(ok: boolean, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status: ok ? 200 : 404, json: async () => body }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PublicDemoBanner", () => {
  it("explains the demo when the backend reports public demo mode", async () => {
    stubFetch(true, { publicDemo: true, limits: { maxItems: 5 }, hint: "Items containing FAIL-ME are rejected." });
    render(<PublicDemoBanner />);
    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("Public demo");
    expect(banner.textContent).toContain("up to 5 items");
    expect(banner.textContent).toContain("FAIL-ME");
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("static preview: says plainly it is not the full project, can't be dismissed, offers replay", async () => {
    stubFetch(true, {
      publicDemo: true,
      staticPreview: true,
      repoUrl: "https://github.com/anshmajumdar121/loopgate",
      batch: { items: ["Acme Coffee", "FAIL-ME Corp"] },
    });
    render(<PublicDemoBanner />);
    const banner = await screen.findByRole("status", { name: /demo preview notice/i });
    expect(banner.textContent).toContain("Demo preview only — this is not the full project.");
    expect(banner.textContent).toContain("nothing you type is executed");
    expect(banner.textContent).toContain("Acme Coffee, FAIL-ME Corp");
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
    expect(screen.getByRole("link", { name: /full project/i }).getAttribute("href")).toBe(
      "https://github.com/anshmajumdar121/loopgate"
    );
    fireEvent.click(screen.getByRole("button", { name: /replay run/i }));
    expect(fetch).toHaveBeenCalledWith("/api/__static/replay", { method: "POST" });
  });

  it("renders nothing against a normal backend", async () => {
    stubFetch(false, { error: "not found" });
    const { container } = render(<PublicDemoBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/demo"));
    expect(container.innerHTML).toBe("");
  });
});
