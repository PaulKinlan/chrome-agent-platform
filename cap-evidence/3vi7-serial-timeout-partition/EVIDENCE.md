# chrome-agent-platform-3vi7 — Serial Phase Assignment for tests/serial-phase-timeout.test.ts

**Candidate:** branch `cap/gemini-3vi7-serial-timeout-flake` @ worktree `/home/paulkinlan/worktrees/cap-gemini-3vi7`.  
**Date:** 2026-09-25.  
**Authority:** Flake elimination for serial phase timeout test under fleet load.

---

## 1. Problem & Root Cause

In `tests/serial-phase-timeout.test.ts:80`:
`86gg: the SAME slow file is killed by the flat bound and survives the scaled one`

The test creates a fixture that sleeps 3.5 s, verifies a 2 s flat bound kills it, and verifies a 6 s scaled bound lets it complete.
Because this test ran in Phase 2 (the 32-worker parallel phase) alongside 482 other tests under heavy machine load (loadavg 70+), the 3.5 s sleep combined with process spawn and queueing delays occasionally exceeded 6 s, causing an intermittent false-red failure.

---

## 2. Fix

Declared `tests/serial-phase-timeout.test.ts` in `SERIAL_REASONS` in `scripts/test-partition.mjs`:
```js
  // 3vi7: tests/serial-phase-timeout.test.ts makes wall-clock queueing assertions
  // (3.5 s fixture vs 2 s flat / 6 s scaled bounds) which race and flake under the
  // 32-worker parallel phase on a heavily loaded fleet machine.
  "tests/serial-phase-timeout.test.ts": "wall-clock bounds assertions (3.5 s fixture vs 2 s / 6 s bounds) race the parallel phase",
```
This follows the exact precedent of `tests/chrome-slot-semaphore-honesty.test.ts`.
Running in Phase 1 isolates the test from parallel worker contention, providing deterministic wall-clock execution for the 3.5 s fixture within the 6 s bound.

---

## 3. Verification

- `tests/test-partition-guard.test.ts`: 7/7 passed.
- `tests/serial-phase-timeout.test.ts`: 6/6 passed in 8s.
- `npm run check:vocabulary`: OK.
- `npm run check:dist`: OK.
