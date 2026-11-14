// tests/gallery-imports.test.ts — the docs/ gallery is deployed static: every
// relative import in the synced module graph must RESOLVE to a synced file.
// (The round-1 failure: docs/components.js imported ../lib/tool-summary.js —
// no such file under docs/, so components.html failed module resolution.)
//
// chrome-agent-platform-0pjmh: this suite is ALWAYS-ON, so it must be true on an
// UNBUILT tree. 7tx47 declared it "177ms, no browser, no build input"; the last clause
// was false. docs/diff-core.bundle.js is build output, the FULL gate runs the build tier
// and the parallel test population at the same time, and the guard therefore redded the
// gate with "unresolved gallery imports: components-artifacts.js →
// ./diff-core.bundle.js (missing)" on a tree where nothing was broken.
//
// The walk now lives in scripts/lib/gallery-imports.mjs as a PURE function over injected
// oracles: a generated docs file that is absent while its SOURCE is present is reported
// as build-pending instead of unresolved, and a generated file whose source is ALSO
// missing stays a hard failure — the exemption cannot hide a real broken import. The
// falsification legs below run with a synthetic filesystem, so the unbuilt-tree case is
// asserted without moving any file and without a nested test runner.

import { ALWAYS_ON, buildReverseGraph, selectTestFiles } from "../scripts/select-tests.mjs";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { GENERATED_DOCS_SOURCES, syncGallery } from "../scripts/sync-gallery.mjs";
import { resolveDocsRelative, walkGalleryImports } from "../scripts/lib/gallery-imports.mjs";

const DOCS = new URL("../docs/", import.meta.url);
const REPO = new URL("../", import.meta.url);
const ENTRYPOINTS = ["components.js", "tool-summary.js", "tool-tree.js", "pure.js"];

