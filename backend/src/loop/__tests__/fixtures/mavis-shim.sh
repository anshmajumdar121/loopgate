#!/usr/bin/env bash
# Fake `minimax` CLI for mavis-bridge.test.ts. Never touches the real Mavis
# daemon — tests must never spend the user's real subscription quota.
#
# Controlled via:
#   MAVIS_SHIM_MODE      = success (default) | stall | daemon-down
#   MAVIS_SHIM_STATE_DIR = scratch dir for per-session poll counters (required)
set -euo pipefail

MODE="${MAVIS_SHIM_MODE:-success}"
STATE_DIR="${MAVIS_SHIM_STATE_DIR:?MAVIS_SHIM_STATE_DIR must be set}"
mkdir -p "$STATE_DIR"

if [ "$MODE" = "daemon-down" ]; then
  echo "Error: could not connect to Mavis daemon" >&2
  exit 1
fi

cmd="${1:-}"
sub="${2:-}"

# Record every invocation so tests can assert which subcommands ran.
echo "$*" >> "$STATE_DIR/invocations.log"

case "$cmd" in
  agent)
    if [ "$sub" = "list" ]; then
      # MAVIS_SHIM_AGENT_EXISTS lists the given agent name, simulating a
      # daemon that already has the role agent registered (possibly with a
      # stale system prompt).
      if [ -n "${MAVIS_SHIM_AGENT_EXISTS:-}" ]; then
        echo "[{\"name\":\"${MAVIS_SHIM_AGENT_EXISTS}\"}]"
      else
        echo "no agents"
      fi
      exit 0
    elif [ "$sub" = "new" ]; then
      echo "Agent '${3:-}' created."
      exit 0
    elif [ "$sub" = "update" ]; then
      echo "Agent '${3:-}' updated."
      exit 0
    fi
    ;;
  session)
    if [ "$sub" = "new" ]; then
      # MAVIS_SHIM_SESSION_NEW_FAILS=<n>: fail the first n `session new`
      # calls with the daemon-busy timeout error seen live, then succeed.
      if [ -n "${MAVIS_SHIM_SESSION_NEW_FAILS:-}" ]; then
        fails_file="$STATE_DIR/session_new_fails"
        so_far=$(cat "$fails_file" 2>/dev/null || echo 0)
        if [ "$so_far" -lt "$MAVIS_SHIM_SESSION_NEW_FAILS" ]; then
          echo $((so_far + 1)) > "$fails_file"
          echo "Error: Cannot connect to Mavis daemon (supervisor-managed): The operation was aborted due to timeout." >&2
          exit 1
        fi
      fi
      session_id="mvs_test_session"
      echo "0" > "$STATE_DIR/$session_id.polls"
      # The real minimax CLI prints this human-readable line (with ANSI
      # color codes) before the JSON payload — mavis-bridge.ts must parse
      # past it, not assume stdout is pure JSON.
      printf '\033[32mRoot session created: %s [model=minimax/MiniMax-M2.7]\033[0m\n' "$session_id"
      echo "{\"sessionId\":\"$session_id\",\"agentName\":\"test\"}"
      exit 0
    elif [ "$sub" = "messages" ]; then
      session_id="${3:-}"
      counter_file="$STATE_DIR/$session_id.polls"
      polls=$(cat "$counter_file" 2>/dev/null || echo 0)
      polls=$((polls + 1))
      echo "$polls" > "$counter_file"

      if [ "$MODE" = "stall" ]; then
        echo "{\"messages\":[{\"role\":\"user\",\"msg_content\":\"hi\"}]}"
        exit 0
      fi

      # success mode: poll 1 = just the user message (proves the poll loop
      # loops). Poll 2 = an intermediate tool-calls message with empty
      # content, exactly like a real agent mid-turn — must NOT be mistaken
      # for completion (found live: an early poll grabbed this shape and
      # wrote 0 chars to outFile). Poll 3+ = the real stop message.
      if [ "$polls" -lt 2 ]; then
        echo "{\"messages\":[{\"role\":\"user\",\"msg_content\":\"hi\"}]}"
      elif [ "$polls" -lt 3 ]; then
        echo "{\"messages\":[{\"role\":\"user\",\"msg_content\":\"hi\"},{\"role\":\"assistant\",\"finish_reason\":\"tool-calls\"}]}"
      else
        echo "{\"messages\":[{\"role\":\"user\",\"msg_content\":\"hi\"},{\"role\":\"assistant\",\"finish_reason\":\"tool-calls\"},{\"role\":\"assistant\",\"msg_content\":\"PONG\",\"finish_reason\":\"stop\",\"usage\":{\"total_tokens\":42}}]}"
      fi
      exit 0
    fi
    ;;
esac

echo "unknown command: $*" >&2
exit 1
