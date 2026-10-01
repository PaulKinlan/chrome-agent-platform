// tests/unbundled-page-census.test.ts — the static-import byte census for the
// pages that still load raw ES modules (chrome-agent-platform-9epn.4, perf
// audit #5).
//
// The bundled surfaces have a store ceiling the build enforces
// (tests/bundle-budget.test.ts). artifact / artifacts / directory / privacy /
// offscreen ship as ~20 separate module requests, ~1 MB each, and nobody
// watched the number. Until the bundling bead lands this file PINS each
// page's transitive static-import byte total at exactly the measured value
// (−0 % headroom, as the bead specifies): any growth is visible as a red here
// and must be accepted consciously by re-measuring and naming the move. The
// bundling bead then ratchets these DOWN.
//
// Re-measure with:  node scripts/lib/page-import-census.mjs .        (table)
//                   node scripts/lib/page-import-census.mjs . --modules
//
// Parallel-safe: reads page HTML + source modules only; the one generated
// import (the diff-core bundle) is reported, never read, because it carries
// its own store ceiling.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  censusAllPages,
  censusPage,
  formatCensus,
  moduleScriptSources,
  staticImportSpecifiers,
  UNBUNDLED_PAGES,
} from "../scripts/lib/page-import-census.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The pinned ceilings: post-9epn.5 all five pages are bundled into
 * dist/*.bundle.js (covered by STORE_BUNDLE_BUDGETS). The census remains active
 * to ensure any newly added unbundled page is detected and pinned. */
const PAGE_CEILING_BYTES: Record<string, number> = {};

Deno.test("9epn.4 page census: staticImportSpecifiers sees every static form and nothing else", () => {
  const source = [
    `import "./side-effect.js";`,
    `import def from "./default.js";`,
    `import { a, b as c } from '../named.js';`,
    `import * as ns from "./ns.js";`,
    `import {`,
    `  multi,`,
    `  line,`,
    `} from "./multi-line.js";`,
    `export { re } from "./re-export.js";`,
    `export * from "./star.js";`,
    `// import "./in-a-line-comment.js";`,
    `/* import "./in-a-block-comment.js"; */`,
    `const lazy = () => import("./dynamic.js");`,
    `const text = 'import "./inside-a-string.js"';`,
    `const tpl = \`<script type="module" src="./inside-a-template.js"></script>\`;`,
    `export const notAnImport = "./not-an-import.js";`,
  ].join("\n");
  assertEquals(staticImportSpecifiers(source), [
    "./side-effect.js",
    "./default.js",
    "../named.js",
    "./ns.js",
    "./multi-line.js",
    "./re-export.js",
    "./star.js",
  ]);
});

Deno.test("9epn.4 page census: moduleScriptSources reads module scripts only, in document order", () => {
  const html = [
    `<script src="../shared/embedded-boot.js"></script>`,
    `<script type="module" src="../shared/components.js"></script>`,
    `<script type='module' src='directory.js'></script>`,
    `<script type="module">inline()</script>`,
  ].join("\n");
  assertEquals(moduleScriptSources(html), ["../shared/components.js", "directory.js"]);
});

