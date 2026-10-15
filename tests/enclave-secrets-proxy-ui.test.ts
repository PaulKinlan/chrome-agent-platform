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
import { createPanelContext } from "../extension/options/panel-context.js";

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

  // jao1.6.1: Quota section elements
  assertStringIncludes(html, 'id="vault-quotas-section"', "#vault-quotas-section container must exist");
  assertStringIncludes(html, 'id="vault-quotas"', "#vault-quotas table container must exist");
  assertStringIncludes(html, 'id="vault-quotas-reset"', "#vault-quotas-reset button must exist");
  assertStringIncludes(html, 'id="vault-quotas-warning"', "#vault-quotas-warning alert element must exist");
  assertStringIncludes(html, 'id="vault-quotas-status"', "#vault-quotas-status message element must exist");
  assertStringIncludes(html, 'id="vault-quota-add-service"', "#vault-quota-add-service input must exist");
  assertStringIncludes(html, 'id="vault-quota-add-limit"', "#vault-quota-add-limit input must exist");
  assertStringIncludes(html, 'id="vault-quota-add-window"', "#vault-quota-add-window select must exist");
  assertStringIncludes(html, 'id="vault-quota-add-save"', "#vault-quota-add-save button must exist");
});

// ── Part E: Bead jao1.6.1 Enclave Quotas Settings UI ─────────────────────────

