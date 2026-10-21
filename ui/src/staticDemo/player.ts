// Static GitHub Pages preview: stands in for the backend by replaying a
// recording of a REAL Loopgate run (backend/scripts/demo/record-static-demo.mjs).
// It answers the UI's /api/* requests from REST snapshots taken during the
// run and feeds the recorded WebSocket broadcasts to a fake socket, on the
// original timeline. The app code is unchanged; only the Pages build
// (VITE_STATIC_DEMO=1) installs this — see install.ts.

export interface RecordedEvent {
  t: number;
  /** Set for task-scoped broadcasts; absent for broadcast-to-all. */
  taskId?: string;
  msg: { type: string } & Record<string, unknown>;
}

export interface RecordedSnapshot {
  t: number;
  path: string;
  status: number;
  body?: unknown;
  text?: string;
}

export interface Recording {
  version: number;
  recordedAt: string;
  durationMs: number;
  batch: { title: string; promptTemplate: string; items: string[] };
  events: RecordedEvent[];
  snapshots: RecordedSnapshot[];
  statics: Record<string, { status: number; body?: unknown; text?: string }>;
}

export const REPO_URL = "https://github.com/anshmajumdar121/loopgate";
export const PREVIEW_NOTICE =
  "This is a static demo preview that replays a recorded run — nothing you type is executed. " +
  `Run the full project from ${REPO_URL} to use Loopgate for real.`;
/** Idle stretches in the recording longer than this are shortened on playback. */
export const MAX_GAP_MS = 2_000;
/** Pause after the last event before the run counts as finished. */
const TAIL_MS = 800;

const TASK_DETAIL = /^\/api\/tasks\/([^/]+)$/;
const BATCH_DETAIL = /^\/api\/batches\/([^/]+)$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Re-time a recording so no gap between consecutive moments exceeds MAX_GAP_MS. */
function compress(rec: Recording): { events: RecordedEvent[]; snapshots: RecordedSnapshot[]; duration: number } {
  const times = [...new Set([...rec.events.map((e) => e.t), ...rec.snapshots.map((s) => s.t)])]
    .filter((t) => t >= 0)
    .sort((a, b) => a - b);
  const map = new Map<number, number>();
  let prev = 0;
  let acc = 0;
  for (const t of times) {
    acc += Math.min(t - prev, MAX_GAP_MS);
    map.set(t, acc);
    prev = t;
  }
  const at = (t: number) => map.get(t) ?? 0;
  return {
    events: rec.events.filter((e) => e.t >= 0).map((e) => ({ ...e, t: at(e.t) })).sort((a, b) => a.t - b.t),
    snapshots: rec.snapshots.map((s) => ({ ...s, t: at(Math.max(0, s.t)) })).sort((a, b) => a.t - b.t),
    duration: acc + TAIL_MS,
  };
}

/** Minimal WebSocket look-alike the UI's useLoopSocket can drive. */
export interface DemoSocketLike {
  readyState: number;
  taskId: string | null;
  deliver(msg: unknown): void;
}

export class StaticBackend {
  readonly events: RecordedEvent[];
  readonly snapshots: RecordedSnapshot[];
  readonly duration: number;
  readonly sockets = new Set<DemoSocketLike>();
  private startedAt: number | null = null;
  private cursor = 0;

  constructor(
    readonly recording: Recording,
    private readonly now: () => number = () => Date.now()
  ) {
    const c = compress(recording);
    this.events = c.events;
    this.snapshots = c.snapshots;
    this.duration = c.duration;
  }

  /** (Re)start playback from the beginning. */
  start(): void {
    this.startedAt = this.now();
    this.cursor = 0;
  }

  /** Playback position in ms; 0 before the first start, frozen at the end. */
  position(): number {
    if (this.startedAt === null) return 0;
    return Math.min(this.now() - this.startedAt, this.duration);
  }

  isPlaying(): boolean {
    return this.startedAt !== null && this.now() - this.startedAt < this.duration;
  }

  /** Deliver every recorded broadcast that is due, honouring subscriptions. */
  tick(): void {
    if (this.startedAt === null) return;
    const pos = this.position();
    while (this.cursor < this.events.length && this.events[this.cursor].t <= pos) {
      const e = this.events[this.cursor++];
      for (const s of this.sockets) {
        if (!e.taskId || s.taskId === e.taskId) s.deliver(e.msg);
      }
    }
  }

