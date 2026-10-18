// tests/options-memory-explorer-race.test.ts — the Data view's memory tree, driven for real.
//
// chrome-agent-platform-qq6or: a fresh profile rendered DUPLICATE identical memory rows ("The hub (1)"
// twice). The render used to be: replaceChildren() -> await the memory.stores reply -> append the new
// root. Two unqueued callers exist — the Data section's own render and hydrateBelowFoldHeavyLists' idle
// hydration — so two renders interleave inside that await: both clear, both append, and
// #memory-explorer ends up with two identical .mem-tree subtrees.
//
// This test drives the ACTUAL panel module against a minimal DOM stub (no browser, no build) and
// resolves the two replies in BOTH orders, because the defect is ordering, not content. The invariant
// is "exactly one tree, and it is the newest render's" — which the stale-token guard makes true by
// construction instead of by timing.
// @ts-nocheck — hand-rolled DOM stub (Deno has no DOM).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

// ── a small DOM good enough for panels/data.js ────────────────────────────────
class StubEl {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = new Map();
    this.className = "";
    this.textContent = "";
    this.id = "";
    this.listeners = [];
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
  }
  getAttribute(name) {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  get classList() {
    const self = this;
    const parts = () => self.className.split(/\s+/u).filter(Boolean);
    const write = (list) => { self.className = list.join(" "); };
    return {
      add: (...c) => write([...new Set([...parts(), ...c])]),
      remove: (...c) => write(parts().filter((x) => !c.includes(x))),
      contains: (c) => parts().includes(c),
      toggle: (c, force) => (force === undefined ? (parts().includes(c) ? (write(parts().filter((x) => x !== c)), false) : (write([...parts(), c]), true)) : force ? (write([...new Set([...parts(), c])]), true) : (write(parts().filter((x) => x !== c)), false)),
    };
  }
  append(...nodes) {
    for (const n of nodes) {
      if (n == null) continue;
      if (typeof n === "string") {
        const t = new StubEl("#text");
        t.textContent = n;
        t.parent = this;
        this.children.push(t);
        continue;
      }
      n.parent = this;
      this.children.push(n);
    }
  }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...nodes) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  addEventListener(type, fn) { this.listeners.push({ type, fn }); }
  removeEventListener() {}
  click() { for (const l of this.listeners) if (l.type === "click") l.fn({ preventDefault() {}, target: this }); }
  descendants() {
    const out = [];
    const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  matches(selector) {
    // supports tag, .class, #id and [attr] / [attr="value"], compounded
    const tokenRe = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/gu;
    let consumed = "";
    let m;
    while ((m = tokenRe.exec(selector)) !== null) {
      consumed += m[0];
      if (m[1] !== undefined) { if (this.tagName !== m[1].toUpperCase() && !(m[1] === "*")) return false; }
      else if (m[2] !== undefined) { if (!this.classList.contains(m[2])) return false; }
      else if (m[3] !== undefined) { if (this.id !== m[3]) return false; }
      else {
        const name = m[4];
        const want = m[5] ?? m[6];
        const have = this.getAttribute(name);
        if (have === null) return false;
        if (want !== undefined && want !== "" && have !== want) return false;
      }
    }
    return consumed.length > 0;
  }
  querySelectorAll(selector) {
    return this.descendants().filter((n) => n.matches(selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function makeDocument(host) {
  const section = new StubEl("section");
  section.setAttribute("id", "data");
  section.append(host);
  const document = {
    getElementById: (id) => (id === "data" ? section : id === "memory-explorer" ? host : null),
    createElement: (tag) => new StubEl(tag),
    createTextNode: (text) => { const t = new StubEl("#text"); t.textContent = String(text); return t; },
    querySelector: (sel) => section.querySelector(sel),
    querySelectorAll: (sel) => section.querySelectorAll(sel),
    documentElement: section,
    addEventListener() {},
    removeEventListener() {},
  };
  return { document, section };
}

/** A sendMessage whose replies are resolved by the test, so the two renders' interleaving is exact. */
function makeDeferredSend() {
  const pending = [];
  const sendMessage = (message) => new Promise((resolve) => {
    pending.push({ message, resolve });
  });
  return { pending, sendMessage };
}

const STORES_OLD = [{ kind: "master", key: "master", label: "The hub", keyCount: 1 }];
const STORES_NEW = [{ kind: "master", key: "master", label: "The hub", keyCount: 7 }];

// panels/data.js imports shared/components-core.js, which declares `class Component extends HTMLElement`
// at module scope: a Deno isolate needs the two DOM globals it names, nothing more.
if (typeof globalThis.HTMLElement === "undefined") globalThis.HTMLElement = class {};
if (typeof globalThis.customElements === "undefined") {
  globalThis.customElements = { define() {}, get() { return undefined; }, whenDefined: async () => undefined };
}

const { createPanelContext } = await import("../extension/options/panel-context.js");
const { renderMemoryExplorer } = await import("../extension/options/panels/data.js");

/** A FRESH panel context per test: the module's bindPanelCtx memoizes the active context, so reusing
 *  one across tests would make test 2 write into test 1's tree. `rawSendMessage` is the seam the
 *  panel uses for `send()`, so the test owns the reply timing exactly. */
async function loadPanel(host) {
  const { document, section } = makeDocument(host);
  globalThis.document = document;
  const { pending, sendMessage } = makeDeferredSend();
  const ctx = createPanelContext({ root: section, rawSendMessage: sendMessage });
  return { render: () => renderMemoryExplorer(ctx), pending };
}

Deno.test("qq6or: two overlapping memory-explorer renders leave ONE tree, the newest one's (reply 1 first)", async () => {
  const host = new StubEl("div");
  host.setAttribute("id", "memory-explorer");
  const { render, pending } = await loadPanel(host);

  const first = render();
  const second = render();
  assertEquals(pending.length, 2, "both renders asked for the stores (they really do overlap)");

  pending[0].resolve({ stores: STORES_OLD });
  pending[1].resolve({ stores: STORES_NEW });
  await Promise.all([first, second]);

  const trees = host.querySelectorAll(".mem-tree");
  assertEquals(trees.length, 1, "exactly one memory tree: two renders must never stack their roots");
  assertStringIncludes(trees[0].descendants().map((n) => n.textContent).join(" "), "The hub (7)",
    "the surviving tree is the NEWEST render's, not whichever reply landed last");
});

Deno.test("qq6or: a STALE reply that lands after the newest one changes nothing", async () => {
  const host = new StubEl("div");
  host.setAttribute("id", "memory-explorer");
  const { render, pending } = await loadPanel(host);

  const first = render();
  const second = render();
  pending[1].resolve({ stores: STORES_NEW }); // newest first
  await second;
  assertEquals(host.querySelectorAll(".mem-tree").length, 1);
  pending[0].resolve({ stores: STORES_OLD }); // the stale one arrives late
  await first;

  const trees = host.querySelectorAll(".mem-tree");
  assertEquals(trees.length, 1, "a late stale reply must not re-add a second tree");
  assertStringIncludes(trees[0].descendants().map((n) => n.textContent).join(" "), "The hub (7)");
});

Deno.test("qq6or: the empty-registry placeholder is also single, and a stale non-empty reply cannot replace it", async () => {
  const host = new StubEl("div");
  host.setAttribute("id", "memory-explorer");
  const { render, pending } = await loadPanel(host);

  const first = render();
  const second = render();
  pending[1].resolve({ stores: [] }); // newest: no stores
  await second;
  assertEquals(host.children.length, 1, "the placeholder is the only child");
  assertEquals(host.querySelectorAll(".mem-tree").length, 0, "no tree for an empty registry");

  pending[0].resolve({ stores: STORES_OLD });
  await first;
  assertEquals(host.querySelectorAll(".mem-tree").length, 0,
    "the stale reply must not paint a tree over the newer empty state");
  assertEquals(host.children.length, 1);
});
