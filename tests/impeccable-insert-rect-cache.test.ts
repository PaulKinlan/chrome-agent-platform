// tests/impeccable-insert-rect-cache.test.ts — chrome-agent-platform-ffp7s.
//
// REPEAT-AFTER-LANDING on hheu4: hheu4 cached getBoundingClientRect inside
// pickable() (live-browser-dom.js) and landed with NO test pinning the cache,
// so the insert-mode path stayed invisible: layoutFlowChildren() still mapped
// every sibling through a RAW getBoundingClientRect and handleMouseMove still
// read the target's rect raw — per uncoalesced mousemove, N+1 forced layouts.
// The nightly perf-review station re-reported it one day after the merge.
//
// COVERAGE LESSON (recorded on the bead): a perf fix that adds a cache must
// pin EVERY hot-path caller of the measurement, behaviourally. A test that
// only exercises the caller it fixed (or no test at all) lets the second
// caller ship uncached while all gates stay green.
//
// This suite drives the REAL sources: live-browser-dom.js is evaluated in a
// shim window (same technique as tests/artifact-sandbox-guidance-eval.test.ts),
// and layoutFlowChildren / handleMouseMove are brace-matched out of
// live-browser.js and compiled with the real helpers injected. It then
// falsifies itself: the same drive with the pre-fix raw reads restored
// (cachedRect(el) -> el.getBoundingClientRect()) MUST show the per-move
// multiplication, proving the assertions discriminate.

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as path from "node:path";

const SCRIPTS_DIR = path.join(Deno.cwd(), ".agents", "skills", "impeccable", "scripts");
const DOM_SOURCE = Deno.readTextFileSync(path.join(SCRIPTS_DIR, "live-browser-dom.js"));
const BROWSER_SOURCE = Deno.readTextFileSync(path.join(SCRIPTS_DIR, "live-browser.js"));

// --- source extraction -----------------------------------------------------

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `function ${name} must exist in the shipped source`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const LAYOUT_SRC = extractFunction(BROWSER_SOURCE, "layoutFlowChildren");
const MOVE_SRC = extractFunction(BROWSER_SOURCE, "handleMouseMove");

// --- shims ------------------------------------------------------------------

type FakeEl = {
  nodeType: number;
  tagName: string;
  id: string;
  classList: string[];
  rectReads: number;
  parentElement: { children: FakeEl[] } | null;
  closest: (sel: string) => null;
  getBoundingClientRect: () => Record<string, number>;
};

function makeEl(rect: { x: number; y: number; width: number; height: number }): FakeEl {
  const el: FakeEl = {
    nodeType: 1,
    tagName: "DIV",
    id: "",
    classList: [],
    rectReads: 0,
    parentElement: null,
    closest: () => null,
    getBoundingClientRect() {
      el.rectReads++;
      return {
        x: rect.x, y: rect.y,
        top: rect.y, left: rect.x,
        right: rect.x + rect.width, bottom: rect.y + rect.height,
        width: rect.width, height: rect.height,
      };
    },
  };
  return el;
}

type DomEnv = {
  helpers: ReturnType<typeof buildHelpers>;
  scrollListeners: Array<() => void>;
};

function buildHelpers(fakeWindow: { addEventListener: (t: string, fn: () => void) => void }, source: string = DOM_SOURCE) {
  const loadDom = new Function(
    "window",
    `${source}\nreturn window.__IMPECCABLE_LIVE_DOM__;`,
  ) as (w: unknown) => { version: number; createLiveBrowserDomHelpers: (opts: Record<string, unknown>) => Record<string, (...a: unknown[]) => unknown> };
  const mod = loadDom(fakeWindow);
  assertEquals(typeof mod?.createLiveBrowserDomHelpers, "function", "live-browser-dom.js must expose the factory");
  // MutationObserver is absent by default (plain Deno runtime): the module
  // guards on typeof and skips the observer, exactly like a browser-less host.
  // buildHelpersWithObserver below injects a shim to pin the observer itself.
  return mod.createLiveBrowserDomHelpers({ prefix: "imp-", document: { body: {} } });
}

