// tests/task-view-simplify.test.ts — source pins for the task-view
// simplification (owner directive 2026-08-28): the durable run registry is a
// debug affordance in an on-demand overlay, never a visible in-flow panel;
// the conversation is the status surface. Verified live by
// scripts/kat-task-view-simplify.ts (falsification-proven; base-run output is
// recorded in the round-2 commit message).

// @ts-nocheck — source-pin assertions over file contents.
import { fileURLToPath } from "node:url";
import { assert, assertStringIncludes } from "jsr:@std/assert@1";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => Deno.readTextFileSync(ROOT + rel);

/** The body of a top-level `function <name>(…) { … }`, found by NAME and ended by the matching brace —
 *  so a pin names the wiring it means and a longer function cannot move it out of reach. */
function functionBody(source: string, name: string): string | null {
  const at = source.indexOf(`function ${name}(`);
  if (at === -1) return null;
  const open = source.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

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
  // The toggle's visibility is driven by the runs for the current surface (since the 3p3e.6
  // re-truth: SETTLED runs count too — filtering to actionable phases made the affordance vanish the
  // moment a run succeeded). THE PIN BINDS THE FUNCTION, NOT A CHARACTER WINDOW: the previous version
  // read the first 800 characters after the declaration, and the expression drifted past that window
  // while the behaviour stayed (chrome-agent-platform-i76t) — a pin that fails because a function grew
  // is testing the file's length, not the wiring.
  const syncBody = functionBody(js, "syncConversationRunControls");
  assert(syncBody !== null, "syncConversationRunControls exists");
  assertStringIncludes(syncBody, "runDebugToggle.hidden = runs.length === 0");
  // …and a toggle with nothing behind it must not leave the panel open.
  assertStringIncludes(syncBody, "setRunDebugOpen(false)");
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
