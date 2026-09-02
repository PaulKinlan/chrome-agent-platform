#!/usr/bin/env node

// Regenerate extension/lib/model-prices.js from the llm-prices.com dataset.
//
//   node scripts/refresh-model-prices.mjs
//
// Fetches https://www.llm-prices.com/current-v1.json (model id -> {input, output}
// per-1M-token USD) and rewrites the bundled MODEL_PRICING table, keeping the
// zero-cost on-device entries. Run this when the upstream prices drift; the
// checked-in table is the committed source of truth between refreshes.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PRICING } from "agent-do";

const ROOT = new URL("..", import.meta.url).pathname;
const PRICES_URL = "https://www.llm-prices.com/current-v1.json";

// Zero-cost on-device + demo models (the Chrome Prompt API / gemini-nano and
// the built-in demo provider).
const FREE_MODELS = [
  "gemini-nano",
  "gemini-nano-prompt-api",
  "chrome-prompt-api",
  "prompt-api",
  "demo",
  "demo-local",
];

const res = await fetch(PRICES_URL);
if (!res.ok) {
  console.error(`fetch failed: ${res.status}`);
  process.exit(1);
}
const data = await res.json();
const prices = data?.prices ?? data;
if (!Array.isArray(prices)) {
  console.error("unexpected payload shape (expected { prices: [...] })");
  process.exit(1);
}

const table = { ...DEFAULT_PRICING };
for (const p of prices) {
  const id = p?.id;
  const input = p?.input;
  const output = p?.output;
  if (!id || input == null || output == null) continue;
  const row = { input: Number(input), output: Number(output) };
  // Cache-read pricing is published per row upstream (input_cached); carry it
  // so a refresh preserves the audited cache fields instead of clobbering them.
  if (p.input_cached != null) row.cacheRead = Number(p.input_cached);
  table[id] = row;
}
for (const f of FREE_MODELS) table[f] ??= { input: 0, output: 0 };

// Picker rows the pricing source does not list, verified against the
// providers' own pricing pages (docs/MODEL-PRICE-AUDIT-2026-09-02.md). A
// refresh must not drop them.
const MANUAL_ROWS = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, cacheRead: 0.2 },
  "gemini-flash-latest": { input: 0.75, output: 3.75, cacheRead: 0.075 },
};
for (const [id, row] of Object.entries(MANUAL_ROWS)) table[id] ??= row;

const L = [];
L.push("// lib/model-prices.js — bundled model pricing (per 1M tokens, USD).");
L.push("//");
L.push("// Source: https://www.llm-prices.com/current-v1.json (model id -> {input, output}");
L.push("// per-1M-token USD). Plus zero-cost entries for the on-device models");
L.push("// (gemini-nano / the Chrome Prompt API).");
L.push("//");
L.push("// Rows may add cacheRead/cacheWrite (per-1M USD) where a published source was");
L.push("// verified — additive documentation-in-data; agent-do's cost math reads only");
L.push("// {input, output}. Audit trail: docs/MODEL-PRICE-AUDIT-2026-09-02.md.");
L.push("//");
L.push("// REFRESH: node scripts/refresh-model-prices.mjs (carries cacheRead through;");
L.push("// MANUAL_ROWS there preserves picker rows the pricing source does not list).");
L.push("// An unknown model falls back to agent-do 0-cost estimate (best-effort).");
L.push("export const MODEL_PRICING = {");
for (const [k, v] of Object.entries(table).sort()) {
  const fields = [`input: ${v.input}`, `output: ${v.output}`];
  if (v.cacheRead != null) fields.push(`cacheRead: ${v.cacheRead}`);
  if (v.cacheWrite != null) fields.push(`cacheWrite: ${v.cacheWrite}`);
  L.push(`  ${JSON.stringify(k)}: { ${fields.join(", ")} },`);
}
L.push("};");

writeFileSync(join(ROOT, "extension", "lib", "model-prices.js"), L.join("\n") + "\n");
console.log(`wrote extension/lib/model-prices.js (${Object.keys(table).length} models)`);
