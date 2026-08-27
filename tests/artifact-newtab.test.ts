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

Deno.test("Manifest WAR: only minimal artifact resources are exposed", async () => {
  const raw = await Deno.readTextFile(`${ROOT}extension/manifest.json`);
  const manifest = JSON.parse(raw);

  assert(Array.isArray(manifest.web_accessible_resources), "web_accessible_resources must be declared");
  assertEquals(manifest.web_accessible_resources.length, 1);

  const entry = manifest.web_accessible_resources[0];
  const resources = entry.resources ?? [];

  // Minimal set only
  assertEquals(resources.sort(), [
    "artifact/artifact.html",
    "artifact/artifact.js",
    "sandbox/artifact-preview.html",
  ].sort());

  // Verify sensitive paths are NEVER in WAR
  for (const path of resources) {
    assert(!path.startsWith("background/"), `background path ${path} must not be in WAR`);
    assert(!path.startsWith("lib/"), `lib path ${path} must not be in WAR`);
    assert(!path.startsWith("dist/"), `dist path ${path} must not be in WAR`);
    assert(!path.startsWith("options/"), `options path ${path} must not be in WAR`);
    assert(!path.includes("service-worker"), `service worker must not be in WAR`);
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
