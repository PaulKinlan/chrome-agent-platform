// @ts-nocheck
// CAP-FB-20260830-MODEL-CATALOG-CURRENT-01 — the bundled model catalogue is the
// ONLY place a model id is written down for the user, and every id in it is a
// current, callable id. The retired-id and pricing-tier gates here are the
// falsification gates the entry names: add "gpt-4.1" to the openai suggested
// list and "no suggested or default id is retired or a pricing tier" goes RED.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  MODEL_CATALOG,
  RETIRED_MODEL_PATTERNS,
  defaultModelFor,
  fetchLiveModels,
  isPricingTierId,
  isRetiredModelId,
  suggestedModelsFor,
} from "../extension/lib/model-catalog.js";

// ── chrome/kv mock so provider.js can be imported (the established pattern)
const store = new Map();
globalThis.chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = structuredClone(store.get(k));
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v)); },
      remove: async (key) => { for (const k of (Array.isArray(key) ? key : [key])) store.delete(k); },
    },
  },
};
const { resolveModelFromConfig } = await import("../extension/lib/provider.js");

Deno.test("every catalogue default is in its own suggested list", () => {
  for (const [id, entry] of Object.entries(MODEL_CATALOG)) {
    if (!entry.default) continue;
    assert(entry.suggested.includes(entry.default), `${id}: default ${entry.default} not in suggested`);
  }
});

Deno.test("no suggested or default id is retired or a pricing tier", () => {
  for (const [id, entry] of Object.entries(MODEL_CATALOG)) {
    for (const m of [entry.default, ...entry.suggested, ...(entry.examples ?? [])].filter(Boolean)) {
      assertEquals(isRetiredModelId(m), false, `${id}: ${m} matches a retired pattern`);
      assertEquals(isPricingTierId(m), false, `${id}: ${m} is a pricing tier`);
    }
  }
});

Deno.test("defaultModelFor(openai) is gpt-5.6-luna", () => {
  assertEquals(defaultModelFor("openai"), "gpt-5.6-luna");
  assertEquals(defaultModelFor("gemini"), "gemini-3.7-flash");
  assertEquals(defaultModelFor("anthropic"), "claude-sonnet-5");
  assertEquals(defaultModelFor("openai-compatible"), "");
  assertEquals(defaultModelFor("nope"), "");
  assertEquals(suggestedModelsFor("openai")[0], "gpt-5.6-luna");
  assertEquals(suggestedModelsFor("nope"), []);
});

Deno.test("retired patterns catch every retired family and no current id", () => {
  for (const r of ["gpt-4.1", "gpt-4o-mini", "gpt-4-turbo", "o1", "o3-mini", "o4-mini", "gemini-1.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "claude-3-5-sonnet", "claude-3.5-haiku", "claude-sonnet-4-5", "claude-opus-4.1", "claude-haiku-4-5", "grok-3", "glm-4.5"]) {
    assert(isRetiredModelId(r), `${r} should be retired`);
  }
  for (const c of ["gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "gemini-3.7-flash", "gemini-3.1-pro-preview", "gemini-flash-latest", "claude-sonnet-5", "claude-fable-5", "grok-4.6", "glm-5.3", "deepseek-v4-flash"]) {
    assert(!isRetiredModelId(c), `${c} should be current`);
  }
  assert(Array.isArray(RETIRED_MODEL_PATTERNS) && RETIRED_MODEL_PATTERNS.every((p) => p instanceof RegExp));
});

Deno.test("isPricingTierId spots llm-prices context tiers only", () => {
  assert(isPricingTierId("gpt-5.6-terra-272k"));
  assert(isPricingTierId("gemini-3-1-pro-preview-200k"));
  assert(!isPricingTierId("gpt-5.6-terra"));
  assert(!isPricingTierId("gemini-3.7-flash"));
});

Deno.test("an empty model with a key resolves to the catalogue default, not the demo model", async () => {
  const r = await resolveModelFromConfig({ provider: "openai", baseURL: "", apiKey: "sk-test", model: "" });
  assertEquals(r.modelId, "gpt-5.6-luna");
  assertEquals(r.usingDefaultModel, true);
  const explicit = await resolveModelFromConfig({ provider: "openai", baseURL: "", apiKey: "sk-test", model: "gpt-5.5" });
  assertEquals(explicit.modelId, "gpt-5.5");
  assertEquals(Boolean(explicit.usingDefaultModel), false);
  // No default for the BYO endpoint → the resolution REFUSES (throws) instead
  // of silently falling back to the demo model
  // (CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01).
  let threw = null;
  try {
    await resolveModelFromConfig({ provider: "openai-compatible", baseURL: "https://byo.example/v1", apiKey: "k", model: "" });
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  assert(threw !== null && /model id/.test(threw), "a real provider id with no model must refuse, never demo-fallback");
});

Deno.test("fetchLiveModels: OpenAI-compatible list, normalised, tiers dropped, never throws", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization ?? "" });
    return new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "gpt-5.6-luna-272k" }, { id: "text-embedding-3-small" }, { id: "gpt-5.4-mini" }] }), { status: 200 });
  };
  try {
    const ids = await fetchLiveModels("openai", { baseURL: "https://api.openai.com/v1", apiKey: "sk-test" });
    assertEquals(ids, ["gpt-5.5", "gpt-5.4-mini"]);
    assertEquals(seen[0].url, "https://api.openai.com/v1/models");
    assertEquals(seen[0].auth, "Bearer sk-test");
    // Gemini native: the key travels in the query, the ids lose their models/ prefix.
    globalThis.fetch = async (url) => {
      seen.push({ url: String(url) });
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.7-flash" }, { name: "models/gemini-3.1-flash-image" }] }), { status: 200 });
    };
    const g = await fetchLiveModels("gemini", { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "gk" });
    assertEquals(g, ["gemini-3.7-flash"]);
    assert(seen[1].url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?key="));
    // Failure paths return [] — never a throw into the UI.
    globalThis.fetch = async () => new Response("nope", { status: 401 });
    assertEquals(await fetchLiveModels("openai", { baseURL: "https://api.openai.com/v1", apiKey: "bad" }), []);
    globalThis.fetch = async () => { throw new Error("boom https://x?key=SECRET"); };
    assertEquals(await fetchLiveModels("openai", { baseURL: "https://api.openai.com/v1", apiKey: "k" }), []);
    assertEquals(await fetchLiveModels("openai", { baseURL: "", apiKey: "k" }), []);
  } finally {
    globalThis.fetch = realFetch;
  }
});
