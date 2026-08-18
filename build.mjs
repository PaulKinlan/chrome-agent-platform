// Build the MV3 service worker + shared agent-core modules with esbuild
// (the AI SDK + zod need bundling for the service-worker environment).
import { build } from "esbuild";
import { readFile, writeFile, copyFile, readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { syncGallery } from "./scripts/sync-gallery.mjs";

const OUT = "extension/dist/background/service-worker.js";
const OPTIONS_OUT = "extension/options/options.bundle.js";

const shared = {
  bundle: true,
  format: "esm",
  target: "chrome120",
  platform: "browser",
  logLevel: "info",
  sourcemap: false,
  legalComments: "none",
};

await build({
  ...shared,
  entryPoints: ["extension/background/service-worker.js"],
  outfile: OUT,
  inject: [new URL("./browser-shim-process.js", import.meta.url).pathname],
  alias: (() => {
    const root = new URL(".", import.meta.url).pathname;
    const shim = `${root}browser-shim-node.js`;
    return {
    "node:fs": shim,
    "node:fs/promises": shim,
    "node:path": shim,
    "node:os": shim,
    "node:crypto": shim,
    "node:process": shim,
    "node:stream": shim,
    "node:util": shim,
    "node:module": shim,
    "node:child_process": shim,
    "fs": shim,
    "path": shim,
    "child_process": shim,
  };
  })(),
});

// Bundle the options page too — it imports lib/provider.js which pulls the AI
// SDK (bare npm specifiers), which a plain module script cannot resolve.
await build({
  ...shared,
  entryPoints: ["extension/options/options.js"],
  outfile: OPTIONS_OUT,
  alias: (() => {
    const root = new URL(".", import.meta.url).pathname;
    const shim = `${root}browser-shim-node.js`;
    return {
      "node:fs": shim, "node:fs/promises": shim, "node:path": shim, "node:os": shim,
      "node:crypto": shim, "node:process": shim, "node:stream": shim, "node:util": shim,
      "node:module": shim, "node:child_process": shim, "fs": shim, "path": shim, "child_process": shim,
    };
  })(),
});
console.log(`built ${OPTIONS_OUT}`);

// MV3 CSP forbids eval / new Function. ajv (a transitive dep of the MCP SDK,
// which agent-do pulls in for MCP-tool support we do NOT use at runtime) emits
// `new Function` in its schema-JIT path. Replace it with a throw so the bundle
// is CSP-clean — that path is dead in this extension, so the throw never runs.
const bundle = await readFile(OUT, "utf8");
const occurrences = (bundle.match(/new Function\s*\(/g) ?? []).length;
let cleaned = bundle.replace(/new Function\s*\(/g, "(function(){ throw new Error('eval disabled (MV3 CSP)'); })(");

// zod v4 probes eval availability with `const F = Function; new F("")` to decide
// its JIT fast-path. `new F("")` constructs the Function constructor via a
// variable, so the `new Function(` rule above does NOT match it — and under MV3
// CSP the probe both throws AND logs a "Hash of blocked script: eval-sha256-..."
// warning on every evaluation. Replace it with a throw so the probe short-
// circuits to false without ever invoking the Function constructor (the JIT
// path it gates is dead in this extension anyway).
const zodProbes = (cleaned.match(/new F\(""\)/g) ?? []).length;
cleaned = cleaned.replace(
  /new F\(""\)/g,
  '(() => { throw new Error("eval disabled (MV3 CSP)"); })()',
);
await writeFile(OUT, cleaned);

const remaining = (cleaned.match(/new Function\s*\(|eval\s*\(|new F\(""\)/g) ?? []).length;
if (remaining > 0) {
  throw new Error(`bundle still contains ${remaining} eval/new-Function sites after cleaning`);
}
console.log(`built ${OUT} (removed ${occurrences} new-Function + ${zodProbes} Function-constructor probe site(s); ${remaining} remaining)`);

// SECURITY/build assertion: TEST-ONLY controls/oracles must never reach the
// shipped extension. RECURSIVELY discover every shipped .js under extension/,
// then scan each with a REAL JavaScript parser (acorn):
//   (a) a case-insensitive substring check for the known fault-seam/oracle names,
//   (b) an AST export walk (declarations, export lists, `x as __y` aliases, and
//       `export default <__id>`), and
//   (c) an AST MemberExpression walk for `window|self|globalThis.__*` access
//       (excluding legitimate __zod_*/__vite_* library internals).
async function walkJs(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walkJs(p, out);
    else if (entry.isFile() && (extname(p) === ".js" || extname(p) === ".mjs")) out.push(p);
  }
  return out;
}
const { scanShippedJs } = await import("./scripts/scan-shipped.mjs");
const shippedJs = await walkJs("extension");
// The __zod_*/__vite_* oracle exemption applies ONLY inside the generated
// dependency bundles (esbuild inlines the zod/vite source there) — never in
// shipped source files.
const violations = await scanShippedJs(shippedJs, {
  generatedBundles: new Set([OUT, OPTIONS_OUT]),
  readText: (f) => readFile(f, "utf8"),
});
if (violations.length > 0) {
  throw new Error(
    `shipped-code scan failed (${violations.length} violation(s)):\n` +
    violations.map((v) => `  - ${v}`).join("\n"),
  );
}
console.log(`build assertion: no test controls/oracles in ${shippedJs.length} shipped JS files (AST export + oracle walk)`);

// Sync the design-system source into the docs/ component gallery (single
// source of truth = extension/shared/; see scripts/sync-gallery.mjs). The
// docs/ copies are committed too so the GitHub Pages showcase works standalone.
await syncGallery();

// Copy the CHANGELOG into the extension package so the Settings About section
// can render it (extension pages fetch it via chrome.runtime.getURL).
await copyFile(new URL("./CHANGELOG.md", import.meta.url).pathname, new URL("./extension/CHANGELOG.md", import.meta.url).pathname);
console.log("copied CHANGELOG.md → extension/CHANGELOG.md");
