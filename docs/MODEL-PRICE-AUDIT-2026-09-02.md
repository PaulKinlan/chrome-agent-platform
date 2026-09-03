# Model price audit — 2026-09-02

Owner ask (beads pf0k): add gemini-3.8-flash and claude-fable-5-1 to the model
picker/catalog, and verify the price of every model the picker can offer
against a published source. Prices are per 1M tokens, USD.

## Sources

- **llm-prices.com `current-v1.json`** (fetched 2026-09-02; `updated_at:
  2026-09-02`) — the catalog's declared upstream; `input`, `output`,
  `input_cached` per id.
- **https://www.anthropic.com/pricing** (fetched 2026-09-02) — Claude family,
  including prompt-caching read/write prices.
- **https://ai.google.dev/gemini-api/docs/pricing** (fetched 2026-09-02) —
  Gemini family, including context-caching prices.
- openai.com/api/pricing returned 403 (bot-blocked) at audit time; OpenAI rows
  are verified against llm-prices only, and rows llm-prices does not list are
  marked unverifiable rather than guessed.

Scope: every id the pickers can show — `MODEL_CATALOG` defaults/suggested/
examples plus the `modelsForVendor` derived lists (the Providers section
catalogue) — 42 ids.

## Results

| id | input | output | cache-read | cache-write | source | status |
| --- | --- | --- | --- | --- | --- | --- |
| gemini-3.8-flash | 0.75 | 3.75 | 0.075 | — | ai.google.dev/gemini-api/docs/pricing + llm-prices | **added** (new model, launched 2026-09-02; identical to 3.7-flash pricing) |
| claude-fable-5-1 | 10 | 50 | **0.25** | 12.50 | anthropic.com/pricing | **added** (new model, launched 2026-09-01; input/output unchanged from Fable 5, cache-read down from 1.00 → 0.25) |
| claude-fable-5 | 10 | 50 | 1.00 | 12.50 | anthropic.com/pricing | verified |
| claude-opus-5 | 5 | 25 | 0.50 | 6.25 | anthropic.com/pricing | verified (not listed by llm-prices) |
| claude-sonnet-5 | 2 | 10 | 0.20 | 2.50 | anthropic.com/pricing | verified |
| claude-4.5-haiku | 1 | 5 | 0.10 | 1.25 | anthropic.com/pricing | verified |
| claude-mythos-5 | 10 | 50 | — | — | llm-prices | verified (not on the Anthropic pricing page today) |
| gpt-5.6-luna | 0.20 | 1.20 | 0.02 | — | llm-prices | verified |
| gpt-5.6-terra | 2 | 12 | 0.20 | — | llm-prices | verified |
| gpt-5.6-sol | **4** | **20** | 0.40 | — | llm-prices | **changed** (bundle was stale at 5/30) |
| gpt-5.5 | 5 | 30 | 0.50 | — | llm-prices | verified |
| gpt-5.5-pro | 30 | 180 | — | — | llm-prices | verified |
| gpt-5.4 | 2.5 | 15 | — | — | llm-prices | verified |
| gpt-5.4-mini | 0.75 | 4.50 | 0.075 | — | llm-prices | verified |
| gpt-5.4-pro | 30 | 180 | — | — | llm-prices | verified |
| gpt-5.2 | 1.75 | 14 | — | — | llm-prices | verified |
| gpt-5.2-pro | 21 | 168 | — | — | llm-prices | verified |
| gpt-5.1 | 1.25 | 10 | — | — | llm-prices | verified |
| gpt-5.1-codex | 1.25 | 10 | — | — | llm-prices | verified |
| gpt-5.1-codex-mini | 0.25 | 2 | — | — | llm-prices | verified |
| gpt-5 | 1.25 | 10 | — | — | llm-prices | verified |
| gpt-5-mini | 0.25 | 2 | — | — | llm-prices | verified |
| gpt-5-pro | 15 | 120 | — | — | llm-prices | verified |
| gpt-5.6 | 5 | 30 | — | — | — | **unverifiable** (not in llm-prices; openai.com blocked the audit fetch) — bundle value left as-is |
| gpt-5.3 | 2.5 | 15 | — | — | — | **unverifiable** (same) |
| gemini-3.7-flash | 0.75 | 3.75 | 0.075 | — | ai.google.dev/gemini-api/docs/pricing | verified |
| gemini-3.6-flash | 0.75 | 3.75 | 0.075 | — | ai.google.dev/gemini-api/docs/pricing | verified |
| gemini-3.5-flash | 1.50 | 9.00 | — | — | ai.google.dev/gemini-api/docs/pricing | verified |
| gemini-3.5-flash-lite | 0.30 | 2.50 | — | — | ai.google.dev/gemini-api/docs/pricing | verified |
| gemini-3.1-pro-preview | 2 | 12 | 0.20 | — | ai.google.dev/gemini-api/docs/pricing | **added price row** (bundle only had the dash-style `gemini-3-1-pro-preview`; the prefix matcher cannot bridge dot↔dash, so the picker id was silently 0-cost) |
| gemini-3.1-pro | 2 | 12 | 0.20 | — | ai.google.dev/gemini-api/docs/pricing | verified |
| gemini-3-1-pro-preview | 2 | 12 | — | — | ai.google.dev/gemini-api/docs/pricing | verified (legacy dash-style row kept for old usage) |
| gemini-3.1-flash-lite | 0.25 | 1.50 | 0.025 | — | ai.google.dev/gemini-api/docs/pricing | verified |
| gemini-3.1-flash-lite-preview | 0.25 | 1.50 | — | — | ai.google.dev/gemini-api/docs/pricing | verified |
| gemini-3-pro-preview | 2 | 12 | — | — | llm-prices | verified |
| gemini-3-flash | 0.50 | 3.00 | 0.05 | — | ai.google.dev/gemini-api/docs/pricing | verified (the page prices the `-preview` id this row prices old usage for) |
| gemini-3-flash-preview | 0.50 | 3.00 | — | — | ai.google.dev/gemini-api/docs/pricing | verified |
| gemini-flash-latest | 0.75 | 3.75 | 0.075 | — | ai.google.dev/gemini-api/docs/pricing | **added price row** — provider alias; resolves to gemini-3.8-flash as of 2026-09-02, re-verify when the alias rolls forward |
| deepseek-v4-flash | 0.14 | 0.28 | 0.028 | — | llm-prices | verified |
| deepseek-v4-pro | 1.74 | 3.48 | 0.145 | — | llm-prices | verified |
| deepseek-chat | 0.27 | 1.10 | — | — | llm-prices | verified |
| deepseek-reasoner | 0.55 | 2.19 | — | — | llm-prices | verified |
| deepseek-coder | 0 | 0 | — | — | — | **unverifiable** (no published price today; bundled as zero-cost) |
| grok-4.6 | 2 | 6 | 0.50 | — | llm-prices | verified |
| glm-5.3 | — | — | — | — | — | **unverifiable** (z.ai pricing page 404 at audit time; not in llm-prices). Example placeholder for BYO endpoints only — deliberately not in the bundled price table. |

## Notes for the next audit

- **k3 / Kimi**: k3 was removed from the Settings provider list earlier
  (unresolvable — see the `k3 review HIGH-2` note in extension/lib/provider.js).
  The bundled `kimi-k2-*` rows (0.60/2.50, cache-read 0.15) match llm-prices
  and price old usage; nothing to change.
- Gemini listed prices are the promotional tier through 2026-12-31 (they double
  from 2027-01-01 per the Google page).
- `scripts/refresh-model-prices.mjs` now carries `input_cached` → `cacheRead`
  and preserves MANUAL_ROWS (claude-opus-5, gemini-3.1-pro-preview,
  gemini-flash-latest) so a refresh does not drop picker rows the source lacks.
- Cache-read/write fields are additive documentation-in-data; agent-do's cost
  math reads only {input, output}.
