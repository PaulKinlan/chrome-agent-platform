// lib/run-gen-cells.js — per-BUILD run-generation cells (the round-27
// blocker-4 fix, extracted for direct testability: chrome-agent-platform-k8u
// residual (c)).
//
// buildOrchestrator creates one cell per enrolled origin; the site-tool
// closures capture THEIR build's cells so a tool can read the run generation
// of the worker it belongs to. The historical defect was a MODULE-GLOBAL map:
// two concurrent builds over the same origin overwrote each other's entries —
// build A's tools captured cell A, but A's commit rebound cell B, so A's cell
// stayed null and A's runs failed site tools spuriously.
//
// The book is created INSIDE each build and never shared: two books over the
// same origin hold DISTINCT cell objects, and one build's bind() can never
// repoint another build's cell. The book is GC'd with its build.

/** A fresh per-build cell book. Never share one across builds. */
export function createRunGenCellBook() {
  const cells = new Map(); // canonical origin -> { get: () => number|null }
  return {
    /** The cell for an origin, created on first use within THIS build. */
    cellFor(origin) {
      let cell = cells.get(origin);
      if (!cell) {
        cell = { get: () => null };
        cells.set(origin, cell);
      }
      return cell;
    },
    /** Bind THIS build's cell for an origin to its worker's run-generation
     * getter. Binding an origin this build never created is a no-op (fail
     * closed) — a build can only ever bind its own cells. */
    bind(origin, getRunGen) {
      const cell = cells.get(origin);
      if (cell) cell.get = getRunGen;
    },
    /** Diagnostic: how many cells this build created. */
    size() {
      return cells.size;
    },
  };
}
