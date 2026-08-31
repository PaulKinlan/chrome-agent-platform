// @ts-nocheck
// CAP-FB-20260830-PAGE-ACTION-TOOLS-01 — the minimal grant-gated page-action
// family (find_elements, click_element, type_text, select_option, scroll_page,
// wait_for) executed through chrome.scripting.executeScript.
//
// These tests use a jsdom-free fake `chrome.scripting.executeScript` that runs
// the tool's REAL injected function against a minimal DOM stub. They assert:
//   - find_elements returns a BOUNDED (<=200) list of {ref, role, accessibleName,
//     tag}, with the ref an OPAQUE per-snapshot integer (never a selector);
//   - click_element / type_text / select_option with a stale/unknown ref refuse
//     with "element not found — take a new snapshot";
//   - every mutating page action is refused WITHOUT the per-origin browser-
//     control grant, rendering the ONE Allow card (permissionRequirement), not a
//     bare error (falsification gate: revert the grant check → RED here);
//   - a privileged (chrome://) page is refused before any injection;
//   - the injected snapshot function is PURE and BOUNDED (caps at 200).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  browserToolset,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
  revokeBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { BROWSER_TOOL_NAMES } from "../extension/lib/chrome-tool-capabilities.js";
import { clearRunFence } from "../extension/lib/run-fence.js";
import { ledgerRowFor, isLedgerableTool } from "../extension/lib/action-ledger.js";

// ── a minimal DOM stub (no jsdom) ──────────────────────────────────────────
// Enough of the element surface the injected page-action function touches:
// tagName, attributes, textContent, value, style, getBoundingClientRect,
// scrollIntoView, focus, click, dispatchEvent, closest, form, options, labels.
class El {
  tagName: string;
  attrs = new Map<string, string>();
  _text = "";
  _value = "";
  style: Record<string, string> = {};
  clicked = 0;
  focused = 0;
  events: string[] = [];
  children: El[] = [];
  parent: El | null = null;
  form: El | null = null;
  options: El[] | null = null;
  labels: El[] | null = null;
  isContentEditable = false;
  hidden = false;
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  get id() { return this.attrs.get("id") ?? ""; }
  set value(v: string) { this._value = v; }
  get value() { return this._value || this.attrs.get("value") || ""; }
  get textContent() { return this._text || this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this._text = v; this.children = []; }
  getAttribute(n: string) { return this.attrs.has(n) ? this.attrs.get(n)! : null; }
  setAttribute(n: string, v: string) { this.attrs.set(n, String(v)); }
  removeAttribute(n: string) { this.attrs.delete(n); }
  getBoundingClientRect() { return { width: 120, height: 30, x: 0, y: 0, top: 0, left: 0 }; }
  scrollIntoView() {}
  focus() { this.focused++; }
  click() { this.clicked++; this.events.push("click"); }
  dispatchEvent(ev: { type?: string }) { this.events.push(String(ev?.type ?? "event")); return true; }
  closest(sel: string) {
    let n: El | null = this;
    while (n) { if (sel === "form" && n.tagName === "FORM") return n; n = n.parent; }
    return null;
  }
}

// A tiny document whose querySelectorAll understands only the two selector
// shapes the injected function issues: the fixed candidate selector, and
// '[data-cap-ref]'. Any '[data-cap-ref]' query filters by that attribute.
function makeDoc(all: El[]) {
  const body = new El("body");
  body._text = all.map((e) => e.textContent).join(" ");
  return {
    body,
    documentElement: new El("html"),
    getElementById: (id: string) => all.find((e) => e.id === id) ?? null,
    querySelectorAll: (sel: string) => {
      if (sel === "[data-cap-ref]") return all.filter((e) => e.attrs.has("data-cap-ref"));
      if (sel === "label") return all.filter((e) => e.tagName === "LABEL");
      if (sel === "option") return all.filter((e) => e.tagName === "OPTION");
      // the fixed candidate selector — return every interactive/labelled element
      return all.filter((e) => ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(e.tagName) || e.attrs.has("role") || e.attrs.has("tabindex"));
    },
  };
}

