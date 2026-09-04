// @ts-nocheck — fake-DOM harness by design (same precedent as the other
// component tests).
// tests/agent-permissions-panel.test.ts — per-agent permission management in
// the agent view (CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01, increment 2,
// chrome-agent-platform-4dg). The panel shows the permission posture where
// the owner already is and mutates Chrome state ONLY from the owner's genuine
// click through the injected seam — site agents get their own host access
// (grant/revoke), named/background agents see the extension-wide posture.

import { assert, assertEquals } from "jsr:@std/assert@1";

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.className = "";
    this._text = "";
    this.hidden = false;
    this.disabled = false;
    this.type = "";
    this.children = [];
    this._listeners = new Map();
  }
  // Real-DOM semantics: assigning textContent replaces the child list.
  get textContent() { return this._text; }
  set textContent(v) {
    this._text = String(v ?? "");
    if (this._text === "") this.children = [];
  }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  appendChild(n) { this.children.push(n); return n; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  async click() {
    for (const fn of [...(this._listeners.get("click") ?? [])]) await fn({});
  }
}

function installFakeDocument() {
  const prev = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeEl(tag) };
  // Module-load globals components.js needs (custom elements + base class).
  const g = globalThis;
  const prevHtml = g.HTMLElement, prevCe = g.customElements, prevEvt = g.CustomEvent,
    prevWin = g.window, prevMm = g.matchMedia;
  g.HTMLElement ??= class HTMLElement {};
  g.customElements ??= { define() {} };
  g.CustomEvent ??= class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  };
  g.window ??= globalThis;
  g.matchMedia ??= () => ({ matches: false });
  return () => {
    globalThis.document = prev;
    if (prevHtml === undefined) delete g.HTMLElement; else g.HTMLElement = prevHtml;
    if (prevCe === undefined) delete g.customElements; else g.customElements = prevCe;
    if (prevEvt === undefined) delete g.CustomEvent; else g.CustomEvent = prevEvt;
    if (prevWin === undefined) delete g.window; else g.window = prevWin;
    if (prevMm === undefined) delete g.matchMedia; else g.matchMedia = prevMm;
  };
}

function walk(el, out = []) {
  out.push(el);
  for (const c of el.children ?? []) walk(c, out);
  return out;
}
const textOf = (root) => walk(root).map((e) => e.textContent).filter(Boolean).join("\n");
const buttons = (root) => walk(root).filter((e) => e.tagName === "BUTTON");

function fakePermissions({ permissions = [], origins = [], requestResults } = {}) {
  const state = { permissions: new Set(permissions), origins: new Set(origins) };
  const calls = { requests: [], removes: [] };
  let requestCall = 0;
  const seam = {
    getAll: async () => ({ permissions: [...state.permissions], origins: [...state.origins] }),
    request: async (q) => {
      calls.requests.push([...(q?.origins ?? [])]);
      const ok = requestResults ? (requestResults[requestCall++] ?? false) : true;
      if (ok) for (const o of q?.origins ?? []) state.origins.add(o);
      return ok;
    },
    remove: async (q) => {
      calls.removes.push([...(q?.origins ?? [])]);
      for (const o of q?.origins ?? []) state.origins.delete(o);
      return true;
    },
  };
  return { state, calls, seam };
}

Deno.test("agent permissions panel: a site agent shows its own host access — Revoke removes exactly that origin", async () => {
  const restoreDoc = installFakeDocument();
  try {
    const { renderAgentPermissionsPanel } = await import("../extension/shared/components.js");
    const perms = fakePermissions({ origins: ["https://beads.gascity.com/*"] });
    const host = new FakeEl("div");
    await renderAgentPermissionsPanel(host, { kind: "site", id: "https://beads.gascity.com", chromePermissions: perms.seam });
    assert(textOf(host).includes("https://beads.gascity.com"), "the site's origin is shown");
    assert(textOf(host).includes("Site access granted"), "the granted state is visible");
    const revoke = buttons(host).find((b) => b.textContent === "Revoke access");
    assert(revoke, "a Revoke button exists");
    await revoke.click();
    assertEquals(perms.calls.removes, [["https://beads.gascity.com/*"]], "revoke removes exactly the site's origin pattern");
    assert(textOf(host).includes("Site access not granted"), "the panel re-renders the new state");
  } finally {
    restoreDoc();
  }
});

