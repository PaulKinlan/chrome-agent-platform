# chrome-agent-platform-3a16 — Consolidate KAT Finalizer Test Files

**Candidate:** branch `cap/gemini-3a16-consolidate-kat-finalizer` @ worktree `/home/paulkinlan/worktrees/cap-gemini-3a16`.  
**Base:** `origin/main` @ `23e0f9273`.  
**Date:** 2026-09-25.  
**Authority:** Test consolidation. Merges `tests/kat-bistro-finalizer.test.ts`, `tests/kat-finalizer-guards.test.ts`, and `tests/kat-finalizer-log-residue.test.ts` into a single authoritative `tests/kat-finalizer.test.ts`. No production change.

---

## 1. Background & Scope

During the independent verification of `qml6`, `2b6a`, `ln0e`, and `23r0`, tests for `scripts/lib/kat-finalizer.ts` were maintained across three separate files to allow collision-free parallel landings:
- `tests/kat-bistro-finalizer.test.ts`: 27 tests (core sequencing, caller binding, teardown, and qml6 guard-(b) regression).
- `tests/kat-finalizer-guards.test.ts`: 16 tests (2b6a's 11 guard pins, 3yfs teardown/0-check assertions, and 23r0's A2 poison-isolation pin).
- `tests/kat-finalizer-log-residue.test.ts`: 4 tests (ln0e's report-order residue cleanup and best-effort removal).

With all candidate beads successfully landed and closed on `main`, `3a16` consolidates these **47 tests** into a single file matching the module under test: `tests/kat-finalizer.test.ts`.

---

## 2. Consolidation Details

- **Target File:** `tests/kat-finalizer.test.ts` (70.9 KB, 47 tests).
- **A2 Poison Isolation Guard Carried Over:** Includes `"kat-finalizer guards: a POISONED slot is RED independently of cleanupError (A2)"`, preserving the sole pin on the `!poisonDetected` clause of `isGreen` in `scripts/lib/kat-finalizer.ts`.
- **Assertion Fidelity:** Every assertion is preserved byte-identical (27 + 16 + 4 = 47).
- **Removed Files:**
  - `tests/kat-bistro-finalizer.test.ts`
  - `tests/kat-finalizer-guards.test.ts`
  - `tests/kat-finalizer-log-residue.test.ts`
- **Allowlist Sync:** In `tests/durable-root.test.ts`, updated `ALLOWED_FILES` (lines 182–186) to reference `"tests/kat-finalizer.test.ts"` and removed the three individual files.

---

## 3. Verification

- `npm run test:file -- tests/kat-finalizer.test.ts`: **47 passed / 0 failed** in 131 ms.
- `npm run test:file -- tests/durable-root.test.ts`: **6 passed / 0 failed** (allowlist validated).
- `npm run test:file -- tests/test-partition-guard.test.ts`: **7 passed / 0 failed** (clean parallel classification).
- `npm run check:vocabulary`: Clean.
- `npm run check:dist`: Clean.
