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
  table[id] = { input: Number(input), output: Number(output) };
}
for (const f of FREE_MODELS) table[f] ??= { input: 0, output: 0 };

const L = [];
L.push("// lib/model-prices.js — bundled model pricing (per 1M tokens, USD).");
L.push("//");
L.push("// Source: https://www.llm-prices.com/current-v1.json (model id -> {input, output}");
L.push("// per-1M-token USD). Plus zero-cost entries for the on-device models");
L.push("// (gemini-nano / the Chrome Prompt API).");
L.push("//");
L.push("// REFRESH: node scripts/refresh-model-prices.mjs");
L.push("// An unknown model falls back to agent-do 0-cost estimate (best-effort).");
L.push("export const MODEL_PRICING = {");
for (const [k, v] of Object.entries(table).sort()) {
  L.push(`  ${JSON.stringify(k)}: { input: ${v.input}, output: ${v.output} },`);
}
L.push("};");

writeFileSync(join(ROOT, "extension", "lib", "model-prices.js"), L.join("\n") + "\n");
console.log(`wrote extension/lib/model-prices.js (${Object.keys(table).length} models)`);
