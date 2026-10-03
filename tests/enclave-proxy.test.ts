// tests/enclave-proxy.test.ts — chrome-agent-platform-jao1.2 (CAP-SECURE-ENCLAVE
// Stage 2): the outbound proxy route with template secret injection.
//
// Pinned here:
//  * the jao1.1 hardenings ride this branch — records are AAD-bound to their
//    key id (a swapped {iv, ct} fails closed) and the install salt is adopted
//    from storage after a concurrent-open race;
//  * the proxy substitutes $VAULT{KEY} placeholders in headers/query, refuses
//    ungranted origins, refuses private/loopback targets via the shared
//    checkFetchTarget, omits credentials, refuses redirects, bounds the body,
//    tags the response untrusted, and never echoes a secret.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
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
      if (typeof keys === "string") {
        return map.has(keys) ? { [keys]: map.get(keys) } : {};
      }
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

/** A fake global fetch capturing requests and serving scripted responses. */
function fakeFetch(responses: Array<{ match: (u: string, init: any) => boolean; reply: any }>) {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = async (url: any, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const r of responses) {
      if (r.match(u, init)) {
        const bytes = new TextEncoder().encode(r.reply.body ?? "{}");
        const body = new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.byteLength; i += 64 * 1024) {
              controller.enqueue(bytes.subarray(i, i + 64 * 1024));
            }
            controller.close();
          },
        });
        return {
          ok: r.reply.ok ?? true,
          status: r.reply.status ?? 200,
          type: r.reply.type ?? "basic",
          headers: new Headers(r.reply.headers ?? { "content-type": "application/json" }),
          body,
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => bytes.buffer,
        };
      }
    }
    return { ok: false, status: 404, type: "basic", headers: new Headers(), text: async () => "not found" };
  };
  (impl as any).calls = calls;
  return impl as any;
}

const SERVICES = {
  "brave-search": { origins: ["https://api.search.brave.com"], secretKey: "BRAVE_SEARCH_API_KEY" },
};

async function buildRoute(profile: any) {
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: "a".repeat(32) + "b",
    installSaltB64: "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==",
  });
  await vault.setSecret("BRAVE_SEARCH_API_KEY", "sk-brave-9f8e7d6c5b4a3210-feeds-back", { by: "sw" });
  const route = (createEnclaveProxyRoutes as any)({ vault, fetchImpl: profile.fetchImpl, services: SERVICES, isAllowedCaller: () => true });
  const handler = route["enclave.proxy"];
  assert(typeof handler === "function", "the route exposes the enclave.proxy handler");
  return { handler, calls: profile.fetchImpl.calls, vault };
}

Deno.test("jao1.2: template substitution injects the vault secret into the header and query, never echoed", async () => {
  const fetchImpl = fakeFetch([{ match: (u) => u.includes("api.search.brave.com"), reply: { body: '{"results": [1, 2]}' } }]);
  const { handler, calls } = await buildRoute({ fetchImpl });

  const res = await handler({
    service: "brave-search",
    path: "/res/search",
    method: "GET",
    query: { q: "test", token: "$VAULT{BRAVE_SEARCH_API_KEY}" },
    headers: { Authorization: "Bearer $VAULT{BRAVE_SEARCH_API_KEY}" },
  }, { principal: "model", documentId: "doc-1" });

  assertEquals(res.ok, true, "the proxied call succeeds");
  assertEquals(calls.length, 1, "exactly one outbound request");
  const sent = calls[0];
  assert(sent.url.startsWith("https://api.search.brave.com/res/search?"), "the URL is pinned to the approved origin");
  assert(sent.url.includes("token=sk-brave-9f8e7d6c5b4a3210-feeds-back"), "the query template substitutes the secret");
  assertEquals(sent.init.headers.Authorization, "Bearer sk-brave-9f8e7d6c5b4a3210-feeds-back", "the header template substitutes the secret");
  assertEquals(sent.init.credentials, "omit", "credentials are always omitted");
  assertEquals(sent.init.redirect, "manual", "redirects are manual");
  // Zero echo: the response envelope and body never carry the secret.
  assert(!JSON.stringify(res).includes("sk-brave-9f8e7d6c5b4a3210-feeds-back"), "the response envelope never echoes the secret");
});

Deno.test("jao1.2: an ungranted origin and a private/loopback target are refused before any network I/O", async () => {
  const fetchImpl = fakeFetch([{ match: () => true, reply: { body: "{}" } }]);
  const { handler, calls } = await buildRoute({ fetchImpl });

  await assertRejects(
    () => handler({ service: "brave-search", path: "https://evil.example/steal", method: "GET", headers: {} }, { principal: "model", documentId: "d" }),
    Error,
    "approved origin",
    "a path pointing at another origin is refused",
  );
  assertEquals(calls.length, 0, "no network I/O for an ungranted origin");

  // The shared checkFetchTarget blocks loopback/private targets even when the
  // origin string matches the allowlist shape.
  await assertRejects(
    () => handler({ service: "brave-search", path: "http://127.0.0.1:9222/x", method: "GET", headers: {} }, { principal: "model", documentId: "d" }),
    Error,
  );
  assertEquals(calls.length, 0, "no network I/O for a loopback target");
});

