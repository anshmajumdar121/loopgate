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

case "$cmd" in
  agent)
    if [ "$sub" = "list" ]; then
      echo "no agents"
      exit 0
    elif [ "$sub" = "new" ]; then
      echo "Agent '${3:-}' created."
      exit 0
    fi
    ;;
  session)
    if [ "$sub" = "new" ]; then
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

      # success mode: only answer from the 2nd poll onward, so the test
      # actually proves the poll loop loops (not just a lucky first read).
      if [ "$polls" -lt 2 ]; then
        echo "{\"messages\":[{\"role\":\"user\",\"msg_content\":\"hi\"}]}"
      else
        echo "{\"messages\":[{\"role\":\"user\",\"msg_content\":\"hi\"},{\"role\":\"assistant\",\"msg_content\":\"PONG\",\"finish_reason\":\"stop\",\"usage\":{\"total_tokens\":42}}]}"
      fi
      exit 0
    fi
    ;;
esac

echo "unknown command: $*" >&2
exit 1
