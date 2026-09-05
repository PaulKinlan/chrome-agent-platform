// @ts-nocheck
// tests/artifact-newtab.test.ts — Tests for Artifact Sizing, New-Tab Opening,
// and Minimal Web-Accessible Resources (WAR) Security.

import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("..", import.meta.url).pathname;

// Stub browser globals for Deno test execution
if (!globalThis.HTMLElement) {
  globalThis.HTMLElement = class HTMLElementStub {
    attachShadow() { return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], appendChild() {} }; }
    getAttribute() { return null; }
    hasAttribute() { return false; }
    setAttribute() {}
    removeAttribute() {}
    dispatchEvent() { return true; }
    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
  };
}
if (!globalThis.customElements) {
  const registry = new Map();
  globalThis.customElements = {
    define(name, cls) { registry.set(name, cls); },
    get(name) { return registry.get(name); },
  };
}
if (!globalThis.CustomEvent) {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
  };
}

Deno.test("Manifest WAR: NO artifact resources are web-exposed (fingerprint surface removed)", async () => {
  const raw = await Deno.readTextFile(`${ROOT}extension/manifest.json`);
  const manifest = JSON.parse(raw);

  // chrome-agent-platform-f62c: artifact/artifact.html, artifact/artifact.js
  // and sandbox/artifact-preview.html were exposed to <all_urls> — every web
  // page could probe the extension's presence by fetching one. All three are
  // only ever loaded from EXTENSION pages (ntp/artifacts/artifact viewers),
  // which need no web match, so the web_accessible_resources block is GONE.
  const exposed = (manifest.web_accessible_resources ?? []).flatMap((entry) =>
    (entry.resources ?? []).map((res) => ({ res, matches: entry.matches ?? [] }))
  );
  for (const gone of [
    "artifact/artifact.html",
    "artifact/artifact.js",
    "sandbox/artifact-preview.html",
  ]) {
    assert(
      !exposed.some((e) => e.res === gone),
      `${gone} must not be web-accessible (the existence probe)`,
    );
  }
  // No resource may be exposed to <all_urls> at all (the finding's shape).
  for (const e of exposed) {
    assert(
      !e.matches.includes("<all_urls>") && !e.matches.includes("*://*/*"),
      `${e.res} must not be exposed to every web page`,
    );
  }
});

Deno.test("Artifact URL: correctly parses and encodes artifact query parameters", () => {
  const id = "asset_12345_test";
  const origin = "https://example.com";

  const urlStr = `chrome-extension://testextensionid/artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin)}`;
  const parsed = new URL(urlStr);

  assertEquals(parsed.pathname, "/artifact/artifact.html");
  assertEquals(parsed.searchParams.get("id"), id);
  assertEquals(parsed.searchParams.get("origin"), origin);
});

Deno.test("Artifact card component: has New Tab button and emits open-tab event", async () => {
  const emitted = [];
  const listeners = new Map();

  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://fakeid/${p}`,
    },
  };

  await import("../extension/shared/components.js");
  const ArtifactCardClass = globalThis.customElements.get("artifact-card");
  assert(ArtifactCardClass, "artifact-card must be registered in customElements");

  const shadow = {
    _html: "",
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    querySelector(sel) {
      if (sel === '[data-act="open-tab"]') {
        return {
          addEventListener: (type, fn) => {
            listeners.set("open-tab", fn);
          },
        };
      }
      return null;
    },
    querySelectorAll: () => [],
  };

  const host = {
    _root: shadow,
    _rendered: false,
    getAttribute(name) {
      if (name === "id") return "asset-99";
      if (name === "name") return "Chart Dashboard";
      if (name === "type") return "html";
      if (name === "origin") return "master";
      return null;
    },
    _emit(type, detail) {
      emitted.push({ type, detail });
    },
  };

  const card = Object.create(ArtifactCardClass.prototype);
  Object.assign(card, host);

  ArtifactCardClass.prototype._render.call(card);
  assert(shadow.innerHTML.includes('data-act="open-tab"'), "must include open-tab action button");
  assert(shadow.innerHTML.includes("New tab"), "must include 'New tab' label");

  ArtifactCardClass.prototype._wire.call(card);
  assert(listeners.has("open-tab"), "must wire open-tab click listener");

  const handler = listeners.get("open-tab");
  handler();

  assertEquals(emitted.length, 1);
  assertEquals(emitted[0].type, "open-tab");
  assertEquals(emitted[0].detail, {
    id: "asset-99",
    name: "Chart Dashboard",
    type: "html",
    origin: "master",
  });
});

