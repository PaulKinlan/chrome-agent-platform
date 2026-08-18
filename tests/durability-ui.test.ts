// Unit tests for the sidebar durability UI contract (the STATE → ELEMENT
// mapping in lib/durability-ui.js): session/error/durable text, the stale-text
// clear, the ARIA live-region visibility, and the data-durability attribute.
// Uses a minimal DOM stub so the pure renderer is tested without a browser.

// @ts-nocheck — the DOM stub is intentionally dynamic.
import { assertEquals } from "jsr:@std/assert@1";
import {
  DURABILITY_TEXT,
  renderDurabilityState,
} from "../extension/lib/durability-ui.js";

function makeHint() {
  return { textContent: "STALE-TEXT", hidden: false };
}
function makeSide() {
  const attrs = {};
  return { setAttribute: (k, v) => { attrs[k] = v; }, _attrs: attrs };
}

Deno.test("durability: session renders the warning + is visible + data-durability=session", () => {
  const side = makeSide();
  const hint = makeHint();
  renderDurabilityState({ side, hint }, "session");
  assertEquals(hint.textContent, DURABILITY_TEXT.session);
  assertEquals(hint.hidden, false);
  assertEquals(side._attrs["data-durability"], "session");
});

Deno.test("durability: error renders the failure text + is visible + data-durability=error", () => {
  const side = makeSide();
  const hint = makeHint();
  renderDurabilityState({ side, hint }, "error");
  assertEquals(hint.textContent, DURABILITY_TEXT.error);
  assertEquals(hint.hidden, false);
  assertEquals(side._attrs["data-durability"], "error");
});

Deno.test("durability: durable clears the live-region text + hides it + data-durability=durable", () => {
  const side = makeSide();
  const hint = makeHint();
  renderDurabilityState({ side, hint }, "durable");
  assertEquals(hint.textContent, "");
  assertEquals(hint.hidden, true);
  assertEquals(side._attrs["data-durability"], "durable");
});

Deno.test("durability: unknown falls back to durable (cleared + hidden)", () => {
  const side = makeSide();
  const hint = makeHint();
  renderDurabilityState({ side, hint }, "unknown");
  assertEquals(hint.textContent, "");
  assertEquals(hint.hidden, true);
  assertEquals(side._attrs["data-durability"], "durable");
});

Deno.test("durability: stale session text is CLEARED when the state transitions session→durable", () => {
  const side = makeSide();
  const hint = makeHint();
  renderDurabilityState({ side, hint }, "session");
  assertEquals(hint.textContent, DURABILITY_TEXT.session);
  renderDurabilityState({ side, hint }, "durable");
  assertEquals(hint.textContent, "", "stale session text must clear on transition to durable");
  assertEquals(hint.hidden, true);
});

Deno.test("durability: error text is CLEARED when the state transitions error→durable", () => {
  const side = makeSide();
  const hint = makeHint();
  renderDurabilityState({ side, hint }, "error");
  assertEquals(hint.textContent, DURABILITY_TEXT.error);
  renderDurabilityState({ side, hint }, "durable");
  assertEquals(hint.textContent, "", "stale error text must clear on transition to durable");
  assertEquals(hint.hidden, true);
});

Deno.test("durability: a missing hint element does not throw (defensive)", () => {
  const side = makeSide();
  renderDurabilityState({ side, hint: null }, "session");
  assertEquals(side._attrs["data-durability"], "session");
});

Deno.test("durability: a missing side element does not throw (defensive)", () => {
  const hint = makeHint();
  renderDurabilityState({ side: null, hint }, "error");
  assertEquals(hint.textContent, DURABILITY_TEXT.error);
  assertEquals(hint.hidden, false);
});