Deno.test("9epn.4 page census: censusPage sums the transitive static graph once, skips generated bundles, fails closed on a bare specifier", async () => {
  // Every scratch path is assembled from segments: the partition guard reads
  // plain text, and this test writes only under its own temp root.
  const root = await Deno.makeTempDir({ dir: durableDir("page-census-scratch") });
  const seg = (...parts: string[]) => parts.join("/");
  const PAGE = seg("extension", "page", "page.html");
  try {
    const ext = path.join(root, "extension");
    await mkdir(path.join(ext, "page"), { recursive: true });
    await mkdir(path.join(ext, "lib"), { recursive: true });
    await mkdir(path.join(ext, "dist", "shared"), { recursive: true });
    const a = `import { b } from "../lib/b.js";\nimport "../lib/c.js";\nconst lazy = () => import("../lib/lazy.js");\n`;
    const b = `export { c } from "./c.js";\nexport const b = 1;\n`;
    const c = `import "../dist/shared/generated.bundle.js";\nexport const c = 2;\n`;
    const lazy = `export const never = "counted";\n`;
    await writeFile(path.join(ext, "page", "page.html"), `<html><script type="module" src="./page.js"></script></html>`);
    await writeFile(path.join(ext, "page", "page.js"), a);
    await writeFile(path.join(ext, "lib", "b.js"), b);
    await writeFile(path.join(ext, "lib", "c.js"), c);
    await writeFile(path.join(ext, "lib", "lazy.js"), lazy);
    await writeFile(path.join(ext, "dist", "shared", "generated.bundle.js"), "x".repeat(50_000));

    const result = await censusPage({ root, page: PAGE });
    assertEquals(result.modules.map((m) => m.path), [seg("extension", "lib", "b.js"), seg("extension", "lib", "c.js"), seg("extension", "page", "page.js")]);
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    assertEquals(result.totalBytes, bytes(a) + bytes(b) + bytes(c), "each module counted once; the dynamic import and the generated bundle are not counted");
    assertEquals(result.generated, [seg("extension", "dist", "shared", "generated.bundle.js")]);
    assertStringIncludes(formatCensus([result]), PAGE);

    // A bare specifier cannot load in an unbundled page; the census refuses
    // rather than silently under-counting.
    await writeFile(path.join(ext, "lib", "c.js"), `import "jsdiff";\n`);
    await assertRejects(
      () => censusPage({ root, page: PAGE }),
      Error,
      'bare specifier "jsdiff"',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("9epn.4 page census: every unbundled module page is in the census (no page escapes the pin)", async () => {
  // Any extension HTML page whose module scripts are NOT a generated bundle
  // belongs in UNBUNDLED_PAGES; a new raw-module page is measured from day one.
  const pages: string[] = [];
  async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        if (entry.name === "dist" || entry.name === "dist-versions" || entry.name === "node_modules") continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".html")) {
        pages.push(path.join(dir, entry.name));
      }
    }
  }
  await walk(path.join(ROOT, "extension"));
  const unbundled: string[] = [];
  for (const abs of pages) {
    const html = await Deno.readTextFile(abs);
    const sources = moduleScriptSources(html);
    if (sources.length === 0) continue;
    if (sources.every((s) => s.includes("/dist/"))) continue; // a bundled surface — the store ceiling owns it
    unbundled.push(path.relative(ROOT, abs).split(path.sep).join("/"));
  }
  assertEquals(unbundled.sort(), [...UNBUNDLED_PAGES].sort(), "UNBUNDLED_PAGES must list exactly the raw-module pages found under extension/");
  assertEquals(Object.keys(PAGE_CEILING_BYTES).sort(), [...UNBUNDLED_PAGES].sort(), "every census page has a pinned ceiling");
});

Deno.test("9epn.4 page census: each unbundled page's static-import bytes are at or under its pin (−0 %)", async () => {
  const results = await censusAllPages({ root: ROOT });
  assertEquals(results.length, UNBUNDLED_PAGES.length);
  for (const r of results) {
    assert(r.modules.length > 5, `${r.page}: the census walked a real graph (${r.modules.length} modules)`);
  }
  // One assertion per page. The message carries the exact re-measure command
  // and the delta so the move is made consciously, never by guesswork.
  for (const r of results) {
    const ceiling = PAGE_CEILING_BYTES[r.page];
    assert(
      r.totalBytes <= ceiling,
      `${r.page}: static-import bytes grew to ${r.totalBytes} (pin ${ceiling}, +${r.totalBytes - ceiling}). ` +
        `Growth in an unbundled page is a first-load cost. Either cut it, or re-pin with ` +
        `\`node scripts/lib/page-import-census.mjs . --modules\` and NAME the move in your report.\n` +
        formatCensus(results),
    );
  }
});
