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
import { SERVICE_DESCRIPTORS, synthesizeServiceTools, braveWebTransform } from "../extension/lib/service-tools.js";
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
