// Wires the static preview into the page: window.fetch for /api/* and
// window.WebSocket are served by the recorded run (player.ts). Loaded only by
// the GitHub Pages build (VITE_STATIC_DEMO=1) — see main.tsx.
import recordingJson from "./recording.json";
import { createDemoSocketClass, StaticBackend, type Recording } from "./player";

/** Delay before the recorded run starts playing on page load. */
const AUTOSTART_MS = 1_500;

export function installStaticDemo(): StaticBackend {
  const backend = new StaticBackend(recordingJson as unknown as Recording);
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    const isApi = url.pathname.startsWith("/api/") || url.pathname === "/health";
    if (url.origin !== window.location.origin || !isApi) return realFetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    await new Promise((r) => setTimeout(r, 30)); // feel like a network call
    return backend.handle(method, url.pathname);
  };

  window.WebSocket = createDemoSocketClass(backend) as unknown as typeof WebSocket;
  window.setInterval(() => backend.tick(), 100);
  window.setTimeout(() => backend.start(), AUTOSTART_MS);
  document.title = "Loopgate — demo preview (not the full project)";
  return backend;
}
