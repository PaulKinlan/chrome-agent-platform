// @ts-nocheck — stubs document for Deno; the module under test touches no
// browser globals at load time (all DOM work is inside mountGrantBrowser).
// tests/folder-browser.test.ts — the Settings → Local folders "Browse" drawer:
// a REAL folder-tree navigator. The backend (listFsGrantEntries) always
// resolved a relativePath into subdirectory segments; the old drawer never
// passed one, so Browse showed only the top level with no way in. This suite
// proves the drawer now navigates: breadcrumbs, Up, directory click-through,
// path-aware file View, and the loading/empty/error/truncated states.
//
// The real showDirectoryPicker cannot be driven headlessly (owner manual
// smoke), so `send` is injected and every navigation decision is asserted
// against a fake send.

import { assertEquals, assert } from "jsr:@std/assert";
import {
  joinPath,
  parentPath,
  breadcrumbParts,
  mountGrantBrowser,
} from "../extension/lib/folder-browser.js";

// --- minimal DOM stub (components.test.ts precedent) -------------------------

function makeEl(tag) {
  const el = {
    tag,
    children: [],
    style: {},
    attrs: {},
    listeners: {},
    _text: "",
    className: "",
    disabled: false,
    type: "",
    append(...nodes) {
      this._text = "";
      for (const n of nodes) { this.children.push(n); n.parent = this; }
      return this;
    },
    appendChild(n) { this.append(n); return n; },
    replaceChildren(...nodes) {
      this.children = [];
      this._text = "";
      for (const n of nodes) { this.children.push(n); n.parent = this; }
    },
    remove() {
      if (this.parent) {
        const i = this.parent.children.indexOf(this);
        if (i >= 0) this.parent.children.splice(i, 1);
      }
    },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    emit(type, ev = {}) { for (const fn of this.listeners[type] ?? []) fn(ev); },
  };
  // textContent behaves like the real DOM: assignment replaces the children
  // (text nodes are children), reading aggregates the subtree.
  Object.defineProperty(el, "textContent", {
    get() {
      if (el.children.length === 0) return el._text;
      return el.children.map((c) => c.textContent).join("");
    },
    set(v) {
      el._text = String(v);
      el.children = [];
    },
  });
  return el;
}

globalThis.document = {
  createElement: (tag) => makeEl(tag),
  createElementNS: (_ns, tag) => makeEl(tag),
};

/** The SVG line icon every entry row now carries (the emoji are gone). */
function hasLineIcon(el) {
  return (el?.children ?? []).some((c) => c.tag === "svg" && c.attrs?.stroke === "currentColor");
}

// --- test helpers ------------------------------------------------------------

function walk(node, out = []) {
  for (const c of node?.children ?? []) { out.push(c); walk(c, out); }
  return out;
}
function byClass(node, cls) {
  return walk(node).filter((n) => String(n.className).split(/\s+/).includes(cls));
}
function byText(node, text) {
  return walk(node).find((n) => n.textContent === text);
}

/** Fake send scripted per relativePath. Records every call. */
function makeSend(script) {
  const calls = [];
  const send = async (type, payload) => {
    calls.push({ type, payload });
    return script(type, payload);
  };
  return { send, calls };
}

/** A grant whose tree is a scripted map of relativePath -> list response. */
const TREE = {
  "": {
    ok: true, grantId: "g1", kind: "directory", path: "",
    entries: [
      { name: "docs", kind: "directory" },
      { name: "notes.txt", kind: "file" },
    ],
    truncated: false, total: 2,
  },
  "docs": {
    ok: true, grantId: "g1", kind: "directory", path: "docs",
    entries: [
      { name: "deep", kind: "directory" },
      { name: "guide.md", kind: "file" },
    ],
    truncated: false, total: 2,
  },
  "docs/deep": {
    ok: true, grantId: "g1", kind: "directory", path: "docs/deep",
    entries: [{ name: "x.txt", kind: "file" }],
    truncated: false, total: 1,
  },
};

