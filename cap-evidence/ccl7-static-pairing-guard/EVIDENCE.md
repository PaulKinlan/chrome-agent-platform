# chrome-agent-platform-ccl7 — Static Pairing Guard for Journey Ledgers

**Candidate:** branch `cap/gemini-ccl7-static-pairing-guard` @ worktree `/home/paulkinlan/worktrees/cap-gemini-ccl7`.  
**Date:** 2026-09-25.  
**Authority:** Pre-commit/unit static pairing guard ensuring `EXPECTED` ledgers match executed `check()` and `report()` call literals in set and order.

---

## 1. Problem & Motivation

In `chrome-agent-platform-we0m`, a check name was updated during a skill rename (`Sorting Hat`), but the corresponding entry in `EXPECTED` at `scripts/chrome-journeys.ts:889` was left behind. Because the pairing was only checked by the runtime finalizer at the end of a ~370-step browser run (~90–120 s), this harness discrepancy required multiple review rounds to surface.

`ccl7` provides a fast, static pairing guard that validates the ledger at commit/test time in milliseconds.

---

## 2. Guard Architecture & Coverage

Implemented in:
- `scripts/lib/journey-ledger-pairing.mjs` (core analysis logic)
- `scripts/check-journey-ledgers.mjs` (CLI command)
- `tests/journey-ledger-pairing.test.ts` (unit test + falsification controls)

### Covered Files
1. `scripts/chrome-journeys.ts` (368 assertions)
2. `scripts/agent-access-journeys.ts` (85 assertions)
3. `scripts/run-status-lifecycle.ts` (31 assertions)

### Documented Exclusion
- `scripts/security-injection.ts`: Excluded by design because its call sites directly index the array by reference — `check(EXPECTED[0], ...)`, `check(EXPECTED[1], ...)`, `check(EXPECTED[2], ...)` — making literal drift impossible by construction.

### Handled Artifacts & Review Refinements
1. **Comment Stripping (F1 Resolution):** `stripComments(source)` removes line (`//`) and block (`/* ... */`) comments while preserving string literals and source character indexing, ensuring commented-out `check()` calls never register as active call sites.
2. **Const-Bound Identifiers:** Resolves `const` declarations (e.g., `STEP1_NAME`, `ONE_CARD_NAME`, `STEP4_NAME`, `STEP5_NAME`, `PRIVACY_RENDERS`, `SEEDED`, `DIALOG`, etc.) passed to `report(ID, ...)`.
3. **Execution Flow Ordering:** Traces execution order through `main()`, correctly accounting for helper sub-routines `await demoPathJourney()` and `await factoryResetJourney()` before final cleanup assertions.
4. **Dual Happy/Catch Call Sites:** Recognizes duplicate call sites guarded by try/catch branches (e.g. `about:*` catch-handler duplicates and `extension loaded` conditional branches) where exactly one fires per run.
5. **Deliberate Catch-Only Tripwires:** Ignores catch-only tripwires intentionally positioned outside `EXPECTED` (`site playbook journey completed without a harness error`).

---

## 3. Results & Measured Parity

Running `node scripts/check-journey-ledgers.mjs`:
- `scripts/chrome-journeys.ts`: **368 non-meta assertions** match `EXPECTED` in exact set and exact order.
- `scripts/agent-access-journeys.ts`: **85 non-meta assertions** match `EXPECTED` in exact set and exact order.
- `scripts/run-status-lifecycle.ts`: **31 non-meta assertions** match `EXPECTED` in exact set and exact order.
- Execution time: **< 30 ms**.

---

## 4. Falsification Drills

1. **Commented Call Site Neutrality (F1):**
   Planting `// check("commented check not in ledger")` and `/* check(...) */` passes cleanly without generating false "Called but not in EXPECTED" errors.
2. **The we0m Regression Drill:**
   Planted the exact `we0m` fault (renaming the Sorting Hat `EXPECTED` entry to include `"recipe"`).
   - Guard failed immediately: reported the mutated name as `MISSING` from calls, the call site name as `EXTRA` (not in EXPECTED), and identified order mismatch at index 322.
3. **Call Site Disparity:**
   Renamed `check("plus menu: opens via a real click")` in `agent-access-journeys.ts` without updating `EXPECTED`.
   - Guard failed immediately: reported the missing expected name and extra undeclared call site.
4. **Assertion Order Swap:**
   Swapped two adjacent entries in `EXPECTED`.
   - Guard failed immediately: set sizes and members matched, but order mismatch was caught and reported at exact index.

---

## 5. Verification

- `node scripts/check-journey-ledgers.mjs`: Green (all three files pass).
- `npm run test:file -- tests/journey-ledger-pairing.test.ts`: **7 passed / 0 failed** in 112 ms.
- `npm run test:file -- tests/test-partition-guard.test.ts`: **7 passed / 0 failed** (clean parallel classification).
- `npm run check:vocabulary`: Clean.
- `npm run check:dist`: Clean.