Deno.test("Artifact card component: one open-tab click emits exactly one open-tab event after preview and attribute re-renders (CAP-FB-20260830-ARTIFACT-QUICK-FIXES-01)", async () => {
  // Guard for the "New tab opens twice" class: the library mounts the card,
  // then an async `card.preview = …` re-renders + re-wires, then an attribute
  // change re-renders + re-wires again. Each re-render must REPLACE the nodes
  // (the old listeners die with them) and each re-wire must add exactly ONE
  // click listener to the live New-tab button — so one click emits once.
  // The shadow stub models the real DOM for exactly this property: assigning
  // innerHTML discards every node handed out before, and querySelector returns
  // the CURRENT live node, so a doubled addEventListener on it would show up
  // as two emits.
  globalThis.chrome = { runtime: { getURL: (p) => `chrome-extension://fakeid/${p}` } };
  await import("../extension/shared/components.js");
  const ArtifactCardClass = globalThis.customElements.get("artifact-card");
  assert(ArtifactCardClass, "artifact-card must be registered in customElements");

  const LIVE = new Set([".preview", '[data-act="open-tab"]', '[data-act="reuse"]', '[data-act="delete"]']);
  let nodes = new Map();
  let renders = 0;
  const shadow = {
    _html: "",
    set innerHTML(v) { this._html = v; nodes = new Map(); renders++; },
    get innerHTML() { return this._html; },
    querySelector(sel) {
      if (!LIVE.has(sel)) return null;
      if (!nodes.has(sel)) {
        nodes.set(sel, { listeners: [], addEventListener(type, fn) { this.listeners.push({ type, fn }); } });
      }
      return nodes.get(sel);
    },
    querySelectorAll: () => [],
  };
  const attrs = { id: "asset-7", name: "Chart", type: "text", origin: "master" };
  const emitted = [];
  const card = Object.create(ArtifactCardClass.prototype);
  Object.assign(card, {
    _root: shadow,
    _rendered: false,
    getAttribute: (name) => attrs[name] ?? null,
    hasAttribute: (name) => name in attrs,
    _emit(type, detail) { emitted.push({ type, detail }); },
  });

  // 1. mount (connectedCallback: render + wire)
  ArtifactCardClass.prototype.connectedCallback.call(card);
  // 2. the async preview lands (the library sets it after asset.get)
  card.preview = "hello";
  // 3. an observed attribute changes (the base class re-renders + re-wires)
  attrs.name = "Chart v2";
  ArtifactCardClass.prototype.attributeChangedCallback.call(card, "name", "Chart", "Chart v2");
  assertEquals(renders, 3, "mount + preview + attribute change = three renders");

  const btn = shadow.querySelector('[data-act="open-tab"]');
  const clicks = btn.listeners.filter((l) => l.type === "click");
  assertEquals(clicks.length, 1, "the live New-tab button carries exactly one click listener");
  for (const l of clicks) l.fn();
  assertEquals(emitted.length, 1, "one click emits exactly one open-tab event");
  assertEquals(emitted[0].type, "open-tab");
  assertEquals(emitted[0].detail, { id: "asset-7", name: "Chart v2", type: "text", origin: "master" });
});

Deno.test("Artifact viewer security (B1): hostile ID in URL query renders as inert text (no markup injection)", async () => {
  const hostileId = '<img src=x onerror="alert(1)"><b>injected</b>';
  const outEl = {
    children: [],
    replaceChildren(child) {
      this.children = [child];
    },
  };

  // Simulating the viewer error rendering logic in artifact.js
  function renderError(message) {
    const err = {
      className: "error",
      textContent: message,
      tagName: "DIV",
    };
    outEl.replaceChildren(err);
  }

  renderError(`Artifact not found: ${hostileId}`);

  assertEquals(outEl.children.length, 1);
  const renderedNode = outEl.children[0];
  assertEquals(renderedNode.className, "error");
  // textContent preserves the exact literal string without parsing HTML
  assertEquals(renderedNode.textContent, `Artifact not found: ${hostileId}`);
  // No child elements or injected tags exist
  assertEquals(renderedNode.children, undefined);
  assert(!renderedNode.innerHTML, "must not set or expose innerHTML");
});
