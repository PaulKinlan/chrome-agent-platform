// tests/bundle-budget.test.ts — the store-target bundle budget gate
// (CAP-FB-20260830-BUNDLE-BUDGET-01).
//
// The Aug-2026 finding: the SW bundle reached 4.56 MB against the
// constitution's ~2.5 MB note because nothing in the build failed when it
// grew, and the "store = minified" contract was never implemented (the store
// shipped 141k lines of readable JS). The fix: metafile-backed contributor
// reporting on every build, store-target minification after the eval scrub,
// and a hard 3.0 MB gate on the minified SW bundle.
//
// Falsification: set the gate to 1 MB and the store build fails naming the
// top contributors; restore and it passes. The order pin (scrub BEFORE
// minify) is the safety-critical invariant: the eval scrub's textual patterns
// only match unminified code.
// @ts-nocheck

import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import {
  assertBundleBudget,
  BUDGET_REPORTED_BUNDLES,
  formatContributors,
  STORE_SW_BUDGET_BYTES,
  topContributors,
} from "../scripts/bundle-budget.mjs";

Deno.test("bundle budget: the store SW budget is exactly the constitution number (3.0 MB)", () => {
  assertEquals(STORE_SW_BUDGET_BYTES, 3_000_000);
  assert(BUDGET_REPORTED_BUNDLES.includes("background/service-worker.js"));
});

Deno.test("bundle budget: topContributors sorts largest-first and truncates", () => {
  const metafile = {
    inputs: {
      "small.js": { bytes: 10 },
      "big.js": { bytes: 9000 },
      "mid.js": { bytes: 500 },
    },
  };
  const top = topContributors(metafile, 2);
  assertEquals(top, [
    { input: "big.js", bytes: 9000 },
    { input: "mid.js", bytes: 500 },
  ]);
  assertStringIncludes(formatContributors(metafile), "big.js");
  assertEquals(topContributors(null), []);
  assertEquals(topContributors({}), []);
});

Deno.test("bundle budget: under-budget passes; over-budget throws naming file, actual, budget and contributors", () => {
  assertEquals(assertBundleBudget({ label: "x.js", bytes: 100 }), 100);
  assertEquals(assertBundleBudget({ label: "x.js", bytes: 3_000_000 }), 3_000_000, "the exact boundary passes");

  const metafile = { inputs: { "huge-dep.js": { bytes: 9_999_999 } } };
  const error = assertThrows(() =>
    assertBundleBudget({ label: "background/service-worker.js", bytes: 4_500_000, metafile })
  );
  assertStringIncludes(error.message, "4_500_000".replaceAll("_", ""), "names the actual size");
  assertStringIncludes(error.message, "3000000", "names the budget");
  assertStringIncludes(error.message, "huge-dep.js", "names the top contributor");
  assertStringIncludes(error.message, "service-worker", "names the bundle");

  assertThrows(() => assertBundleBudget({ label: "x.js", bytes: NaN }), undefined, "not measurable");
});

Deno.test("bundle budget: build.mjs wires the metafile report, the store gate, and scrub-BEFORE-minify", async () => {
  const source = await Deno.readTextFile("extension/../build.mjs");
  // The SW build carries the metafile the report + gate consume.
  assertStringIncludes(source, "metafile: true");
  // Store-only minification — the developer build keeps readable code +
  // source maps (CAP-FB-20260826-OBSERVABILITY-01).
  assertStringIncludes(source, "if (!DEBUG_BUILD) {");
  assertStringIncludes(source, "minify: true");
  // The gate calls the shared module with the SW size.
  assertStringIncludes(source, 'assertBundleBudget({ label: "background/service-worker.js"');
  // SAFETY ORDER: the eval scrub (textual, unminified-only patterns) runs
  // BEFORE minification, and the minified output is re-scanned.
  const scrubAt = source.indexOf("new Function\\s*\\(");
  const minifyAt = source.indexOf("minify: true");
  assert(scrubAt !== -1 && minifyAt !== -1, "both the scrub and the minify step exist");
  assert(scrubAt < minifyAt, "the eval scrub must run BEFORE minification");
  assertStringIncludes(source, "minified bundle", "the minified bytes are re-scanned for eval sites");
});

Deno.test("bundle budget: no shipped source or built bundle references a CDN (Pyodide is bundled+pinned)", async () => {
  // The security half of the bead: the Python runtime must never fetch
  // unpinned remote code. It ships as verified bytes staged from
  // wasm-tools/python/ — no CDN URL may appear in any extension source.
  const files: string[] = [];
  async function collect(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name === "dist-versions" || entry.name === "dist-archives") continue;
        await collect(p);
      } else if (/\.(js|mjs|html|json|ts)$/.test(entry.name)) {
        files.push(p);
      }
    }
  }
  await collect("extension");
  for (const file of files) {
    const text = await Deno.readTextFile(file);
    assert(
      !text.includes("cdn.jsdelivr.net"),
      `${file}: no cdn.jsdelivr.net — runtime code is bundled and hash-verified, never fetched`,
    );
  }
});

Deno.test("bundle budget: a store-built dist ships a minified SW at or under budget (when present)", async () => {
  // build-bootstrap regenerates dist with --target=store ahead of this file
  // in the serial suite; when the marker says store, the REAL bytes are
  // gated here too (CI-visible). A developer or absent dist skips honestly.
  let marker;
  try {
    marker = JSON.parse(await Deno.readTextFile("extension/dist/dist.complete"));
  } catch {
    return; // no built dist in this environment
  }
  if (marker?.target !== "store") return; // developer build: unminified by design
  const size = (await Deno.stat("extension/dist/background/service-worker.js")).size;
  assert(
    size <= STORE_SW_BUDGET_BYTES,
    `store-built SW bundle is ${size} bytes — over the ${STORE_SW_BUDGET_BYTES} budget`,
  );
});
