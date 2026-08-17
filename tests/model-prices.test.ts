// @ts-nocheck
// tests/model-prices.test.ts — the bundled pricing table covers the models the
// extension actually uses, so agent-do cost tracking + spending limits stay
// enabled (the "[agent-do] No pricing entry for model ..." warning stops).
import { MODEL_PRICING } from "../extension/lib/model-prices.js";

function price(modelId) {
  const normalized = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  // agent-do's longestPrefixMatch semantics: exact, then longest prefix.
  if (MODEL_PRICING[normalized]) return MODEL_PRICING[normalized];
  let best = null;
  for (const key of Object.keys(MODEL_PRICING)) {
    if (!normalized.startsWith(key)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best === null ? null : MODEL_PRICING[best];
}

Deno.test("model pricing covers gemini-3.7-flash (the model Paul hit)", () => {
  const p = price("gemini-3.7-flash");
  if (!p) throw new Error("gemini-3.7-flash missing");
  if (!(p.input > 0 && p.output > 0)) throw new Error("expected non-zero rates");
});

Deno.test("model pricing covers the deepseek + kimi + openai + anthropic families", () => {
  for (const m of ["deepseek-v4-pro", "deepseek-chat", "kimi-k2-thinking-turbo", "gpt-4o", "claude-opus-4-5", "gemini-2.5-flash", "glm-5.2"]) {
    if (!price(m)) throw new Error(`${m} missing from the pricing table`);
  }
});

Deno.test("on-device models are zero-cost (no cost tracking noise)", () => {
  for (const m of ["gemini-nano", "chrome-prompt-api"]) {
    const p = price(m);
    if (!p) throw new Error(`${m} missing`);
    if (p.input !== 0 || p.output !== 0) throw new Error(`${m} should be zero-cost`);
  }
});

Deno.test("dated/suffixed variants resolve via prefix", () => {
  // gemini-3.7-flash-preview-12-2025 → gemini-3.7-flash (longest prefix).
  const p = price("gemini-3.7-flash-preview-12-2025");
  if (!p || !(p.input > 0)) throw new Error("prefix resolution failed");
});
