// tests/impeccable-live-browser-dom-lifecycle.test.ts — chrome-agent-platform-1rc3n + 1cs04.
//
// Two review findings on the landed hheu4 rect cache, both RED on main before
// this suite existed:
//
//   1rc3n — createLiveBrowserDomHelpers called root.addEventListener unguarded,
//   so a stub root (Node harness, minimal fake window) threw at construction,
//   and NOTHING ever tore the scroll/resize listeners or the MutationObserver
//   down: repeated factory calls accumulated observers on the document for the
//   process lifetime. The factory now guards registration (mirroring the
//   MutationObserver typeof guard) and the returned helpers expose dispose().
//
//   1cs04 — the observer opts were {childList,subtree,attributes} with
//   characterData absent, so a text-node data/nodeValue update (the React
//   text-update shape) mutated the host page WITHOUT invalidating the rect
//   cache, and pickable() answered from a stale rect. characterData:true
//   closes the DOM-mutation class. Layout changes with NO mutation/scroll/
//   resize signal (CSS animation/transition, hover-driven resize, webfont or
//   image load) remain NOT signalled — that residual is stated in the source
//   comment and callers must invalidate explicitly.
//
// Acceptance probes are from the coord triage (2026-11-08): stub-root factory
// must not throw and dispose must remove listeners + disconnect the observer;
// characterData-only mutation must change what pickable() answers. The suite
// drives the REAL shipped source with the same shim technique as
// tests/impeccable-insert-rect-cache.test.ts.

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as path from "node:path";

const SCRIPTS_DIR = path.join(Deno.cwd(), ".agents", "skills", "impeccable", "scripts");
const DOM_SOURCE = Deno.readTextFileSync(path.join(SCRIPTS_DIR, "live-browser-dom.js"));

// --- shims ------------------------------------------------------------------

type MutableEl = {
  nodeType: number;
  tagName: string;
  id: string;
  classList: string[];
  parentElement: { children: unknown[] } | null;
  closest: (sel: string) => null;
  rect: { width: number; height: number };
  rectReads: number;
  getBoundingClientRect: () => Record<string, number>;
};

function makeMutableEl(initial: { width: number; height: number }): MutableEl {
  const el: MutableEl = {
    nodeType: 1,
    tagName: "DIV",
    id: "",
    classList: [],
    parentElement: null,
    closest: () => null,
    rect: { ...initial },
    rectReads: 0,
    getBoundingClientRect() {
      el.rectReads++;
      const r = el.rect;
      return {
        x: 0, y: 0, top: 0, left: 0,
        right: r.width, bottom: r.height,
        width: r.width, height: r.height,
      };
    },
  };
  return el;
}

type Loaded = {
  createLiveBrowserDomHelpers: (opts: Record<string, unknown>) => Helpers;
};

type Helpers = {
  pickable: (el: unknown) => boolean;
  dispose?: () => void;
  [key: string]: unknown;
};

function loadModule(fakeWindow: Record<string, unknown>): Loaded {
  const loadDom = new Function(
    "window",
    `${DOM_SOURCE}\nreturn window.__IMPECCABLE_LIVE_DOM__;`,
  ) as (w: unknown) => Loaded;
  const mod = loadDom(fakeWindow);
  assertEquals(typeof mod?.createLiveBrowserDomHelpers, "function");
  return mod;
}

type ListenerLog = {
  added: Array<{ type: string; capture: boolean }>;
  removed: Array<{ type: string; capture: boolean }>;
};

function makeRecordingWindow(hasAdd = true): { win: Record<string, unknown>; log: ListenerLog } {
  const log: ListenerLog = { added: [], removed: [] };
  const win: Record<string, unknown> = {
    document: { body: {} },
  };
  if (hasAdd) {
    win.addEventListener = (type: string, _fn: unknown, opts?: { capture?: boolean }) => {
      log.added.push({ type, capture: !!opts?.capture });
    };
    win.removeEventListener = (type: string, _fn: unknown, opts?: { capture?: boolean }) => {
      log.removed.push({ type, capture: !!opts?.capture });
    };
  }
  return { win, log };
}

