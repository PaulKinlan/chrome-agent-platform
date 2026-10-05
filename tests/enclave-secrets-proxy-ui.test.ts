// tests/enclave-secrets-proxy-ui.test.ts — Falsification tests for chrome-agent-platform-vyhl:
// Enclave environment secret storage, origin-pinned proxy rules, live service-tool caller gate,
// audit ledger, and Options UI integration.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createSecretVault,
  createServiceWorkerAccess,
} from "../extension/lib/secret-vault.js";
import {
  createEnclaveProxyRoutes,
  DEFAULT_SERVICES,
} from "../extension/background/routes/enclave-proxy.js";
import { createVaultRoutes } from "../extension/background/routes/vault.js";
import {
  synthesizeServiceTools,
  SERVICE_DESCRIPTORS,
} from "../extension/lib/service-tools.js";
import { createEnclaveLedger } from "../extension/lib/enclave-ledger.js";
import { sanitizeRequestHeaders } from "../extension/lib/python-network.js";

const SW_ACCESS = createServiceWorkerAccess();
const swVault = (vault: any) => ({
  ...vault,
  getSecretRaw: (keyId: string, opts: any = {}) =>
    vault.getSecretRaw(keyId, { ...opts, access: SW_ACCESS }),
});

function fakeStorage() {
  const map = new Map<string, any>();
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
            controller.enqueue(bytes);
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
        };
      }
    }
    return { ok: false, status: 404, type: "basic", headers: new Headers(), text: async () => "not found" };
  };
  (impl as any).calls = calls;
  return impl as any;
}

Deno.test("vyhl Part B.1: synthesized service-tool executes through SW's ENCLAVE_SW_CALLER gate while unauthenticated callers are refused", async () => {
  const ENCLAVE_SW_CALLER = Symbol("cap.enclave.sw-caller");
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: "a".repeat(32) + "b",
    installSaltB64: "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==",
  });
  await vault.setSecret("BRAVE_SEARCH_API_KEY", "sk-brave-live-key-1234", { by: "sw" });

  const fetchImpl = fakeFetch([
    {
      match: (u) => u.includes("api.search.brave.com"),
      reply: {
        body: JSON.stringify({
          web: { results: [{ title: "Found Result", url: "https://example.com/live", description: "snippet" }] },
        }),
      },
    },
  ]);

  const proxyRoutes = createEnclaveProxyRoutes({
    vault: swVault(vault),
    fetchImpl,
    services: DEFAULT_SERVICES,
    isAllowedCaller: (context: any) =>
      Boolean(context?.[ENCLAVE_SW_CALLER] === true || context?.principal === "owner-options"),
  });

  // Direct unauthenticated call with model principal is REFUSED
  const directResult = await proxyRoutes["enclave.proxy"](
    { service: "brave-search", path: "/test", method: "GET" },
    { principal: "model" },
  );
  assertEquals(directResult.ok, false);
  assertStringIncludes(directResult.error, "restricted to sanctioned surfaces");

  // In-worker synthesized tool closure stamps [ENCLAVE_SW_CALLER]: true and succeeds
  const tools: Record<string, any> = synthesizeServiceTools({
    descriptors: SERVICE_DESCRIPTORS,
    proxyCall: (message: any, context: any) =>
      proxyRoutes["enclave.proxy"](message, { ...context, [ENCLAVE_SW_CALLER]: true }),
    vault: swVault(vault),
  });

  const res = await tools.brave_search.execute({ query: "deno testing" }, {});
  assertEquals(res.results.length, 1);
  assertEquals(res.results[0].url, "https://example.com/live");
  assertEquals(fetchImpl.calls.length, 1);
  assertEquals(fetchImpl.calls[0].init.headers["X-Subscription-Token"], "sk-brave-live-key-1234");
});

Deno.test("vyhl Part A / B.2: cross-origin secret exfiltration defense refuses mismatched $VAULT{KEY} before any network I/O", async () => {
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: "a".repeat(32) + "b",
    installSaltB64: "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==",
  });
  await vault.setSecret("BRAVE_SEARCH_API_KEY", "sk-brave-12345", { by: "sw" });
  await vault.setSecret("GITHUB_TOKEN", "ghp_secret_github_token", { by: "sw" });

  const fetchImpl = fakeFetch([]);

  const proxyRoutes = createEnclaveProxyRoutes({
    vault: swVault(vault),
    fetchImpl,
    services: DEFAULT_SERVICES,
    isAllowedCaller: () => true,
  });

  // Attempting to inject $VAULT{GITHUB_TOKEN} into a request targeting brave-search (https://api.search.brave.com)
  const err = await assertRejects(
    () =>
      proxyRoutes["enclave.proxy"](
        {
          service: "brave-search",
          path: "/res/v1/search",
          method: "GET",
          headers: { Authorization: "Bearer $VAULT{GITHUB_TOKEN}" },
        },
        {},
      ),
    Error,
  );
  assertEquals((err as any).code, "origin_not_approved");
  assertStringIncludes(err.message, "approved origin");
  assertEquals(fetchImpl.calls.length, 0, "No network I/O may be made for cross-origin secret substitution");

  // Python sanitizeRequestHeaders allows $VAULT{...} but rejects raw authorization
  const withVault = sanitizeRequestHeaders({ Authorization: "Bearer $VAULT{GITHUB_TOKEN}", Accept: "application/json" });
  assertEquals((withVault.headers as Record<string, string>)["Authorization"], "Bearer $VAULT{GITHUB_TOKEN}");
  assertEquals(withVault.refused.length, 0);

  const withRaw = sanitizeRequestHeaders({ Authorization: "Bearer raw_secret_token", Accept: "application/json" });
  assertEquals((withRaw.headers as Record<string, string>)["Authorization"], undefined);
  assertEquals(withRaw.refused.includes("Authorization"), true);
});

