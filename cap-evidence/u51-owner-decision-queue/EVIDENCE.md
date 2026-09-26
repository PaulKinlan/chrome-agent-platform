# Evidence: chrome-agent-platform-u51 (Product decisions blocking tracked work)

## Summary of Reconciled Statuses

In accordance with master-opus review, owner decisions are strictly un-decided unless explicitly confirmed by Paul with verbatim citation:

1. **Q11 (Extension Name & Distribution)**: **RESOLVED (Paul, 2026-09-18)**
   - Quote: *"I don't need this to be in the store at all. Close this issue / requirement. Keep the name as is."*
   - Product name remains **Chrome Agent Platform**.
   - Distribution is strictly unpacked/developer demo (no CWS release). `CAP-FB-20260825-WEBSTORE-RELEASE-01` closed as not required.

2. **Q12 (Recommended Model for Hub)**: **ANSWERED (2026-09-01)**
   - Settled in base as `ANSWERED (2026-09-01)` with OpenAI `gpt-5.6-luna` shipped as Recommended and Gemini `gemini-3.7-flash` as Alternative. Follow-on `chrome-agent-platform-q2tc` measures balance before offering others.

3. **Q13 (Owner-Selected Wasm Distribution Policy)**: **OPEN (for Paul)**
   - The Store release half is moot per Q11 (no CWS release).
   - Whether owner-selected Wasm is enabled in the developer/unpacked build remains an open question for Paul.
   - Updated `chrome-agent-platform-tzc` Blockers to link directly to this open question.

4. **Q14 (Co-do Licence Reconciliation)**: **RESOLVED (2026-09-05, Pillar 4)**
   - No Co-do binaries copied into platform. Shipped tools are built from in-repo sources or pinned releases with SBOM provenance and SPDX declarations. Closed in `chrome-agent-platform-39is`.

5. **Q16 (Grouped Tabular Artifact Promotion)**: **OPEN (for Paul)**
   - Directive dptw (2026-09-03) set `ASSET_BOUNDS.maxContentBytes = Infinity` as context.
   - The architectural decision between atomic grouped chunked promotion vs unbounded single-body retention remains an open decision for Paul.

6. **Q17 (`debugger` & `open_side_panel` posture)**: **RESOLVED (Paul, 2026-08-27 & 2026-08-30)**
   - Full text and developer-only surface requirement restored verbatim from base.

7. **Q22 (Permission Card Bundling)**: **OPEN (for Paul)**
   - Restored requirement: Owner call needed before `CAP-FB-20260830-EXEC-DEMO-01`'s final recording. The pre-prompt capability bundle is an option, not a decided next action.

## Verification
- `tests/docs-process-truth.test.ts`: 10/10 passed.
- `tests/settings-strings-audit.test.ts`: 6/6 passed.
