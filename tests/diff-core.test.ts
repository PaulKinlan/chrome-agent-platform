// tests/diff-core.test.ts — CAP-FB-20260830-DIFF-LIBRARY-01
//
// Proves the bundled diff core (jsdiff wrapped by extension/shared/diff-core.js)
// on the two Crumb artifact bodies, and guards the MV3 CSP invariant that no
// shipped bundle carries a dynamic evaluator.
//
// REQUIRES A BUILD: the test imports the SAME bundle the extension pages load
// (`extension/dist/shared/diff-core.bundle.js`), so run `npm run build` first.
// Importing the source module would need Deno to resolve the bare "diff"
// specifier from node_modules, and the consumers never do that.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";

const ROOT = new URL("../", import.meta.url);
const bundleUrl = new URL("extension/dist/shared/diff-core.bundle.js", ROOT);
const core = await import(bundleUrl.href);
const v1 = await Deno.readTextFile(new URL("fixtures/crumb-v1.html", import.meta.url));
const v2 = await Deno.readTextFile(new URL("fixtures/crumb-v2.html", import.meta.url));

Deno.test("diffLines(crumb-v1, crumb-v2) reports 10 added and 2 removed lines", () => {
  const parts = core.diffLines(v1, v2);
  let added = 0, removed = 0;
  for (const part of parts) {
    if (part.added) added += part.count;
    else if (part.removed) removed += part.count;
  }
  assertEquals({ added, removed }, { added: 10, removed: 2 });
});

Deno.test("structuredPatch yields 2 hunks (the header colour lines and the opening-hours block)", () => {
  const patch = core.structuredPatch("crumb.html", "crumb.html", v1, v2);
  assertEquals(patch.hunks.length, 2);
  const [colours, hours] = patch.hunks;
  assert(colours.lines.includes("-  header { background: #f4e4c1; color: #3b2a14; padding: 2rem; }"));
  assert(colours.lines.includes("+  header { background: #2b1d0e; color: #f8efe0; padding: 2rem; }"));
  assert(hours.lines.includes("+    <h2>Opening hours</h2>"));
});

Deno.test("lineDiffSummary carries per-hunk and total counts", () => {
  const summary = core.lineDiffSummary(v1, v2);
  assertEquals(summary.added, 10);
  assertEquals(summary.removed, 2);
  assertEquals(summary.hunks.length, 2);
  assertEquals(
    summary.hunks.map((h: { added: number; removed: number }) => [h.added, h.removed]),
    [[3, 2], [7, 0]],
  );
  assertEquals(summary.hunks[0].oldStart, 4);
  assertEquals(summary.hunks[1].newStart, 22);
  // Every hunk row is one of context/add/remove with the marker stripped.
  for (const hunk of summary.hunks) {
    for (const row of hunk.rows) {
      assert(["context", "add", "remove"].includes(row.kind), row.kind);
      assert(!/^[-+ ]/.test(row.text) || row.text.startsWith("  "), "marker leaked into text");
    }
  }
});

Deno.test("applyPatch(v1, structuredPatch) equals v2 byte-for-byte", () => {
  const patch = core.structuredPatch("crumb.html", "crumb.html", v1, v2);
  assertEquals(core.applyPatch(v1, patch), v2);
  // And through the unified text form (what a patch_asset tool would carry).
  const text = core.createTwoFilesPatch("crumb.html", "crumb.html", v1, v2);
  assertEquals(core.applyPatch(v1, text), v2);
});

Deno.test("lineDiffSummary of identical inputs is empty", () => {
  assertEquals(core.lineDiffSummary(v1, v1), { added: 0, removed: 0, hunks: [] });
});

Deno.test("neutralizeDiffLine replaces U+202E and control characters with U+FFFD", () => {
  assertEquals(core.neutralizeDiffLine("a\u202ebc\u0007d"), "a\ufffdbc\ufffdd");
  assertEquals(core.neutralizeDiffLine("keep\nnewline"), "keep\nnewline");
  assertEquals(core.neutralizeDiffLine("plain"), "plain");
});

Deno.test("truncateDiffLine bounds a line to 8 KiB and never splits a surrogate pair", () => {
  const short = "x".repeat(100);
  assertEquals(core.truncateDiffLine(short), short);
  const long = "y".repeat(9000);
  const cut = core.truncateDiffLine(long);
  assert(cut.endsWith("…"));
  assert(new TextEncoder().encode(cut).byteLength <= 8192);
  const pairs = "\u{1F600}".repeat(3000); // 4 bytes each = 12000 bytes
  const cutPairs = core.truncateDiffLine(pairs);
  assert(new TextEncoder().encode(cutPairs).byteLength <= 8192);
  for (const ch of cutPairs) assert(!/^[\ud800-\udfff]$/u.test(ch), "lone surrogate in output");
});

Deno.test("no shipped bundle contains new Function or eval(", async () => {
  const dist = new URL("extension/dist/", ROOT);
  let seen = 0;
  for await (const entry of walk(dist, { exts: [".js"], includeDirs: false })) {
    // The admitted Pyodide runtime lane (dist/wasm-tools/python/) is vendored
    // third-party runtime bytes admitted by exact sha256 (PYTHON_RUNTIME_PIN /
    // MANIFEST.json, verified in python-runtime.test.ts) — NOT authored
    // bundles; its dead network-loader branches contain the token "eval(".
    if (entry.path.includes("/wasm-tools/python/")) continue;
    const text = await Deno.readTextFile(entry.path);
    const hits = text.match(/new Function\s*\(|[^.\w]eval\s*\(/g) ?? [];
    assertEquals(hits, [], `${entry.path} carries a dynamic evaluator`);
    seen++;
  }
  assert(seen > 0, "no bundles found — run `npm run build` first");
  assert(await Deno.stat(bundleUrl).then(() => true), "diff-core bundle missing from dist");
});
