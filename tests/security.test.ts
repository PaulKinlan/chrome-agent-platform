// @ts-nocheck — browser globals are stubbed (the same pattern as components.test.ts).
// tests/security.test.ts — the sandbox-boundary security invariants, tested
// WITHOUT a browser where possible (pure helpers + the hooks deny-list):
//   1. redactSecrets never serializes a credential key (the wider-goal review's
//      CRITICAL — the storage.onChanged hook leaked providerConfig.apiKey).
//   2. renderHtmlFrame's CSP closes the network egress (connect-src 'none',
//      img-src data: blob:) + the sandbox has NO popup/top-navigation authority.
//   3. The hooks deny-list is authoritative + fail-closed (a denied hook cannot
//      be subscribed), and subscription fan-out is bounded.
// The live CDP assertions (a frame actually attempting an exfil/escape) live in
// scripts/security-suite.ts.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { redactSecrets, SECRET_KEY_RE } from "../extension/lib/pure.js";

// ---- browser-global stubs so components.js can be imported (no DOM) ----
const registry = new Map();
class HTMLElementStub {
  attachShadow(_init) { return new ShadowRootStub(); }
  getAttribute(_n) { return null; }
  hasAttribute(_n) { return false; }
  setAttribute(_n, _v) {}
  removeAttribute(_n) {}
  dispatchEvent(_e) { return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get _root() { return this; }
}
class ShadowRootStub {
  get innerHTML() { return ""; }
  set innerHTML(_v) {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild() {}
}
globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
};
globalThis.matchMedia = () => ({ matches: false });

// ---- the hooks chrome mock (the same shape as hooks.test.ts) ----
const store = new Map();
const granted = new Set(["storage"]);
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
  permissions: {
    contains: async ({ permissions }) => permissions.every((p) => granted.has(p)),
  },
};
function reset() { store.clear(); granted.clear(); granted.add("storage"); }

Deno.test("security: redactSecrets strips every credential key recursively", () => {
  const payload = {
    ok: true,
    providerConfig: { apiKey: "sk-secret", model: "gpt-4o" },
    nested: { list: [{ token: "abc", Authorization: "Bearer x" }] },
    fine: "keep",
  };
  const out = redactSecrets(payload);
  assertEquals(out.providerConfig.apiKey, "[REDACTED]");
  assertEquals(out.providerConfig.model, "gpt-4o");
  assertEquals(out.nested.list[0].token, "[REDACTED]");
  assertEquals(out.nested.list[0].Authorization, "[REDACTED]");
  assertEquals(out.fine, "keep");
});

Deno.test("security: redactSecrets recognises a broad credential-key vocabulary", () => {
  for (const k of ["apiKey", "api_key", "accessKey", "access_key", "secret", "password", "authorization", "credential", "bearer"]) {
    assert(SECRET_KEY_RE.test(k), `SECRET_KEY_RE must match ${k}`);
  }
});

Deno.test("security: renderHtmlFrame injects a CSP that closes network egress", async () => {
  const mod = await import("../extension/shared/components.js");
  const csp = mod.HTML_FRAME_CSP;
  assert(csp.includes("connect-src 'none'"), "connect-src 'none' must be present (fetch/beacon/ws blocked)");
  assert(csp.includes("img-src data: blob:"), "remote images must be blocked (only data:/blob:)");
  assert(csp.includes("default-src 'none'"), "default-src 'none' must close the default");
  assert(csp.includes("form-action 'none'"), "form-action must be closed (no form-based exfil)");
  assert(csp.includes("base-uri 'none'"), "base-uri must be closed");
  assert(csp.includes("frame-src 'none'"), "no nested frames");
  assert(csp.includes("object-src 'none'"), "no plugin/object");

  const html = mod.renderHtmlFrame(`<img src="https://evil.example/x">`);
  // the sandbox must NOT allow popups or top-navigation (a prompt-injected
  // script must not open a window or navigate the extension).
  assert(html.includes("sandbox=\"allow-scripts\""), "sandbox must be allow-scripts only");
  assert(!html.includes("allow-popups"), "allow-popups must NOT be present");
  assert(!html.includes("allow-top-navigation"), "allow-top-navigation must NOT be present");
  assert(!html.includes("allow-same-origin"), "allow-same-origin must NOT be present (opaque origin)");
  // the CSP meta must be present in the srcdoc (escaped for the attribute).
  assert(html.includes("Content-Security-Policy"), "the CSP meta must be injected");
});