Deno.test("vyhl Part A.2: custom proxy rule registration and vault.test auto-injection", async () => {
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: "a".repeat(32) + "b",
    installSaltB64: "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==",
  });
  const ledger = createEnclaveLedger();
  const fetchImpl = fakeFetch([
    {
      match: (u, init) => u.startsWith("https://api.example.com") && init?.headers?.["X-Api-Key"] === "custom-secret-token",
      reply: { ok: true, status: 200, body: '{"ok": true}' },
    },
  ]);

  let dynamicRules: Record<string, any> = {};
  const proxyRoutes = createEnclaveProxyRoutes({
    vault: swVault(vault),
    fetchImpl,
    getDynamicServices: () => dynamicRules,
    onRecord: (entry: any) => ledger.record(entry),
    isAllowedCaller: () => true,
  });

  const routes = createVaultRoutes({
    vault,
    requireSettingsSender: () => {},
    storageArea: storage,
    ledger,
    testConnection: async ({ service }: any) => {
      const svc = dynamicRules[service] || DEFAULT_SERVICES[service as keyof typeof DEFAULT_SERVICES];
      return await proxyRoutes["enclave.proxy"](
        { service, path: svc?.testPath || "/", method: "GET", injectServiceAuth: true },
        { principal: "owner-options" },
      );
    },
  });

  const owner = { principal: "owner-options" };

  // Set custom secret and proxy rule
  await routes["vault.set"](
    {
      keyId: "CUSTOM_API_KEY",
      value: "custom-secret-token",
      origin: "https://api.example.com",
      authType: "header",
      authName: "X-Api-Key",
      testPath: "/health",
    },
    owner,
  );

  const status = await routes["vault.status"]({}, owner);
  assertEquals(status.ok, true);
  assertEquals(status.services.some((s: any) => s.keyId === "CUSTOM_API_KEY"), true);
  assertEquals(status.proxyRules.some((r: any) => r.keyId === "CUSTOM_API_KEY" && r.origin === "https://api.example.com"), true);

  // Update dynamic services map for proxy test
  dynamicRules = Object.fromEntries(status.proxyRules.map((r: any) => [r.keyId, r]));

  // Test connection auto-injects X-Api-Key to https://api.example.com/health
  const testRes = await routes["vault.test"]({ service: "CUSTOM_API_KEY" }, owner);
  assertEquals(testRes.ok, true);
  assertEquals(testRes.status, 200);
  assertEquals(fetchImpl.calls.length, 1);
  assertEquals(fetchImpl.calls[0].url, "https://api.example.com/health");
  assertEquals(fetchImpl.calls[0].init.headers["X-Api-Key"], "custom-secret-token");
});

Deno.test("vyhl Part C: createEnclaveLedger strips query params, redacts secrets, bounds entries, and clears", () => {
  const ledger = createEnclaveLedger({ maxEntries: 3 });

  ledger.record({
    service: "brave-search",
    keyId: "BRAVE_SEARCH_API_KEY",
    method: "GET",
    origin: "https://api.search.brave.com",
    path: "/res/v1/web/search?q=secret_query_value&token=leak",
    status: 200,
    ok: true,
    ms: 45,
  });

  const list1 = ledger.list();
  assertEquals(list1.length, 1);
  assertEquals(list1[0].path, "/res/v1/web/search", "Query string must be stripped from path");
  assertEquals((list1[0] as any).headers, undefined, "Headers must never be recorded");
  assertEquals((list1[0] as any).body, undefined, "Bodies must never be recorded");
  assert(!JSON.stringify(list1[0]).includes("secret_query_value"), "Plaintext query secret must not be recorded");

  // Ring buffer bounds to maxEntries = 3
  ledger.record({ service: "github", keyId: "GITHUB_TOKEN", method: "GET", origin: "https://api.github.com", path: "/user" });
  ledger.record({ service: "custom", keyId: "CUSTOM_API", method: "POST", origin: "https://api.example.com", path: "/items" });
  ledger.record({ service: "fourth", keyId: "FOURTH_KEY", method: "GET", origin: "https://api.fourth.com", path: "/test" });

  const list2 = ledger.list();
  assertEquals(list2.length, 3, "Ledger must be bounded to maxEntries");
  assertEquals(list2[0].keyId, "FOURTH_KEY", "Newest entry should be first");

  // Clear
  ledger.clear();
  assertEquals(ledger.list().length, 0);
});

Deno.test("vyhl Part D: options.html contains all required Web services architecture, form, and ledger elements", async () => {
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));

  assertStringIncludes(html, 'id="vault-architecture"', "#vault-architecture banner must exist");
  assertStringIncludes(html, 'id="vault-services"', "#vault-services container must exist");
  assertStringIncludes(html, 'id="vault-add-origin"', "#vault-add-origin input must exist");
  assertStringIncludes(html, 'id="vault-add-auth-type"', "#vault-add-auth-type select must exist");
  assertStringIncludes(html, 'id="vault-add-auth-name"', "#vault-add-auth-name input must exist");
  assertStringIncludes(html, 'id="vault-ledger"', "#vault-ledger container must exist");
  assertStringIncludes(html, 'id="vault-ledger-clear"', "#vault-ledger-clear button must exist");

  // Preserved existing IDs
  assertStringIncludes(html, 'id="vault-add-id"');
  assertStringIncludes(html, 'id="vault-add-value"');
  assertStringIncludes(html, 'id="vault-add-toggle"');
  assertStringIncludes(html, 'id="vault-add-save"');
  assertStringIncludes(html, 'id="vault-status"');
});
