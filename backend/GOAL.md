# Current Goal

> Written by `loop-planner`. Read by `loop-maker` and `loop-verifier`.

## Task

Refactor the canvas zoom controls to feel smoother and more responsive

## Completion Criteria

- [ ] `npm run build` exits 0
- [ ] `npm test` passes (all tests green)
- [ ] Diff is minimal — only allowlisted files touched

## Implementation Plan

1. Read existing code under the workdir to ground the change in reality.
2. Implement: Refactor the canvas zoom controls to feel smoother and more responsive.
3. Run the documented build and tests; ensure both pass.

## Files to touch

- src/index.ts
- src/utils/handlers.ts

## Files NOT to touch (denylist)

- .env, .env.*
- **/secrets/**
- **/credentials/**
- **/*_key*
- **/*_secret*

## Risks

- Minimal scope — no architectural change

## Notes for the maker

Build command: `npm run build`
Test command: `npm test`
Lint command: `npm run lint`
