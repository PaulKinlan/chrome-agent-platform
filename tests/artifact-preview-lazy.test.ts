// @ts-nocheck — stubs browser globals (HTMLElement/customElements/document)
// with a minimal fake DOM, plus a chrome.runtime.sendMessage stub so
// RUNTIME_SEND binds to our recorder. The REAL AgentConversation deferral
// logic is what runs under test.
//
// tests/artifact-preview-lazy.test.ts — an <artifact-card> appended into a
// reopened long thread must not fire its asset.get RPC until the card is
// actually VISIBLE (IntersectionObserver), with an immediate fallback when no
// IntersectionObserver exists (unit harnesses / old browsers). Before the fix,
// a reopened thread fired every card's asset.get synchronously on mount (the
// 24-sequential-RPC storm on thread open).

import { assert, assertEquals } from "jsr:@std/assert";

// ── minimal fake DOM (same subset as tests/live-status-append-order.test.ts) ──
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = new Map();
    this.className = "";
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.hidden = false;
    const self = this;
    this.classList = {
      add: (c) => self.classSet.add(c),
      contains: (c) => self.classSet.has(c),
    };
    this.classSet = new Set();
  }
  get isConnected() {
    let p = this;
    while (p.parent) p = p.parent;
    return p.isHost === true;
  }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  appendChild(node) {
    node.parent?.children?.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, ref) {
    node.parent?.children?.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceChildren() { for (const c of this.children) c.parent = null; this.children = []; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  removeAttribute(n) { this.attrs.delete(n); }
  attachShadow() { return { querySelector: () => null, querySelectorAll: () => [] }; }
  addEventListener() {}
  dispatchEvent() { return true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const registry = new Map();

globalThis.HTMLElement = FakeEl;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init?.detail ?? {}; }
};
globalThis.document = {
  createElement(tag) { return new FakeEl(tag); },
  addEventListener() {},
};

// A controllable stand-in for the visibility observer.
class FakeIntersectionObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target) { this.targets.add(target); }
  unobserve(target) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  reveal(target) { this.callback([{ target, isIntersecting: true, intersectionRatio: 1 }]); }
}

/** Each test installs its own chrome stub, imports a FRESH query-busted module
 *  instance (so RUNTIME_SEND binds to THIS test's recorder) and restores the
 *  globals in finally — the tests stay order-independent. */
async function withHarness({ intersectionObserver = null, query }, fn) {
  const prevChrome = globalThis.chrome;
  const prevIO = globalThis.IntersectionObserver;
  if (intersectionObserver) globalThis.IntersectionObserver = intersectionObserver;
  else delete globalThis.IntersectionObserver;
  const rpc = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://extid/${p}`,
      sendMessage: (msg, cb) => {
        rpc.push({ type: msg?.type, id: msg?.id ?? null, origin: msg?.origin ?? null });
        if (msg?.type === "asset.get") cb({ ok: true, asset: { type: "text", name: `asset ${msg?.id}`, size: 10, content: "x" } });
        else if (msg?.type === "asset.list") cb({ ok: true, assets: [] });
        else if (msg?.type === "agent.registry") cb({ ok: true, groups: [] });
        else if (msg?.type === "skill.list") cb({ ok: true, skills: [] });
        else cb({ ok: true });
        return undefined;
      },
    },
  };
  try {
    await import(`../extension/shared/components.js?${query}`);
    const AgentConversation = registry.get("agent-conversation");
    const conv = new AgentConversation();
    conv.isHost = true;
    const assetGets = () => rpc.filter((m) => m.type === "asset.get");
    const settle = () => new Promise((r) => setTimeout(r, 0));
    await fn({ conv, assetGets, settle });
  } finally {
    if (prevIO !== undefined) globalThis.IntersectionObserver = prevIO;
    else delete globalThis.IntersectionObserver;
    if (prevChrome !== undefined) globalThis.chrome = prevChrome;
    else delete globalThis.chrome;
  }
}

Deno.test("artifact preview lazy-load: without IntersectionObserver the eager fallback fires asset.get immediately", async () => {
  await withHarness({ query: "lazy-preview-fallback=1" }, async ({ conv, assetGets, settle }) => {
    // No IntersectionObserver in this harness (unit tests / very old browsers):
    // the preview load stays EAGER — the deferral must never silently drop it.
    const before = assetGets().length;
    conv.appendArtifact({ artifact: { id: "art-eager-1", name: "Eager", type: "data" } });
    await settle();
    assertEquals(assetGets().slice(before).length, 1, "the fallback path still loads the preview");
    assertEquals(assetGets().at(-1).id, "art-eager-1");
  });
});

Deno.test("artifact preview lazy-load: appended cards defer asset.get until revealed, exactly once each", async () => {
  await withHarness({ intersectionObserver: FakeIntersectionObserver, query: "lazy-preview-observer=1" }, async ({ conv, assetGets, settle }) => {
    // A reopened thread mounts every historical card at once.
    const cards = [1, 2, 3].map((n) =>
      conv.appendArtifact({ artifact: { id: `art-lazy-${n}`, name: `Card ${n}`, type: "data" } })
    );
    await settle();
    assertEquals(assetGets().filter((m) => /^art-lazy-/.test(m?.id ?? "")).length, 0,
      "mounting offscreen cards must not fire any asset.get");

    const observer = FakeIntersectionObserver.instances.at(-1);
    assert(observer, "the conversation created an observer");
    assertEquals(observer.targets.size, 3, "all three cards are pending observation");

    // Scroll: the middle card becomes visible → exactly its preview loads.
    observer.reveal(cards[1]);
    await settle();
    assertEquals(assetGets().filter((m) => m?.id === "art-lazy-2").length, 1);
    assertEquals(assetGets().filter((m) => /^art-lazy-/.test(m?.id ?? "")).length, 1,
      "only the revealed card loaded");
    assertEquals(observer.targets.size, 2, "the revealed card is unobserved after loading");

    // A repeated reveal of the same card must not double-load.
    observer.reveal(cards[1]);
    await settle();
    assertEquals(assetGets().filter((m) => m?.id === "art-lazy-2").length, 1);

    // The remaining cards load when they scroll into view.
    observer.reveal(cards[0]);
    observer.reveal(cards[2]);
    await settle();
    assertEquals(assetGets().filter((m) => /^art-lazy-/.test(m?.id ?? "")).length, 3);
    assertEquals(observer.targets.size, 0);
  });
});

Deno.test("artifact preview lazy-load: a card removed before it is ever visible never loads its asset", async () => {
  await withHarness({ intersectionObserver: FakeIntersectionObserver, query: "lazy-preview-removed=1" }, async ({ conv, assetGets, settle }) => {
    const card = conv.appendArtifact({ artifact: { id: "art-gone-1", name: "Gone", type: "data" } });
    await settle();
    const observer = FakeIntersectionObserver.instances.at(-1);

    // The thread view is rebuilt before this offscreen card was ever visible.
    conv.replaceChildren();
    card.remove();
    observer.reveal(card); // a late record for a card that no longer exists
    await settle();
    assertEquals(assetGets().filter((m) => m?.id === "art-gone-1").length, 0,
      "a disconnected card's pending job is dropped, not loaded");
    assertEquals(observer.targets.size, 0, "the pending job was also unobserved");

    // The conversation keeps working for NEW cards after that drop.
    const next = conv.appendArtifact({ artifact: { id: "art-next-1", name: "Next", type: "data" } });
    observer.reveal(next);
    await settle();
    assertEquals(assetGets().filter((m) => m?.id === "art-next-1").length, 1);
  });
});