// m0uen: a MutationObserver shim that captures the module's callback so tests
// can fire synthetic records at it — the browser-less way to model "a mutation
// happened between moves".
function buildHelpersWithObserver(source: string = DOM_SOURCE) {
  const observers: Array<{ cb: (records: unknown[]) => void; target: unknown; opts: unknown }> = [];
  class MutationObserverShim {
    cb: (records: unknown[]) => void;
    constructor(cb: (records: unknown[]) => void) { this.cb = cb; }
    observe(target: unknown, opts: unknown) { observers.push({ cb: this.cb, target, opts }); }
    disconnect() {}
  }
  (globalThis as Record<string, unknown>).MutationObserver = MutationObserverShim;
  try {
    const helpers = buildHelpers({ addEventListener() {} }, source);
    return { helpers, observers };
  } finally {
    delete (globalThis as Record<string, unknown>).MutationObserver;
  }
}

function loadDomEnv(): DomEnv {
  const scrollListeners: Array<() => void> = [];
  const fakeWindow = {
    addEventListener(type: string, fn: () => void) {
      if (type === "scroll") scrollListeners.push(fn);
    },
  };
  return { helpers: buildHelpers(fakeWindow), scrollListeners };
}

// Drives the REAL extracted handleMouseMove in insert mode over a static
// parent of 4 fake children. `invalidateBetweenMoves` simulates one insert
// (a DOM mutation) per move: the shipped code invalidates the shared cache
// after an apply (live-browser.js invalidateElementRects call sites).
function driveInsertMoves(opts: { moves: number; invalidateBetweenMoves?: boolean; regressed?: boolean }) {
  const { helpers } = loadDomEnv();
  const els = [0, 1, 2, 3].map((i) => makeEl({ x: i * 100, y: 0, width: 80, height: 80 }));
  // handleMouseMove walks target.parentElement — the static parent under test.
  const parent: { children: FakeEl[] } = { children: els };
  for (const el of els) el.parentElement = parent;
  const target = els[1];

  let layoutSrc = LAYOUT_SRC;
  let moveSrc = MOVE_SRC;
  if (opts.regressed) {
    // Restore the pre-ffp7s raw reads; fail loudly if the shape ever drifts
    // so the falsification half can never silently become a no-op.
    const nextLayout = layoutSrc.replace("cachedRect(el)", "el.getBoundingClientRect()");
    const nextMove = moveSrc.replace("cachedRect(target)", "target.getBoundingClientRect()");
    assert(nextLayout !== layoutSrc, "regression variant must find cachedRect(el) in layoutFlowChildren");
    assert(nextMove !== moveSrc, "regression variant must find cachedRect(target) in handleMouseMove");
    layoutSrc = nextLayout;
    moveSrc = nextMove;
  }

  const layoutFlowChildren = new Function(
    "pickable", "cachedRect",
    `${layoutSrc}\nreturn layoutFlowChildren;`,
  )(helpers.pickable, helpers.cachedRect) as (parent: { children: FakeEl[] }) => unknown[];

  const shown: unknown[] = [];
  const handleMouseMove = new Function(
    "pendingApplyInFlight", "state", "insertActive", "document", "own", "pickable",
    "hideInsertLine", "detectInsertAxis", "layoutFlowChildren", "cachedRect",
    "resolveInsertHover", "insertHoverAnchor", "insertHoverPosition", "insertHoverAxis",
    "showInsertLine", "syncPageInteractionCursor", "pickActive", "hoveredElement", "showHighlight",
    `${moveSrc}\nreturn handleMouseMove;`,
  )(
    false, "PICKING", true,
    { elementFromPoint: () => target },
    () => false, helpers.pickable,
    () => { throw new Error("hideInsertLine must not fire: the target is pickable"); },
    () => "column", layoutFlowChildren, helpers.cachedRect,
    ({ target: t }: { target: FakeEl }) => ({
      anchor: t, position: "after", axis: "column",
      line: { axis: "column", top: 90, left: 100, width: 80, height: 0 },
    }),
    null, null, null,
    (resolved: unknown) => { shown.push(resolved); },
    () => {}, false, null, () => {},
  ) as (e: { clientX: number; clientY: number }) => void;

  for (let m = 0; m < opts.moves; m++) {
    handleMouseMove({ clientX: 150, clientY: 40 });
    if (opts.invalidateBetweenMoves) helpers.invalidateElementRects();
  }
  return { els, shown, helpers };
}

// --- the shared cache itself --------------------------------------------------

