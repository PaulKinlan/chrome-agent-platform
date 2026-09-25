# chrome-agent-platform-ccl7 — Static Pairing Guard for Journey Ledgers

**Candidate:** branch `cap/gemini-ccl7-static-pairing-guard` @ worktree `/home/paulkinlan/worktrees/cap-gemini-ccl7`.  
**Date:** 2026-09-25.  
**Authority:** Pre-commit/unit static pairing guard ensuring `EXPECTED` ledgers match executed `check()` and `report()` call literals in set and order.

---

## 1. Problem & Motivation

In `chrome-agent-platform-we0m`, a check name was updated during a skill rename (`Sorting Hat`), but the corresponding entry in `EXPECTED` at `scripts/chrome-journeys.ts:889` was left behind. Because the pairing was only checked by the runtime finalizer at the end of a ~370-step browser run (~90–120 s), this harness discrepancy required multiple review rounds to surface.

`ccl7` provides a fast, static pairing guard that validates the ledger at commit/test time in milliseconds.

---

## 2. Guard Architecture

Implemented in:
- `scripts/lib/journey-ledger-pairing.mjs` (core analysis logic)
- `scripts/check-journey-ledgers.mjs` (CLI command: `npm run check:ledgers`)
- `tests/journey-ledger-pairing.test.ts` (unit test + falsification controls)

### Handled Artifacts
1. **Const-Bound Identifiers:** Resolves `const` declarations (e.g., `STEP1_NAME`, `ONE_CARD_NAME`, `STEP4_NAME`, `STEP5_NAME`, `PRIVACY_RENDERS`, `SEEDED`, `DIALOG`, etc.) passed to `report(ID, ...)`.
2. **Execution Flow Ordering:** Traces execution order through `main()`, correctly accounting for helper sub-routines `await demoPathJourney()` and `await factoryResetJourney()` before final cleanup assertions.
3. **Dual Happy/Catch Call Sites:** Recognizes duplicate call sites guarded by try/catch branches (e.g. `about:*` catch-handler duplicates and `extension loaded` conditional branches) where exactly one fires per run.
4. **Deliberate Catch-Only Tripwires:** Ignores catch-only tripwires intentionally positioned outside `EXPECTED` (`site playbook journey completed without a harness error`).
5. **Cross-File Coverage:** Validates both `scripts/chrome-journeys.ts` and `scripts/agent-access-journeys.ts`.

---

## 3. Results & Measured Parity

Running `npm run check:ledgers`:
- `scripts/chrome-journeys.ts`: **368 non-meta assertions** match `EXPECTED` in exact set and exact order.
- `scripts/agent-access-journeys.ts`: **85 non-meta assertions** match `EXPECTED` in exact set and exact order.
- Execution time: **< 20 ms**.

---

## 4. Falsification Drills

1. **The we0m Regression Drill:**
   Planted the exact `we0m` fault (renaming the Sorting Hat `EXPECTED` entry to include `"recipe"`).
   - Guard failed immediately: reported the mutated name as `MISSING` from calls, the call site name as `EXTRA` (not in EXPECTED), and identified order mismatch at index 322.
2. **Call Site Disparity:**
   Renamed `check("plus menu: opens via a real click")` in `agent-access-journeys.ts` without touching `EXPECTED`.
   - Guard failed immediately: reported the missing expected name and extra undeclared call site.
3. **Assertion Order Swap:**
   Swapped two adjacent entries in `EXPECTED`.
   - Guard failed immediately: set sizes and members matched, but order mismatch was caught and reported at exact index.

---

## 5. Verification

- `npm run check:ledgers`: Green (both files pass).
- `npm run test:file -- tests/journey-ledger-pairing.test.ts`: 5/5 passed in 19 ms.
- `npm run test:file -- tests/test-partition-guard.test.ts`: 7/7 passed.
- `npm run test:file -- tests/package-scripts-exist.test.ts`: 4/4 passed.
