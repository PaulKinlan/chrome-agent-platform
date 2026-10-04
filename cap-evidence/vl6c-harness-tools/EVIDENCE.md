# chrome-agent-platform-vl6c — Expose Existing CAP Tool Catalogue to ACP Harness Runs

**Bead:** `chrome-agent-platform-vl6c`  
**Candidate branch:** `cap/gemini-vl6c-harness-tools` @ worktree `/home/paulkinlan/worktrees/cap-gemini-vl6c`  
**Base:** `origin/main` @ `e362fd80`  
**Author:** `cap-gemini` (Gemini 3.8 Flash)  
**Date:** 2026-10-03  

---

## 1. Summary & Architecture

`chrome-agent-platform-vl6c` exposes the existing Chrome Agent Platform tool catalogue to ACP harness runs (such as Claude Code and Codex). Rather than creating a separate tool registry, external harnesses connect via the ACP WebSocket bridge (`scripts/acp-bridge.ts`) and receive an authenticated HTTP MCP tool endpoint exposing CAP's lazy `search_tools` / `execute_tool` interface.

Key architectural boundaries:
1. **Durable Agent Loop Integration:** Harness selections route through standard durable `agent.run` execution in `extension/background/service-worker.js` and `extension/shared/conversation.js`. The model backend is adapted via `createAcpModelProxy` (`extension/lib/acp-model-proxy.js`) and hosted in the offscreen document (`extension/lib/acp-model-host.js`).
2. **Reverse RPC Channel:** In `scripts/lib/acp-tools.ts`, a connection-scoped reverse RPC channel (`_cap/tools/list` and `_cap/tools/call`) forwards tool requests between the harness adapter and the CAP service worker.
3. **Run-Bound In-Context Approvals:** Native permission prompts (`acp-permission`) bind strictly to the active `executionId` and `documentId`. Approvals are resolved directly through the conversation UI card via `run.resolve-inline-approval`, with automatic timeout/denial fallback.

---

## 2. Review Findings Addressed (master-opus V1–V4, B1–B3, N1, N2, N5)

- **V1 (CHANGELOG integrity):** Restored full 3,032-line `CHANGELOG.md` from `origin/main`, adding only the new 0.3.566 entry at the top.
- **V2 (Rebase onto main e362fd80):** Rebased cleanly onto `origin/main` @ `e362fd80` (carrying landed `sqf5`). `extension/lib/acp-client.js` merges both `sqf5` executionId attachment / args stripping (preserving `args.id`) and N1 refusal.
- **V3 & B1 (Skip prompt declaration on toolsEnabled):** In `scripts/acp-bridge.ts:814`, `applyBrowserToolDeclaration` is skipped whenever `toolsEnabled` is true, ensuring neither Claude Code nor Pi is told to emit raw JSON-RPC text instructions when driving MCP/model sessions.
- **B2 (Pi and native transport chat path preserved):** In `extension/lib/acp-run-config.js` and `extension/lib/acp-model-host.js`, removed artificial errors for `pi` and native transport. Pi connects cleanly as a chat harness, and native transport is supported.
- **B3 (Documentation updated):** Updated `docs/ACP-HARNESS-TOOLS.md` to reflect verified live architecture, removing stale "must not be merged" and budget warnings.
- **N1 (Legacy tool method disabled when toolHandler active):** In `extension/lib/acp-client.js`, `browser/call_tool` returns `-32601` with `"browser/call_tool is disabled when toolHandler is configured"` if `this.toolHandler` is active.
- **N2 (Private _cap namespace protected):** In `scripts/acp-bridge.ts`, adapter-originated frames targeting `_cap/` are dropped.
- **N5 (Dead import cleanup):** Removed unused `runAcpTaskTurn` import from `extension/ntp/ntp.js`.

---

## 3. Real Live Harness Acceptance Run (V4)

Driven via `cap-evidence/vl6c-harness-acceptance-run.ts` against the live ACP bridge on port 3296 with authentic CLI adapters:
```
[acceptance] Starting ACP bridge on port 3296...
Listening on http://127.0.0.1:3296/

[test 1] Codex: query tools over MCP and call list_tabs...
[acp-bridge] Client connected from local script (harness: codex)
  Codex response: I’ll look up the available browser/devtools tab tool and call the tab lister directly.Open tabs found:

- `42` — Example Domain
  PASS: Codex called list_tabs via reverse-RPC MCP endpoint
  PASS: Codex response mentions the open tab (Example Domain)

[test 2] Codex: call close_tab, trigger approval card, and receive denial...
[acp-bridge] Client disconnected, cleaning up adapter process
[acp-bridge] Client connected from local script (harness: codex)
  Codex response: I’ll look for the tab-control tool you named and use it directly if it’s available.I tried to close tab `42`, but the owner approval was denied, so the tab was not closed.
  PASS: Codex called close_tab
  PASS: Codex acknowledged that owner approval was denied

[test 3] Pi: pure chat turn over bridge (tool-less chat path)...
[acp-bridge] Client disconnected, cleaning up adapter process
[acp-bridge] Client connected from local script (harness: pi)
  Pi response: New version available: v1.0.0 (installed v0.87.1). Run: `npm i -g @earendil-works/pi-coding-agent`
pong
  PASS: Pi completed chat turn successfully
  PASS: Pi response contains expected text ('pong')

[acceptance] Shutting down bridge...
[acp-bridge] Client disconnected, cleaning up adapter process

[acceptance summary] Passed: 6, Failed: 0
```

Note: In-process bridge handshake and protocol smoke checks are preserved in `cap-evidence/vl6c-bridge-smoke.ts`.

---

## 4. Measured Gates and Ceilings

Production store build on rebased head:
| Surface | Size | Ceiling | Status |
| --- | ---: | ---: | --- |
| Store background/service-worker.js | 2,544,739 B | 3,000,000 B | PASS |
| Workers/agent-worker.js | 846,602 B | 2,000,000 B | PASS |
| options.bundle.js | 889,522 B | 900,000 B | PASS |
| ntp.bundle.js | 880,740 B | 920,000 B | PASS |
| sidepanel.bundle.js | 665,925 B | 700,000 B | PASS |
| shared/diff-core.bundle.js | 16,611 B | 17,000 B | PASS |

- `npm run check:vocabulary`: Clean (17 surfaces).
- `npm run note:dist`: Clean.
- Test suites: 100/100 passed across `acp-tools`, `acp-model`, `acp-model-host`, `harness-run-identity`, `changelog`, `threads`, `conversation-run-sequence`.
