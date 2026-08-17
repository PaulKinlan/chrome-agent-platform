import { assertEquals } from "jsr:@std/assert@1";
import { modelsForVendor } from "../extension/lib/model-prices.js";

Deno.test("modelsForVendor filters to the vendor's priced models", () => {
  const claude = modelsForVendor("anthropic");
  assertAll(claude, "claude-");
  assertIncludes(claude, "claude-opus-5");
  assertIncludes(claude, "claude-fable-5");
  assertIncludes(claude, "claude-haiku-4-5");

  const deepseek = modelsForVendor("deepseek");
  assertAll(deepseek, "deepseek-");
  assertIncludes(deepseek, "deepseek-v4-pro");
  assertIncludes(deepseek, "deepseek-v4-flash");
  assertIncludes(deepseek, "deepseek-coder");
});

Deno.test("modelsForVendor sorts newest-first", () => {
  const gpt = modelsForVendor("openai");
  // The newest gpt-5.x flagship families come before gpt-4.x.
  const i5 = gpt.findIndex((m) => m.startsWith("gpt-5"));
  const i4 = gpt.findIndex((m) => m.startsWith("gpt-4"));
  assertEquals(i5 < i4, true);

  const gemini = modelsForVendor("gemini");
  const i37 = gemini.indexOf("gemini-3.7-flash");
  const i15 = gemini.findIndex((m) => m.startsWith("gemini-1.5"));
  assertEquals(i37 < i15, true);
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
