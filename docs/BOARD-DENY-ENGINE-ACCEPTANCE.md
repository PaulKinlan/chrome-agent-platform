# Board Deny Policy Engine Fixture and Census Acceptance

- **Bead:** `chrome-agent-platform-5ihd` (follow-up to `4egg` / `qcuf`)
- **Status:** Complete verification & contract pin
- **Contract Test:** `tests/board-deny-engine-contract.test.ts`
- **Related Beads:** `4egg` (resolved), `11rm` (streamed archive), `8fuc` (streamed converter wiring), `2g90` (streaming backup architecture)

---

## 1. Context & Purpose

`chrome-agent-platform-4egg` uncovered an architectural discrepancy in the pre-implementation 11rm target registry:
1. `cap:board-deny-rules` was mistakenly grouped into `storage.local (KV)` deny union keys.
2. In production, `extension/lib/agent-board.js` persists `BOARD_DENY_RULES_KEY = "cap:board-deny-rules"` strictly via `masterMemory().setTrusted(...)`, storing it in OPFS at `memory/master/cap:board-deny-rules.json`. There is zero live writer to `chrome.storage.local`.
3. In the uncorrected registry (`1ce24493`), `memory/master/cap:board-deny-rules.json` fell through to `portable-user-data` (which overwrites on restore), completely bypassing the mandatory `archive ∪ live` deny union merge and risking silent relaxation of active owner deny rules.

Commit `b5c65f0c` landed `C 4981dda9` (`qcuf`), correcting the registry classifier in `extension/lib/archive-target-registry.js`. However, `4egg`'s broader acceptance also required census and engine fixture correction, and the sealed registry package explicitly did not execute runtime engine barrier/clear/apply.

`5ihd` resolves this gap: it audits what existing fixtures and census files asserted, states plainly what the sealed package proved and what remained unproven, and pins the engine acceptance contract in executable tests.

---

## 2. Audit of Existing Census and Fixture Artifacts

### A. Historical Census Artifacts
- **`/home/paulkinlan/cap-evidence/11rm-implementation/target-census-authoritative.md:50`**:
  - Mistakenly asserted: `| cap:board-deny-rules | union-merge (DENY_KEY, lib/hooks.js) |` under `storage.local (KV)`.
  - Misattributed the key to `lib/hooks.js` (which actually owns `cap:hooksDeny`).
- **`/home/paulkinlan/cap-evidence/11rm-implementation/target-census-refined.md:35`**:
  - Repeated the same classification under `chrome.storage.local`.

### B. Historical Engine Fixture
- **`/home/paulkinlan/cap-evidence/11rm-implementation/registry-engine-fixtures.json`**:
  - Lines 98–103 (`"kv"` section): Listed `{"key": "cap:board-deny-rules", "cls": "portable-deny-union", "export": "include", "import": "merge-deny-union", "cite": "hooks.js DENY_KEY"}`.
  - `"opfs"` section: Completely omitted `memory/master/cap:board-deny-rules.json`.

---

## 3. What Was Proved vs. What Remained Unproven

### What the Sealed Registry Package (`C 4981dda9`) Proved:
- **Unit Classifier Contract (`extension/lib/archive-target-registry.js`)**:
  - `classifyOpfsPath("memory/master/cap:board-deny-rules.json")` returns `{ cls: "portable-deny-union", root: "memory" }`.
  - `classifyKvKey("cap:board-deny-rules")` returns `{ cls: "unclassified" }` (phantom KV refused fail-closed).
  - `classifyOpfsPath("memory/master/cap:board-deny-rules")` returns `{ cls: "unclassified" }` (missing extension refused).
  - Scoped memories (`memory/origins/.../cap:board-deny-rules.json`) return `{ cls: "portable-user-data" }`, preventing privilege escalation into master deny authority.
- Verified by `tests/archive-target-registry.test.ts:200` and `tests/archive-target-registry-successor.test.ts:100-108`.

### What Remained Unproven:
1. **Engine Boundary Dispatch**: The live archive engine in `extension/lib/data-archive.js` does not yet consume `archive-target-registry.js` (deferred to the 11rm streamed converter architecture, `2g90` / `8fuc`).
2. **Deny-Union Merge Execution**: No test verified that the restore engine correctly decodes MemoryStore envelopes (`{ __v, __value }`), deduplicates rules, enforces the `BOARD_MAX_DENY_RULES` (200) bound without truncation, and prevents owner deny relaxation.
3. **Post-Barrier Ordering**: No test proved that live state is re-read after acquiring the import maintenance lock, protecting concurrent owner policy mutations.

---

## 4. The Engine Acceptance Contract (`tests/board-deny-engine-contract.test.ts`)

`5ihd` delivers executable evidence pinning all four engine acceptance invariants:

1. **Storage & Census Truth**:
   - `BOARD_DENY_RULES_KEY = "cap:board-deny-rules"` and `BOARD_MAX_DENY_RULES = 200` in `extension/lib/agent-board.js`.
   - `agent-board.js` reads/writes only via `memory.getStrict` and `memory.setTrusted` (never KV).
   - `service-worker.js` passes `masterMemory()`, binding the file path to `memory/master/cap:board-deny-rules.json`.

2. **Registry Classification Boundary**:
   - `memory/master/cap:board-deny-rules.json` resolves to `portable-deny-union`.
   - Phantom KV `cap:board-deny-rules` resolves to `unclassified` (fail-closed, never imported).
   - Unextended and origin-scoped paths never acquire master deny-union authority.

3. **Engine Deny-Union Merge Semantics (`merge-deny-union`)**:
   - Merges `archive ∪ live` by structural rule identity (`action + agentId + peerId`).
   - Invariant: Live owner deny rules are **never dropped or weakened**, even when importing an empty archive or an archive lacking those rules.
   - Enforces `BOARD_MAX_DENY_RULES` (200): If the union exceeds 200 rules, the operation **fails closed** (`deny_rule_overflow`), preventing truncation or silent policy weakening.
   - Envelope compatibility: Correctly unwraps both MemoryStore envelopes (`{ __v, __value: rules }`) and legacy raw arrays.

4. **Post-Barrier Live-State Ordering**:
   - When an import occurs, live state must be read **after** acquiring the maintenance barrier.
   - Pre-barrier reads create a race condition where owner policy modifications made while the archive is transferring/staging would be overwritten. Post-barrier reading guarantees zero lost deny rules.

---

## 5. Integration Roadmap

- The unit classifier is landed on `main` at `b5c65f0c`.
- The engine acceptance invariants and falsification tests are landed in `tests/board-deny-engine-contract.test.ts`.
- Full runtime execution of the streaming restore engine is tracked under `chrome-agent-platform-11rm` and `chrome-agent-platform-8fuc`.
