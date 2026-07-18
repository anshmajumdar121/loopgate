#!/bin/sh
# Stand-in for the real `claude` CLI, used by llm-agent-cli.test.ts to
# exercise the nonzero-exit branch of the --cli spawnSync failure handling
# in backend/llm-agent.mjs (~line 287-292): the binary runs but exits
# nonzero. Writes to stderr like a real CLI failure would.
echo "shim: simulated CLI failure" >&2
exit 1
