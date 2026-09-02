// @ts-nocheck — this file stubs browser globals (HTMLElement/customElements/
// document) that Deno's type-checker doesn't know about; runtime behavior is
// what's under test.
// tests/dialog-confirm-modernization.test.ts — CAP-FB-20260823-DIALOG-CONFIRM-
// MODERNIZATION-01: (A) the promise-based confirmActionDialog replacement is
// behavior-exact (confirm→true; cancel/Escape/backdrop→false, mutate nothing;
// destructive names the exact object and focuses Cancel; single resolution),
// driven through a minimal fake DOM; (B) an acorn AST scan proves ZERO
// window.confirm/window.prompt/window.alert call expressions remain in ANY
// shipped extension script (bare or window./globalThis.-qualified) — the
// inventory is complete and stays complete.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

// ── Minimal browser-global stubs for importing extension/shared/components.js ──
const registry = new Map();
class HTMLElementStub {
  attachShadow(_init) { return { get innerHTML() { return ""; }, set innerHTML(_v) {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {} }; }
  getAttribute(_n) { return null; }
  hasAttribute(_n) { return false; }
  setAttribute(_n, _v) {}
  removeAttribute(_n) {}
  dispatchEvent(_e) { return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
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

// ── Minimal fake DOM for the dialog helper ──
class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.attributes = {};
    this.textContent = "";
    this.className = "";
    this.id = "";
    this.type = "";
    this.open = false;
    this.focused = false;
  }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  dispatch(t, e = {}) {
    e.target ??= this;
    e.preventDefault ??= () => { e.defaultPrevented = true; };
    for (const f of this.listeners[t] ?? []) f(e);
  }
  // A REAL user click: trusted + under a live user activation (the shared
  // confirm refuses to mint an approval from a scripted click by default —
  // CAP-FB-20260830-UNTRUSTED-CONTENT-FENCING-01). `scriptedClick` is the
  // untrusted `.click()` a page/model script would issue.
  click() { this.dispatch("click", { target: this, isTrusted: true }); }
  scriptedClick() { this.dispatch("click", { target: this, isTrusted: false }); }
  remove() {
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    }
  }
  focus() { this.focused = true; FakeDoc.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
}
const FakeDoc = {
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  documentElement: new FakeNode("html"),
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  getElementById(id) {
    return this.head.children.find((c) => c.id === id) ?? null;
  },
};
globalThis.document = FakeDoc;
// A live user activation (what a real click/Enter produces in the browser).
Object.defineProperty(globalThis.navigator, "userActivation", { value: { isActive: true }, configurable: true });

const { confirmActionDialog } = await import("../extension/shared/components.js");

function openDialog(opts) {
  let settledWith = null;
  const p = confirmActionDialog(opts).then((v) => { settledWith = v; });
  const dialog = FakeDoc.body.children.filter((c) => c.tagName === "dialog").pop();
  assert(dialog, "a <dialog> is mounted into the document body");
  assertEquals(dialog.open, true, "the dialog is shown modally");
  const [heading, message, actions] = dialog.children;
  const [cancel, accept] = actions.children;
  return { p, dialog, heading, message, cancel, accept, settled: () => settledWith };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("confirmActionDialog: the confirm control resolves true and removes the dialog", async () => {
  const d = openDialog({ title: "Delete artifact", body: 'Delete "report.html"?', confirmLabel: "Delete", destructive: true });
  assertEquals(d.heading.textContent, "Delete artifact");
  assertEquals(d.message.textContent, 'Delete "report.html"?', "the destructive body names the EXACT object");
  assertEquals(d.accept.textContent, "Delete");
  assertStringIncludes(d.accept.className, "destructive");
  assertEquals(d.dialog.getAttribute("aria-label"), "Delete artifact");
  d.accept.click();
  await d.p;
  assertEquals(d.settled(), true);
  assertEquals(d.dialog.open, false);
  assertEquals(FakeDoc.body.children.includes(d.dialog), false, "the dialog is removed from the DOM");
});

Deno.test("confirmActionDialog: Cancel button resolves false (mutate-nothing path)", async () => {
  const d = openDialog({ title: "t", body: "b", confirmLabel: "OK" });
  d.cancel.click();
  await d.p;
  assertEquals(d.settled(), false);
  assertEquals(FakeDoc.body.children.includes(d.dialog), false);
});

Deno.test("confirmActionDialog: Escape (native cancel event) resolves false", async () => {
  const d = openDialog({ title: "t", body: "b" });
  d.dialog.dispatch("cancel");
  await d.p;
  assertEquals(d.settled(), false);
});

Deno.test("confirmActionDialog: backdrop light-dismiss resolves false; an inner click keeps the dialog open", async () => {
  const d = openDialog({ title: "t", body: "b" });
  // inner click: target is a child, NOT the dialog backdrop
  d.message.dispatch("click", { target: d.message });
  await tick();
  assertEquals(d.settled(), null, "inner clicks never dismiss");
  assertEquals(d.dialog.open, true);
  // backdrop click: with showModal() it lands on the <dialog> itself
  d.dialog.dispatch("click", { target: d.dialog });
  await d.p;
  assertEquals(d.settled(), false);
});

Deno.test("confirmActionDialog: single resolution — later interactions are inert", async () => {
  const d = openDialog({ title: "t", body: "b" });
  d.accept.click();
  d.cancel.click();
  d.dialog.dispatch("cancel");
  await d.p;
  await tick();
  assertEquals(d.settled(), true, "the first settle wins exactly once");
});

Deno.test("confirmActionDialog: destructive dialogs focus Cancel (safe default); non-destructive focus the accept control", async () => {
  const d1 = openDialog({ title: "t", body: "b", destructive: true });
  assertEquals(FakeDoc.activeElement, d1.cancel);
  d1.cancel.click();
  await d1.p;
  const d2 = openDialog({ title: "t", body: "b" });
  assertEquals(FakeDoc.activeElement, d2.accept);
  d2.accept.click();
  await d2.p;
});

Deno.test("confirmActionDialog: the shared style mounts exactly once across dialogs", async () => {
  const before = FakeDoc.head.children.filter((c) => c.id === "cap-confirm-dialog-style").length;
  const d1 = openDialog({ title: "a", body: "b" });
  const d2 = openDialog({ title: "c", body: "d" });
  const styles = FakeDoc.head.children.filter((c) => c.id === "cap-confirm-dialog-style");
  assertEquals(styles.length, Math.max(1, before), "one shared style element, never duplicated");
  assertStringIncludes(styles[0].textContent, ".cap-confirm-dialog::backdrop");
  d1.accept.click(); d2.cancel.click();
  await d1.p; await d2.p;
});

Deno.test("confirmActionDialog: a SCRIPTED click never approves by default (requireGenuineGesture defaults to true)", async () => {
  const d = openDialog({ title: "Close 5 tabs?", body: "Close every open tab?", confirmLabel: "Close tabs", destructive: true });
  d.accept.scriptedClick();
  await tick();
  assertEquals(d.settled(), null, "an untrusted click must not resolve the promise");
  assertEquals(d.dialog.open, true, "the dialog stays open for a real decision");
  d.cancel.click();
  await d.p;
  assertEquals(d.settled(), false);
  // The explicit opt-out still exists for side-effect-free confirms.
  const plain = openDialog({ title: "t", body: "b", requireGenuineGesture: false });
  plain.accept.scriptedClick();
  await plain.p;
  assertEquals(plain.settled(), true);
});

// ── B. Inventory completeness: zero legacy modal calls in shipped extension JS ──
Deno.test("inventory: NO window.confirm/alert/prompt call expressions remain in any shipped extension script", async () => {
  const { parse } = await import("acorn");
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const ROOT = new URL("../extension", import.meta.url).pathname;
  const SKIP = new Set(["dist", "dist-versions", "node_modules"]);
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(ent.name)) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".js")) files.push(p);
    }
  };
  walk(ROOT);
  const BANNED = new Set(["confirm", "alert", "prompt"]);
  const offenders = [];
  const visit = (node, file) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "CallExpression") {
      const c = node.callee;
      if (c.type === "Identifier" && BANNED.has(c.name)) {
        offenders.push(`${file}:${node.start} bare ${c.name}()`);
      }
      if (c.type === "MemberExpression" && !c.computed &&
          c.property.type === "Identifier" && BANNED.has(c.property.name) &&
          c.object.type === "Identifier" && (c.object.name === "window" || c.object.name === "globalThis")) {
        offenders.push(`${file}:${node.start} ${c.object.name}.${c.property.name}()`);
      }
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach((n) => visit(n, file));
      else if (v && typeof v.type === "string") visit(v, file);
    }
  };
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    let ast;
    try {
      ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
    } catch {
      ast = parse(src, { ecmaVersion: "latest", sourceType: "script" });
    }
    visit(ast, f);
  }
  assert(files.length > 100, `scan covers the shipped tree (got ${files.length})`);
  assertEquals(offenders, [], "no confirm/alert/prompt call expressions may remain in shipped extension scripts");
});

