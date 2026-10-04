// tests/service-tools.test.ts — chrome-agent-platform-jao1.3 (CAP-SECURE-ENCLAVE
// Stage 3): the declarative service descriptor & tool synthesis engine.
//
// THE ISOLATION CONTRACT under test: the synthesized tool exposes ONLY clean
// semantic parameters (query, count, country) to the model — auth headers,
// secret ids, and $VAULT templates live in the DESCRIPTOR and are consumed by
// the enclave proxy, never by the tool's schema or its serialization.

import { assert, assertEquals, assertObjectMatch, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { z } from "zod";
import { tool } from "ai";
import { SERVICE_DESCRIPTORS, synthesizeServiceTools, braveWebTransform, enclaveToolsForRun } from "../extension/lib/service-tools.js";
import { createSecretVault } from "../extension/lib/secret-vault.js";
import { createEnclaveProxyRoutes } from "../extension/background/routes/enclave-proxy.js";

const ENCODER = new TextEncoder();

function fakeStorage() {
  const map: Map<string, any> = new Map();
  return {
    map,
    async get(keys: any) {
      if (keys === null) {
        const out: Record<string, any> = {};
        for (const [k, v] of map) out[k] = v;
        return out;
      }
      if (typeof keys === "string") return map.has(keys) ? { [keys]: map.get(keys) } : {};
      const out: Record<string, any> = {};
      for (const k of keys as string[]) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(items: Record<string, any>) {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

async function composedTools(profile: any = {}) {
  // The production composition, proven in-test: vault -> enclave proxy routes
  // (fake fetch) -> synthesized tools whose proxyCall IS the real handler.
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: "a".repeat(32) + "b",
    installSaltB64: "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==",
  });
  await vault.setSecret("BRAVE_SEARCH_API_KEY", "sk-brave-9f8e7d6c5b4a3210-feeds-back", { by: "sw" });
  const fetchCalls: Array<{ url: string; init: any }> = [];
  const fetchImpl = async (url: any, init: any = {}) => {
    fetchCalls.push({ url: String(url), init });
    const body = profile.braveBody ?? JSON.stringify({
      web: { results: [
        { title: "First result", url: "https://example.com/one", description: "The first thing the web says." },
        { title: "Second result", url: "https://example.com/two", description: "Another page, summarised." },
      ] },
    });
    const bytes = ENCODER.encode(body);
    return {
      ok: true,
      status: 200,
      type: "basic",
      headers: new Headers({ "content-type": "application/json" }),
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      text: async () => new TextDecoder().decode(bytes),
    } as any;
  };
  const routes = (createEnclaveProxyRoutes as any)({
    vault,
    fetchImpl,
    isAllowedCaller: () => true,
  });
  const tools: Record<string, any> = synthesizeServiceTools({
    descriptors: SERVICE_DESCRIPTORS,
    proxyCall: (message: any, context: any) => routes["enclave.proxy"](message, context),
    vault,
  });
  return { tools, fetchCalls, storage };
}

Deno.test("jao1.3: brave_search is synthesized with ONLY clean semantic parameters — zero auth fields in the schema or serialization", async () => {
  const { tools } = await composedTools();
  const t = tools.brave_search;
  assert(t, "brave_search is synthesized");

  // The AI SDK shape: a zod inputSchema whose shape is EXACTLY the semantic
  // parameters — no auth header, no secret id, no template strings.
  const shape = (t as any).inputSchema.shape;
  assertEquals(Object.keys(shape).sort(), ["count", "country", "query"], "the schema is exactly the semantic parameters");

  const serialized = JSON.stringify(t, (key, value) => (typeof value === "function" ? "fn()" : value));
  assert(!serialized.includes("X-Subscription-Token"), "the auth header never appears in the tool");
  assert(!serialized.includes("BRAVE_SEARCH_API_KEY"), "the secret id never appears in the tool");
  assert(!serialized.includes("$VAULT"), "no template syntax appears in the tool");
  assert(!serialized.includes("sk-brave"), "no secret value appears in the tool");
});

Deno.test("jao1.3: brave_search executes through the enclave proxy with the injected subscription token", async () => {
  const { tools, fetchCalls } = await composedTools();
  const brave = tools.brave_search as any;
  const result = await (tools.brave_search as any).execute({ query: "chrome agent platform", count: 2 }, {});

  assertEquals(fetchCalls.length, 1, "exactly one outbound request");
  const { url, init } = fetchCalls[0];
  assert(url.startsWith("https://api.search.brave.com/res/v1/web/search?"), `the request hits the Brave search endpoint: ${url}`);
  assert(url.includes("q=chrome+agent+platform"), "the query parameter carries the search");
  assertEquals(init.method, "GET");
  assertEquals(init.headers["X-Subscription-Token"], "sk-brave-9f8e7d6c5b4a3210-feeds-back", "the proxy injected the subscription token from the vault");
  assertEquals(init.credentials, "omit", "the request is anonymous");
  assertEquals(init.redirect, "manual", "redirects are refused");

  // The transform structures the raw Brave JSON into clean results.
  assertEquals(result.results.length, 2);
  assertEquals(result.results[0], { title: "First result", url: "https://example.com/one", snippet: "The first thing the web says." });
});

Deno.test("jao1.3: a ref usal from the enclave proxy surfaces as a named error, never a silent empty", async () => {
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: "a".repeat(32) + "b",
    installSaltB64: "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==",
  });
  // NO secret configured: the substitution fails closed before any I/O.
  const routes = (createEnclaveProxyRoutes as any)({
    vault,
    fetchImpl: async () => {
      throw new Error("no network I/O may happen for an unconfigured secret");
    },
    isAllowedCaller: () => true,
  });
  const tools: Record<string, any> = synthesizeServiceTools({
    descriptors: SERVICE_DESCRIPTORS,
    proxyCall: (message: any, context: any) => routes["enclave.proxy"](message, context),
    vault,
  });
  const err = await assertRejects(
    () => tools.brave_search.execute({ query: "x" }, {}),
    Error,
  );
  assertStringIncludes(String(err.message), "BRAVE_SEARCH_API_KEY", "the refusal names the missing key id");
  assert(!String(err.message).includes("sk-"), "no secret value in the error (there is none to leak)");
});

Deno.test("jao1.3: the descriptor schema is strict — auth and secret ids are descriptor-only, and the model cannot inject parameters", async () => {
  const descriptor = SERVICE_DESCRIPTORS["brave-search"];
  const toolDef: any = descriptor.tools.find((t: any) => t.name === "brave_search");
  assert(toolDef, "the brave_search tool is declared");
  assertEquals({ type: descriptor.auth.type, header: descriptor.auth.header, secretId: descriptor.auth.secretId }, { type: "header", header: "X-Subscription-Token", secretId: "BRAVE_SEARCH_API_KEY" }, "auth is declared on the descriptor: the header name and the vault secret id");

  // The synthesized schema REJECTS an injected auth-shaped parameter: zod
  // strips unknown keys, and the request builder only maps DECLARED
  // parameters — prove both by executing with an auth-shaped extra param.
  const { tools, fetchCalls } = await composedTools();
  const brave = tools.brave_search as any;
  await (tools.brave_search as any).execute(
    { query: "x", apiKey: "sk-INJECTED", XSubscriptionToken: "spoof" } as any,
    {},
  );
  const sent = fetchCalls[0];
  assert(!sent.url.includes("sk-INJECTED") && !sent.url.includes("spoof"), "an injected auth parameter never reaches the URL");
  assertEquals(sent.init.headers["X-Subscription-Token"], "sk-brave-9f8e7d6c5b4a3210-feeds-back", "the header is the vault-injected value only");
});

Deno.test("jao1.5 wiring: an empty descriptor set produces no tools", () => {
  const tools = synthesizeServiceTools({ descriptors: {}, proxyCall: async () => ({}), vault: {} });
  assertEquals(Object.keys(tools).length, 0);
});

Deno.test("jao1.5 wiring: secretGate controls which services are synthesized", async () => {
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: "a".repeat(32) + "b",
    installSaltB64: "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==",
  });
  const routes = (createEnclaveProxyRoutes as any)({ vault, fetchImpl: async () => { throw new Error("no I/O"); }, isAllowedCaller: () => true });

  // Gate OFF: nothing configured — brave_search must be ABSENT.
  const toolsOff = synthesizeServiceTools({
    descriptors: SERVICE_DESCRIPTORS,
    proxyCall: (message: any, context: any) => routes["enclave.proxy"](message, context),
    vault,
    secretGate: () => false,
  });
  assertEquals(toolsOff.brave_search, undefined, "brave_search must be ABSENT when the gate is off");

  // Gate ON: brave_search is synthesized.
  const toolsOn = synthesizeServiceTools({
    descriptors: SERVICE_DESCRIPTORS,
    proxyCall: (message: any, context: any) => routes["enclave.proxy"](message, context),
    vault,
    secretGate: () => true,
  });
  assert(toolsOn.brave_search !== undefined, "brave_search must be PRESENT when the gate is on");
});

