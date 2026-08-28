# Usage visualizations — design (FolioLM reference study + adoption)

Owner ask: upgrade the Settings → Usage panel to FolioLM-style "graphical
visualisations of tool usage, token usage and cost breakdowns, graphs".

## 1. What FolioLM (PaulKinlan/NotebookLM-Chrome) does

Studied `src/lib/usage.ts`, `src/lib/provider-registry.ts`,
`src/sidepanel/components/UsageStatsModal.tsx` (cloned at HEAD, 2026-08-28):

- **Storage**: one `usageRecords` array in `chrome.storage.local`, rolling
  10,000-record cap. Record: `{id, modelConfigId, providerId, model,
  inputTokens, outputTokens, totalTokens, timestamp, operation, cost}`.
- **Cost**: computed AT RECORD TIME from a per-provider/model pricing table
  ($/1M input, $/1M output); `null` when the model is unknown (rendered as 0).
- **Aggregation**: `getUsageStats` (totals + requestCount over the selected
  range) + `getUsageDataPoints` (records grouped by DAY, `YYYY-MM-DD` keys).
- **UI**: a modal with (a) five stat cards — Total tokens, Input Tokens,
  Output Tokens, Estimated Cost, API Requests; (b) a canvas bar chart of
  usage-over-time per day with gridlines, axis labels, colors read from CSS
  custom properties (theme-aware); (c) a time-range selector
  (day/week/month/quarter/year); (d) an honest "No usage data available"
  empty state drawn inside the chart.

## 2. What CAP already tracks (honest inventory)

- **Ledger**: `lib/usage.js` + `lib/usage-store.js` — per-LLM-call rows in the
  IndexedDB sole-authority ledger (`cap-usage`), rolling **7-day** retention
  (MAX_RECORDS 5000). Row: `{id, timestamp, agentId, taskId, provider, model,
  inputTokens, outputTokens, totalTokens, estimatedCost}`.
- **Aggregates already computed** by `usage.get`: `totals`, `byModel`,
  `byProvider`, `byAgent`, `byTask`, `byDay` (calls/tokens/cost each).
- **Cost**: `lib/model-prices.js` — bundled per-1M-token USD pricing
  (llm-prices.com snapshot, refreshable); unknown models estimate 0. All cost
  figures are ESTIMATES and are labelled as such.
- **Tool usage**: NOT in the ledger today. The service worker's single tool
  executor (`executeWorkerTool`) is the chokepoint for browser + management
  tool calls from agent runs — this feature adds a bounded per-day per-tool
  call counter there. KNOWN GAP (disclosed): bundled WASM capability tools and
  any in-page tool execution do not pass that chokepoint and are not counted.

## 3. Adoption decisions

| FolioLM | CAP adoption |
|---|---|
| chrome.storage array, 10k cap | keep our IndexedDB ledger (7d) — stronger durability story, no change |
| cost at record time | already true (model-prices); label every figure "estimate" |
| day-bucketed data points | `dayBuckets()` fills ALL days of the window (zero-filled) so bars align |
| 5 stat cards | same: Total tokens, Input, Output, Est. cost, Calls |
| canvas bar chart | **SVG** instead (no canvas DPI juggling, DOM-a11y, theme tokens via `var()`) |
| time range day..year | only **24h / 7d** — the ledger retention is 7 days; offering month/quarter would show empty lies |
| modal | inline panel section (Usage already lives in Settings) |
| — (no per-tool viz) | ADD per-tool call bars (owner ask) + per-agent share bars (we have the dimension) |
| charts on canvas (no a11y) | every chart gets `role="img"` + aria-label AND the numeric tables stay on the page (the pre-existing "Show detail" tables) |

Charts are hand-rolled SVG string builders in `lib/usage-viz.js` (pure,
Deno-testable; all dynamic text escaped; colors from theme tokens so the dark
scheme applies automatically). Aggregation happens over the ALREADY-AGGREGATED
`usage.get` output — no raw-row scans in the UI (the thread-open lesson).

## 4. Non-goals

- No chart library. No new permissions. No changes to the ledger schema.
- No month/quarter ranges (retention is 7 days; the selector must not lie).
- No per-token live streaming; the panel renders on open + range switch only.
