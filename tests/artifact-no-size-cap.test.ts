// tests/artifact-no-size-cap.test.ts — chrome-agent-platform-p45y (r5 review,
// owner 2026-09-03: NO self-imposed size caps on artifact rendering).
//
// Two behaviors the r5 round removes caps from:
//
//   P1 — the sandbox preview host (sandbox/artifact-preview.js) silently
//        dropped any guarded HTML payload over 300,000 characters, so an HTML
//        artifact grown across valid ≤64 KiB appends stored fine past 300,000
//        chars yet never mounted — the host later reported "content never
//        arrived". The cap is GONE: whatever guarded HTML a valid payload
//        delivers is mounted as-is (the 15 s readiness watchdog stays as the
//        honest error only when nothing genuinely arrives).
//   P2 — <artifact-inspector> refused any body over a 4 MiB RAW-byte ceiling
//        ("not rendered, Copy disabled"), which could hide append-grown and
//        escaping-heavy bodies even though the source view must show the
//        complete stored content. The refusal is GONE: a body of ANY raw or
//        serialized size renders complete (only synchronous syntax
//        highlighting stays bounded to its tokenize budget).
//
// Both are BEHAVIOR tests (not greps): a real payload drives the real host
// message handler, and the real registered inspector class renders real
// assets through its own _render. RED against the r4 code: the host drops the
// >300,000-char payload (no frame mounts) and the inspector refuses bodies
// over the raw 4 MiB ceiling (empty code + "not rendered" status). The
// escaping-heavy inspector case (raw 3 MiB, under r4's RAW band) is RED only
// through its source-pin: the inspector source must contain no
// MAX_ARTIFACT_BODY_BYTES / mount-refusal branch (r4's did).
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";

const registry = new Map();

class HTMLElementStub {
  constructor() { this._attrs = new Map(); }
  attachShadow(_init) { return new ShadowRootStub(); }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  hasAttribute(n) { return this._attrs.has(n); }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  removeAttribute(n) { this._attrs.delete(n); }
  dispatchEvent(_e) { return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
class ShadowRootStub {
  get innerHTML() { return ""; }
  set innerHTML(_v) {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild() {}
}
globalThis.HTMLElement = globalThis.HTMLElement || HTMLElementStub;
globalThis.customElements = globalThis.customElements || {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis.window || globalThis;
globalThis.CustomEvent = globalThis.CustomEvent || class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
};
globalThis.document = globalThis.document || {
  createElement: () => new HTMLElementStub(),
  head: new HTMLElementStub(),
  documentElement: new HTMLElementStub(),
};
globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false }));

const ROOT = new URL("..", import.meta.url).pathname;

/** A tiny stub element for the inspector's shadow queries. */
function stubEl() {
  const el = {
    textContent: "", hidden: false, attrs: {}, children: [],
    setAttribute(n, v) { this.attrs[n] = String(v); },
    replaceChildren(...kids) { this.children = kids; },
  };
  return el;
}

// ---- P2: <artifact-inspector> renders complete bodies at ANY size ----------

