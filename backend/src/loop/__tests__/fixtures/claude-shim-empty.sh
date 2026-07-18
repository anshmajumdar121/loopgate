#!/bin/sh
# Stand-in for the real `claude` CLI, used by llm-agent-cli.test.ts to
# exercise the empty-content guard in backend/llm-agent.mjs (~line
# 394-410): the CLI exits 0 but produces no usable stdout text.
exit 0
