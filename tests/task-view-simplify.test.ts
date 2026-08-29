// tests/task-view-simplify.test.ts — source pins for the task-view
// simplification (owner directive 2026-08-28): the durable run registry is a
// debug affordance in an on-demand overlay, never a visible in-flow panel;
// the conversation is the status surface. Verified live by
// scripts/kat-task-view-simplify.ts (falsification-proven; base-run output is
// recorded in the round-2 commit message).

// @ts-nocheck — source-pin assertions over file contents.
import { assert, assertStringIncludes } from "jsr:@std/assert@1";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (rel) => Deno.readTextFileSync(ROOT + rel);

Deno.test("task view: the registry lives INSIDE the debug overlay panel, not the thread-body flow", () => {
  const html = read("extension/ntp/ntp.html");
  // The debug overlay exists with a11y labelling.
  assertStringIncludes(html, 'id="run-debug-panel"');
  assertStringIncludes(html, 'aria-label="Run debug details"');
  // The registry element is a CHILD of the overlay panel (one DOM region).
  const panelStart = html.indexOf('id="run-debug-panel"');
  const registryAt = html.indexOf('id="durable-run-registry"');
  const conversationAt = html.indexOf('id="thread-conversation"');
  assert(panelStart !== -1 && registryAt !== -1 && conversationAt !== -1, "all three regions exist");
  assert(panelStart < registryAt && registryAt < conversationAt, "registry is inside the debug panel, before the conversation");
  // The toggle button exists with disclosure semantics.
  assertStringIncludes(html, 'id="run-debug-toggle"');
  assertStringIncludes(html, 'aria-controls="run-debug-panel"');
  assertStringIncludes(html, 'aria-expanded="false"');
});

Deno.test("task view: the overlay is absolutely positioned (out of flow) and hidden by default", () => {
  const html = read("extension/ntp/ntp.html");
  const css = html.match(/\.run-debug \{([^}]+)\}/)?.[1] ?? "";
  assertStringIncludes(css, "position: absolute");
  assertStringIncludes(css, "inset-inline-end");
  assertStringIncludes(html, ".run-debug[hidden] { display: none; }");
});

Deno.test("task view: the toggle wiring is hover-reveal + click-pin + Escape-close, and closes on surface teardown", () => {
  const js = read("extension/ntp/ntp.js");
  assertStringIncludes(js, "setRunDebugOpen");
  assertStringIncludes(js, 'pointerenter');
  assertStringIncludes(js, 'matchMedia?.("(pointer: fine)")');
  assertStringIncludes(js, 'event.key === "Escape"');
  // The overlay closes when its surface closes (hideThreadViewInner) and when
  // a new surface opens (openThread / agent surfaces).
  const hideIdx = js.indexOf("function hideThreadViewInner");
  assert(hideIdx !== -1, "hideThreadViewInner exists");
  assertStringIncludes(js.slice(hideIdx, hideIdx + 400), "setRunDebugOpen(false)");
  // The toggle's visibility is driven by actionable runs for the surface.
  const syncIdx = js.indexOf("function syncConversationRunControls");
  assert(syncIdx !== -1, "syncConversationRunControls exists");
  assertStringIncludes(js.slice(syncIdx, syncIdx + 800), "runDebugToggle.hidden = runs.length === 0");
});

Deno.test("task view round-2: the toggle anchors to the inline-end of the view head", () => {
  const html = read("extension/ntp/ntp.html");
  // A short title must not leave the toggle mid-row — the auto inline-start
  // margin pushes it to the end edge (and flips side in RTL).
  assertStringIncludes(html, "#run-debug-toggle { margin-inline-start: auto; }");
});

Deno.test("task view round-2: the hover close is a CANCELLABLE delay, not a synchronous close", () => {
  const js = read("extension/ntp/ntp.js");
  // The panel hangs below the toggle with a gap; a synchronous pointerleave
  // close makes the hover-opened panel untraversable. The close must be a
  // delayed timer that re-entering the toggle or panel cancels.
  assertStringIncludes(js, "hoverCloseTimer");
  assertStringIncludes(js, "cancelHoverClose");
  const hoverBlock = js.slice(js.indexOf("hoverCloseTimer"), js.indexOf("hoverCloseTimer") + 1600);
  assert(/setTimeout\(\(\) => \{[^}]*setRunDebugOpen\(false\)[^}]*\}, 250\)/.test(hoverBlock), "close is delayed by ~250ms");
  assert(/pointerenter", hoverIn\)/.test(js), "re-entry cancels the pending close");
});

Deno.test("task view round-2: the KAT surfaces page exceptions and guards prerequisite interactions", () => {
  const kat = read("scripts/kat-task-view-simplify.ts");
  // CDP exceptionDetails are never discarded — a throwing page evaluation is
  // a recorded FAILURE, so base falsification runs are auditable.
  assertStringIncludes(kat, "exceptionDetails");
  assertStringIncludes(kat, "page evaluation did not throw");
  // The toggle click is guarded: on the base tree there is no toggle, and the
  // check goes RED via reported state instead of a swallowed TypeError.
  assert(/getElementById\('run-debug-toggle'\); if \(!t\) return \{ clicked: false \}/.test(kat), "toggle click is guarded");
  // The KAT covers hover traversal, click-outside, coarse-pointer, RTL
  // geometry, and repeated open/close lifecycle.
  assertStringIncludes(kat, "TRAVERSABLE");
  assertStringIncludes(kat, "coarse");
  assertStringIncludes(kat, "RTL");
  assertStringIncludes(kat, "repeated open/Escape-close lifecycle");
  assertStringIncludes(kat, "click OUTSIDE");
});