Deno.test("chrome-agent-platform-1pr0: enclaveToolsForRun gates scoped, enabled, and configured states across all 4 combinations", () => {
  let synthesizeCalls = 0;
  const mockBraveSearch = { name: "brave_search", description: "Search the web" };
  const mockSynthesize = (configuredIds: Set<string>) => {
    synthesizeCalls++;
    const tools: Record<string, any> = {};
    if (configuredIds.has("BRAVE_SEARCH_API_KEY")) {
      tools.brave_search = mockBraveSearch;
    }
    return tools;
  };

  // State 1: scoped = true => {} (synthesis NOT even called)
  synthesizeCalls = 0;
  const res1 = enclaveToolsForRun({
    scoped: true,
    enabled: true,
    configuredIds: new Set(["BRAVE_SEARCH_API_KEY"]),
    synthesize: mockSynthesize,
  });
  assertEquals(res1, {}, "State 1: scoped=true must return empty tools");
  assertEquals(synthesizeCalls, 0, "State 1: scoped=true must not invoke synthesize callback");

  // State 2: scoped = false + configured => { brave_search }
  synthesizeCalls = 0;
  const res2 = enclaveToolsForRun({
    scoped: false,
    enabled: true,
    configuredIds: new Set(["BRAVE_SEARCH_API_KEY"]),
    synthesize: mockSynthesize,
  });
  assertEquals(Object.keys(res2), ["brave_search"], "State 2: scoped=false + configured must return brave_search");
  assertEquals(res2.brave_search, mockBraveSearch);
  assertEquals(synthesizeCalls, 1, "State 2: synthesize callback invoked once");

  // State 3: scoped = false + unconfigured => {}
  synthesizeCalls = 0;
  const res3 = enclaveToolsForRun({
    scoped: false,
    enabled: true,
    configuredIds: new Set(),
    synthesize: mockSynthesize,
  });
  assertEquals(res3, {}, "State 3: scoped=false + unconfigured must return empty tools");
  assertEquals(synthesizeCalls, 0, "State 3: unconfigured must not invoke synthesize callback");

  // State 4: enabled = false => {}
  synthesizeCalls = 0;
  const res4 = enclaveToolsForRun({
    scoped: false,
    enabled: false,
    configuredIds: new Set(["BRAVE_SEARCH_API_KEY"]),
    synthesize: mockSynthesize,
  });
  assertEquals(res4, {}, "State 4: enabled=false must return empty tools");
  assertEquals(synthesizeCalls, 0, "State 4: enabled=false must not invoke synthesize callback");
});

