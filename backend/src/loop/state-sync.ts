// Watcher for GOAL.md and STATE.md in the task's workdir.
//
// Why we need this: agents communicate with the orchestrator by writing to
// those two markdown files (per the agent prompts). The orchestrator's
// `runLoop` spawns an agent, then awaits a write to know "the agent is done
// with this phase". Polling is wasteful and adds latency, so we use chokidar.
//
// Debouncing: agents sometimes write files in a few small chunks rather than
// one big write. We coalesce bursts inside a 300ms window so the orchestrator
// doesn't react to a half-written file.
//
// Two primitives the orchestrator uses:
//   - `awaitChange(filename, timeoutMs)` → promise resolves with the latest
//     file content after a real write event (or rejects on timeout)
//   - `getLatestContent(filename)` → synchronous snapshot of the last known
//     content (used to build the next agent's prompt without re-reading disk)
//
// `ignoreInitial: true` means the watcher won't fire when files already exist
// at start — only on real changes after the watcher is alive. This avoids a
// spurious "change" right after we start watching.

import chokidar from "chokidar";
import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

export type WatchedFile = "GOAL.md" | "STATE.md";

const WATCHED: readonly WatchedFile[] = ["GOAL.md", "STATE.md"] as const;
const DEBOUNCE_MS = 300;

export interface FileWatcher {
  /** Stop the watcher and release OS handles. Idempotent. */
  stop(): void;

  /** Register a callback for every (debounced) change. Returns an unsubscribe fn. */
  onChange(callback: (filePath: WatchedFile, content: string) => void): () => void;

  /**
   * Wait for the next change to `filename`. Resolves with the new content on
   * the first debounced change event. Rejects on timeout.
   *
   * Callers (the orchestrator) spawn an agent first, then await — so we
   * observe writes made by the live agent. Pre-existing content doesn't
   * trigger a resolution because the watcher is set up with
   * `ignoreInitial: true`.
   */
  awaitChange(filename: WatchedFile, timeoutMs: number): Promise<string>;

  /** Last known content of `filename`, or null if never observed. */
  getLatestContent(filename: WatchedFile): string | null;

  /**
   * Resolves once chokidar's initial directory scan has completed (its
   * 'ready' event). Resolves immediately if already ready. Not required for
   * correctness on the slow (real LLM) write path — a directory scan over 2
   * files finishes in single-digit ms, and every observed write in this
   * system lands 150s+ after the watcher starts. It guards the theoretical
   * edge case on a near-instant writer (e.g. the mock agent fallback) where
   * ignoreInitial could otherwise swallow a write that lands before the
   * initial scan finishes.
   */
  ready(): Promise<void>;

  /**
   * Monotonic per-file counter — increments on every successful file read by
   * the watcher. The orchestrator uses this to tell a NEW write apart from
   * pre-existing content. Snapshot this BEFORE awaiting, then compare to the
   * post-await value: if equal, no new write happened during the wait.
   */
  getGeneration(filename: WatchedFile): number;
}

