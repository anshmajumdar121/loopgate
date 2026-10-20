#!/bin/sh
# Stand-in for the real `claude` CLI, used by llm-agent-cli.test.ts so the
# --cli path (backend/llm-agent.mjs) can be exercised end-to-end without
# shelling out to the real `claude` binary (which requires an authenticated
# login and would make the test flaky/non-hermetic). Pointed to via
# LOOP_CLI_BIN. Ignores all args/stdin and just echoes a fixed, parseable
# plan to stdout, mirroring what `claude -p <prompt> --output-format text`
# would print on success.
echo "## Implementation Plan
1. Step one
## Completion Criteria
- [ ] works"