  private latest(path: string): RecordedSnapshot | undefined {
    const pos = this.position();
    let found: RecordedSnapshot | undefined;
    for (const s of this.snapshots) {
      if (s.t > pos) break;
      if (s.path === path) found = s;
    }
    return found;
  }

  info() {
    return {
      publicDemo: true,
      staticPreview: true,
      repoUrl: REPO_URL,
      recordedAt: this.recording.recordedAt,
      batch: this.recording.batch,
      playing: this.isPlaying(),
      hint: PREVIEW_NOTICE,
    };
  }

  /** Answer one API request the way the real backend would have at this moment. */
  handle(method: string, path: string): Response {
    const m = method.toUpperCase();
    const read = m === "GET" || m === "HEAD";

    if (read && path === "/api/demo") return json(200, this.info());
    if (read && (path === "/health" || path === "/api/health")) return json(200, { status: "ok", staticPreview: true });
    if (m === "POST" && path === "/api/__static/replay") {
      this.start();
      return json(200, { ok: true });
    }
    if (m === "POST" && path === "/api/batches") {
      // Whatever the visitor typed, the preview can only replay its recording.
      if (this.isPlaying()) return json(409, { error: "The recorded batch is already playing — watch the canvas." });
      this.start();
      const first = this.snapshots.find(
        (s) => s.path === "/api/batches" && ((s.body as { batches?: unknown[] })?.batches?.length ?? 0) > 0
      );
      const batch = (first?.body as { batches: unknown[] } | undefined)?.batches[0];
      return json(201, { batch, staticPreview: true });
    }
    if (!read) return json(403, { error: PREVIEW_NOTICE, staticPreview: true });

    const fixed = this.recording.statics[path];
    if (fixed) {
      return fixed.text !== undefined
        ? new Response(fixed.text, { status: fixed.status, headers: { "content-type": "text/markdown; charset=utf-8" } })
        : json(fixed.status, fixed.body);
    }

    const snap = this.latest(path);
    if (snap) return json(snap.status, snap.body);

    const batchId = path.match(BATCH_DETAIL)?.[1];
    if (batchId) {
      const list = (this.latest("/api/batches")?.body as { batches?: Array<{ id: string }> } | undefined)?.batches ?? [];
      const batch = list.find((b) => b.id === batchId);
      return batch ? json(200, { batch }) : json(404, { error: "batch not found" });
    }
    if (TASK_DETAIL.test(path)) return json(404, { error: "task not found" });
    if (path === "/api/tasks") return json(200, { tasks: [] });
    if (path === "/api/batches") return json(200, { batches: [] });
    if (path === "/api/tasks/active") return json(200, { task: null });
    if (path === "/api/projects") return json(200, { projects: [] });
    if (path === "/api/sessions") return json(200, { sessions: [] });
    return json(404, { error: "not found in the static preview" });
  }
}

/** A WebSocket class bound to `backend`, assignable to window.WebSocket. */
export function createDemoSocketClass(backend: StaticBackend) {
  return class DemoSocket extends EventTarget implements DemoSocketLike {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readyState = 0;
    taskId: string | null = null;
    readonly url: string;
    readonly protocol = "";
    readonly extensions = "";
    readonly bufferedAmount = 0;
    binaryType: BinaryType = "blob";
    onopen: ((ev: Event) => unknown) | null = null;
    onmessage: ((ev: MessageEvent) => unknown) | null = null;
    onclose: ((ev: CloseEvent) => unknown) | null = null;
    onerror: ((ev: Event) => unknown) | null = null;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      backend.sockets.add(this);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        const ev = new Event("open");
        this.onopen?.(ev);
        this.dispatchEvent(ev);
        this.deliver({ type: "pong" });
      }, 20);
    }

    send(data: string): void {
      if (this.readyState !== 1) return;
      let msg: { type?: string; taskId?: string };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "subscribe" && typeof msg.taskId === "string") this.taskId = msg.taskId;
      else if (msg.type === "unsubscribe") this.taskId = null;
      else if (msg.type === "ping") this.deliver({ type: "pong" });
    }

    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      backend.sockets.delete(this);
      const ev = new CloseEvent("close", { code: 1000, wasClean: true });
      this.onclose?.(ev);
      this.dispatchEvent(ev);
    }

    deliver(msg: unknown): void {
      if (this.readyState !== 1) return;
      const ev = new MessageEvent("message", { data: JSON.stringify(msg) });
      this.onmessage?.(ev);
      this.dispatchEvent(ev);
    }
  };
}
