# Contributing to Loop Agent

Thanks for helping out. Small, focused changes are the easiest to review.

## Setup

Requires Node 20+.

```bash
cd backend && npm install && npm run dev      # API on 127.0.0.1:3001
cd ui && npm install && npm run dev           # UI on http://localhost:5173
```

No API key is needed to try things out: `cd backend && npm run demo:stack` boots a
fake LLM, an isolated backend and the UI on http://localhost:5174.

## Tests

Run these in both `backend/` and `ui/`:

```bash
npm test
npx tsc --noEmit
```

On Windows, a few backend tests need bash-executable shims or Playwright Chromium
(`npx playwright install`); see the Tests section of the [README](README.md).

## Before you open a PR

Run the trust scoreboard from `backend/`:

```bash
npm run demo:trust
```

It must print `11/11 guarantees hold`. If a change breaks one of those guarantees,
fix the change rather than the scoreboard. The guarantees are enforced in code, not
in prompts, and that is the point of the project.

## Pull requests

- Keep PRs small and focused: one change, one reason.
- Add or update tests alongside behavior changes.
- Describe what changed and why in the PR description.
- Security issues: do not open a public issue. See [SECURITY.md](SECURITY.md).