Deno.test("artifact inspector: an escaping-heavy body (raw < 4 MiB, serialized > 4 MiB) renders COMPLETE — no size refusal (p45y r5)", async () => {
  // SOURCE-PIN (the behavioral render below cannot alone prove the guard's
  // removal: r4's inspector refused on RAW byte count, and this sample's raw
  // 3 MiB stayed under the old raw 4 MiB band, so r4 rendered it too — only
  // the source can show the refusal branch is gone). RED on the r4 source
  // (it defined MAX_ARTIFACT_BODY_BYTES and refused from DOM mount); GREEN
  // here where the inspector has no size-based mount refusal left.
  for (const [label, src] of [
    ["components.js", Deno.readTextFileSync(new URL("../extension/shared/components.js", import.meta.url))],
    ["docs/components.js", Deno.readTextFileSync(new URL("../docs/components.js", import.meta.url))],
  ]) {
    const inspector = src.slice(src.indexOf("/* <artifact-inspector>"), src.indexOf('customElements.define("artifact-inspector"'));
    assert(
      !/MAX_ARTIFACT_BODY_BYTES/.test(inspector) && !/refused from DOM mount/.test(inspector) && !/larger than any valid artifact/.test(inspector),
      `${label}: the inspector must have no size-based mount refusal (the r4 4 MiB raw guard is gone)`,
    );
  }

  const mod = await import(`../extension/shared/components.js?inspector-escape=${crypto.randomUUID()}`);
  const InspectorClass = globalThis.customElements.get("artifact-inspector");
  if (!InspectorClass) throw new Error("artifact-inspector must be registered");

  // '"' escapes to \" in JSON: raw bytes stay under 4 MiB while the store's
  // serialized-byte measure (JSON.stringify) is above the 4 MiB blob ceiling.
  // The render path has no size refusal of its own (p45y r5): a body whose
  // serialized size exceeds the STORE ceiling is foreign data only on the
  // write path — the inspector still renders it whole, byte for byte.
  const content = '"'.repeat(3 * 1024 * 1024);
  const rawBytes = new TextEncoder().encode(content).byteLength;
  const serializedBytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
  assert(rawBytes < 4 * 1024 * 1024, "the sample raw size must be below the old raw ceiling");
  assert(serializedBytes > 4 * 1024 * 1024, "the sample serialized size must exceed the store ceiling");

  const els = { meta: stubEl(), code: stubEl(), note: stubEl() };
  const insp = Object.create(InspectorClass.prototype);
  insp._root = {
    innerHTML: "",
    querySelector: (sel) => sel === ".meta" ? els.meta : sel === "code" ? els.code : sel === ".note" ? els.note : null,
    querySelectorAll: () => [],
  };
  insp._rendered = true;
  insp._asset = { type: "html", name: "escape-heavy", content, size: rawBytes, origin: "master" };
  insp._render();

  assertEquals(els.code.textContent, content, "the complete escaping-heavy body must render byte-for-byte");
  assert(els.code.textContent.length === content.length, "no truncation and no empty refusal");
});

Deno.test("artifact inspector: a body over the old 4 MiB raw ceiling renders COMPLETE — no size refusal (p45y r5)", async () => {
  const mod = await import(`../extension/shared/components.js?inspector-huge=${crypto.randomUUID()}`);
  const InspectorClass = globalThis.customElements.get("artifact-inspector");
  if (!InspectorClass) throw new Error("artifact-inspector must be registered");

  // Larger than the r4 inspector's 4 MiB RAW refusal band: the source view
  // must still show all of it.
  const content = "x".repeat(4 * 1024 * 1024 + 64 * 1024);
  const els = { meta: stubEl(), code: stubEl(), note: stubEl() };
  const insp = Object.create(InspectorClass.prototype);
  insp._root = {
    innerHTML: "",
    querySelector: (sel) => sel === ".meta" ? els.meta : sel === "code" ? els.code : sel === ".note" ? els.note : null,
    querySelectorAll: () => [],
  };
  insp._rendered = true;
  insp._asset = { type: "text", name: "huge", content, size: content.length, origin: "master" };
  insp._render();

  assertEquals(els.code.textContent, content, "the complete multi-MB body must render byte-for-byte");
  assert(els.code.textContent.length === content.length, "no truncation and no empty refusal");
});

// ---- P1: the sandbox preview host mounts guarded HTML of ANY size ----------

/** Load the real host module with a fake window/document (same harness shape
 * as tests/security.test.ts) and return the capture + message handler. */
