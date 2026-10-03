# Evidence: chrome-agent-platform-sqf5

## Problem
ACP harness browser-tool calls ran as the owner's page (`principal: "extension"`), which led to two defects:
1. Gated tools received a Settings refusal (`"This operation requires owner approval in Settings."`) rather than raising the in-conversation live approval card that CAP's own model runs get.
2. The Service Worker (SW) had no verified live run identity for ACP tool calls, so it could not refuse tool calls originating from an ended turn.
3. The harness could attempt to smuggle pre-approved status (`approved: true`) or an arbitrary `executionId`.

## Root Cause Analysis
1. In `AcpClient._handleAgentRequest`: `chrome.runtime.sendMessage` dispatched `{ type: "browser.callTool", name, args }` without attaching a verified execution ID, and without stripping harness-injected `approved` or `executionId` fields from `args`.
2. In `service-worker.js`: `handlers["browser.callTool"]` ran the toolset using the incoming message context (`principal: "extension"`), which failed `approvalExecutionId` for anything outside the Settings document (`approvalResolverDocument`), causing `requireOwnerApproval` to issue a Settings refusal.
3. In `acp.journal`: `action === "open"` minted an `acp:` execution ID for thread settling, but did not register a durable run in `durableRuns` nor register in `activeExecutions`. Consequently, the SW had no live execution state to fence against or recover upon SW restart.

## Implementation Details
1. **Durable Registry Admission**:
   - Updated `validExecutionId` in `extension/lib/durable-runs.js` to accept `acp:` execution IDs (`/^acp:[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,194}$/`).
   - In `service-worker.js` route `acp.journal` (`action: "open"`): mints/receives execution ID, maps owning document in `harnessRunDocuments`, registers in `activeExecutions` via `beginExecution`, and admits to `durableRuns`.
   - On `action: "result"` or `action: "cancel"`: finalizes execution via `endExecution`, cleans `harnessRunDocuments`, and settles the run durably via `durableRuns.settle`.
2. **Harness Client Boundary (`AcpClient`)**:
   - `AcpClient` captures `this.executionId` upon initialization and supports `setExecutionId`.
   - When dispatching `browser/call_tool`, it explicitly strips any harness-supplied `approved`, `executionId`, or `id` fields from `params.args`, attaching only `this.executionId`.
3. **SW Route Gating & Execution Context (`browser.callTool`)**:
   - Validates execution liveness via `isExecutionLive(executionId)`. If missing or no longer active, fails closed with `{ ok: false, error: "harness_run_not_active" }`.
   - If SW restarts mid-turn, `isExecutionLive` recovers the run authority and owning document from `durableRuns.list()`, restoring it into `activeExecutions`.
   - Dispatches tool gates under `principal: "model"` carrying `executionId`, `resolverDocumentId`, and `onApprovalEvent`.
   - Destructive action policy `"never"` refuses immediately with `{ ok: false, approvalDenied: true }` without raising a card.
   - Gated tools (`close_tab`, `wipe_browsing_data`, `write_file`):
     - `close_tab`: raises in-conversation live approval card. Deny leaves tab open; Approve closes tab.
     - `write_file`: dispatches with `principal: "model"` to `fs-grant.write-file-approved` to stage the diff for the approval card.
     - Ignores caller-supplied `approved: true` whenever an `executionId` is present.

## Verification
- Unit test suite: `tests/harness-run-identity.test.ts` (7 tests, all passing):
  - AcpClient attaches execution ID and strips harness-injected fields.
  - SW refuses calls carrying ended or non-live run IDs.
  - SW ignores harness `approved: true` and dispatches under `principal: "model"`.
  - Destructive action policy "never" refuses with no card shown.
  - `close_tab` over `browser.callTool` raises live card; Deny leaves tab open, Approve closes tab.
  - `write_file` dispatches with `principal: "model"` to `fs-grant.write-file-approved` for diff card.
  - Live run survives SW restart mid-turn via durable registry recovery.
- Regression suites:
  - `tests/browser-tool-proxy.test.ts` (12 passed)
  - `tests/harness-destructive-approval.test.ts` (6 passed)
  - `tests/acp-thread-journal.test.ts` (7 passed)
  - `tests/acp-browser-tool-loop.test.ts` (6 passed)
  - `tests/sw-dispatch-authority-census.test.ts` (5 passed)
  - `tests/code-health.test.ts` (5 passed)
  - `npm run check:vocabulary` (17 surfaces, all valid)
  - `npm run build:production` (2,534,571 bytes <= 3.0 MB budget)
