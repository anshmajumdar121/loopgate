# Security Policy

Loop Agent is a local developer tool. It is not hardened for exposure to a network.

## What it does to protect you

- The backend binds to `127.0.0.1` by default.
- Requests are checked against a Host and Origin allowlist, including WebSocket
  upgrades, to block DNS-rebinding and cross-site access. Extra names can be added
  with `LOOP_ALLOWED_HOSTS`.
- Request bodies, WebSocket frames and client counts are capped.
- API keys are passed to child processes through the environment (not argv) and are
  never returned over the API.

These behaviours are exercised by `npm run demo:trust` in `backend/`.

## What it does not do

- **There is no authentication token.** Anyone who can reach the server's port can use
  the API.
- **API keys are stored in plaintext** in `backend/data/_connections.json`. That
  directory is git-ignored, but the file is not encrypted.
- Agents are single LLM completions whose file writes go through a write policy
  (reserved files, a denylist and a plan allowlist). That policy is a guardrail, not
  a sandbox.

**Do not expose the server to a network.** Do not set `LOOP_HOST` to a public or LAN
address, and do not put it behind a tunnel or reverse proxy, unless you add your own
authentication in front of it.

## Reporting a vulnerability

Please report issues privately through GitHub security advisories (the repository's
**Security** tab, then **Report a vulnerability**). Do not open a public issue for
security problems. Include steps to reproduce, and the version or commit you tested.
