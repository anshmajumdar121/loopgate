#!/bin/sh
# Stand-in for the real `claude` CLI, used by llm-agent-cli.test.ts to
# exercise the maker-role --cli dispatch path (backend/llm-agent.mjs
# lines ~472-526): multi-file ```file:relative/path``` extraction, the
# path-safety check, and the STATE.md Diff Summary append. Ignores all
# args/stdin and echoes a single ```file:index.html``` block, matching
# the extraction regex exactly (closing fence on its own line).
printf '%s\n' '```file:index.html' '<!doctype html><html><body>hi</body></html>' '```'