Deno.test("agent permissions panel: a refused grant stays actionable and says so honestly", async () => {
  const restoreDoc = installFakeDocument();
  try {
    const { renderAgentPermissionsPanel } = await import("../extension/shared/components.js");
    const perms = fakePermissions({ origins: [], requestResults: [false, true] });
    const host = new FakeEl("div");
    await renderAgentPermissionsPanel(host, { kind: "site", id: "https://example.com", chromePermissions: perms.seam });
    assert(textOf(host).includes("Site access not granted"));
    const grant = buttons(host).find((b) => b.textContent === "Grant access…");
    assert(grant, "a Grant button exists");
    await grant.click();
    assertEquals(perms.calls.requests, [["https://example.com/*"]], "the request is exactly the site's origin pattern");
    assert(textOf(host).includes("did not grant site access"), "the refusal is surfaced honestly");
    assert(buttons(host).some((b) => !b.disabled && b.textContent === "Grant access…"), "the button stays actionable");
    // The owner tries again — this time Chrome grants.
    await buttons(host).find((b) => b.textContent === "Grant access…").click();
    assertEquals(perms.calls.requests.length, 2, "the second genuine click requests again");
    assert(textOf(host).includes("Site access granted"), "the granted state renders after the successful retry");
  } finally {
    restoreDoc();
  }
});

Deno.test("agent permissions panel: a named agent sees the extension-wide posture, honestly labelled, with per-origin revoke", async () => {
  const restoreDoc = installFakeDocument();
  try {
    const { renderAgentPermissionsPanel } = await import("../extension/shared/components.js");
    const perms = fakePermissions({ permissions: ["storage", "scripting"], origins: ["https://a.example/*", "https://b.example/*"] });
    const host = new FakeEl("div");
    await renderAgentPermissionsPanel(host, { kind: "named", id: "writer", chromePermissions: perms.seam });
    assert(textOf(host).includes("belong to the extension"), "the extension-wide scope is stated plainly");
    assert(textOf(host).includes("storage — granted to the extension"));
    assert(textOf(host).includes("https://a.example/*") && textOf(host).includes("https://b.example/*"), "every granted origin is listed");
    const revokes = buttons(host).filter((b) => b.textContent === "Revoke");
    assertEquals(revokes.length, 2, "one revoke per granted origin");
    await revokes[0].click();
    assertEquals(perms.calls.removes, [["https://a.example/*"]], "revocation targets the exact origin");
    assert(!textOf(host).includes("https://a.example/*"), "the revoked origin disappears");
    assert(textOf(host).includes("https://b.example/*"), "the other origin remains");
  } finally {
    restoreDoc();
  }
});

Deno.test("agent permissions panel: no seam — honest unavailable line, never a crash", async () => {
  const restoreDoc = installFakeDocument();
  try {
    const { renderAgentPermissionsPanel } = await import("../extension/shared/components.js");
    const host = new FakeEl("div");
    await renderAgentPermissionsPanel(host, { kind: "site", id: "https://example.com", chromePermissions: null });
    assert(textOf(host).includes("unavailable"), "the unavailable state is stated");
    assertEquals(buttons(host).length, 0, "no actions render without a seam");
  } finally {
    restoreDoc();
  }
});

Deno.test("agent permissions panel: the isCurrent fence stops a stale agent's read from painting", async () => {
  const restoreDoc = installFakeDocument();
  try {
    const { renderAgentPermissionsPanel } = await import("../extension/shared/components.js");
    // A SLOW getAll so the agent switch provably lands mid-read.
    let release;
    const gate = new Promise((r) => { release = r; });
    const seam = {
      getAll: async () => { await gate; return { permissions: [], origins: ["https://stale.example/*"] }; },
      request: async () => true,
      remove: async () => true,
    };
    const host = new FakeEl("div");
    let current = true;
    const p = renderAgentPermissionsPanel(host, { kind: "site", id: "https://stale.example", chromePermissions: seam, isCurrent: () => current });
    current = false; // the owner switched agents mid-read
    release();
    await p;
    assertEquals(host.children.length, 0, "nothing renders once the agent is no longer current");
  } finally {
    restoreDoc();
  }
});

Deno.test("source pin: the permissions panel is owner-surface-only — no model-callable registry names it", async () => {
  // A grant surface must never be reachable from the model's toolset: the
  // three tool registries must not mention the panel or its slot.
  for (const src of ["extension/lib/management-tools.js", "extension/lib/browser-tools.js", "extension/lib/tools.js"]) {
    const text = await Deno.readTextFile(new URL(`../${src}`, import.meta.url));
    assert(!/renderAgentPermissionsPanel|agent-permissions-slot/.test(text), `${src} must not expose the permissions panel`);
  }
});
