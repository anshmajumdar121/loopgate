<!-- role=verifier attempt=1 model=tencent/hy3:free -->
<!-- finish=stop textChars=2352 reasoningChars=0 -->

## Verifier Verdict — Attempt 1

**Verdict: APPROVE**

### Completion Criteria Walkthrough
1. **Centered canvas, dark bg, zero console errors** — `body` is `#111` with flex column centering; canvas `#000` with `2px solid #333` border. Runtime check: uncaught errors none, console errors none, failed requests none. ✅
2. **Auto-move at consistent speed on load** — `init()` called at boot; `setInterval(loop, 100)` starts snake (3 segments, moving RIGHT). ✅
3. **Arrow keys control; no 180° instant self-collision** — `handleKey` maps arrows + WASD, calls `preventDefault()`, blocks reversal vs `dir`; `update()` re-guards `nextDir` vs `dir` before commit. ✅
4. **Eating grows by exactly one + score++** — `willEat` branch does `score++`, `spawnFood()`, and skips `snake.pop()` (net +1 segment); non-eat branch pops tail. `updateScore()` refreshes text. ✅
5. **Game-over on wall/self hit with overlay** — Wall bounds check and body overlap check both call `endGame(false)`; overlay `hidden` toggled false, final score shown. ✅
6. **Restart fully resets** — `restartBtn` → `restart()` → `init()` resets snake, dir, nextDir, score, gameOver, food, hides overlay, clears/restarts timer. ✅
7. **No external network requests** — No `<link>`, no `<script src>`, no remote fonts/images (system monospace stack). Runtime: failed network requests none. ✅
8. **No build/server needed** — Single static self-contained HTML. ✅
9. **Arrow keys don't scroll/navigate** — `preventDefault()` on mapped keys; listener registered `{ passive: false }`. ✅
10. **No leak/freeze; tail popped each tick** — `snake.pop()` on non-eat; interval cleared on end/restart. ✅

### Scope / Constraints
- **Files changed:** only `index.html` — matches GOAL.md allowlist (Files to touch: `index.html`). No extra files. ✅
- **Denylist:** No denylisted paths touched. ✅
- **Intent:** Diff fully implements the planned Snake game with all required features. ✅
- **No-cheating:** No disabled/skipped tests, no swallowed errors, no type-suppression hacks. Clean ES6 IIFE, strict mode. ✅

### Runtime Evidence
Headless Chromium load + Restart click produced **no uncaught/page errors, no console errors, no failed requests**. This is authoritative confirmation the prototype loads and basic interaction works.

All 10 criteria satisfied; scope clean; no violations. **APPROVE → state = DONE.**