Deno.test("ffp7s: pickable() and cachedRect() share ONE rect cache per invalidation scope", () => {
  const { helpers, scrollListeners } = loadDomEnv();
  const el = makeEl({ x: 0, y: 0, width: 100, height: 100 });

  assertEquals(helpers.pickable(el), true, "a 100x100 element is pickable");
  const r1 = helpers.cachedRect(el);
  const r2 = helpers.cachedRect(el);
  assertEquals(el.rectReads, 1, "pickable's read is reused by cachedRect — ONE layout read");
  assertEquals(r1, r2, "the same cached snapshot object is returned");
  assert(r1 && (r1 as Record<string, number>).width === 100);

  helpers.invalidateElementRects();
  helpers.cachedRect(el);
  assertEquals(el.rectReads, 2, "explicit invalidation (apply completion) forces exactly one re-read");

  // The scroll listener captured at helper creation must invalidate too.
  assert(scrollListeners.length >= 1, "the helper registers a scroll invalidator");
  scrollListeners[0]();
  helpers.cachedRect(el);
  assertEquals(el.rectReads, 3, "scroll invalidates the shared cache");
});

// --- the insert-mode path -----------------------------------------------------

Deno.test("ffp7s: N insert-mode mousemoves over a static DOM perform ONE layout read per element", () => {
  const { els, shown } = driveInsertMoves({ moves: 5 });
  assertEquals(shown.length, 5, "every move resolves an insert line");
  for (const [i, el] of els.entries()) {
    assertEquals(el.rectReads, 1, `element ${i} is measured exactly once across 5 moves (target included)`);
  }
});

Deno.test("ffp7s: N inserts (invalidation per move) re-measure each element ONCE per scope, never per caller", () => {
  // Models N completed inserts over an otherwise static DOM: each apply
  // invalidates, so the next move re-measures every element exactly once —
  // pickable, the sibling map and the target read all share that one read.
  const moves = 4;
  const { els } = driveInsertMoves({ moves, invalidateBetweenMoves: true });
  for (const [i, el] of els.entries()) {
    assertEquals(el.rectReads, moves, `element ${i}: one read per invalidation scope, not ${moves}+ per move`);
  }
});

Deno.test("ffp7s FALSIFICATION: restoring the raw per-move reads multiplies layout reads again", () => {
  const { els } = driveInsertMoves({ moves: 5, regressed: true });
  const totalReads = els.reduce((n, el) => n + el.rectReads, 0);
  // Pre-fix behaviour: 4 pickable reads + 5 moves x (4 sibling reads + 1 raw
  // target read) = 29. The fixed drive above totals 4. Anything > 4 proves the
  // assertions discriminate; the exact pre-fix count is pinned so a partial
  // regression (e.g. only the map restored) still fails.
  assertEquals(totalReads, 29, "the regressed path must show the full per-move multiplication");
  assert(totalReads > els.length, "regression variant must exceed one read per element");
});

// --- wiring pins (discriminating, per 961k5's lesson) -------------------------