Deno.test("jao1.2: an unknown $VAULT{KEY} fails closed and never sends", async () => {
  const fetchImpl = fakeFetch([{ match: () => true, reply: { body: "{}" } }]);
  const { handler, calls } = await buildRoute({ fetchImpl });
  await assertRejects(
    () => handler({
      service: "brave-search", path: "/res/search", method: "GET",
      headers: { Authorization: "Bearer $VAULT{DOES_NOT_EXIST}" },
    }, { principal: "model", documentId: "d" }),
    Error,
  );
  assertEquals(calls.length, 0, "an unresolvable template never reaches the network");
});

Deno.test("jao1.2: redirect responses are refused without following (laundering blocked)", async () => {
  const fetchImpl = fakeFetch([
    { match: (u) => u.includes("api.search.brave.com"), reply: { status: 302, type: "opaqueredirect", headers: { location: "https://evil.example/steal" }, body: "" } },
  ]);
  const { handler, calls } = await buildRoute({ fetchImpl });
  const res = await handler({
    service: "brave-search", path: "/res/search", method: "GET",
    headers: { Authorization: "Bearer $VAULT{BRAVE_SEARCH_API_KEY}" },
  }, { principal: "model", documentId: "d" });
  assertEquals(res.ok, false, "a redirect does not complete");
  assertStringIncludes(String(res.error ?? res), "redirect", "the refusal names the redirect");
  assertEquals(calls.length, 1, "exactly one request was made (no follow)");
});

Deno.test("jao1.2: the response is bounded and tagged untrusted", async () => {
  const big = "x".repeat(1024 * 1024 + 100);
  const fetchImpl = fakeFetch([{ match: (u) => u.includes("api.search.brave.com"), reply: { body: big } }]);
  const { handler } = await buildRoute({ fetchImpl });
  const res = await handler({
    service: "brave-search", path: "/res/search", method: "GET", headers: {},
  }, { principal: "model", documentId: "d" });
  assertEquals(res.ok, false, "a body over the bound is refused");
  assertStringIncludes(String(res.error ?? res), "1 MiB", "the refusal names the bound");

  const small = fakeFetch([{ match: (u) => u.includes("api.search.brave.com"), reply: { body: '{"small": true}' } }]);
  const { handler: handler2 } = await buildRoute({ fetchImpl: small });
  const res2 = await handler2({
    service: "brave-search", path: "/res/search", method: "GET", headers: {},
  }, { principal: "model", documentId: "d" });
  assertEquals(res2.untrusted, true, "a successful response is tagged untrusted");
  assertEquals(typeof res2.body, "string");
});

Deno.test("jao1.2: the jao1.1 AAD hardening rides this branch — a swapped {iv, ct} fails closed", async () => {
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: "a".repeat(32) + "b",
    installSaltB64: "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==",
  });
  await vault.setSecret("BRAVE_SEARCH_API_KEY", "sk-brave-9f8e7d6c5b4a3210-feeds-back", { by: "sw" });
  await vault.setSecret("GITHUB_TOKEN", "ghp_a1b2c3d4e5f6g7h8i9j0klmnop", { by: "sw" });

  // Swap BRAVE's {iv, ct} into GITHUB_TOKEN's slot.
  const brave = (await storage.get("cap:vault:secret:BRAVE_SEARCH_API_KEY"))["cap:vault:secret:BRAVE_SEARCH_API_KEY"];
  await storage.set({ "cap:vault:secret:GITHUB_TOKEN": brave });

  await assertRejects(
    () => vault.getSecretRaw("GITHUB_TOKEN", { caller: "sw" }),
    Error,
    "integrity",
    "a record swapped into another id's slot fails closed (AAD binding)",
  );
});

Deno.test("jao1.2: concurrent opens adopt one install salt (the dsflash1 race closed)", async () => {
  const storage = fakeStorage();
  const [v1, v2, v3] = await Promise.all([
    createSecretVault({ storageArea: storage, extensionId: "a".repeat(32) + "b" }),
    createSecretVault({ storageArea: storage, extensionId: "a".repeat(32) + "b" }),
    createSecretVault({ storageArea: storage, extensionId: "a".repeat(32) + "b" }),
  ]);
  await v1.setSecret("BRAVE_SEARCH_API_KEY", "from-v1", { by: "sw" });
  const got = await v2.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw" });
  assertEquals(got.value, "from-v1", "a concurrent open decrypts records written before it");
  const salts = [...storage.map.keys()].filter((k) => k === "cap:vault:install-salt");
  assertEquals(salts.length, 1, "exactly one salt key exists");
});

Deno.test("jao1.2: the caller gate refuses unsanctioned callers before any resolution or I/O", async () => {
  const fetchImpl = fakeFetch([{ match: () => true, reply: { body: "{}" } }]);
  let gateCalls = 0;
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: "a".repeat(32) + "b",
    installSaltB64: "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==",
  });
  await vault.setSecret("BRAVE_SEARCH_API_KEY", "sk-brave-9f8e7d6c5b4a3210-feeds-back", { by: "sw" });
  const route = (createEnclaveProxyRoutes as any)({
    vault,
    fetchImpl,
    services: SERVICES,
    isAllowedCaller: (ctx: any) => {
      gateCalls++;
      return ctx?.principal === "owner-options";
    },
  });
  const handler = route["enclave.proxy"];
  const res = await handler({
    service: "brave-search", path: "/res/search", method: "GET",
    headers: { Authorization: "Bearer $VAULT{BRAVE_SEARCH_API_KEY}" },
  }, { principal: "model", documentId: "d" });
  assertEquals(res.ok, false, "an unsanctioned caller is refused");
  assertEquals(gateCalls, 1, "the gate ran");
  assert(!JSON.stringify(res).includes("sk-brave"), "the refusal carries no secret");
});
