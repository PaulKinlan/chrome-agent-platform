# Usage authority — precedent review (CHAOS) + porting decisions

Read-only review of Paul's proven usage trackers, as directed. NotebookLM and Kodu
are NOT present locally (only CHAOS), so I record their absence rather than guess.

## CHAOS contracts (present, read-only)

`/home/paulkinlan/chaos/packages/extension/src/agents/usage.ts`:
- `UsageRecord` schema: `id, timestamp, agentId, agentName, provider, model,
  inputTokens, outputTokens, totalTokens, estimatedCost, source`.
- `recordUsage`: zero-token guard → fresh `crypto.randomUUID()` → append →
  trim (7-day retention + 5000-record cap) → `chrome.storage.local.set`.
- `getUsage`/`getUsageRecords`: filter by agentId/provider/since, newest-first.
- `getUsageSummary`: totals + byProvider/byAgent/byModel buckets.
- `clearUsage`: `chrome.storage.local.remove(STORAGE_KEY)`.
- `checkSpendingLimit`: daily limit under a separate `chaos:spending-limit:<id>` key.

`pricing.ts`: static per-1M-token PRICING table + `estimateCost` (longest-prefix).

`extension-agent.ts`: the agent-do `onUsage` hook forwards `record.inputTokens`/
`outputTokens` with no callback identity/dedup (fresh UUID per callback).

`packages/sdk/tests/conformance/usage-store.test.ts`: a `UsageStore` conformance
suite (record/query/clear/filter) run against `InMemoryUsageStore` — a clean
store ABSTRACTION decoupled from chrome.storage.

`components/views/usage-view.ts` + `state/app-state.ts`: time-range (24h/7d/30d),
stat cards, provider/agent breakdowns, recent-requests table, spending alerts.

`docs/help/usage.md` is absent (only the plan exists at plans/token-usage-tracking.md).

## What CHAOS does NOT solve (this lane's specific requirements)

CHAOS assumes the optional `storage` permission is effectively available and writes
`chrome.storage.local` directly. It has NO: IndexedDB durability, permissionless
survival across SW restarts, idempotent callback identity, atomic legacy migration,
mirror/outbox ordering, corruption quarantine, or preparse bounds. Its record id is
a fresh UUID per callback (so duplicate delivery double-counts).

## Porting decisions (semantics only, no framework code)

- KEEP the CHAOS `UsageRecord` shape + retention/cap + zero-token guard + the
  provider/agent/model aggregation semantics. My lane adds `taskId` (already in the
  existing platform ledger) and keeps `provider/model/agentId`; I will NOT add
  `agentName`/`source` (no broad UI churn).
- PORT the `UsageStore` conformance IDEA: the production authority remains IndexedDB,
  but the ledger operations are a small store surface so the reviewer probes can be
  exercised against `fake-indexeddb` (the SDK's InMemory-store spirit).
- PORT `clearUsage` = empty ledger (but as a canonical empty generation-bump, not a
  key delete — this lane's no-resurrection requirement).
- SPENDING LIMITS: out of scope for this increment (CHAOS's per-agent limit is a
  separate feature; I record it as a future port, not now).

NotebookLM / Kodu: not present locally — no claims made about their internals.