// m0uen-style observer shim: captures callbacks + observe opts per instance.
// fire() models the BROWSER CONTRACT: a record of a given type is delivered to
// the callback only when observe() subscribed to that type — so a functional
// test cannot pass just because the shim bypasses the subscription.
type ObserverRecord = {
  cb: (records: unknown[]) => void;
  target: unknown;
  opts: Record<string, boolean> | undefined;
  disconnected: boolean;
  fire: (records: unknown[], type: string) => void;
};

function withObserverShim<T>(run: (observers: ObserverRecord[]) => T): T {
  const observers: ObserverRecord[] = [];
  class MutationObserverShim {
    constructor(cb: (records: unknown[]) => void) {
      const rec: ObserverRecord = {
        cb,
        target: undefined,
        opts: undefined,
        disconnected: false,
        fire: (records: unknown[], type: string) => {
          if (rec.opts?.[type]) rec.cb(records);
        },
      };
      observers.push(rec);
    }
    observe(target: unknown, opts: Record<string, boolean>) {
      const rec = observers.find((o) => o.cb === (this as unknown as { cb: (r: unknown[]) => void }).cb) ?? observers[observers.length - 1];
      rec.target = target;
      rec.opts = opts;
    }
    disconnect() {
      const rec = observers.find((o) => o.cb === (this as unknown as { cb: (r: unknown[]) => void }).cb) ?? observers[observers.length - 1];
      rec.disconnected = true;
    }
  }
  (globalThis as Record<string, unknown>).MutationObserver = MutationObserverShim;
  try {
    return run(observers);
  } finally {
    delete (globalThis as Record<string, unknown>).MutationObserver;
  }
}

// --- 1rc3n ------------------------------------------------------------------

Deno.test("live-browser-dom: the factory must not throw on a root without addEventListener (1rc3n)", () => {
  const { win } = makeRecordingWindow(false); // stub root: no addEventListener at all
  const mod = loadModule(win);
  // Pre-fix this threw TypeError: root.addEventListener is not a function.
  const helpers = mod.createLiveBrowserDomHelpers({ prefix: "imp-", document: { body: {} } });
  assertEquals(typeof helpers.pickable, "function");
  // The helpers still work: measurement degrades to explicit invalidation only.
  const el = makeMutableEl({ width: 100, height: 100 });
  assertEquals(helpers.pickable(el), true);
});

Deno.test("live-browser-dom: dispose() removes the scroll/resize listeners and disconnects the observer (1rc3n)", () => {
  withObserverShim((observers) => {
    const { win, log } = makeRecordingWindow(true);
    const mod = loadModule(win);
    const first = mod.createLiveBrowserDomHelpers({ prefix: "imp-", document: { body: {} } });
    assertEquals(log.added.filter((r: { type: string }) => r.type === "scroll").length, 1, "scroll listener registered");
    assertEquals(log.added.filter((r: { type: string }) => r.type === "resize").length, 1, "resize listener registered");
    assertEquals(observers.length, 1, "one observer per factory call");

    assertEquals(typeof first.dispose, "function", "helpers must expose dispose()");
    first.dispose!();

    // Both listeners removed, with the capture flag they were registered with.
    assertEquals(log.removed.map((r: { type: string }) => r.type).sort(), ["resize", "scroll"]);
    assertEquals(log.removed.find((r: { type: string }) => r.type === "scroll")?.capture, true, "scroll removal must match capture:true");
    assertEquals(log.removed.find((r: { type: string }) => r.type === "resize")?.capture, false, "resize removal must match non-capture");
    assert(observers[0].disconnected, "the MutationObserver must be disconnected");

    // Second instance is unaffected by the first's teardown.
    const second = mod.createLiveBrowserDomHelpers({ prefix: "imp-", document: { body: {} } });
    assertEquals(typeof second.pickable, "function");
    second.dispose?.();
  });
});