function makeDomElement(tag: string) {
  const listeners: Record<string, Function[]> = {};
  const attrs: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  const children: any[] = [];
  let _text = "";

  const el: any = {
    tagName: tag.toUpperCase(),
    tag,
    id: "",
    className: "",
    type: "",
    value: "",
    placeholder: "",
    disabled: false,
    hidden: false,
    checked: false,
    min: "",
    children,
    dataset,
    style,
    attrs,
    listeners,
    parent: null,
    append(...nodes: any[]) {
      _text = "";
      for (const n of nodes) {
        if (typeof n === "string") {
          const textNode = makeDomElement("#text");
          textNode._text = n;
          children.push(textNode);
          textNode.parent = el;
        } else if (n) {
          children.push(n);
          n.parent = el;
        }
      }
      return el;
    },
    appendChild(n: any) {
      return el.append(n);
    },
    replaceChildren(...nodes: any[]) {
      children.length = 0;
      _text = "";
      el.append(...nodes);
    },
    remove() {
      if (el.parent) {
        const idx = el.parent.children.indexOf(el);
        if (idx >= 0) el.parent.children.splice(idx, 1);
      }
    },
    addEventListener(type: string, fn: Function) {
      (listeners[type] ??= []).push(fn);
    },
    setAttribute(k: string, v: any) {
      const s = String(v ?? "");
      attrs[k] = s;
      if (k === "id") el.id = s;
      if (k === "class") el.className = s;
      if (k.startsWith("data-")) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        dataset[camel] = s;
      }
    },
    getAttribute(k: string) {
      return attrs[k] ?? null;
    },
    click() {
      for (const fn of listeners["click"] ?? []) {
        fn({ type: "click", target: el });
      }
    },
    querySelector(sel: string) {
      return el.querySelectorAll(sel)[0] ?? null;
    },
    querySelectorAll(sel: string) {
      const out: any[] = [];
      const match = (n: any) => {
        if (sel.startsWith("#") && n.id === sel.slice(1)) return true;
        if (sel.startsWith(".") && String(n.className).split(/\s+/).includes(sel.slice(1))) return true;
        if (n.tag && n.tag.toLowerCase() === sel.toLowerCase()) return true;
        return false;
      };
      const walk = (n: any) => {
        for (const c of n.children ?? []) {
          if (match(c)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
  };

  Object.defineProperty(el, "textContent", {
    get() {
      if (children.length === 0) return _text;
      return children.map((c) => (c.tag === "#text" ? c._text : c.textContent)).join("");
    },
    set(v) {
      _text = String(v ?? "");
      children.length = 0;
    },
  });

  return el;
}

function createPanelFixture() {
  const ids = [
    "vault-services",
    "vault-ledger",
    "vault-ledger-clear",
    "vault-quotas",
    "vault-quotas-reset",
    "vault-quotas-warning",
    "vault-quotas-status",
    "vault-quota-add-service",
    "vault-quota-add-limit",
    "vault-quota-add-window",
    "vault-quota-add-save",
    "vault-add-id",
    "vault-add-value",
    "vault-add-toggle",
    "vault-add-origin",
    "vault-add-auth-type",
    "vault-add-auth-name",
    "vault-add-save",
    "vault-status",
    "enclave-enabled-toggle",
    "enclave-expose-status",
  ];
  const elements: Record<string, any> = {};
  const root = makeDomElement("section");
  root.id = "web-services";

  for (const id of ids) {
    const el = makeDomElement(id.includes("btn") || id.includes("save") || id.includes("reset") || id.includes("clear") || id.includes("toggle") ? "button" : (id.includes("input") || id.includes("limit") || id.includes("id") || id.includes("value") || id.includes("origin") ? "input" : (id.includes("window") || id.includes("type") ? "select" : "div")));
    el.id = id;
    elements[id] = el;
    root.append(el);
  }

  (globalThis as any).document = {
    createElement: (tag: string) => makeDomElement(tag),
    getElementById: (id: string) => elements[id] ?? null,
    querySelector: (sel: string) => (sel.startsWith("#") ? elements[sel.slice(1)] ?? null : null),
  };

  return { root, elements };
}

Deno.test("jao1.6.1 Part E.2: Quotas UI renders every required field honestly (count, window, remaining, limit, disabled, unmetered, active)", async () => {
  const { root, elements } = createPanelFixture();
  const { mount } = await import("../extension/options/panels/web-services.js");

  const cannedUsage = {
    "brave-search": {
      count: 7,
      disabled: false,
      limit: 50,
      remaining: 43,
      resetMs: 72000000,
      unmetered: false,
      windowMs: 86400000,
      windowStartMs: Date.now() - 14400000,
    },
    "github": {
      count: 0,
      disabled: true,
      limit: 0,
      remaining: 0,
      resetMs: null,
      unmetered: false,
      windowMs: 3600000,
      windowStartMs: Date.now(),
    },
    "unmetered-svc": {
      count: 3,
      disabled: false,
      limit: null,
      remaining: null,
      resetMs: null,
      unmetered: true,
      windowMs: null,
      windowStartMs: Date.now(),
    },
  };

  const swCalls: any[] = [];
  const ctx = createPanelContext({
    root,
    send: async (type: string, payload: any = {}) => {
      swCalls.push({ type, ...payload });
      if (type === "vault.status") return { ok: true, services: [], proxyRules: [], ledger: [] };
      if (type === "vault.ledger.usage") return { ok: true, usage: cannedUsage, configInvalid: false };
      return { ok: true };
    },
  });

  const handle = await mount(root, ctx);

  // Verify vault.ledger.usage was called
  assert(swCalls.some((c) => c.type === "vault.ledger.usage"), "mount must read vault.ledger.usage");

  // Verify quotas table rendered inside #vault-quotas
  const table = elements["vault-quotas"].querySelector("table");
  assert(table, "Quotas table must be rendered inside #vault-quotas");

  const rows = table.querySelectorAll(".vault-quota-row");
  assertEquals(rows.length, 3, "All 3 services must be rendered in quota rows");

  // 1. Check brave-search (active / metered)
  const braveRow = rows.find((r: any) => r.dataset.service === "brave-search");
  assert(braveRow, "brave-search row must exist");
  assertEquals(braveRow.dataset.count, "7", "Count must match exact route field");
  assertEquals(braveRow.dataset.limit, "50", "Limit must match exact route field");
  assertEquals(braveRow.dataset.remaining, "43", "Remaining must match exact route field");
  assertEquals(braveRow.dataset.disabled, "false");
  assertEquals(braveRow.dataset.unmetered, "false");
  const braveStatus = braveRow.querySelector(".vault-status-pill");
  assertEquals(braveStatus?.textContent, "Active");
  assertStringIncludes(braveRow.querySelector(".vault-quota-window")?.textContent, "24h");

  // 2. Check github (disabled)
  const githubRow = rows.find((r: any) => r.dataset.service === "github");
  assert(githubRow, "github row must exist");
  assertEquals(githubRow.dataset.disabled, "true", "Disabled must be true when limit is 0");
  assertEquals(githubRow.dataset.remaining, "0", "Remaining must be 0 when disabled");
  const githubStatus = githubRow.querySelector(".vault-status-pill");
  assertEquals(githubStatus?.textContent, "Disabled");
  assertStringIncludes(githubRow.querySelector(".vault-quota-limit")?.textContent, "0 (disabled)");

  // 3. Check unmetered-svc (unmetered)
  const unmeteredRow = rows.find((r: any) => r.dataset.service === "unmetered-svc");
  assert(unmeteredRow, "unmetered-svc row must exist");
  assertEquals(unmeteredRow.dataset.unmetered, "true", "Unmetered must be true");
  const unmeteredStatus = unmeteredRow.querySelector(".vault-status-pill");
  assertEquals(unmeteredStatus?.textContent, "Unmetered");
  assertEquals(unmeteredRow.querySelector(".vault-quota-remaining")?.textContent, "Unmetered");
  assertEquals(unmeteredRow.querySelector(".vault-quota-window")?.textContent, "—");

  // Warning must be hidden when configInvalid is false
  assertEquals(elements["vault-quotas-warning"].hidden, true);

  handle.unmount();
});

Deno.test("jao1.6.1 Part E.3: Quotas UI renders configInvalid honestly in fail-closed state", async () => {
  const { root, elements } = createPanelFixture();
  const { mount } = await import("../extension/options/panels/web-services.js");

  const ctx = createPanelContext({
    root,
    send: async (type: string) => {
      if (type === "vault.status") return { ok: true, services: [], proxyRules: [], ledger: [] };
      if (type === "vault.ledger.usage") {
        return {
          ok: true,
          usage: { "brave-search": { count: 0, disabled: false, limit: 50, remaining: 50, resetMs: 86400000, unmetered: false, windowMs: 86400000 } },
          configInvalid: true, // Corrupted / invalid stored quota
        };
      }
      return { ok: true };
    },
  });

  const handle = await mount(root, ctx);

  // Warning banner MUST be displayed when configInvalid is true
  assertEquals(elements["vault-quotas-warning"].hidden, false, "Warning banner must be visible on configInvalid");
  assertStringIncludes(elements["vault-quotas-warning"].textContent, "not valid", "Must explain config validation failure honestly");

  handle.unmount();
});

Deno.test("jao1.6.1 Part E.4: Setting a per-service limit writes through vault.ledger.setQuotas and re-renders", async () => {
  const { root, elements } = createPanelFixture();
  const { mount } = await import("../extension/options/panels/web-services.js");

  let currentUsage: any = {
    "brave-search": { count: 0, disabled: false, limit: 50, remaining: 50, resetMs: 86400000, unmetered: false, windowMs: 86400000 },
  };

  const setQuotaCalls: any[] = [];
  const ctx = createPanelContext({
    root,
    send: async (type: string, payload: any = {}) => {
      if (type === "vault.status") return { ok: true, services: [], proxyRules: [], ledger: [] };
      if (type === "vault.ledger.usage") return { ok: true, usage: currentUsage, configInvalid: false };
      if (type === "vault.ledger.setQuotas") {
        setQuotaCalls.push({ type, ...payload });
        // Simulate background updating usage after setQuotas
        const q = payload.quotas["brave-search"];
        currentUsage["brave-search"] = {
          count: 0,
          disabled: q.limit === 0,
          limit: q.limit,
          remaining: q.limit,
          resetMs: q.windowMs,
          unmetered: false,
          windowMs: q.windowMs,
        };
        return { ok: true, quotas: payload.quotas };
      }
      return { ok: true };
    },
  });

  const handle = await mount(root, ctx);

  const rows = elements["vault-quotas"].querySelectorAll(".vault-quota-row");
  const braveRow = rows.find((r: any) => r.dataset.service === "brave-search");
  assert(braveRow, "brave-search row must exist");

  const limitInput = braveRow.querySelector(".vault-quota-limit-input");
  const windowSelect = braveRow.querySelector(".vault-quota-window-select");
  const setBtn = braveRow.querySelector(".vault-quota-set-btn");

  // Set limit to 20 with 1 hour window (3600000 ms)
  limitInput.value = "20";
  windowSelect.value = "3600000";

  setBtn.click();
  await new Promise((r) => setTimeout(r, 20));

  // Verify vault.ledger.setQuotas was called with the exact payload
  assertEquals(setQuotaCalls.length, 1);
  assertEquals(setQuotaCalls[0].quotas["brave-search"], { limit: 20, windowMs: 3600000 });

  // Verify status message updated
  assertStringIncludes(elements["vault-quotas-status"].textContent, "Quota updated for brave-search");

  // Verify re-rendered limit
  const rowsAfter = elements["vault-quotas"].querySelectorAll(".vault-quota-row");
  const updatedRow = rowsAfter.find((r: any) => r.dataset.service === "brave-search");
  assertEquals(updatedRow.dataset.limit, "20");

  handle.unmount();
});

Deno.test("jao1.6.1 Part E.5: Clearing a per-service limit writes through vault.ledger.setQuotas and restores defaults", async () => {
  const { root, elements } = createPanelFixture();
  const { mount } = await import("../extension/options/panels/web-services.js");

  let currentUsage: any = {
    "brave-search": { count: 0, disabled: false, limit: 10, remaining: 10, resetMs: 3600000, unmetered: false, windowMs: 3600000 },
  };

  const setQuotaCalls: any[] = [];
  const ctx = createPanelContext({
    root,
    send: async (type: string, payload: any = {}) => {
      if (type === "vault.status") return { ok: true, services: [], proxyRules: [], ledger: [] };
      if (type === "vault.ledger.usage") return { ok: true, usage: currentUsage, configInvalid: false };
      if (type === "vault.ledger.setQuotas") {
        setQuotaCalls.push({ type, ...payload });
        // Clear restores default 50
        currentUsage["brave-search"] = {
          count: 0,
          disabled: false,
          limit: 50,
          remaining: 50,
          resetMs: 86400000,
          unmetered: false,
          windowMs: 86400000,
        };
        return { ok: true, quotas: payload.quotas };
      }
      return { ok: true };
    },
  });

  const handle = await mount(root, ctx);

  const rows = elements["vault-quotas"].querySelectorAll(".vault-quota-row");
  const braveRow = rows.find((r: any) => r.dataset.service === "brave-search");
  const clearBtn = braveRow.querySelector(".vault-quota-clear-btn");

  clearBtn.click();
  await new Promise((r) => setTimeout(r, 20));

  // Verify setQuotas was called (clearing brave-search)
  assertEquals(setQuotaCalls.length, 1);
  assertEquals(setQuotaCalls[0].quotas["brave-search"], undefined);

  // Status message confirms clearance
  assertStringIncludes(elements["vault-quotas-status"].textContent, "Quota cleared for brave-search");

  // Re-rendered limit back to 50
  const rowsAfter = elements["vault-quotas"].querySelectorAll(".vault-quota-row");
  const restoredRow = rowsAfter.find((r: any) => r.dataset.service === "brave-search");
  assertEquals(restoredRow.dataset.limit, "50");

  handle.unmount();
});

Deno.test("jao1.6.1 Part E.6: Reset to defaults writes { quotas: {} } and restores built-in limits", async () => {
  const { root, elements } = createPanelFixture();
  const { mount } = await import("../extension/options/panels/web-services.js");

  const setQuotaCalls: any[] = [];
  const ctx = createPanelContext({
    root,
    send: async (type: string, payload: any = {}) => {
      if (type === "vault.status") return { ok: true, services: [], proxyRules: [], ledger: [] };
      if (type === "vault.ledger.usage") {
        return {
          ok: true,
          usage: { "brave-search": { count: 0, disabled: false, limit: 50, remaining: 50, resetMs: 86400000, unmetered: false, windowMs: 86400000 } },
          configInvalid: false,
        };
      }
      if (type === "vault.ledger.setQuotas") {
        setQuotaCalls.push({ type, ...payload });
        return { ok: true, quotas: {} };
      }
      return { ok: true };
    },
  });

  const handle = await mount(root, ctx);

  const resetBtn = elements["vault-quotas-reset"];
  resetBtn.click();
  await new Promise((r) => setTimeout(r, 20));

  assertEquals(setQuotaCalls.length, 1);
  assertEquals(setQuotaCalls[0].quotas, {}, "Reset to defaults must send empty quotas object { quotas: {} }");
  assertStringIncludes(elements["vault-quotas-status"].textContent, "All quotas reset to built-in defaults");

  handle.unmount();
});

Deno.test("jao1.6.1 Part E.7: Fail-closed path: invalid_quota_config renders failure in UI and never claims success", async () => {
  const { root, elements } = createPanelFixture();
  const { mount } = await import("../extension/options/panels/web-services.js");

  const ctx = createPanelContext({
    root,
    send: async (type: string) => {
      if (type === "vault.status") return { ok: true, services: [], proxyRules: [], ledger: [] };
      if (type === "vault.ledger.usage") {
        return {
          ok: true,
          usage: { "brave-search": { count: 0, disabled: false, limit: 50, remaining: 50, resetMs: 86400000, unmetered: false, windowMs: 86400000 } },
          configInvalid: false,
        };
      }
      if (type === "vault.ledger.setQuotas") {
        // Route throws error code invalid_quota_config
        const err: any = new Error("enclave quotas: enclave quota limit for brave-search must be a non-negative integer");
        err.code = "invalid_quota_config";
        throw err;
      }
      return { ok: true };
    },
  });

  const handle = await mount(root, ctx);

  const rows = elements["vault-quotas"].querySelectorAll(".vault-quota-row");
  const braveRow = rows.find((r: any) => r.dataset.service === "brave-search");
  const limitInput = braveRow.querySelector(".vault-quota-limit-input");
  const setBtn = braveRow.querySelector(".vault-quota-set-btn");

  limitInput.value = "10";
  setBtn.click();
  await new Promise((r) => setTimeout(r, 20));

  // Status must show failure, with danger color, and must NOT claim success
  const statusEl = elements["vault-quotas-status"];
  assertEquals(statusEl.hidden, false);
  assertEquals(statusEl.style.color, "var(--danger,#b3261e)", "Error must be styled in danger color");
  assertStringIncludes(statusEl.textContent, "Failed to set quota", "Must indicate failure");
  assert(!statusEl.textContent.includes("Quota updated"), "Must NEVER claim success when setQuotas rejects");

  handle.unmount();
});


Deno.test("jao1.6.1 Part E.8: a REJECTED storage read renders the failure, re-enables the control, and writes NOTHING", async () => {
  const { root, elements } = createPanelFixture();
  const { mount } = await import("../extension/options/panels/web-services.js");

  // Make the authoritative storage read itself reject - the path F1 introduced. Before this test
  // nothing proved the failure was REACHABLE: the throw escaped the click listener after the button
  // was disabled, so the control stayed greyed, no status was ever rendered, and the safe outcome
  // (no write) was accidental rather than asserted.
  const hadChrome = "chrome" in globalThis;
  const prevChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    storage: { local: { get: async () => { throw new Error("storage read failed"); } } },
  };

  const setQuotaCalls: any[] = [];
  const ctx = createPanelContext({
    root,
    send: async (type: string, payload: any = {}) => {
      if (type === "vault.status") return { ok: true, services: [], proxyRules: [], ledger: [] };
      if (type === "vault.ledger.usage") {
        return {
          ok: true,
          usage: { "brave-search": { count: 0, disabled: false, limit: 50, remaining: 50, resetMs: 86400000, unmetered: false, windowMs: 86400000 } },
          configInvalid: false,
        };
      }
      if (type === "vault.ledger.setQuotas") {
        setQuotaCalls.push({ type, ...payload });
        return { ok: true, quotas: payload.quotas };
      }
      return { ok: true };
    },
  });

  try {
    const handle = await mount(root, ctx);
    const rows = elements["vault-quotas"].querySelectorAll(".vault-quota-row");
    const braveRow = rows.find((r: any) => r.dataset.service === "brave-search");
    assert(braveRow, "brave-search row must exist");
    const limitInput = braveRow.querySelector(".vault-quota-limit-input");
    const setBtn = braveRow.querySelector(".vault-quota-set-btn");

    limitInput.value = "20";
    setBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    const statusEl = elements["vault-quotas-status"];
    assertEquals(statusEl.hidden, false, "a failed read must be visible, not silent");
    assertStringIncludes(statusEl.textContent, "Could not read your saved quota settings", "the failure must be named");
    assertEquals(statusEl.style.color, "var(--danger,#b3261e)", "the failure must be styled as an error");
    assert(!statusEl.textContent.includes("Quota updated"), "must NEVER claim success after a failed read");

    // SAFETY, the behaviour that matters: a read we could not perform must not become a write.
    // Writing here would persist a quota set built from a config we could not read - the exact
    // stale-override bug F1 exists to prevent.
    assertEquals(setQuotaCalls.length, 0, "no setQuotas write may be sent when the read failed");

    // The control must not be left disabled by an error path - the pre-fix defect.
    assertEquals(setBtn.disabled, false, "the control must be re-enabled after a failed read");

    handle.unmount();
  } finally {
    if (hadChrome) (globalThis as any).chrome = prevChrome;
    else delete (globalThis as any).chrome;
  }
});