async function loadHost() {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const parentPosts = [];
  let messageHandler = null;
  const mounted = [];
  let createCount = 0;
  const status = { textContent: "" };
  const fakeWindow = {
    parent: { postMessage: (data) => parentPosts.push(data) },
    location: { href: "chrome-extension://extension-id/sandbox/artifact-preview.html" },
    addEventListener(type, fn) { if (type === "message") messageHandler = fn; },
  };
  const fakeDocument = {
    createElement(tag) {
      if (tag !== "iframe") throw new Error(`unexpected createElement: ${tag}`);
      createCount += 1;
      return {
        attrs: {},
        contentWindow: { postMessage: () => {} },
        setAttribute(name, value) { this.attrs[name] = value; },
      };
    },
    getElementById(id) {
      assertEquals(id, "preview-status");
      return { textContent: "", after() {}, ...status };
    },
    body: { replaceChildren(...children) { mounted.length = 0; mounted.push(...children); } },
  };
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  try {
    await import(`../extension/sandbox/artifact-preview.js?no-size-cap=${crypto.randomUUID()}`);
  } catch (e) {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    throw e;
  }
  return {
    status,
    mounted,
    createCount: () => createCount,
    handler: (data) => messageHandler({ source: fakeWindow.parent, data }),
    restore() { globalThis.window = previousWindow; globalThis.document = previousDocument; },
  };
}

Deno.test("preview host: a guarded HTML payload over 300,000 characters MOUNTS (no size cap — append-grown artifacts preview)", async () => {
  const mod = await import(`../extension/shared/components.js?host-guard=${crypto.randomUUID()}`);
  const host = await loadHost();
  try {
    const nonce = "append-grown-over-300k";
    const content = "<!doctype html><html><body id=\"grown\">" + "a".repeat(300_000) + "<p id=\"grown-tail\">TAIL-OVER-300K</p></body></html>";
    assert(content.length > 300_000, "the sample must exceed the removed preview cap");
    const guarded = mod.injectFrameGuards(content, nonce);
    host.handler({ type: "cap:artifact-preview-open", nonce, html: guarded });

    assertEquals(host.createCount(), 1, "the payload must mount a preview frame (r4 silently dropped it)");
    assertEquals(host.mounted.length, 1, "exactly one inner preview frame remains");
    const frame = host.mounted[0];
    assertEquals(frame.srcdoc, guarded, "the complete guarded payload must reach the nested srcdoc boundary");
    assert(frame.srcdoc.endsWith("TAIL-OVER-300K</p></body></html>"), "the append-grown tail must be present at the very end");
    // No over-limit refusal text: with the cap gone the status stays untouched
    // (only the never-arrived watchdog writes to it, and a payload DID arrive).
    assertEquals(host.status.textContent, "", "no size-refusal message may be shown");
  } finally {
    host.restore();
  }
});

Deno.test("preview host: a multi-MB guarded payload MOUNTS (no residual 4 MiB-adjacent bound)", async () => {
  const mod = await import(`../extension/shared/components.js?host-huge=${crypto.randomUUID()}`);
  const host = await loadHost();
  try {
    const nonce = "multi-megabyte";
    const content = "<body>" + "m".repeat(4 * 1024 * 1024 + 256 * 1024) + "</body>";
    const guarded = mod.injectFrameGuards(content, nonce);
    host.handler({ type: "cap:artifact-preview-open", nonce, html: guarded });

    assertEquals(host.createCount(), 1, "the multi-MB payload must mount a preview frame");
    assertEquals(host.mounted[0].srcdoc, guarded, "the complete multi-MB payload reaches the nested frame");
  } finally {
    host.restore();
  }
});

Deno.test("preview host: the source keeps the honest never-arrived watchdog and no size gate", async () => {
  const hostSource = await Deno.readTextFile(new URL("../extension/sandbox/artifact-preview.js", import.meta.url));
  // The r5 cap removal: no 300,000-char ceiling, no length/byte comparison
  // before mount — anything a valid payload delivers is mounted as-is.
  assert(!hostSource.includes("300000"), "the 300,000-char preview cap must not return");
  assert(!/html\.(?:length|byteLength)\s*>/.test(hostSource), "no size comparison may gate the mount");
  // The watchdog stays as the honest report only when nothing ever arrives.
  assert(hostSource.includes("content never arrived"), "the never-arrived watchdog must stay");
  assert(hostSource.includes("PREVIEW_TIMEOUT_MS"), "the readiness watchdog timing must stay");
});
