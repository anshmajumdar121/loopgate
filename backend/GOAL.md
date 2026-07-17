# Snake Game - Implementation Plan

## Overview
Build a classic Snake game as a single self-contained `index.html` with inline CSS and JS, no build step, and no external dependencies. Required features: arrow-key controls, a live score counter, a game-over state with a Restart button, and a clean centered canvas on a dark background. Must be fully playable end-to-end with no bugs.

## Steps
1. Create `index.html` at project root with standard HTML5 boilerplate (`<!DOCTYPE html>`, `<html>`, `<head>`, `<body>`).
2. Add inline `<style>` in `<head>`:
   - `body`: dark background (e.g., `#111`), zero margin, flexbox centering (column, centered both axes).
   - `#gameCanvas`: border (`2px solid #333`), background (`#000`), display block.
   - `#score`: light text (`#eee`), monospace font, spacing below canvas.
   - `#gameOverOverlay`: hidden by default, centered overlay with translucent dark backdrop, readable message, and a clearly styled `#restartBtn`.
3. Add body markup: a `<div id="score">Score: 0</div>`, a `<canvas id="gameCanvas" width="400" height="400"></canvas>`, and a `<div id="gameOverOverlay" hidden>` containing a game-over message and `<button id="restartBtn">Restart</button>`.
4. Add inline `<script>` implementing game logic:
   - Config: `cell = 20`, `cols = 20`, `rows = 20`, `tick = 100` ms.
   - State: `snake` (array of `{x,y}`), `dir`, `nextDir`, `food`, `score`, `timer`, `gameOver`.
   - `init()`: place snake (3 segments) at center, spawn random `food` on empty cell, reset `score` to 0, attach event listeners, start interval loop.
   - `loop()`: call `update()` then `draw()`.
   - `update()`: assign `dir = nextDir`; compute new head; if head out of bounds or overlaps snake -> `endGame()`; else unshift head; if head equals food -> `score++`, respawn food; else pop tail.
   - `draw()`: clear canvas; draw food (red); draw snake segments (lime); update score text.
   - `endGame()`: stop interval, show overlay with final score.
   - `restart()`: hide overlay, call `init()`.
   - `keydown` handler: map Arrow keys to direction vectors, `preventDefault()` to stop scroll, ignore 180° reversal, set `nextDir`.
5. Verify no external references: no `<link>`, no `<script src>`, no remote fonts/images.
6. Mentally test edge cases: reverse prevention, food spawning not on snake, rapid key presses between ticks, restart resets all state.

## Files to Create/Modify
- `index.html` (new, self-contained)

## Completion Criteria
- [ ] Opening `index.html` directly in a browser shows a centered canvas on a dark background with zero console errors.
- [ ] The snake begins moving automatically at a consistent speed immediately after page load.
- [ ] Arrow keys control direction; pressing the opposite of the current direction does not cause an instant self-collision.
- [ ] Eating food increases the score counter and grows the snake by exactly one segment.
- [ ] Game-over triggers correctly when the snake hits a wall or its own body, showing a clear overlay/message.
- [ ] A Restart button appears on game over and fully resets snake, score, and play state to initial conditions.
- [ ] No external network requests occur (view source confirms only inline CSS/JS).
- [ ] No build step or local server is required; double-clicking the file plays the game.
- [ ] Arrow keys do not scroll or navigate the browser page during play.
- [ ] The game runs indefinitely without memory leaks or freezes (tail correctly popped each tick).

## Notes for the maker
- Assumption: Project root has no critical existing `index.html`; the task implies creating the game file (will overwrite if present).
- Assumption: Canvas size 400x400 with 20px cells (20x20 grid) is acceptable since exact dimensions were not specified.
- Assumption: "Dark background" interpreted as `#111` body / `#000` canvas; exact shades are flexible.
- Assumption: Vanilla JS (ES6) only, no frameworks or libraries.
- Constraint: Cannot inspect actual GOAL.md template or repo files due to tool-mode override (no file/explore tools available); headings inferred from typical structure and task requirements.

PLAN READY
- Steps: 6
- Files to touch: index.html
- Criteria: 10
- Risks: none
- Notes: Assumptions about canvas size (400x400, 20x20 grid), overwrite of any existing index.html, dark palette shades, and vanilla JS only; cannot verify current repo state due to no tool access.