function treeSend(tree) {
  return makeSend((type, payload) => {
    if (type === "fs-grant.list-entries") {
      const res = tree[payload.relativePath ?? ""];
      if (!res) return { ok: false, error: "directory_not_found", path: payload.relativePath };
      return res;
    }
    if (type === "fs-grant.read-file") {
      return {
        ok: true, grantId: "g1", name: payload.relativePath.split("/").pop(),
        size: 3, sha256: "abc", content: "hi",
      };
    }
    return { ok: false, error: `unexpected ${type}` };
  });
}

async function mount(host, send, grant = { grantId: "g1", name: "MyFolder" }) {
  const api = mountGrantBrowser({ host, grant, send });
  await flush();
  return api;
}
async function flush() { await new Promise((r) => setTimeout(r, 0)); }

// --- pure path helpers -------------------------------------------------------

Deno.test("joinPath normalises and joins", () => {
  assertEquals(joinPath("", "a"), "a");
  assertEquals(joinPath("a", "b"), "a/b");
  assertEquals(joinPath("a/b", "c.txt"), "a/b/c.txt");
  assertEquals(joinPath("a/", "/b"), "a/b");
  assertEquals(joinPath("/a/", "/b/"), "a/b");
});

Deno.test("parentPath returns the parent (root is empty)", () => {
  assertEquals(parentPath(""), "");
  assertEquals(parentPath("a"), "");
  assertEquals(parentPath("a/b"), "a");
  assertEquals(parentPath("a/b/c"), "a/b");
});

Deno.test("breadcrumbParts builds the prefix trail from the root", () => {
  assertEquals(breadcrumbParts(""), [""]);
  assertEquals(breadcrumbParts("a"), ["", "a"]);
  assertEquals(breadcrumbParts("a/b"), ["", "a", "a/b"]);
});

// --- drawer: top level -------------------------------------------------------

Deno.test("mount lists the grant root with breadcrumb + entries", async () => {
  const host = makeEl("div");
  const { send, calls } = treeSend(TREE);
  await mount(host, send);

  assertEquals(calls.length, 1);
  assertEquals(calls[0].type, "fs-grant.list-entries");
  assertEquals(calls[0].payload, { grantId: "g1", relativePath: "" });

  // Breadcrumb shows the grant root (current, aria-current).
  const crumbs = byClass(host, "fs-crumb");
  assertEquals(crumbs.length, 1);
  assertEquals(crumbs[0].textContent, "MyFolder");
  assert(crumbs[0].attrs["aria-current"] === "page");

  // A directory row is a real button; the file row is inert (has View).
  const dirBtn = byClass(host, "fs-dir");
  assertEquals(dirBtn.length, 1);
  assertEquals(dirBtn[0].textContent, "docs");
  assert(hasLineIcon(dirBtn[0]), "the directory row carries the SVG folder icon");
  assert(!dirBtn[0].textContent.includes("📁"), "no emoji in the directory row");
  const fileRow = byClass(host, "fs-file");
  assertEquals(fileRow.length, 1);
  assertEquals(fileRow[0].textContent, "notes.txt");
  assert(hasLineIcon(fileRow[0]), "the file row carries the SVG file icon");
  assertEquals(dirBtn[0].type, "button");

  const viewBtns = byClass(host, "fs-view");
  assertEquals(viewBtns.length, 1);

  // Up is disabled at the root.
  assertEquals(byClass(host, "fs-up")[0].disabled, true);
});

// --- drawer: navigation ------------------------------------------------------