Deno.test("chrome-agent-platform-1pr0: enclaveToolsForRun end-to-end with synthesizeServiceTools", async () => {
  const { tools: _fullTools } = await composedTools();
  const synth = (ids: Set<string>) => synthesizeServiceTools({
    descriptors: SERVICE_DESCRIPTORS,
    proxyCall: async () => ({ ok: true, body: "{}" }),
    vault: {} as any,
    secretGate: (svc: any) => Boolean(svc.auth?.secretId && ids.has(svc.auth.secretId)),
  });

  // State 1: scoped = true -> {}
  const scopedTools = enclaveToolsForRun({
    scoped: true,
    enabled: true,
    configuredIds: new Set(["BRAVE_SEARCH_API_KEY"]),
    synthesize: synth,
  });
  assertEquals(scopedTools, {});

  // State 2: scoped = false, enabled = true, configured -> { brave_search }
  const normalTools = enclaveToolsForRun({
    scoped: false,
    enabled: true,
    configuredIds: new Set(["BRAVE_SEARCH_API_KEY"]),
    synthesize: synth,
  });
  assert(normalTools.brave_search !== undefined, "brave_search must be present for configured normal run");

  // State 3: scoped = false, enabled = true, unconfigured -> {}
  const unconfiguredTools = enclaveToolsForRun({
    scoped: false,
    enabled: true,
    configuredIds: new Set(),
    synthesize: synth,
  });
  assertEquals(unconfiguredTools, {});

  // State 4: enabled = false -> {}
  const disabledTools = enclaveToolsForRun({
    scoped: false,
    enabled: false,
    configuredIds: new Set(["BRAVE_SEARCH_API_KEY"]),
    synthesize: synth,
  });
  assertEquals(disabledTools, {});
});
