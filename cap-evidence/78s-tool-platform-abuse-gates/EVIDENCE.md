# chrome-agent-platform-78s — Tool Platform Abuse, Quota, and Lifecycle Gates (Gates 8–10)

**Candidate:** branch `cap/gemini-78s-tool-platform-abuse-gates` @ worktree `/home/paulkinlan/worktrees/cap-gemini-78s`.  
**Base:** `origin/main` @ `334f6c071`.  
**Date:** 2026-09-26.  
**Authority:** [CAP-FB-20260822-TOOL-PLATFORM-ABUSE-GATES-01]. Clean landing of abuse gates 8, 9, 10 in `tests/tool-platform-abuse-gates.test.ts`.

---

## 1. Overview & Triage Resolution

Commit `7993faec` previously introduced abuse gates 8, 9, and 10, but was stalled behind historic 06qj merge/revert conflicts on `cap-beads-78s`. Triage confirmed the substantive test additions were clean, hermetic, and independent.

This deliverable extracts and integrates the three abuse gates directly onto the current `origin/main` baseline without merge artifacts:
- **Gate 8:** Unsealed or discarded stream promotion rejection.
- **Gate 9:** Cross-owner stream promotion hijacking defense.
- **Gate 10:** Adversarial tabular formula injection with Unicode separators, row-width overflows, and cell-byte overflow defenses.

---

## 2. Gate Details

### Abuse Gate 8: Unsealed or Discarded Stream Promotion
- An unsealed stream promotion attempt fails closed with `wasm_stream_authority` error.
- A discarded stream promotion attempt fails closed (missing directory / invalid ref).

### Abuse Gate 9: Cross-Owner Stream Hijacking Defense
- A victim's confidential stream output cannot be promoted by an unauthorized attacker principal; rejected with `wasm_stream_authority`.
- Legitimate owner promotion succeeds and produces `{ ok: true, promoted: true }`.

### Abuse Gate 10: Tabular Injection & Overflow Defenses
- Formula injection neutralization: handles Unicode line separators (`\u2028`, `\u2029`), BOM (`\uFEFF`), leading whitespace/tabs, and malicious command pipes (`|`), ensuring cells start with single quote `'`.
- Row-width overflow defense: a row containing more cells than the declared header fails closed with `table_row_width`.
- Cell-byte overflow defense: a cell exceeding `maxCellBytes` fails closed with `table_cell_bound`.

---

## 3. Verification

- `npm run test:file -- tests/tool-platform-abuse-gates.test.ts`: **10 passed / 0 failed** in 209 ms.
- `tests/test-partition-guard.test.ts`: **9 passed / 0 failed** (clean parallel classification).
- `npm run check:vocabulary`: Clean.
- `npm run note:dist`: Clean.