interface ChangeEvent {
  filename: WatchedFile;
  content: string;
  resolve: (content: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Per-file monotonic counter. Increments on every successful file read by the
 * chokidar change handler. The orchestrator uses this to tell "new content was
 * written since I started waiting" apart from "the file already had content
 * from a previous phase, but nothing new happened during this phase".
 */
const generations = new Map<WatchedFile, number>();

/**
 * Create a watcher for GOAL.md and STATE.md in `workdir`. The watcher is
 * independent of any specific task — keep one per active loop run and call
 * `stop()` in a `finally` block.
 */
export function watchFiles(workdir: string): FileWatcher {
  const absoluteDir = pathResolve(workdir);
  const latest = new Map<WatchedFile, string>();
  const fileGenerations = new Map<WatchedFile, number>();

  // Pending awaitChange promises keyed by filename. `pending` accumulates new
  // events as awaiters register. When a raw change event arrives, scheduleFlush
  // moves the current `pending` list into `flushPending` (the snapshot) and
  // starts a 300ms debounce. When the debounce fires, flushFile resolves all
  // events in `flushPending`. Events added DURING the debounce wait for the
  // NEXT debounce — they aren't picked up by an in-flight one.
  //
  // Why this matters: if a previous phase's debounce is still pending when
  // the next phase calls awaitChange, the late fire would otherwise resolve
  // the new awaiter with stale content (from the previous phase's write).
  const pending = new Map<WatchedFile, ChangeEvent[]>();
  const flushPending = new Map<WatchedFile, ChangeEvent[]>();

  // Subscribe a long-lived listener set for change events.
  const subscribers = new Set<(file: WatchedFile, content: string) => void>();

  // Per-file debounce timers. When a raw change event arrives, we read the
  // file and store the content in `pending`; the timer fires after DEBOUNCE_MS
  // of quiet and resolves all awaiting promises for that file with the
  // latest content.
  const debounceTimers = new Map<WatchedFile, NodeJS.Timeout>();

  // chokidar FSWatcher. We watch the directory and filter events by basename
  // to avoid an entry per file (which is fine for 2 files but cleaner to use
  // the directory).
  const watcher = chokidar.watch(absoluteDir, {
    persistent: true,
    ignoreInitial: true,
    // Only fire once the file size has been stable for stabilityThreshold ms.
    // Without this, fs.writeFile's truncate-then-write can surface as a single
    // coalesced fsevents callback whose read catches the file at 0 bytes —
    // `latest` then caches "" with no follow-up event to correct it, and the
    // orchestrator parses an empty plan (the "Planner returned 0 steps,
    // 0 files" failure). Keep the threshold well below the orchestrator's
    // POST_EXIT_GRACE_MS so a write that lands just before agent exit is
    // still observed within the grace window.
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    depth: 0, // only direct children of workdir
  });

  let isReady = false;
  let readyResolvers: Array<() => void> = [];
  watcher.on("ready", () => {
    isReady = true;
    for (const resolve of readyResolvers) resolve();
    readyResolvers = [];
  });

  // Helpers
  const basename = (p: string): string => p.split(/[\\/]/).pop() ?? "";
  const isWatched = (name: string): name is WatchedFile =>
    (WATCHED as readonly string[]).includes(name);

  const flushFile = (filename: WatchedFile) => {
    // Resolve events that were snapshotted when the current debounce was
    // scheduled. Events added DURING the debounce wait are NOT in this list —
    // they wait for the next debounce. This prevents a stale flush from
    // resolving a fresh awaiter with content from a previous write.
    const toFlush = flushPending.get(filename) ?? [];
    flushPending.set(filename, []);
    if (toFlush.length === 0) return;
    const content = latest.get(filename) ?? "";
    for (const evt of toFlush) {
      evt.resolve(content);
    }
  };

  const scheduleFlush = (filename: WatchedFile) => {
    // If a debounce is already pending, clear it — we're about to schedule a
    // new one. The events that were in `flushPending` for the previous
    // debounce stay there (they'll be resolved by the new debounce's flush).
    // New events arriving after this point accumulate in `pending` and will
    // be picked up by the NEXT debounce.
    const existing = debounceTimers.get(filename);
    if (existing) clearTimeout(existing);
    // Move current pending events into the flush snapshot.
    const toFlush = pending.get(filename) ?? [];
    pending.set(filename, []);
    if (toFlush.length > 0) {
      // Merge with any existing flushPending for this file (from a debounce
      // that was already pending). Both groups resolve together.
      const existing2 = flushPending.get(filename) ?? [];
      flushPending.set(filename, [...existing2, ...toFlush]);
    }
    // Only schedule a flush if there's something to flush OR we want to
    // ensure an in-flight debounce gets reset to fire after this point. In
    // practice we always schedule since the change event triggered this.
    const t = setTimeout(() => {
      debounceTimers.delete(filename);
      flushFile(filename);
    }, DEBOUNCE_MS);
    debounceTimers.set(filename, t);
  };

  const onRawChange = async (rawPath: string) => {
    const name = basename(rawPath);
    if (!isWatched(name)) return;
    try {
      const fullPath = pathResolve(absoluteDir, name);
      const content = await readFile(fullPath, "utf8");
      latest.set(name, content);
      // Bump generation BEFORE notifying subscribers / scheduling the flush
      // so callers polling getGeneration() see the change as soon as the file
      // is on disk — without waiting for the 300ms debounce.
      const gen = fileGenerations.get(name) ?? 0;
      fileGenerations.set(name, gen + 1);
      // Notify subscribers synchronously (cheap; they just queue UI updates)
      for (const sub of subscribers) {
        try {
          sub(name, content);
        } catch {
          /* subscriber errors must not break the watcher */
        }
      }
      scheduleFlush(name);
    } catch (err) {
      process.stderr.write(
        `[watcher] onRawChange readErr name=${name} err=${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  };

  // Wire up chokidar events. We listen to 'add' (new file appearing) and
  // 'change' (existing file rewritten) — both should count as a change from
  // the orchestrator's perspective.
  watcher.on("add", (p) => {
    void onRawChange(p);
  });
  watcher.on("change", (p) => {
    void onRawChange(p);
  });
  watcher.on("error", () => {
    // chokidar can emit transient errors on macOS fsevents; ignore. A
    // persistent failure would manifest as the watcher not firing, which the
    // orchestrator's timeout will catch.
  });

  // Eagerly read both files at start so `getLatestContent` is primed even if
  // the watcher hasn't fired yet. Ignore ENOENT — files may be created later.
  const prime = async () => {
    for (const name of WATCHED) {
      try {
        const fullPath = pathResolve(absoluteDir, name);
        const content = await readFile(fullPath, "utf8");
        latest.set(name, content);
      } catch {
        /* file doesn't exist yet — that's fine */
      }
    }
  };
  void prime();

  return {
    stop() {
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      // Unblock any caller awaiting ready() that never got a 'ready' event
      // (e.g. stop() called immediately after construction).
      for (const resolve of readyResolvers) resolve();
      readyResolvers = [];
      // Reject any pending awaits so the orchestrator unblocks and exits.
      for (const [, queue] of pending) {
        for (const evt of queue) {
          evt.reject(new Error("watcher stopped"));
        }
      }
      for (const [, queue] of flushPending) {
        for (const evt of queue) {
          evt.reject(new Error("watcher stopped"));
        }
      }
      pending.clear();
      flushPending.clear();
      subscribers.clear();
      void watcher.close();
    },

    onChange(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },

    awaitChange(filename, timeoutMs) {
      return new Promise<string>((resolve, reject) => {
        const evt: ChangeEvent = {
          filename,
          content: latest.get(filename) ?? "",
          resolve,
          reject,
          // A backstop in case the timer fails to fire for some reason.
          timer: setTimeout(() => {
            // Pull this event out of the queue if it's still pending
            const queue = pending.get(filename);
            if (queue) {
              const idx = queue.indexOf(evt);
              if (idx >= 0) queue.splice(idx, 1);
            }
            reject(
              new Error(
                `timeout: no change to ${filename} within ${timeoutMs}ms`
              )
            );
          }, timeoutMs),
        };
        // If stop() is called, reject immediately
        const queue = pending.get(filename) ?? [];
        queue.push(evt);
        pending.set(filename, queue);
      });
    },

    getLatestContent(filename) {
      return latest.get(filename) ?? null;
    },

    ready() {
      if (isReady) return Promise.resolve();
      return new Promise<void>((resolve) => readyResolvers.push(resolve));
    },

    /**
     * Monotonic counter — increments on every successful file read by the
     * watcher. The orchestrator uses this to tell a NEW write apart from
     * pre-existing content. Snapshot this BEFORE awaiting, then compare to
     * the post-await value: if equal, no new write happened during the wait.
     */
    getGeneration(filename) {
      return fileGenerations.get(filename) ?? 0;
    },
  };
}