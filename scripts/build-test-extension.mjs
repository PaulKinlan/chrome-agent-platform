#!/usr/bin/env node
// scripts/build-test-extension.mjs — build an ISOLATED test copy of the
// extension (the CRITICAL seam-isolation requirement): the seam (test-only
// routes such as the key-persistence sentinel) is written ONLY into a
// PRIVATE temp directory this script CREATES itself. There is NO
// caller-supplied destination parameter at all — no arbitrary path to
// validate, no delete API, no TOCTOU window: the script owns the mkdtemp it
// writes, and nothing outside it is ever removed.
//
//   node scripts/build-test-extension.mjs
//
// Prints the destination dir as the last stdout line.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = path.join(ROOT, "extension");
// PRIVATE, self-created destination — the only path this script touches.
const dest = await mkdtemp(path.join(await realpath(tmpdir()), "cap-test-ext-"));
async function realpath(p) { const { realpath } = await import("node:fs/promises"); return realpath(p); }

// OWNED-DEST LIFETIME: on ANY failure before the path is printed, the temp
// dir we created is removed SYNCHRONOUSLY-RELIABLY (awaited in a sync-capable
// wrapper: the process exits immediately after the throw, so a fire-and-
// forget rm can be cut short — do it with rmSync).
import { rmSync } from "node:fs";
const failClean = (e) => { try { rmSync(dest, { recursive: true, force: true }); } catch { /* best effort, already logged */ } throw e; };

// Copy the extension tree (dist excluded — rebuilt fresh here).
try {
await cp(EXT, dest, {
  recursive: true,
  filter: (src) => {
    if (src === EXT) return true;
    const rel = path.relative(EXT, src);
    return rel !== "dist" && !rel.startsWith("dist" + path.sep);
  },
});

// Build the service worker + options bundle INTO the copy.
const shared = {
  bundle: true,
  format: "esm",
  target: "chrome120",
  platform: "browser",
  logLevel: "silent",
  sourcemap: false,
  legalComments: "none",
};
const shimNode = path.join(ROOT, "browser-shim-node.js");
await build({
  ...shared,
  entryPoints: [path.join(EXT, "background/service-worker.js")],
  outfile: path.join(dest, "dist/background/service-worker.js"),
  inject: [path.join(ROOT, "browser-shim-process.js")],
  alias: {
    "node:fs": shimNode, "node:fs/promises": shimNode, "node:path": shimNode,
    "node:os": shimNode, "node:crypto": shimNode, "node:process": shimNode,
    "node:stream": shimNode, "node:util": shimNode, "node:module": shimNode,
    "node:child_process": shimNode, fs: shimNode, path: shimNode, child_process: shimNode,
  },
});
await build({
  ...shared,
  entryPoints: [path.join(EXT, "options/options.js")],
  outfile: path.join(dest, "dist/options.bundle.js"), // matches the production dist layout the html loads
});

// Append the TEST SEAM to the COPY's service worker + scrub eval sites.
const out = path.join(dest, "dist/background/service-worker.js");
const seam = await readFile(path.join(ROOT, "scripts/test-seam.snippet.js"), "utf8");
let bundle = await readFile(out, "utf8");
bundle = bundle
  .replace(/new Function\s*\(/g, "(function(){ throw new Error('eval disabled (MV3 CSP)'); })(")
  .replace(/new F\(""\)/g, '(() => { throw new Error("eval disabled (MV3 CSP)"); })()');
await writeFile(out, bundle + "\n// ── TEST SEAM (isolated test build — never production) ──\n" + seam + "\n");
if (!bundle.includes("handlers")) throw new Error("test build looks wrong (no handler table)");

// Verify the PRODUCTION tree stayed clean (belt + braces).
const prodSw = path.join(EXT, "dist/background/service-worker.js");
try {
  const prod = await readFile(prodSw, "utf8");
  if (prod.includes("key-sentinel") || prod.includes("__CAP_TEST_SEAM")) {
    throw new Error("PRODUCTION bundle contains seam markers — refusing to continue");
  }
} catch (e) { if (!/ENOENT/.test(String(e?.message ?? e))) throw e; }

} catch (e) { failClean(e); }
console.log(dest);
