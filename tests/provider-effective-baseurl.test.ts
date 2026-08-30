// A preset provider saved without a base URL is a complete config; only a
// BYO endpoint with no URL is unconfigured (CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01,
// surfaced by the PROVIDER-ERROR-TRUTH-01 x MODEL-CATALOG-CURRENT-01 merge).
import { assertEquals } from "jsr:@std/assert@1";
import { effectiveBaseURL, withEffectiveBaseURL } from "../extension/lib/provider.js";
import { providerOriginPattern } from "../extension/lib/provider-gate.js";

Deno.test("effectiveBaseURL: an OpenAI preset with an empty base URL resolves to the preset endpoint", () => {
  assertEquals(effectiveBaseURL({ provider: "openai", baseURL: "" }), "https://api.openai.com/v1");
  assertEquals(providerOriginPattern(withEffectiveBaseURL({ provider: "openai", baseURL: "", apiKey: "k", model: "" })), "https://api.openai.com/*");
});

Deno.test("effectiveBaseURL: a stored base URL always wins over the preset", () => {
  assertEquals(effectiveBaseURL({ provider: "openai", baseURL: "https://proxy.example/v1" }), "https://proxy.example/v1");
});

Deno.test("effectiveBaseURL: a BYO endpoint with no URL stays unconfigured", () => {
  assertEquals(effectiveBaseURL({ provider: "openai-compatible", baseURL: "" }), "");
  assertEquals(providerOriginPattern(withEffectiveBaseURL({ provider: "openai-compatible", baseURL: "" })), null);
});