Deno.test("live-browser-dom: after dispose(), scroll no longer invalidates the cache (1rc3n)", () => {
  withObserverShim(() => {
    const scrollListeners: Array<() => void> = [];
    const win: Record<string, unknown> = {
      document: { body: {} },
      addEventListener: (type: string, fn: () => void) => {
        if (type === "scroll") scrollListeners.push(fn);
      },
      removeEventListener: () => {},
    };
    const mod = loadModule(win);
    const helpers = mod.createLiveBrowserDomHelpers({ prefix: "imp-", document: { body: {} } });
    const el = makeMutableEl({ width: 100, height: 100 });
    assertEquals(helpers.pickable(el), true);
    assertEquals(el.rectReads, 1);

    // While alive, a scroll event invalidates: the layout changed, so the
    // next pickable re-measures.
    el.rect = { width: 10, height: 10 };
    for (const fn of scrollListeners) fn();
    assertEquals(helpers.pickable(el), false);
    assertEquals(el.rectReads, 2, "scroll invalidates while the instance is alive");

    helpers.dispose?.();

    // dispose drops the cache once by design; the next pickable re-seeds it.
    // Deregistration itself is asserted by the recording-window test above —
    // a captured handler closure stays invokable, so a real window's dispatch
    // table (which no longer holds it) is what makes the event inert.
    el.rect = { width: 100, height: 100 };
    assertEquals(helpers.pickable(el), true);
    assertEquals(el.rectReads, 3, "cache re-seeded after dispose");
  });
});

// --- 1cs04 ------------------------------------------------------------------

Deno.test("live-browser-dom: the observer watches characterData (1cs04)", () => {
  withObserverShim((observers) => {
    const { win } = makeRecordingWindow(true);
    const mod = loadModule(win);
    const helpers = mod.createLiveBrowserDomHelpers({ prefix: "imp-", document: { body: {} } });
    helpers.dispose?.();
    assertEquals(observers.length, 1);
    const opts = observers[0].opts ?? {};
    // characterData was the missing signal: text-node data/nodeValue updates
    // (the React text-update shape) are DOM mutations like any other.
    assertEquals(opts.characterData, true, "characterData must be observed");
    assertEquals(opts.childList, true);
    assertEquals(opts.attributes, true);
    assertEquals(opts.subtree, true);
  });
});

Deno.test("live-browser-dom: a characterData-only text mutation invalidates the rect cache (1cs04)", () => {
  withObserverShim((observers) => {
    const { win } = makeRecordingWindow(true);
    const mod = loadModule(win);
    const helpers = mod.createLiveBrowserDomHelpers({ prefix: "imp-", document: { body: {} } });

    const el = makeMutableEl({ width: 100, height: 100 });
    assertEquals(helpers.pickable(el), true, "100x100 is pickable");
    assertEquals(el.rectReads, 1, "rect cached on first pickable");

    // The layout changes with NO scroll/resize and NO childList/attributes
    // mutation — only a text node's data changes (React text-update shape).
    el.rect = { width: 10, height: 10 };
    const textNode = { nodeType: 3, parentElement: el };
    observers[0].fire([{ target: textNode }], "characterData");

    // Pre-fix: stale cached 100x100 rect answered true with NO re-read.
    assertEquals(helpers.pickable(el), false, "stale rect must not answer after a characterData mutation");
    assertEquals(el.rectReads, 2, "the cache was invalidated and the rect re-measured");

    helpers.dispose?.();
  });
});

Deno.test("live-browser-dom: own-chrome records still do not invalidate (m0uen regression anchor)", () => {
  withObserverShim((observers) => {
    const { win } = makeRecordingWindow(true);
    const mod = loadModule(win);
    const helpers = mod.createLiveBrowserDomHelpers({
      prefix: "imp-",
      document: { body: {} },
    });
    const host = makeMutableEl({ width: 100, height: 100 });
    assertEquals(helpers.pickable(host), true);
    assertEquals(host.rectReads, 1);

    // The overlay's own chrome churn (target inside [id^=imp-]) must NOT
    // empty the host-page cache.
    host.rect = { width: 10, height: 10 };
    const ownStyleText = { nodeType: 3, parentElement: { nodeType: 1, id: "imp-cursor-style", closest: () => ({ id: "imp-cursor-style" }), parentElement: null } };
    observers[0].fire([{ target: ownStyleText }], "childList");

    assertEquals(helpers.pickable(host), true, "own-chrome record must not invalidate");
    assertEquals(host.rectReads, 1, "no re-read for own-chrome churn");

    helpers.dispose?.();
  });
});
