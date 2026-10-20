import { useEffect, useRef, useCallback } from "react";
import { useWorkflow } from "@/lib/store";
import { useBatchStore } from "@/lib/batchStore";
import type {
  WsClientMessage,
  WsServerMessage,
  Task,
  LogEntry,
  PlanSummary,
  DiffSummary,
  Verdict,
} from "@/types/loop";

let socket: WebSocket | null = null;
let pendingSubscriptions = new Set<string>();

/** Heartbeat: how often the server pings, and the timeout before we declare
 *  the connection dead and force a reconnect. */
const PONG_TIMEOUT_MS = 60_000;

export function useLoopSocket() {
  const reconnectTimer = useRef<number | null>(null);
  const heartbeatTimer = useRef<number | null>(null);
  const pongDeadlineTimer = useRef<number | null>(null);
  const isMounted = useRef(false);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const s = useWorkflow.getState();
      // Reset the pong deadline — any server message counts as liveness.
      if (pongDeadlineTimer.current !== null) {
        window.clearTimeout(pongDeadlineTimer.current);
      }
      pongDeadlineTimer.current = window.setTimeout(() => {
        // No message in PONG_TIMEOUT_MS — connection is dead. Force a
        // close so the onclose handler fires the reconnect path.
        console.warn("[ws] pong timeout — forcing reconnect");
        socket?.close();
      }, PONG_TIMEOUT_MS);

      let msg: WsServerMessage;
      try {
        msg = JSON.parse(event.data) as WsServerMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case "pong":
          // App-level pong (we also handle ws-native pong frames in the
          // socket.on("pong") handler below). Already counted as liveness
          // above.
          break;

        case "connection_health": {
          // Not task-scoped. Re-broadcast as a DOM event so the
          // Connections panel (which has no socket of its own) can
          // refresh its list without threading through the task store.
          window.dispatchEvent(
            new CustomEvent("loop:connection-health", { detail: msg })
          );
          break;
        }

        case "batch_update": {
          // Not task-scoped — every client mirrors every batch.
          if (msg.batch) useBatchStore.getState().upsertBatch(msg.batch);
          // Batch items create their task server-side. Let the active-task
          // follower poll immediately instead of waiting for its next tick.
          window.dispatchEvent(
            new CustomEvent("loop:batch-update", { detail: msg })
          );
          break;
        }

        case "task_update": {
          if (msg.taskId !== s.currentTaskId) return;
          s.setTaskMirror(msg.task);
          s.applyTaskStatusToNodes(msg.task.status, msg.task.attempt);
          break;
        }

        case "phase_change": {
          if (msg.taskId !== s.currentTaskId) return;
          s.setPhase(msg.from, msg.to);
          break;
        }

        case "log": {
          if (msg.taskId !== s.currentTaskId) return;
          s.appendLog(msg.entry);
          break;
        }

        case "node_status": {
          if (msg.taskId !== s.currentTaskId) return;
          s.setNodeStatus(msg.nodeId, msg.status as import("@/data/workflow").RunStatus);
          break;
        }

        case "plan_ready": {
          if (msg.taskId !== s.currentTaskId) return;
          s.setPlan(msg.plan);
          break;
        }

        case "diff_ready": {
          if (msg.taskId !== s.currentTaskId) return;
          s.setDiff(msg.diff);
          break;
        }

        case "verdict": {
          if (msg.taskId !== s.currentTaskId) return;
          s.setVerdict(msg.verdict);
          break;
        }

        case "verifier_progress": {
          if (msg.taskId !== s.currentTaskId) return;
          s.setLiveScore({
            attempt: msg.attempt,
            passed: msg.passed,
            total: msg.total,
            partial: msg.partial,
            done: msg.done,
          });
          break;
        }

        case "node_score": {
          if (msg.taskId !== s.currentTaskId) return;
          // Per-node score breakdown — feeds the small /10 chip on the
          // matching canvas node. Ignore ids we don't render (e.g. if a
          // future backend adds a node the UI hasn't been taught yet).
          if (!msg.nodeId) return;
          s.setNodeScore(msg.nodeId, {
            attempt: msg.attempt,
            passed: msg.passed,
            total: msg.total,
            score: msg.score,
            done: msg.done,
          });
          break;
        }

        case "escalation": {
          if (msg.taskId !== s.currentTaskId) return;
          s.setEscalation(msg.reason);
          break;
        }

        case "done": {
          if (msg.taskId !== s.currentTaskId) return;
          s.setDone(msg.summary);
          break;
        }

        case "error": {
          if (msg.taskId !== s.currentTaskId) return;
          s.setError(msg.message);
          break;
        }

        case "task_re_prompted": {
          if (msg.taskId !== s.currentTaskId) return;
          // The matching `task_update` (broadcast right before this event by
          // orchestrator.rePrompt) already cleared plan/diff/verdict and
          // updated the prompt + attempt counter. Nothing more to do here —
          // the UI is already in sync. Log it for debug visibility.
          break;
        }

        case "task_deleted": {
          // Clear local task state when the active task is deleted. The
          // backend has already removed the row from its store; we mirror
          // that by clearing currentTaskId, which cascades the rest of the
          // taskMirror / plan / diff / verdict / logs fields via the
          // setCurrentTask reducer.
          s.setCurrentTask(null);
          break;
        }
      }
    },
    []
  );

  const connect = useCallback(() => {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    useWorkflow.getState().setWsStatus("connecting");

    const url = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
    socket = new WebSocket(url);

    socket.onopen = () => {
      console.log("[ws] connected");
      useWorkflow.getState().setWsStatus("open");
      // Re-subscribe to any pending task
      for (const taskId of pendingSubscriptions) {
        send({ type: "subscribe", taskId });
      }
      // A connection_health broadcast that fired while this socket was
      // down (the dev proxy cycles it every 30-60s) is gone for good —
      // the server doesn't replay. Nudge the Connections panel to refetch
      // on every (re)connect so it can never stay stale. detail: null
      // distinguishes this resync nudge from a real broadcast.
      window.dispatchEvent(
        new CustomEvent("loop:connection-health", { detail: null })
      );
      // Reset pong deadline
      if (pongDeadlineTimer.current !== null) {
        window.clearTimeout(pongDeadlineTimer.current);
      }
      pongDeadlineTimer.current = window.setTimeout(() => {
        console.warn("[ws] pong timeout — forcing reconnect");
        socket?.close();
      }, PONG_TIMEOUT_MS);
    };

    // ws-native pong frame — server sends a ping every 30s and the
    // browser auto-replies. Treat the receipt of pong as proof of
    // liveness and reset the deadline timer. Without this, idle
    // connections (no app-level messages) would be killed by the
    // deadline even though they're healthy.
    // Note: browser WebSocket uses addEventListener, not the Node ws
    // library's EventEmitter `.on()`.
    socket.addEventListener("pong", () => {
      if (pongDeadlineTimer.current !== null) {
        window.clearTimeout(pongDeadlineTimer.current);
      }
      pongDeadlineTimer.current = window.setTimeout(() => {
        console.warn("[ws] pong timeout — forcing reconnect");
        socket?.close();
      }, PONG_TIMEOUT_MS);
    });

    socket.onmessage = handleMessage;

    socket.onclose = () => {
      console.log("[ws] closed — will retry in 2s");
      socket = null;
      useWorkflow.getState().setWsStatus("closed");
      // Clear heartbeat timers — connect() resets them on the next open
      if (heartbeatTimer.current !== null) {
        window.clearTimeout(heartbeatTimer.current);
        heartbeatTimer.current = null;
      }
      if (pongDeadlineTimer.current !== null) {
        window.clearTimeout(pongDeadlineTimer.current);
        pongDeadlineTimer.current = null;
      }
      if (isMounted.current) {
        reconnectTimer.current = window.setTimeout(() => connect(), 2000);
      }
    };

    socket.onerror = (e) => {
      console.error("[ws] error", e);
      // onclose fires after onerror — let it handle the reconnect.
    };
  }, [handleMessage]);

  const send = useCallback((msg: WsClientMessage) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }, []);

  const subscribe = useCallback((taskId: string) => {
    pendingSubscriptions.add(taskId);
    send({ type: "subscribe", taskId });
  }, [send]);

  const unsubscribe = useCallback((taskId: string) => {
    pendingSubscriptions.delete(taskId);
    send({ type: "unsubscribe", taskId });
  }, [send]);

  useEffect(() => {
    isMounted.current = true;
    connect();
    return () => {
      isMounted.current = false;
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
      if (heartbeatTimer.current !== null) window.clearTimeout(heartbeatTimer.current);
      if (pongDeadlineTimer.current !== null) window.clearTimeout(pongDeadlineTimer.current);
      if (socket) {
        socket.close();
        socket = null;
      }
    };
  }, [connect]);

  return { subscribe, unsubscribe, send };
}

function _typeNarrow(_t: Task | LogEntry | PlanSummary | DiffSummary | Verdict) {
  /* satisfies unused import check */
}