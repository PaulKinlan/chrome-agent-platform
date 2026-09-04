import { assertEquals } from "jsr:@std/assert@1";
import { modelsForVendor } from "../extension/lib/model-prices.js";

Deno.test("modelsForVendor filters to the vendor's priced models", () => {
  const claude = modelsForVendor("anthropic");
  assertAll(claude, "claude-");
  assertIncludes(claude, "claude-opus-5");
  assertIncludes(claude, "claude-fable-5");
  assertIncludes(claude, "claude-sonnet-5");

  const deepseek = modelsForVendor("deepseek");
  assertAll(deepseek, "deepseek-");
  assertIncludes(deepseek, "deepseek-v4-pro");
  assertIncludes(deepseek, "deepseek-v4-flash");
  assertIncludes(deepseek, "deepseek-coder");
});

Deno.test("modelsForVendor sorts newest-first", () => {
  const gpt = modelsForVendor("openai");
  // The newest gpt-5.6 flagship families come before gpt-5.5 / gpt-5.4.
  const i56 = gpt.findIndex((m) => m.startsWith("gpt-5.6"));
  const i55 = gpt.findIndex((m) => m.startsWith("gpt-5.5"));
  assertEquals(i56 >= 0 && i55 >= 0, true, "expected both gpt-5.6 and gpt-5.5");
  assertEquals(i56 < i55, true);

  const gemini = modelsForVendor("gemini");
  const i37 = gemini.indexOf("gemini-3.7-flash");
  const i31 = gemini.findIndex((m) => m.startsWith("gemini-3.1"));
  assertEquals(i37 >= 0 && i31 >= 0, true, "expected both gemini-3.7 and gemini-3.1");
  assertEquals(i37 < i31, true);
});

Deno.test("modelsForVendor returns [] for an unknown vendor", () => {
  assertEquals(modelsForVendor("unknown").length, 0);
});

function assertAll(models: string[], prefix: string) {
  for (const m of models) assertEquals(m.startsWith(prefix), true, `${m} lacks ${prefix}`);
}
function assertIncludes(models: string[], id: string) {
  assertEquals(models.includes(id), true, `missing ${id} in ${models.length} models`);
}

// CAP-FB-20260830-MODEL-CATALOG-CURRENT-01 — the price table keeps every
// historical row (old usage still needs a price), but the picker view over it
// must never offer a pricing pseudo-id (`-272k` is a context tier, OpenAI
// 404s it) or a retired family.
Deno.test("modelsForVendor never returns a pricing-tier id", () => {
  for (const vendor of ["openai", "anthropic", "gemini", "deepseek"]) {
    for (const id of modelsForVendor(vendor)) {
      assertEquals(/-\d+k$/.test(id), false, `${vendor}: ${id} is a pricing tier`);
    }
  }
  assertEquals(modelsForVendor("openai")[0], "gpt-5.6-terra");
});

Deno.test("modelsForVendor never returns a retired id", () => {
  const retired = /^(gpt-4|o[134]\b|o[134]-|chatgpt-4|gemini-[12][.-]|claude-3|claude-(sonnet|opus|haiku)-4|grok-3|glm-4)/;
  for (const vendor of ["openai", "anthropic", "gemini", "deepseek"]) {
    for (const id of modelsForVendor(vendor)) {
      assertEquals(retired.test(id), false, `${vendor}: ${id} is retired`);
    }
  }
});

// ── beads chrome-agent-platform-pf0k (2026-09-02): price-audit gates.
// Falsification: revert the claude-fable-5-1 / gemini-3.8-flash rows (or the
// gpt-5.6-sol correction) and these go RED.
import { MODEL_PRICING } from "../extension/lib/model-prices.js";

Deno.test("fable 5.1: same input/output as fable 5, cheaper cache-read", () => {
  const v5 = MODEL_PRICING["claude-fable-5"];
  const v51 = MODEL_PRICING["claude-fable-5-1"];
  assertEquals(v51, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
  assertEquals(v51.input === v5.input && v51.output === v5.output, true);
  assertEquals(v51.cacheRead < v5.cacheRead, true, "fable 5.1 cache-read must be the DECREASED figure");
});

Deno.test("gemini-3.8-flash is priced identically to gemini-3.7-flash", () => {
  assertEquals(MODEL_PRICING["gemini-3.8-flash"], { input: 0.75, output: 3.75, cacheRead: 0.075 });
  assertEquals(MODEL_PRICING["gemini-3.8-flash"], MODEL_PRICING["gemini-3.7-flash"]);
});

Deno.test("gpt-5.6-sol reflects the 2026-09-02 source (stale 5/30 corrected to 4/20)", () => {
  assertEquals(MODEL_PRICING["gpt-5.6-sol"], { input: 4, output: 20, cacheRead: 0.4 });
});

Deno.test("the audit doc covers every picker-visible id", async () => {
  const doc = await Deno.readTextFile(new URL("../docs/MODEL-PRICE-AUDIT-2026-09-02.md", import.meta.url));
  const seen = new Set<string>();
  for (const vendor of ["openai", "anthropic", "gemini", "deepseek"]) {
    for (const id of modelsForVendor(vendor)) seen.add(id);
  }
  // Catalogue-only ids (suggested/defaults, and the BYO examples) are
  // picker-visible without flowing through modelsForVendor.
  const { MODEL_CATALOG } = await import("../extension/lib/model-catalog.js");
  for (const entry of Object.values(MODEL_CATALOG) as Array<{ default: string; suggested: string[]; examples?: string[] }>) {
    for (const id of [entry.default, ...entry.suggested, ...(entry.examples ?? [])].filter(Boolean)) seen.add(id);
  }
  for (const id of seen) {
    assertEquals(doc.includes(id), true, `audit doc lacks a row for picker-visible id ${id}`);
  }
  assertEquals(doc.includes("2026-09-02"), true, "audit doc must carry the check date");
});
