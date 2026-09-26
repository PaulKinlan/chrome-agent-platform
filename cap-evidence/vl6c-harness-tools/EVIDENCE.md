# chrome-agent-platform-vl6c — Expose Existing CAP Tool Catalogue to ACP Harness Runs

**Bead:** `chrome-agent-platform-vl6c`  
**Candidate branch:** `cap/gemini-vl6c-harness-tools` @ worktree `/home/paulkinlan/worktrees/cap-gemini-vl6c`  
**Base:** `origin/main` @ `3a5d002f0`  
**Author:** `cap-gemini` (Gemini 3.8 Flash)  
**Date:** 2026-09-26  

---

## 1. Summary & Architecture

`chrome-agent-platform-vl6c` exposes the existing Chrome Agent Platform tool catalogue to ACP harness runs (such as Claude Code and Codex). Rather than creating a separate tool registry, external harnesses connect via the ACP WebSocket bridge (`scripts/acp-bridge.ts`) and receive an authenticated HTTP MCP tool endpoint exposing CAP's lazy `search_tools` / `execute_tool` interface.

Key architectural boundaries:
1. **Durable Agent Loop Integration:** Harness selections route through standard durable `agent.run` execution in `extension/background/service-worker.js` and `extension/shared/conversation.js`. The model backend is adapted via `createAcpModelProxy` (`extension/lib/acp-model-proxy.js`) and hosted in the offscreen document (`extension/lib/acp-model-host.js`).
2. **Reverse RPC Channel:** In `scripts/lib/acp-tools.ts`, a connection-scoped reverse RPC channel (`_cap/tools/list` and `_cap/tools/call`) forwards tool requests between the harness adapter and the CAP service worker.
3. **Run-Bound In-Context Approvals:** Native permission prompts (`acp-permission`) bind strictly to the active `executionId` and `documentId`. Approvals are resolved directly through the conversation UI card via `run.resolve-inline-approval`, with automatic timeout/denial fallback.

---

## 2. Rebase & Fixture Repairs (Carrying `x1zq`)

The candidate rebased cleanly onto current `origin/main` (`3a5d002f0`), incorporating the four test fixture repairs from `x1zq`:
1. `tests/bundle-budget.test.ts`: Uses durable scratch directory `durableDir("bundle-budget-tests")` rather than raw `/tmp`.
2. `tests/offscreen-single-listener.test.ts`: Added `runtime.onConnect` stub so listener assertions hold.
3. `tests/first-run-onboarding-composition.test.ts`: Adapted `provider.permission-summary` signature regex.
4. `tests/changelog.test.ts`: User-facing release notes replacing internal engineering jargon.

---

## 3. Verification & Acceptance Gates

- **Focused ACP & Regression Test Suites (57 passed / 0 failed):**
  - `tests/acp-model-host.test.ts`: 2 passed / 0 failed
  - `tests/acp-model.test.ts`: 3 passed / 0 failed
  - `tests/acp-tools.test.ts`: 2 passed / 0 failed
  - `tests/conversation-run-sequence.test.ts`: 14 passed / 0 failed (includes durable `agent.run` dispatch check)
  - `tests/threads.test.ts`: 15 passed / 0 failed (includes harness selection persistence across continuations)
  - `tests/offscreen-single-listener.test.ts`: 1 passed / 0 failed
  - `tests/first-run-onboarding-composition.test.ts`: 7 passed / 0 failed
  - `tests/bundle-budget.test.ts`: 13 passed / 0 failed
  - `tests/changelog.test.ts`: 15 passed / 0 failed
- **Bundle Budget & Production Build:**
  - `npm run build:production`: Service worker bundle size is 2,991,949 bytes (passes packaging budget <= 3,000,000 bytes).
  - Built atomically with dist.complete verification.
- **Diagnostics & Vocabulary:**
  - `npm run note:dist`: Clean.
  - `npm run check:vocabulary`: Clean (17 surfaces).