// ── CAP-FB-20260830-USER-VOICE-COPY-01: ONE delete-agent dialog ───────────
Deno.test("deleteAgentDialog produces one body for named agents and one for background agents, and requires a genuine gesture", async () => {
  const { deleteAgentDialog } = await import("../extension/shared/components.js");
  assert(typeof deleteAgentDialog === "function", "deleteAgentDialog is exported beside confirmActionDialog");
  const open = (opts) => {
    let settledWith = null;
    const p = deleteAgentDialog(opts).then((v) => { settledWith = v; });
    const dialog = FakeDoc.body.children.filter((c) => c.tagName === "dialog").pop();
    const [heading, message, actions] = dialog.children;
    const [cancel, accept] = actions.children;
    return { p, dialog, heading, message, cancel, accept, settled: () => settledWith };
  };
  // Named agent: the shared body, in the reader's words.
  const named = open({ name: "Research", kind: "named" });
  assertEquals(named.heading.textContent, "Delete Research?");
  assertEquals(named.message.textContent, "Its memory and history are removed. Artifacts it made are kept.");
  assertEquals(named.accept.textContent, "Delete");
  assertStringIncludes(named.accept.className, "destructive");
  assertEquals(FakeDoc.activeElement, named.cancel, "destructive: Cancel holds focus");
  // A scripted click never approves a delete.
  named.accept.scriptedClick();
  await tick();
  assertEquals(named.settled(), null, "a scripted click must not mint the deletion");
  assertEquals(named.dialog.open, true);
  named.cancel.click();
  await tick();
  assertEquals(named.settled(), false);
  // Background agent: its schedule is the thing that stops.
  const background = open({ name: "Reading digest", kind: "background" });
  assertEquals(background.message.textContent, "Its schedule stops and its history is removed.");
  background.cancel.click();
  await tick();
  // Site agent: the site and its page tools.
  const site = open({ name: "github.com", kind: "site" });
  assertEquals(site.message.textContent, "It stops working on this site and its page tools are removed. Artifacts it made are kept.");
  site.accept.click();
  await tick();
  assertEquals(site.settled(), true, "a genuine click deletes");
  // Every delete-agent call site goes through the helper — no hand-rolled body.
  for (const file of ["extension/ntp/ntp.js", "extension/options/options.js", "extension/sidepanel/sidepanel.js"]) {
    const src = await Deno.readTextFile(new URL(`../${file}`, import.meta.url));
    assertStringIncludes(src, "deleteAgentDialog(", `${file} uses the shared delete-agent dialog`);
    for (const stale of ["registry entry", "recurring alarm", "system prompt override", "Are you sure you want to delete ${"]) {
      assert(!src.includes(stale), `${file} must not still say "${stale}"`);
    }
  }
});