Deno.test("security: artifact preview keeps a stable host for every self-navigation vector", async () => {
  const mod = await import("../extension/shared/components.js");
  const root = new URL("..", import.meta.url);
  const hostSource = await Deno.readTextFile(new URL("extension/sandbox/artifact-preview.js", root));
  const swSource = await Deno.readTextFile(new URL("extension/background/service-worker.js", root));
  const executableHostSource = hostSource.replace(/\/\/.*$/gm, "");
  assert(!/document\.(?:open|write|close)\s*\(/.test(executableHostSource), "the stable host must never replace itself with untrusted HTML");
  assert(hostSource.includes('document.createElement("iframe")'), "the host must create a disposable inner frame");
  assert(hostSource.includes('frame.setAttribute("sandbox", "allow-scripts")'), "the inner frame must remain opaque and scripts-only");
  assert(!swSource.includes("setupGenerativeUiNetworkGuard"), "containment must not depend on optional DNR setup");
  assert(!swSource.includes("GENERATIVE_UI_DNR_RULE_ID"), "containment must not depend on opaque-origin initiator matching");

  const guard = mod.navigationGuardScript();
  assert(!guard.includes("Object.defineProperty(window,'location'"), "the unforgeable Window.location must not be redefined");
  assert(!guard.includes("window.location.assign="), "location.assign must not be presented as overridable authority");
  assert(guard.includes("window.navigation.addEventListener"), "use the platform navigation event as defense in depth");
  assert(guard.includes("a[href],area[href]"), "link activation must be blocked");
  assert(guard.includes("'submit'"), "form activation must be blocked");

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const parentPosts = [];
  const innerPosts = [];
  const parent = { postMessage: (data) => parentPosts.push(data) };
  let messageHandler = null;
  let createCount = 0;
  let mounted = [];
  const fakeWindow = {
    parent,
    location: { href: "chrome-extension://extension-id/sandbox/artifact-preview.html" },
    addEventListener(type, fn) { if (type === "message") messageHandler = fn; },
  };
  const fakeDocument = {
    createElement(tag) {
      assertEquals(tag, "iframe");
      createCount += 1;
      return {
        attrs: {},
        contentWindow: { postMessage: (data) => innerPosts.push(data) },
        setAttribute(name, value) { this.attrs[name] = value; },
      };
    },
    body: { replaceChildren(...children) { mounted = children; } },
  };

  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  try {
    await import(`../extension/sandbox/artifact-preview.js?stable-host=${crypto.randomUUID()}`);
    assert(messageHandler, "sandbox host message listener did not register");

    const nonce = "navigation-vectors";
    const raw = `<script>
      location.assign("https://evil.invalid/assign");
      location.replace("https://evil.invalid/replace");
      location.href = "https://evil.invalid/href";
      self.location = "https://evil.invalid/self";
      top.location = "https://evil.invalid/top";
    </script><form action="https://evil.invalid/form"><button>go</button></form><a href="https://evil.invalid/link">go</a>`;
    const guarded = mod.injectFrameGuards(raw, nonce);
    messageHandler({ source: parent, data: { type: "cap:artifact-preview-open", nonce, html: guarded } });

    assertEquals(createCount, 1);
    assertEquals(mounted.length, 1);
    const frame = mounted[0];
    assertEquals(frame.id, "artifact-preview-content");
    assertEquals(frame.attrs.sandbox, "allow-scripts");
    assertEquals(frame.attrs.referrerpolicy, "no-referrer");
    assertEquals(frame.srcdoc, guarded, "interactive payload must execute only in the nested srcdoc boundary");
    for (const vector of ["location.assign", "location.replace", "location.href", "self.location", "top.location", "<form", "<a href"]) {
      assert(frame.srcdoc.includes(vector), `adversarial vector was not retained in the disposable frame: ${vector}`);
    }
    assertEquals(fakeWindow.location.href, "chrome-extension://extension-id/sandbox/artifact-preview.html", "opening hostile content must not replace the stable host URL");

    // Duplicate mount delivery is idempotent; a new nonce replaces the old
    // child instead of retaining listeners/documents from both previews.
    messageHandler({ source: parent, data: { type: "cap:artifact-preview-open", nonce, html: guarded } });
    assertEquals(createCount, 1, "same payload/nonce must not duplicate the inner frame");
    messageHandler({ source: parent, data: { type: "cap:artifact-preview-open", nonce: "next-preview", html: mod.injectFrameGuards("<button>next</button>", "next-preview") } });
    assertEquals(createCount, 2, "a new preview must replace the prior inner frame");
    assertEquals(mounted.length, 1, "only one inner preview may remain mounted");

    const current = mounted[0];
    messageHandler({ source: current.contentWindow, data: { type: "cap:preference-ready", nonce: "next-preview" } });
    assertEquals(parentPosts.length, 1, "only the validated readiness message is relayed upward");
    messageHandler({ source: parent, data: { type: "cap:preference", nonce: "next-preview", preference: { theme: "sunlit" } } });
    assertEquals(innerPosts.length, 1, "validated preference is relayed to the current inner frame");
    messageHandler({ source: current.contentWindow, data: { type: "cap:artifact-preview-open", nonce: "forged", html: "<p>forged</p>" } });
    assertEquals(createCount, 2, "an untrusted child cannot replace the host's preview authority");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

Deno.test("security: injectCspMeta places the CSP after <head> or prepends", async () => {
  const mod = await import("../extension/shared/components.js");
  const full = mod.injectCspMeta(`<!doctype html><html><head><title>t</title></head><body>x</body></html>`);
  assert(full.indexOf("Content-Security-Policy") < full.indexOf("<title>"), "CSP must precede content");
  const frag = mod.injectCspMeta(`<div>hi</div>`);
  // the CSP (and the navigation guard) must be PREPENDED before the content —
  // the guard script may precede the meta, but both must come before <div>.
  assert(frag.indexOf("Content-Security-Policy") < frag.indexOf("<div>"), "a fragment must get the CSP prepended before content");
});

Deno.test("security: a DENIED hook refuses subscription (the prompt-injection gate)", async () => {
  reset();
  const { setHookDeny, subscribeHook, checkHookAllowed } = await import("../extension/lib/hooks.js");
  await setHookDeny("bookmarks.onCreated", true);
  // the deny-list is authoritative even when the permission is present
  const sub = await subscribeHook({ hookId: "bookmarks.onCreated", recipeId: "auto-group-by-domain" });
  assertEquals(sub.ok, false);
  assert((sub.error ?? "").includes("denied"), "denied hook must fail closed");
  const check = await checkHookAllowed("bookmarks.onCreated");
  assertEquals(check.ok, false);
});

Deno.test("security: hook fan-out is bounded (unknown recipe + template size + count)", async () => {
  reset();
  const { subscribeHook } = await import("../extension/lib/hooks.js");
  // an arbitrary/unknown recipeId must NOT create a fan-out row
  const bad = await subscribeHook({ hookId: "runtime.onStartup", recipeId: "not-a-real-recipe-123" });
  assertEquals(bad.ok, false);
  assert((bad.error ?? "").includes("recipe"), "unknown recipeId must be rejected");
  // an oversized prompt template must be refused
  const huge = await subscribeHook({ hookId: "runtime.onStartup", recipeId: "auto-group-by-domain", promptTemplate: "x".repeat(70000) });
  assertEquals(huge.ok, false);
  assert((huge.error ?? "").includes("large"), "oversized template must be refused");
});

// ---- preference percolation (the controlled down-channel) ----
Deno.test("security: preference percolation accepts a valid parent message", async () => {
  const { buildPreferenceMessage, validatePreferenceMessage, applyPreference } = await import("../extension/lib/preference-bridge.js");
  const msg = buildPreferenceMessage({ theme: "sunlit", locale: "en-GB" }, "nonce-1");
  const res = validatePreferenceMessage(msg, { nonce: "nonce-1", sourceIsParent: true });
  assertEquals(res.ok, true);
  assertEquals(res.preference.theme, "sunlit");
  assertEquals(res.preference.locale, "en-GB");
  const doc = { documentElement: { setAttribute() {} } };
  const applied = applyPreference(res.preference, { document: doc });
  assertEquals(applied.theme, "sunlit");
});

Deno.test("security: preference percolation rejects forgery + replay + unknown keys", async () => {
  const { buildPreferenceMessage, validatePreferenceMessage } = await import("../extension/lib/preference-bridge.js");
  // not the parent
  const a = validatePreferenceMessage(buildPreferenceMessage({ theme: "sunlit" }, "n"), { nonce: "n", sourceIsParent: false });
  assertEquals(a.ok, false);
  // wrong nonce (replay / forgery)
  const b = validatePreferenceMessage(buildPreferenceMessage({ theme: "sunlit" }, "n"), { nonce: "other", sourceIsParent: true });
  assertEquals(b.ok, false);
  // unknown theme
  const c = validatePreferenceMessage(buildPreferenceMessage({ theme: "hacker" }, "n"), { nonce: "n", sourceIsParent: true });
  assertEquals(c.ok, false);
  // a disallowed key (the untrusted layer must not receive arbitrary settings)
  const forged = { type: "cap:preference", nonce: "n", preference: { apiKey: "x", theme: "sunlit" } };
  const d = validatePreferenceMessage(forged, { nonce: "n", sourceIsParent: true });
  assertEquals(d.ok, false);
  assert((d.error ?? "").includes("disallowed"), "unknown keys must be rejected");
  // an invalid locale
  const e = validatePreferenceMessage(buildPreferenceMessage({ locale: "!!!" }, "n"), { nonce: "n", sourceIsParent: true });
  assertEquals(e.ok, false);
});
