// tests/panel-frame-pool.test.ts — CAP-FB-20260828-PANEL-DOC-RETENTION-01.
// Pins the bounded panel-frame pool: the old single shared #view-frame forced a
// cross-document replace on every panel switch and the renderer retained each
// destroyed document until a major GC (measured 12 cycles: Documents 4→39,
// listeners 113→776, heap 1.8→8.4MB — scripts/panel-leak-probe.ts). The pool
// makes the document count bounded by the panel count and close a plain hide.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";

const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
const ntpHtml = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));

Deno.test("PANEL-POOL: panels use a per-path persistent frame pool (no shared #view-frame)", () => {
  assert(ntpJs.includes("const panelFrames = new Map()"), "ntp.js must declare the per-path panel frame pool");
  assert(ntpJs.includes("function panelFrameFor(path)"), "ntp.js must create panel frames lazily per path");
  assert(!ntpHtml.includes('id="view-frame"'), "the static shared #view-frame must be gone from the markup");
});

Deno.test("PANEL-POOL: a panel document is booted exactly once (no per-open navigation)", () => {
  // The only frame.src assignment in openView is the boot-once branch.
  const openView = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  assert(/if \(!frame\.src \|\| frame\.src === "about:blank"[^)]*\) \{\s*\n\s*frame\.src = frameUrl;/.test(openView),
    "openView must navigate a pooled frame only on first boot");
  assert(!/location\.replace\(/.test(openView), "openView must never replace-navigate an already-booted panel");
});

Deno.test("PANEL-POOL: close is a plain hide (no document churn on the close path)", () => {
  const hide = ntpJs.slice(ntpJs.indexOf("function hideViewInner()"), ntpJs.indexOf("function showThreadView("));
  assert(!/location\.replace\(|\.src = /.test(hide), "hideViewInner must not navigate or blank the panel frame");
});

Deno.test("PANEL-POOL: message-origin checks accept any pooled panel frame", () => {
  assert(ntpJs.includes("function isPanelFrameSource(win)"), "the pooled-frame origin check must exist");
  assert(!/e\.source !== viewFrame\.contentWindow/.test(ntpJs), "no check may address the removed shared frame");
});

Deno.test("PANEL-POOL: the joint-history back-stack contract is preserved (pushState on open, back on close)", () => {
  // CAP-FB-20260826-BACK-STACK-02: open pushes ONE history entry, close pops it.
  const openView = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  assert(/history\.pushState\(\{ route: "view"/.test(openView), "openView must keep the single pushState");
  const closeView = ntpJs.slice(ntpJs.indexOf("function closeView("), ntpJs.indexOf("// ── Multi-Page App"));
  assert(/history\.back\(\)/.test(closeView), "closeView must keep the history.back() path");
});
