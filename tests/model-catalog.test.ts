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
    // Gemini native: the key travels in the x-goog-api-key HEADER, never the URL
    // (chrome-agent-platform-ofbtl), and the ids lose their models/ prefix.
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), gkey: init?.headers?.["x-goog-api-key"] ?? "" });
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.7-flash" }, { name: "models/gemini-3.1-flash-image" }] }), { status: 200 });
    };
    const g = await fetchLiveModels("gemini", { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "gk" });
    assertEquals(g, ["gemini-3.7-flash"]);
    assert(seen[1].url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?"));
    assertEquals(seen[1].url.includes("key="), false, `the provider key must not travel in the URL: ${seen[1].url}`);
    assertEquals(seen[1].gkey, "gk");
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

// ── beads chrome-agent-platform-ofbtl (2026-11-09): the Gemini native LIST put
// the provider API key in the URL query string (`?key=`), where every
// intermediary, referrer and request log on the path sees it. Same class as
// jjedl, which moved the image path to the x-goog-api-key header on this host.
// Falsification: put `key=` back on either the initial page or the pageToken
// continuation (or drop the header) and these go RED.
Deno.test("fetchLiveModels gemini native: the key is a header on EVERY page, never a query param", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: { ...(init?.headers ?? {}) } });
    // Page 1 hands back a continuation cursor; page 2 ends the walk.
    const body = seen.length === 1
      ? { models: [{ name: "models/gemini-3.8-flash" }], nextPageToken: "tok/with+odd chars" }
      : { models: [{ name: "models/gemini-3.7-flash" }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const ids = await fetchLiveModels("gemini", {
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "gk-ofbtl",
    });
    assertEquals(ids, ["gemini-3.8-flash", "gemini-3.7-flash"]);
    assertEquals(seen.length, 2, "the pageToken continuation must be followed");
    for (const [i, req] of seen.entries()) {
      assert(req.url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?"), `page ${i}: ${req.url}`);
      assertEquals(req.url.includes("key"), false, `page ${i}: the key must not appear in the URL at all: ${req.url}`);
      assertEquals(req.url.includes("gk-ofbtl"), false, `page ${i}: the key value must not appear in the URL: ${req.url}`);
      assertEquals(req.headers["x-goog-api-key"], "gk-ofbtl", `page ${i}: the key must travel in x-goog-api-key`);
    }
    // The continuation still carries the cursor — dropping the key must not
    // silently drop pagination.
    assert(seen[1].url.includes("pageToken=tok%2Fwith%2Bodd%20chars"), `page 2 cursor lost: ${seen[1].url}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── beads chrome-agent-platform-pf0k (2026-09-02): the two models launched
// 2026-09-01/02 must reach the picker, and every catalogue id must be priced.
// Falsification: drop gemini-3.8-flash from the gemini suggested list (or the
// price row) and these go RED.
import { MODEL_PRICING } from "../extension/lib/model-prices.js";

Deno.test("the picker offers gemini-3.8-flash and claude-fable-5-1", () => {
  assert(suggestedModelsFor("gemini").includes("gemini-3.8-flash"), "gemini suggested lacks gemini-3.8-flash");
  assert(suggestedModelsFor("anthropic").includes("claude-fable-5-1"), "anthropic suggested lacks claude-fable-5-1");
  // Newest first: the new Flash sorts ahead of 3.7.
  const g = suggestedModelsFor("gemini");
  assert(g.indexOf("gemini-3.8-flash") < g.indexOf("gemini-3.7-flash"), "3.8-flash should sort before 3.7-flash");
});

Deno.test("every catalogue default/suggested id is priced (positive input/output)", () => {
  for (const [providerId, entry] of Object.entries(MODEL_CATALOG)) {
    for (const m of [entry.default, ...entry.suggested].filter(Boolean)) {
      const p = MODEL_PRICING[m];
      assert(p, `${providerId}: ${m} has no MODEL_PRICING row (would silently estimate $0)`);
      assertEquals(typeof p.input, "number", `${m}.input`);
      assertEquals(typeof p.output, "number", `${m}.output`);
      assert(p.input > 0, `${providerId}: ${m}.input must be positive`);
      assert(p.output > 0, `${providerId}: ${m}.output must be positive`);
      if (p.cacheRead != null) assert(p.cacheRead > 0, `${m}.cacheRead must be positive when present`);
      if (p.cacheWrite != null) assert(p.cacheWrite > 0, `${m}.cacheWrite must be positive when present`);
    }
  }
});

// ── chrome-agent-platform-8rzmy (2026-11-12): the Settings probe was the last
// credentialed egress with no guard. It fetched a caller-supplied baseURL with the
// browser's DEFAULT redirect policy and no private-host predicate, while carrying the
// stored provider key in headers — so a public redirector, or a model-authored provider
// record naming a LAN host, could move the key. These four legs fence it, and each one
// reds if its half of the fix is removed.

Deno.test("8rzmy: a redirect hop toward loopback/metadata is refused BEFORE it is issued, and the key never reaches it", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url: any) => {
    calls.push(String(url));
    // The public endpoint answers a redirect to the cloud metadata address — the
    // classic SSRF pivot. With redirect:"follow" the browser would walk it, and the
    // key would arrive with no code of ours having seen a hop.
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
  };
  try {
    const ids = await fetchLiveModels("openai", { baseURL: "https://api.example.com/v1", apiKey: "sk-secret" });
    assertEquals(ids, [], "a refused redirect yields no models");
    assertEquals(calls, ["https://api.example.com/v1/models"], "the private hop is never issued");
    assert(!calls.some((u) => u.includes("169.254.169.254")), `the metadata host must never be fetched: ${JSON.stringify(calls)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("8rzmy: a cross-origin redirect hop carries no provider credential", async () => {
  const realFetch = globalThis.fetch;
  const seen: Array<{ url: string; auth: string; gkey: string }> = [];
  globalThis.fetch = async (url: any, init: any) => {
    const headers = init?.headers ?? {};
    seen.push({ url: String(url), auth: String(headers.Authorization ?? ""), gkey: String(headers["x-goog-api-key"] ?? "") });
    if (seen.length === 1) {
      return new Response(null, { status: 307, headers: { location: "https://mirror.example.net/v1/models" } });
    }
    return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna" }] }), { status: 200 });
  };
  try {
    const ids = await fetchLiveModels("openai", { baseURL: "https://api.example.com/v1", apiKey: "sk-secret" });
    assertEquals(ids, ["gpt-5.6-luna"]);
    assertEquals(seen.length, 2, "the public hop IS followed");
    assertEquals(seen[0].auth, "Bearer sk-secret", "the configured origin gets the key");
    assertEquals(seen[1].auth, "", "a cross-origin hop drops it, as the browser would");
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("8rzmy: a KEYED probe at a private destination is never issued at all", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url: any) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ data: [{ id: "llama3" }] }), { status: 200 });
  };
  try {
    for (const baseURL of ["http://127.0.0.1:11434/v1", "http://192.168.1.9:1234/v1", "http://[::1]:8080/v1", "http://localhost:1234/v1"]) {
      const ids = await fetchLiveModels("openai-compatible", { baseURL, apiKey: "sk-secret" });
      assertEquals(ids, [], `a key must not be sent to ${baseURL}`);
    }
    assertEquals(calls, [], "no request carrying a key is issued to a private destination");
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("8rzmy: a KEYLESS probe at loopback still lists — the ollama/lm-studio presets must keep working", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url: any, init: any) => {
    calls.push(String(url));
    assertEquals(init?.headers?.Authorization, undefined, "a keyless probe carries no credential header");
    return new Response(JSON.stringify({ data: [{ id: "llama3.2" }] }), { status: 200 });
  };
  try {
    // needsKey:false in the Settings presets, so refreshLiveModels passes an empty key.
    const ids = await fetchLiveModels("ollama", { baseURL: "http://localhost:11434/v1", apiKey: "" });
    assertEquals(ids, ["llama3.2"], "the owner's own local endpoint still lists its models");
    assertEquals(calls, ["http://localhost:11434/v1/models"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