Deno.test("ffp7s: live-browser.js consumes cachedRect from the shared helper — not a private second cache", () => {
  // The destructure must pull cachedRect from domHelpers (if this breaks, the
  // compiled drive above would stay green while the real file throws
  // ReferenceError — this pin closes that gap).
  const destructure = BROWSER_SOURCE.match(/const \{([\s\S]*?)\} = domHelpers;/);
  assert(destructure, "live-browser.js must destructure domHelpers");
  assert(/\bcachedRect\b/.test(destructure[1]), "cachedRect must be destructured from domHelpers");

  // The two hot insert-mode readers must go through the shared cache.
  assert(LAYOUT_SRC.includes("cachedRect(el)"), "layoutFlowChildren must map through cachedRect");
  assert(!LAYOUT_SRC.includes(".getBoundingClientRect()"), "layoutFlowChildren must contain no raw rect read");
  assert(MOVE_SRC.includes("cachedRect(target)"), "handleMouseMove must read the target rect through cachedRect");
  assert(!MOVE_SRC.includes("target.getBoundingClientRect()"), "handleMouseMove must not read the target rect raw");

  // And the helper module must actually export it (a rename here would make
  // every consumer above undefined at runtime). Target the helper factory's
  // own return list — makeFrozenAnchor returns an object literal too.
  assert(
    /return \{\s*own,\s*pickable,\s*cachedRect,\s*invalidateElementRects,/.test(DOM_SOURCE),
    "live-browser-dom.js must export cachedRect from createLiveBrowserDomHelpers",
  );
});

// --- m0uen: the cache must survive the overlay's OWN chrome churn -------------
//
// The reviewer's measured defect: insert mode ALWAYS mutates between moves —
// handleMouseMove's insert branch ends in syncPageInteractionCursor(), which
// rewrote the cursor <style>'s textContent unconditionally; the module's own
// MutationObserver saw that host-document mutation and emptied the cache
// before the next move ([5,5,5,5] reads per element instead of [1,1,1,1]).
// The static-DOM drives above could never see this (no MutationObserver in a
// browser-less host). These pins model the mutation explicitly.

function cursorStyleRecord() {
  // Exactly what a textContent rewrite produces: a childList record targeting
  // the <style id="imp-pick-cursor"> element, plus records targeting its text
  // node (parentElement chain, nodeType 3).
  const style = { nodeType: 1, id: "imp-pick-cursor", closest: () => null };
  const text = { nodeType: 3, parentElement: style };
  return [{ target: style }, { target: text }];
}

Deno.test("m0uen: own-chrome mutations between moves do NOT empty the shared cache; a host-page mutation DOES", () => {
  const { helpers, observers } = buildHelpersWithObserver();
  assertEquals(observers.length, 1, "the module installs exactly one MutationObserver when the host provides one");
  const fire = (records: unknown[]) => observers[0].cb(records);

  const els = [0, 1, 2, 3].map((i) => makeEl({ x: i * 100, y: 0, width: 80, height: 80 }));

  // Five "moves" in the reviewer's repro order: reads first, then the
  // production churn — the cursor style's textContent rewritten after every
  // move, firing real observer records before the next move reads.
  for (let m = 0; m < 5; m++) {
    for (const el of els) helpers.cachedRect(el);
    fire(cursorStyleRecord());
  }
  for (const [i, el] of els.entries()) {
    assertEquals(el.rectReads, 1, `element ${i}: own-chrome churn must not cost a single extra layout read (m0uen)`);
  }

  // FALSIFIER inside the same pin: a host-page record still invalidates.
  fire([{ target: els[0] }]);
  helpers.cachedRect(els[0]);
  assertEquals(els[0].rectReads, 2, "a host-page mutation must still empty the cache");
});

Deno.test("m0uen FALSIFICATION: without the own-chrome filter the same sequence empties the cache every move", () => {
  // The pre-fix observer invalidated on EVERY record. Restore exactly that and
  // the pin above must invert — proving the assertions discriminate the filter
  // and would have failed the original ffp7s delta.
  const regressed = DOM_SOURCE.replace("!isOwnChromeTarget(r && r.target)", "true");
  assert(regressed !== DOM_SOURCE, "the falsifier must find the own-chrome filter expression");
  const { helpers, observers } = buildHelpersWithObserver(regressed);
  assertEquals(observers.length, 1);
  const fire = (records: unknown[]) => observers[0].cb(records);

  const els = [0, 1, 2, 3].map((i) => makeEl({ x: i * 100, y: 0, width: 80, height: 80 }));
  for (let m = 0; m < 5; m++) {
    for (const el of els) helpers.cachedRect(el);
    fire(cursorStyleRecord());
  }
  for (const [i, el] of els.entries()) {
    // Reviewer's measured production shape: one read per element per move.
    assertEquals(el.rectReads, 5, `element ${i}: unfiltered own-chrome records must reproduce the per-move re-read`);
  }
});

Deno.test("m0uen: setPageInteractionCursor writes only when the cursor value actually changes", () => {
  const src = extractFunction(BROWSER_SOURCE, "setPageInteractionCursor");
  let writes = 0;
  let content = "";
  const style = {
    id: "",
    get textContent() { return content; },
    set textContent(v: string) { writes++; content = v; },
  };
  const fakeDocument = {
    getElementById: (id: string) => (id === "imp-pick-cursor" ? style : null),
    createElement: () => style,
    head: { appendChild: () => {} },
  };
  const setPageInteractionCursor = new Function(
    "document", "PICK_CURSOR_STYLE_ID", "PREFIX",
    `${src}\nreturn setPageInteractionCursor;`,
  )(fakeDocument, "imp-pick-cursor", "imp-") as (cursor: string) => void;

  setPageInteractionCursor("crosshair");
  assertEquals(writes, 1, "the first write establishes the value");
  for (let i = 0; i < 5; i++) setPageInteractionCursor("crosshair");
  assertEquals(writes, 1, "identical rewrites per mousemove must be skipped (m0uen churn source)");
  setPageInteractionCursor("col-resize");
  assertEquals(writes, 2, "a changed cursor value must write");
  setPageInteractionCursor("");
  assertEquals(writes, 3, "clearing an active cursor writes once");
  setPageInteractionCursor("");
  assertEquals(writes, 3, "clearing an already-empty cursor must not write");
});