Deno.test("clicking a directory row queries the subdirectory path and re-renders", async () => {
  const host = makeEl("div");
  const { send, calls } = treeSend(TREE);
  await mount(host, send);
  calls.length = 0;

  byClass(host, "fs-dir")[0].emit("click");
  await flush();

  assertEquals(calls.length, 1);
  assertEquals(calls[0].payload, { grantId: "g1", relativePath: "docs" });
  // Breadcrumbs: root › docs (2 crumbs, root clickable).
  const crumbs = byClass(host, "fs-crumb");
  assertEquals(crumbs.length, 2);
  assertEquals(crumbs[0].textContent, "MyFolder");
  assertEquals(crumbs[1].textContent, "docs");
  assert(crumbs[0].attrs["aria-current"] === undefined);
  assert(crumbs[1].attrs["aria-current"] === "page");
  // Nested contents visible.
  assertEquals(byClass(host, "fs-dir")[0].textContent, "deep");
  assert(hasLineIcon(byClass(host, "fs-dir")[0]), "the nested directory row keeps its SVG icon");
});

Deno.test("nested click-through: docs/deep, then breadcrumb back to docs", async () => {
  const host = makeEl("div");
  const { send, calls } = treeSend(TREE);
  await mount(host, send);
  calls.length = 0;

  byClass(host, "fs-dir")[0].emit("click"); // -> docs
  await flush();
  byClass(host, "fs-dir")[0].emit("click"); // -> docs/deep
  await flush();

  assertEquals(calls[1].payload, { grantId: "g1", relativePath: "docs/deep" });
  assertEquals(byClass(host, "fs-crumb").length, 3);

  // Click the middle breadcrumb (docs) -> back to docs.
  byClass(host, "fs-crumb")[1].emit("click");
  await flush();
  assertEquals(calls[2].payload, { grantId: "g1", relativePath: "docs" });
  assertEquals(byClass(host, "fs-crumb").length, 2);
  assertEquals(byClass(host, "fs-crumb")[1].textContent, "docs");
});

Deno.test("Up walks back one level and is disabled at the root", async () => {
  const host = makeEl("div");
  const { send, calls } = treeSend(TREE);
  await mount(host, send);
  calls.length = 0;

  const up = () => byClass(host, "fs-up")[0];
  assertEquals(up().disabled, true);

  byClass(host, "fs-dir")[0].emit("click"); // -> docs
  await flush();
  assertEquals(up().disabled, false);
  up().emit("click");
  await flush();
  assertEquals(calls[1].payload, { grantId: "g1", relativePath: "" });
  assertEquals(byClass(host, "fs-crumb").length, 1);
  assertEquals(up().disabled, true);

  // Deep -> Up -> Up -> root.
  byClass(host, "fs-dir")[0].emit("click"); // docs
  await flush();
  byClass(host, "fs-dir")[0].emit("click"); // docs/deep
  await flush();
  up().emit("click"); // docs
  await flush();
  assertEquals(calls[4].payload, { grantId: "g1", relativePath: "docs" });
  up().emit("click"); // root
  await flush();
  assertEquals(calls[5].payload, { grantId: "g1", relativePath: "" });
  assertEquals(up().disabled, true);
});

// --- drawer: states ----------------------------------------------------------

Deno.test("truncated response shows the truncated-at-limit notice", async () => {
  const host = makeEl("div");
  const { send } = makeSend((type, payload) => {
    if (type === "fs-grant.list-entries") {
      return {
        ok: true, grantId: "g1", kind: "directory", path: "",
        entries: [{ name: "big", kind: "file" }],
        truncated: true, total: 999,
      };
    }
    return { ok: false, error: "unexpected" };
  });
  await mount(host, send);
  const count = byClass(host, "fs-count")[0];
  assert(count.textContent.includes("truncated at limit"));
});

Deno.test("empty directory shows the empty message", async () => {
  const host = makeEl("div");
  const { send } = makeSend(() => ({
    ok: true, grantId: "g1", kind: "directory", path: "", entries: [], truncated: false, total: 0,
  }));
  await mount(host, send);
  assert(byText(host, "This directory is empty."));
});

