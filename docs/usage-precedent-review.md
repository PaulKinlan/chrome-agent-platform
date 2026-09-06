# Usage authority — precedent review (the owner's earlier extension) + porting decisions

Read-only review of Paul's proven usage trackers, as directed. NotebookLM and Kodu
are NOT present locally (only that earlier extension), so I record their absence rather than guess.

## The precedent's contracts (present, read-only)

`packages/extension/src/agents/usage.ts` (in the precedent's repository):
- `UsageRecord` schema: `id, timestamp, agentId, agentName, provider, model,
  inputTokens, outputTokens, totalTokens, estimatedCost, source`.
- `recordUsage`: zero-token guard → fresh `crypto.randomUUID()` → append →
  trim (7-day retention + 5000-record cap) → `chrome.storage.local.set`.
- `getUsage`/`getUsageRecords`: filter by agentId/provider/since, newest-first.
- `getUsageSummary`: totals + byProvider/byAgent/byModel buckets.
- `clearUsage`: `chrome.storage.local.remove(STORAGE_KEY)`.
- `checkSpendingLimit`: daily limit under a separate per-agent `spending-limit:<id>` key.

`pricing.ts`: static per-1M-token PRICING table + `estimateCost` (longest-prefix).

`extension-agent.ts`: the agent-do `onUsage` hook forwards `record.inputTokens`/
`outputTokens` with no callback identity/dedup (fresh UUID per callback).

`packages/sdk/tests/conformance/usage-store.test.ts`: a `UsageStore` conformance
suite (record/query/clear/filter) run against `InMemoryUsageStore` — a clean
store ABSTRACTION decoupled from chrome.storage.

`components/views/usage-view.ts` + `state/app-state.ts`: time-range (24h/7d/30d),
stat cards, provider/agent breakdowns, recent-requests table, spending alerts.

`docs/help/usage.md` is absent (only the plan exists at plans/token-usage-tracking.md).

## What the precedent does NOT solve (this lane's specific requirements)

The precedent assumes the optional `storage` permission is effectively available and writes
`chrome.storage.local` directly. It has NO: IndexedDB durability, permissionless
survival across SW restarts, idempotent callback identity, atomic legacy migration,
mirror/outbox ordering, corruption quarantine, or preparse bounds. Its record id is
a fresh UUID per callback (so duplicate delivery double-counts).

## Porting decisions (semantics only, no framework code)

- KEEP the precedent's `UsageRecord` shape + retention/cap + zero-token guard + the
  provider/agent/model aggregation semantics. My lane adds `taskId` (already in the
  existing platform ledger) and keeps `provider/model/agentId`; I will NOT add
  `agentName`/`source` (no broad UI churn).
- PORT the `UsageStore` conformance IDEA: the production authority remains IndexedDB,
  but the ledger operations are a small store surface so the reviewer probes can be
  exercised against `fake-indexeddb` (the SDK's InMemory-store spirit).
- PORT `clearUsage` = empty ledger (but as a canonical empty generation-bump, not a
  key delete — this lane's no-resurrection requirement).
- SPENDING LIMITS: out of scope for this increment (the precedent's per-agent limit is a
  separate feature; I record it as a future port, not now).

NotebookLM / Kodu: not present locally — no claims made about their internals.

## Current-main reconciliation (0.2.125 candidate)

The accepted correction is `d6030b722f3df97899564595536ff040d29a2238`; the reviewed integration precedent is `963b4114364930a8cbd4a2977a5f31999587c259`; the current target is exact `598fb12a004287753ebb78f8cc385d56e0206f77`. The earlier tracker/release reconciliation was `1ea0d6d4b3d4fb1603a2a6372de0441baa3857af`.

Content comparison, rather than base age, decides the replay:

- `extension/lib/agent.js`, `usage-store.js`, `usage.js`, the fake IDB/lock fixtures, `usage-authority.test.ts`, `e2e-task.test.ts`, and `system-prompts.test.ts` retain the exact reviewed Git blobs from `963b411`; the broader `usage.test.ts` retains later accepted coverage rather than being replaced by the stale correction branch.
- The Usage-panel refresh and single detail-toggle listener remain present in `extension/options/options.js`; current provider adapters and permission flow are retained.
- Later manifest/package/lockfile versions, Durable-run records, task-scoped controls, and provider/permission code are not replaced by either stale candidate.

The invariant remains attempt-bound: each real provider invocation gets an immutable identity; synchronous throws and asynchronous rejections drop only that attempt; plain non-Promise stream objects pass through `Promise.resolve`; AI SDK retries bind the usage callback to the successful attempt; abort/finalization clears residual queue entries. Deterministic probes 8–11 cover abort, async retry, synchronous throw, and plain-object returns. Browser evidence is a separate remaining gate.
