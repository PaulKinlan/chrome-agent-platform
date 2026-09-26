# chrome-agent-platform-u51 — Resolution of Product Decision Queue

**Candidate:** branch `cap/gemini-u51-decision-queue` @ worktree `/home/paulkinlan/worktrees/cap-gemini-u51`.  
**Base:** `origin/main` @ `334f6c071`.  
**Date:** 2026-09-26.  
**Authority:** Product owner decision reconciliation across `docs/OPEN-QUESTIONS.md`, `PLAN.md`, `docs/ARCHITECTURE.md`, and dependent beads.

---

## 1. Resolution of the Five Decision Queue Items

### Q11: Final Extension Name and Distribution Channel
- **Decision:** **RESOLVED** (Paul, 2026-09-18).
  - Product name remains **Chrome Agent Platform** (no rename).
  - Distribution channel is strictly the **unpacked/developer demo** — **no Chrome Web Store release**.
- **Impact:** `CAP-FB-20260825-WEBSTORE-RELEASE-01` closed as not required.

### Q12: Recommended Default Provider for the Hub
- **Decision:** **RESOLVED** (2026-09-01).
  - OpenAI `gpt-5.6-luna` is the pre-selected Recommended provider.
  - Gemini `gemini-3.7-flash` is the documented Alternative.
  - Anthropic `claude-sonnet-5` and Z.ai `glm-5.3` remain under "More providers" pending measurement.
- **Impact:** `CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01` landed; follow-on `chrome-agent-platform-q2tc` tracks measuring additional models before adding them to recommended defaults.

### Q13: Owner-Selected Wasm Distribution Policy
- **Decision:** **RESOLVED** (2026-09-18, via Q11).
  - Because Chrome Agent Platform has no Chrome Web Store release, CWS remotely-hosted code policies do not apply.
  - Owner-selected Wasm is supported as a local/developer capability gated by explicit owner gestures and isolated within the sandboxed WASI runtime.
- **Impact:** Unblocks `chrome-agent-platform-tzc` (`CAP-FB-20260822-OWNER-WASM-INSTALL-01`) from CWS policy blocker.

### Q14: Co-do Licence and Provenance Reconciliation
- **Decision:** **RESOLVED** (2026-09-05, Pillar 4).
  - **No Co-do binaries are copied into the platform.**
  - All shipped tools are built from verified in-repo sources or pinned releases with immutable SHA-256 hashes, exact SPDX license declarations, and SBOM provenance (`STORE_WASM_LANE = "bundled-reviewed-only"`).
- **Impact:** Closed in `chrome-agent-platform-39is`.

### Q16: Grouped Tabular Artifact Promotion
- **Decision:** **RESOLVED** (2026-09-26, pursuant to dptw directive).
  - Under owner directive `dptw` (2026-09-03), `extension/lib/artifacts.js:422` set `ASSET_BOUNDS.maxContentBytes = Infinity`.
  - Single-body artifact storage is retained without size caps; chunked tabular promotion is formally deferred.
- **Impact:** `chrome-agent-platform-uwe1` resolved; `chrome-agent-platform-tq4` retains single-body storage without chunked promotion dependencies.

---

## 2. Status of Remaining Open Questions

The remaining questions in `docs/OPEN-QUESTIONS.md` are documented with concrete recommendations and next actions:
- **Q15 (Semantic Index Engine):** Defer semantic embeddings entirely for the demo; the zero-dependency lexical search is fast (< 1 ms) and covers all ~160 capabilities cleanly. Revisit only if tool catalogue exceeds 500 entries.
- **Q21 (Shared-Worker Conversation History):** Documented residual. Worker runs are stateless single-shot executions by design. Threads remain owned by the hub (`continueThread` → `runTask`).
- **Q22 (Permission Card Bundling):** Keep per-tool asks as the non-negotiable security floor. For the exec demo, introduce a pre-prompt task-level capability bundle for tab operations (`tabs` + `tabGroups`) so the owner sees exactly one prompt on step 1.

---

## 3. Verification

- `tests/docs-process-truth.test.ts`: 7/7 passed.
- `tests/settings-strings-audit.test.ts`: 4/4 passed.
- `npm run check:vocabulary`: Clean (17 surfaces verified).
- `npm run check:dist`: Clean.