// ── the in-memory chrome shim ──────────────────────────────────────────────
const store = new Map<string, unknown>();
const grantedPermissions = new Set<string>(["storage", "tabs", "scripting"]);
let currentTab: { id: number; url: string } | null = null;
let dom: El[] = [];
const executeScriptCalls: unknown[] = [];

function reset() {
  store.clear();
  grantedPermissions.clear();
  for (const p of ["storage", "tabs", "scripting"]) grantedPermissions.add(p);
  currentTab = { id: 7, url: "https://shop.example/cart" };
  dom = [];
  executeScriptCalls.length = 0;
  clearRunFence();
  // Global DOM-event constructors the injected function references. Minimal
  // stubs so `new Event(...)` etc. do not throw inside the page function.
  for (const name of ["Event", "MouseEvent", "KeyboardEvent", "InputEvent"]) {
    (globalThis as Record<string, unknown>)[name] = class {
      type: string;
      constructor(type: string) { this.type = type; }
    };
  }
}

(globalThis as Record<string, unknown>).chrome = {
  permissions: {
    contains: async (q: { permissions?: string[]; origins?: string[] }) => {
      if (q?.permissions && !q.permissions.every((p) => grantedPermissions.has(p))) return false;
      return true;
    },
  },
  storage: {
    local: {
      get: async (key: string | string[]) => {
        const out: Record<string, unknown> = {};
        for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      set: async (obj: Record<string, unknown>) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      remove: async (keys: string | string[]) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
    },
  },
  tabs: {
    query: async () => (currentTab ? [currentTab] : []),
    get: async (id: number) => (currentTab && currentTab.id === id ? currentTab : null),
  },
  scripting: {
    executeScript: async ({ target, func, args }: { target: unknown; func: (...a: unknown[]) => unknown; args?: unknown[] }) => {
      executeScriptCalls.push({ target, args });
      // Run the REAL injected function against the DOM stub as globals.
      const doc = makeDoc(dom);
      const prevDoc = (globalThis as Record<string, unknown>).document;
      const prevWin = (globalThis as Record<string, unknown>).window;
      (globalThis as Record<string, unknown>).document = doc;
      (globalThis as Record<string, unknown>).window = { innerHeight: 800, scrollX: 0, scrollY: 0, scrollBy() {}, scrollTo() {} };
      try {
        const result = await func(...(args ?? []));
        return [{ result }];
      } finally {
        (globalThis as Record<string, unknown>).document = prevDoc;
        (globalThis as Record<string, unknown>).window = prevWin;
      }
    },
  },
};

function tools() { return browserToolset(false); }

// ── fixtures ────────────────────────────────────────────────────────────────
function fixtureDom() {
  const btn = new El("button", {});
  btn._text = "Add to cart";
  const input = new El("input", { type: "text", "aria-label": "Search products", id: "q" });
  const form = new El("form");
  input.form = form;
  const select = new El("select", { "aria-label": "Size" });
  const o1 = new El("option", { value: "s" }); o1._text = "Small";
  const o2 = new El("option", { value: "m" }); o2._text = "Medium";
  select.options = [o1, o2];
  const link = new El("a", { href: "/help" });
  link._text = "Help";
  return [btn, input, select, link, o1, o2, form];
}

// ── tests ────────────────────────────────────────────────────────────────────

Deno.test("the six page-action tools are present in the browser toolset and named", () => {
  reset();
  const t = tools();
  for (const name of ["find_elements", "click_element", "type_text", "select_option", "scroll_page", "wait_for"]) {
    assert(name in t, `${name} present in the toolset`);
    assert(BROWSER_TOOL_NAMES.includes(name), `${name} in BROWSER_TOOL_NAMES`);
  }
});

Deno.test("find_elements returns a bounded list of {ref, role, accessibleName, tag} with integer refs and is tagged untrusted", async () => {
  reset();
  dom = fixtureDom();
  await setOriginBrowserControlGrant(["https://shop.example"]);
  const r = await tools().find_elements.execute({});
  assert(r.untrusted === true, "the snapshot is untrusted content (attacker-controlled names are fenced)");
  assert(Array.isArray(r.elements), JSON.stringify(r));
  const byName = Object.fromEntries(r.elements.map((e: Record<string, unknown>) => [e.accessibleName, e]));
  assert("Add to cart" in byName, `accessible names resolved: ${JSON.stringify(r.elements)}`);
  assertEquals(byName["Add to cart"].role, "button");
  assertEquals(byName["Add to cart"].tag, "button");
  assert("Search products" in byName, "the input's aria-label is its accessible name");
  assertEquals(byName["Search products"].role, "textbox");
  assertEquals(byName["Size"].role, "combobox");
  // the ref is an opaque per-snapshot INTEGER, never a selector string
  for (const e of r.elements) assert(Number.isInteger(e.ref) && e.ref >= 0, `ref is an integer: ${JSON.stringify(e)}`);
});

Deno.test("find_elements is bounded at 200 nodes and reports truncation", async () => {
  reset();
  dom = [];
  for (let i = 0; i < 500; i++) { const b = new El("button"); b._text = `B${i}`; dom.push(b); }
  await setGlobalBrowserControlGrant();
  const r = await tools().find_elements.execute({});
  assert(r.elements.length <= 200, `bounded: ${r.elements.length}`);
  assertEquals(r.elements.length, 200);
  assertEquals(r.truncated, true);
});

Deno.test("click_element resolves a ref from the last snapshot and clicks the element", async () => {
  reset();
  dom = fixtureDom();
  await setOriginBrowserControlGrant(["https://shop.example"]);
  const snap = await tools().find_elements.execute({});
  const addRef = snap.elements.find((e: Record<string, unknown>) => e.accessibleName === "Add to cart").ref;
  const btn = dom[0];
  assertEquals(btn.clicked, 0);
  const r = await tools().click_element.execute({ ref: addRef });
  assertEquals(r.ok, true);
  assertEquals(btn.clicked, 1);
  assertEquals(r.name, "Add to cart");
});

Deno.test("click_element with a stale/unknown ref refuses with 'take a new snapshot'", async () => {
  reset();
  dom = fixtureDom();
  await setGlobalBrowserControlGrant();
  await tools().find_elements.execute({});
  const r = await tools().click_element.execute({ ref: 9999 });
  assert(r.ok !== true, JSON.stringify(r));
  assertEquals(r.error, "element not found — take a new snapshot");
});

Deno.test("a fresh find_elements invalidates the prior snapshot's refs (per-snapshot ids)", async () => {
  reset();
  dom = fixtureDom();
  await setGlobalBrowserControlGrant();
  const snap = await tools().find_elements.execute({});
  const linkRef = snap.elements.find((e: Record<string, unknown>) => e.accessibleName === "Help").ref;
  // the page changes: only a single button remains
  const only = new El("button"); only._text = "OK";
  dom = [only];
  await tools().find_elements.execute({}); // supersedes the prior snapshot
  const r = await tools().click_element.execute({ ref: linkRef });
  assertEquals(r.error, "element not found — take a new snapshot");
});

Deno.test("type_text sets the value via the native setter and dispatches input/change; submit requests the form", async () => {
  reset();
  dom = fixtureDom();
  await setGlobalBrowserControlGrant();
  const snap = await tools().find_elements.execute({});
  const searchRef = snap.elements.find((e: Record<string, unknown>) => e.accessibleName === "Search products").ref;
  const input = dom[1];
  let submitted = false;
  input.form!.requestSubmit = () => { submitted = true; };
  const r = await tools().type_text.execute({ ref: searchRef, value: "widgets", submit: true });
  assertEquals(r.ok, true);
  assertEquals(input.value, "widgets");
  assert(input.events.includes("input") && input.events.includes("change"), input.events.join(","));
  assert(submitted, "submit:true requested the form submit");
});

Deno.test("select_option chooses by value or visible text and rejects an unknown option", async () => {
  reset();
  dom = fixtureDom();
  await setGlobalBrowserControlGrant();
  const snap = await tools().find_elements.execute({});
  const sizeRef = snap.elements.find((e: Record<string, unknown>) => e.accessibleName === "Size").ref;
  const select = dom[2];
  const ok = await tools().select_option.execute({ ref: sizeRef, value: "Medium" });
  assertEquals(ok.ok, true);
  assertEquals(select.value, "m");
  const bad = await tools().select_option.execute({ ref: sizeRef, value: "XXL" });
  assert(bad.ok !== true && /no option matches/.test(String(bad.error)), JSON.stringify(bad));
});

Deno.test("scroll_page scrolls without a ref and refuses a stale ref", async () => {
  reset();
  dom = fixtureDom();
  await setGlobalBrowserControlGrant();
  const r = await tools().scroll_page.execute({ direction: "down" });
  assertEquals(r.ok, true);
  const stale = await tools().scroll_page.execute({ ref: 4242 });
  assertEquals(stale.error, "element not found — take a new snapshot");
});

// ── the security invariant: a mutation without the origin grant is the ONE
// Allow card, not a bare error (falsification gate) ──────────────────────────
Deno.test("every mutating page action is refused WITHOUT the origin grant and renders the Allow card", async () => {
  reset();
  dom = fixtureDom();
  // no browser-control grant at all
  await revokeBrowserControlGrant().catch(() => {});
  for (const [name, args] of [
    ["click_element", { ref: 0 }],
    ["type_text", { ref: 0, value: "x" }],
    ["select_option", { ref: 0, value: "m" }],
  ] as const) {
    const r = await (tools() as Record<string, { execute: (a: unknown) => Promise<Record<string, unknown>> }>)[name].execute(args);
    assert(r.waitingForPermission === true, `${name}: renders an approval card, not a bare error: ${JSON.stringify(r)}`);
    assert(r.permissionRequirement && Array.isArray(r.permissionRequirement.grantOrigins) && r.permissionRequirement.grantOrigins.includes("https://shop.example"), `${name}: the card names the exact origin: ${JSON.stringify(r)}`);
    // no injection happened
  }
  assertEquals(executeScriptCalls.length, 0, "no page injection fired without the grant");
});

Deno.test("a scoped origin grant for a DIFFERENT origin does not authorize a page action here", async () => {
  reset();
  dom = fixtureDom();
  await setOriginBrowserControlGrant(["https://other.example"]);
  const r = await tools().click_element.execute({ ref: 0 });
  assert(r.waitingForPermission === true, JSON.stringify(r));
  assertEquals(executeScriptCalls.length, 0);
});

Deno.test("page actions refuse on a privileged (chrome://) page before any injection", async () => {
  reset();
  currentTab = { id: 7, url: "chrome://settings" };
  await setGlobalBrowserControlGrant();
  const r = await tools().find_elements.execute({});
  assert(r.ok !== true && /http\(s\)/.test(String(r.error)), JSON.stringify(r));
  assertEquals(executeScriptCalls.length, 0, "no injection into a privileged page");
});

Deno.test("page actions refuse without the scripting permission (renders a card, not a raw failure)", async () => {
  reset();
  grantedPermissions.delete("scripting");
  await setGlobalBrowserControlGrant();
  const r = await tools().find_elements.execute({});
  assert(r.waitingForPermission === true, JSON.stringify(r));
  assert(String(r.error).includes("scripting"), JSON.stringify(r));
});

Deno.test("click_element/type_text/select_option are ledgerable and produce a human sentence; find_elements/scroll_page are not", () => {
  assert(isLedgerableTool("click_element"), "click is a mutation, ledgered");
  assert(isLedgerableTool("type_text"), "type is a mutation, ledgered");
  assert(isLedgerableTool("select_option"), "select is a mutation, ledgered");
  assert(!isLedgerableTool("find_elements"), "find_elements is read-only, not ledgered");
  assert(!isLedgerableTool("scroll_page"), "scroll is read-only, not ledgered");
  assert(!isLedgerableTool("wait_for"), "wait_for is read-only, not ledgered");
  const row = ledgerRowFor("click_element", { ref: 3 }, { ok: true, name: "Add to cart", role: "button" });
  assert(row && /Add to cart/.test(row.sentence), JSON.stringify(row));
  assertEquals(row!.inverse, null); // page actions are honestly irreversible
});