Deno.test("list failure keeps the current view and shows the error in status", async () => {
  // A tree whose "docs" query fails, everything else works.
  const broken = { ...TREE, docs: { ok: false, error: "fs_permission_lapsed" } };
  const { send: brokenSend, calls: brokenCalls } = makeSend((type, payload) => {
    if (type === "fs-grant.list-entries") {
      return broken[payload.relativePath ?? ""] ?? { ok: false, error: "directory_not_found" };
    }
    return { ok: false, error: "unexpected" };
  });

  const host2 = makeEl("div");
  await mount(host2, brokenSend); // root ok
  brokenCalls.length = 0;
  byClass(host2, "fs-dir")[0].emit("click"); // -> docs fails
  await flush();

  // The root view is retained (docs row still present) and the error is shown.
  assert(byClass(host2, "fs-dir")[0]);
  const status = byClass(host2, "fs-status")[0];
  assert(status.textContent.includes("fs_permission_lapsed"));
  assertEquals(byClass(host2, "fs-crumb").length, 1);
});

Deno.test("a vanished subdirectory drops back to the parent and shows the notice", async () => {
  const host = makeEl("div");
  const { send, calls } = treeSend(TREE);
  await mount(host, send);
  calls.length = 0;

  byClass(host, "fs-dir")[0].emit("click"); // -> docs (exists)
  await flush();
  // Now "deep" is gone: replace the tree so docs/deep 404s.
  calls.length = 0;
  const gone = { ...TREE, "docs/deep": null }; // script returns directory_not_found
  const { send: send2, calls: calls2 } = makeSend((type, payload) => {
    if (type === "fs-grant.list-entries") {
      const res = gone[payload.relativePath ?? ""];
      if (!res) return { ok: false, error: "directory_not_found", path: payload.relativePath };
      return res;
    }
    return { ok: false, error: "unexpected" };
  });
  // Mount fresh on a new host, navigate docs -> deep (vanished).
  const host2 = makeEl("div");
  await mount(host2, send2);
  byClass(host2, "fs-dir")[0].emit("click"); // docs
  await flush();
  byClass(host2, "fs-dir")[0].emit("click"); // docs/deep -> directory_not_found
  await flush();

  // Dropped back to docs (breadcrumbs root › docs) with the notice shown.
  assertEquals(byClass(host2, "fs-crumb").length, 2);
  assertEquals(byClass(host2, "fs-crumb")[1].textContent, "docs");
  const status = byClass(host2, "fs-status")[0];
  assert(status.textContent.includes("no longer available"));
  // list-entries was called: root, docs, docs/deep (fail), then auto docs.
  const lists = calls2.filter((c) => c.type === "fs-grant.list-entries");
  assertEquals(lists.length, 4);
  assertEquals(lists[2].payload.relativePath, "docs/deep");
  assertEquals(lists[3].payload.relativePath, "docs");
});

// --- drawer: file View -------------------------------------------------------

Deno.test("file View reads through the CURRENT directory path (path-aware)", async () => {
  const host = makeEl("div");
  const { send, calls } = treeSend(TREE);
  await mount(host, send);
  calls.length = 0;

  byClass(host, "fs-dir")[0].emit("click"); // -> docs
  await flush();

  const view = byClass(host, "fs-view")[0];
  assert(view, "guide.md row has a View button");
  view.emit("click");
  await flush();

  const read = calls.find((c) => c.type === "fs-grant.read-file");
  assert(read, "read-file was called");
  assertEquals(read.payload, {
    grantId: "g1",
    relativePath: "docs/guide.md", // NOT the top-level-only "guide.md"
    asText: true,
  });
  // The viewer rendered name/size/body.
  const viewers = byClass(host, "fs-file-viewer");
  assertEquals(viewers.length, 1);
  assert(viewers[0].textContent.includes("guide.md"));
  assert(viewers[0].textContent.includes("hi"));
});