/** Every import/export-from and dynamic-import specifier in one docs file. */
function specifiers(file: string): string[] {
  const src = Deno.readTextFileSync(new URL(file, DOCS));
  const out: string[] = [];
  for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s*["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

function docsExists(rel: string): boolean {
  try {
    Deno.statSync(new URL(rel, DOCS));
    return true;
  } catch {
    return false;
  }
}

function sourceExists(repoRel: string): boolean {
  try {
    Deno.statSync(new URL(repoRel, REPO));
    return true;
  } catch {
    return false;
  }
}

Deno.test("gallery: every relative import in the synced docs module graph resolves", () => {
  const generatedSources = new Map<string, string>(GENERATED_DOCS_SOURCES as [string, string][]);
  const result = walkGalleryImports({
    entrypoints: ENTRYPOINTS,
    specifiers,
    exists: docsExists,
    generatedSources,
    sourceExists,
  });
  console.log(
    `gallery: walked ${result.visited.length} file(s); ` +
      `${result.buildPending.length} build-pending edge(s)` +
      (result.buildPending.length > 0 ? `: ${result.buildPending.join("; ")}` : ""),
  );
  assertEquals(result.unvisited, [], `queued files that could not be read: ${result.unvisited.join(", ")}`);
  assertEquals(result.unresolved, [], `unresolved gallery imports: ${result.unresolved.join("; ")}`);
});

// ── falsification of the build-pending exemption (0pjmh) ─────────────────────
// A synthetic filesystem: only the files named in `present` exist. These legs are what
// keep the always-on guard from becoming a guard that cannot fail.

function syntheticWalk({
  importers,
  present,
  generated = {},
  sources = [],
}: {
  importers: Record<string, string[]>;
  present: string[];
  generated?: Record<string, string>;
  sources?: string[];
}) {
  const have = new Set(present);
  const sourceSet = new Set(sources);
  return walkGalleryImports({
    entrypoints: Object.keys(importers).slice(0, 1),
    specifiers: (f) => {
      const v = importers[f];
      if (v === undefined) throw new Error(`no such synthetic file: ${f}`);
      return v;
    },
    exists: (rel) => have.has(rel),
    generatedSources: new Map(Object.entries(generated)),
    sourceExists: (repoRel) => sourceSet.has(repoRel),
    docsPrefix: "/docs/",
  });
}

Deno.test("gallery/0pjmh: a generated docs file absent on an unbuilt tree is BUILD-PENDING, not unresolved", () => {
  const result = syntheticWalk({
    importers: { "components.js": ["./components-artifacts.js"], "components-artifacts.js": ["./diff-core.bundle.js"] },
    present: ["components.js", "components-artifacts.js"],
    generated: { "diff-core.bundle.js": "extension/shared/diff-core.js" },
    sources: ["extension/shared/diff-core.js"],
  });
  assertEquals(result.unresolved, [], "the unbuilt tree must not read as a broken import");
  assertEquals(result.buildPending.length, 1, "the skipped edge is reported, never hidden");
  assert(result.buildPending[0].includes("source extension/shared/diff-core.js present"));
});

Deno.test("gallery/0pjmh: the exemption is NOT a hole — a generated file whose SOURCE is missing stays unresolved", () => {
  const result = syntheticWalk({
    importers: { "components.js": ["./components-artifacts.js"], "components-artifacts.js": ["./diff-core.bundle.js"] },
    present: ["components.js", "components-artifacts.js"],
    generated: { "diff-core.bundle.js": "extension/shared/diff-core.js" },
    sources: [], // the canonical source is gone too: this is a real broken import
  });
  assertEquals(result.buildPending, [], "nothing is excused when the source is absent too");
  assertEquals(result.unresolved.length, 1);
  assert(result.unresolved[0].includes("AND its source extension/shared/diff-core.js is missing"));
});

Deno.test("gallery/0pjmh: a NON-generated missing import is still unresolved — the guard is not blind", () => {
  const result = syntheticWalk({
    importers: { "components.js": ["./nope.js"] },
    present: ["components.js"],
    generated: { "diff-core.bundle.js": "extension/shared/diff-core.js" },
    sources: ["extension/shared/diff-core.js"],
  });
  assertEquals(result.unresolved, ["components.js → ./nope.js (missing)"]);
});

Deno.test("gallery/0pjmh: a specifier escaping docs/ is unresolved (the round-1 defect)", () => {
  const result = syntheticWalk({
    importers: { "components.js": ["../lib/tool-summary.js"] },
    present: ["components.js"],
  });
  assertEquals(result.unresolved.length, 1);
  assert(result.unresolved[0].includes("escapes /docs/"));
  assertEquals(resolveDocsRelative("components.js", "../lib/tool-summary.js"), null);
});

Deno.test("gallery/0pjmh: resolveDocsRelative normalises like a browser, never like a filesystem path", () => {
  assertEquals(resolveDocsRelative("components.js", "./pure.js"), "pure.js");
  assertEquals(resolveDocsRelative("components-artifacts.js", "./diff-core.bundle.js"), "diff-core.bundle.js");
  assertEquals(resolveDocsRelative("sub/a.js", "../b.js"), "b.js");
  assertEquals(resolveDocsRelative("sub/a.js", "./../sub/./b.js"), "sub/b.js");
  assertEquals(resolveDocsRelative("a.js", "../../x.js"), null);
});

Deno.test("gallery/0pjmh: the generated-entry list is DERIVED from the sync table and names the GIT source", () => {
  const entries = GENERATED_DOCS_SOURCES as [string, string][];
  assert(entries.length > 0, "the sync table declares at least one build-output entry");
  for (const [dst, src] of entries) {
    assert(!dst.startsWith("docs/"), `the docs target is stored docs-relative: ${dst}`);
    assert(dst.endsWith(".bundle.js"), `a generated docs copy is a bundle: ${dst}`);
    // The asserted authority is the hand-written module, never the built artifact: a guard that
    // needed the artifact would be false on a fresh clone (this bead, one layer down).
    assert(src.startsWith("extension/"), `a generated entry's source lives under extension/: ${src}`);
    assert(src.endsWith(".js") && !src.includes("/dist/"), `the source is the git module, not the bundle: ${src}`);
    assert(sourceExists(src), `the canonical source of ${dst} must exist in git: ${src}`);
  }
});

Deno.test("7tx47: a pure.js delta selects this guard, so an unsynced mirror reds on the AUTHORING branch", () => {
  // chrome-agent-platform-7tx47: the guard only helps the author if it RUNS on the author's branch. It
  // imports sync-gallery.mjs, not pure.js, so the import graph never selected it for the delta that
  // matters — measured on fleet/fixer-mfu4a, where pure.js +102 with no mirror passed the authoring
  // gate and only the merged tree's build noticed. Two things must stay true: the mirror pair is
  // declared, and this suite is in the always-on floor (which selectTestFiles always includes).
  const syncSource = Deno.readTextFileSync(new URL("../scripts/sync-gallery.mjs", import.meta.url));
  assert(
    syncSource.includes('["extension/lib/pure.js", "docs/pure.js"]'),
    "the pure.js <- docs/pure.js mirror pair is the premise of this guard; if it moved, move this pin with it",
  );
  assert(
    ALWAYS_ON.includes("tests/gallery-imports.test.ts"),
    "the gallery guard must be always-on, or an unsynced mirror can pass the authoring branch's gate",
  );
  const selected = selectTestFiles(["extension/lib/pure.js"], buildReverseGraph());
  assert(
    selected.includes("tests/gallery-imports.test.ts"),
    "a pure.js delta must select the gallery guard",
  );
});

Deno.test("gallery: the synced deploy copies match the canonical sources (sync-gallery --check)", async () => {
  assert(await syncGallery({ check: true }), "docs/ drifted from extension/ — run node scripts/sync-gallery.mjs");
});
