// tests/provider-set-route.test.ts — CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01.
//
// `provider.set` with a PRESET provider id and no base URL used to store
// `baseURL: ""` — a config the run-time preflight could never run ("configured
// provider origin is invalid") even though the product already knows the
// preset endpoint. The route now stores the EFFECTIVE base URL (preset when
// omitted); the BYO endpoint has no preset and stays empty, and `provider.status`
// says so BEFORE a run. Drives the REAL route handlers (kv falls back to its
// in-memory session store outside a browser — no chrome stub is needed).

// @ts-nocheck — dynamic route doubles (no types in Deno).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createProviderRoutes } from "../extension/background/routes/provider.js";

const SETTINGS = { principal: "owner-options" };

Deno.test("provider.set stores the preset baseURL when omitted", async () => {
  const routes = createProviderRoutes();
  const res = await routes["provider.set"](
    { config: { provider: "openai", apiKey: "sk-test-not-a-real-key", model: "gpt-5.6-sol" } },
    SETTINGS,
  );
  assertEquals(res.baseURL, "https://api.openai.com/v1");
  assertEquals(res.apiKey, "", "the route never returns the key");
  assertEquals(res.hasApiKey, true);
  const stored = await routes["provider.get"]({}, SETTINGS);
  assertEquals(stored.baseURL, "https://api.openai.com/v1");
  assertEquals(stored.model, "gpt-5.6-sol");
  // Every preset resolves, not only OpenAI.
  for (const [provider, baseURL] of [
    ["anthropic", "https://api.anthropic.com/v1"],
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai"],
    ["deepseek", "https://api.deepseek.com/v1"],
  ]) {
    const r = await routes["provider.set"]({ config: { provider, apiKey: "k", model: "m" } }, SETTINGS);
    assertEquals(r.baseURL, baseURL, `${provider} preset`);
  }
});

Deno.test("provider.set: switching to a preset provider does not inherit the previous provider's base URL", async () => {
  const routes = createProviderRoutes();
  await routes["provider.set"](
    { config: { provider: "openai-compatible", apiKey: "k", baseURL: "https://my-byo.example/v1", model: "grok-4.6" } },
    SETTINGS,
  );
  const r = await routes["provider.set"]({ config: { provider: "openai", apiKey: "k", model: "gpt-5.6-sol" } }, SETTINGS);
  assertEquals(r.baseURL, "https://api.openai.com/v1");
});

Deno.test("provider.set keeps a BYO endpoint's empty baseURL and provider.status reports ok:false with the base-URL reason", async () => {
  const routes = createProviderRoutes();
  const r = await routes["provider.set"](
    { config: { provider: "openai-compatible", apiKey: "k", baseURL: "", model: "grok-4.6" } },
    SETTINGS,
  );
  assertEquals(r.baseURL, "");
  const status = await routes["provider.status"]();
  assertEquals(status.ok, false);
  assert(/base URL/.test(status.reason), `reason must name the base URL, got: ${status.reason}`);
  // The redacted permission summary carries the same reason for the preflight.
  const summary = await routes["provider.permission-summary"]();
  assertEquals(summary.origin, null);
  assert(/base URL/.test(summary.reason), `summary reason must name the base URL, got: ${summary.reason}`);
});

Deno.test("provider.set rejects an unknown provider id", async () => {
  const routes = createProviderRoutes();
  await routes["provider.set"]({ config: { provider: "openai", apiKey: "k", model: "m" } }, SETTINGS);
  const r = await routes["provider.set"]({ config: { provider: "not-a-provider", apiKey: "k", model: "m" } }, SETTINGS);
  assertEquals(r.ok, false);
  assertEquals(r.reason, "unknown provider");
  assertEquals(r.apiKey, undefined, "the refusal carries no key field at all");
  // The previous, valid config is untouched.
  const stored = await routes["provider.get"]({}, SETTINGS);
  assertEquals(stored.provider, "openai");
});
