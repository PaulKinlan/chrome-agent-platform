// scripts/lib/page-import-census.mjs — the static-import byte census for the
// UNBUNDLED extension pages (chrome-agent-platform-9epn.4, perf audit #5).
//
// The bundled surfaces (ntp / sidepanel / options / diff-core / SW / worker)
// have a byte ceiling the store build enforces (scripts/bundle-budget.mjs).
// The pages that still load raw ES modules — artifact, artifacts, directory,
// privacy, offscreen — ship as 18–22 separate requests and had no number
// anyone watched. This module walks each page's <script type="module">
// entries and sums the bytes of every module reached through STATIC
// imports (`import … from`, `import "…"`, `export … from`). Dynamic
// `import()` is deliberately NOT followed: it is the lazy path and does not
// cost the page's first load.
//
// Pure: given a repo root and a page HTML path it returns the module list and
// the byte total; the test pins the totals. No build is required — a generated
// `dist/` import (the diff-core bundle, which the diff-core budget already
// covers) is REPORTED separately and never read, so the census is a pure
// source measurement that is parallel-safe.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The unbundled pages (relative to the repo root). The gallery and the
 * bundled pages are not here on purpose: bundled pages have a store ceiling.
 * As of 9epn.5, all 5 former unbundled pages (artifact, artifacts, directory,
 * privacy, offscreen) are bundled into dist/*.bundle.js. */
export const UNBUNDLED_PAGES = Object.freeze([]);

const MODULE_SCRIPT_RE = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/giu;
const SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/iu;
// Static import forms, each anchored at a statement start (a module's static
// imports are top-level statements, so a specifier inside a string body or a
// template never matches). The clause class `[\w$*{}\s,]` spans newlines, so
// multi-line import lists are covered; `import(` (dynamic) never matches
// because none of the forms admits a `(` after the keyword.
const STATIC_IMPORT_FORMS = Object.freeze([
  /^[ \t]*import\s*["']([^"'\n]+)["']/gmu, // import "side-effect";
  /^[ \t]*import\s+[\w$*{}\s,]+?\s*from\s*["']([^"'\n]+)["']/gmu, // import x, { y } from "…";
  /^[ \t]*export\s+[\w$*{}\s,]+?\s*from\s*["']([^"'\n]+)["']/gmu, // export { y } from "…"; export * from "…";
]);

/** Strip comments so a specifier mentioned in prose is never resolved. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:\\"'`])\/\/[^\n]*/gu, "$1");
}

/** The static import specifiers of one module source, in source order. */
export function staticImportSpecifiers(source) {
  const found = [];
  const code = stripComments(source);
  for (const form of STATIC_IMPORT_FORMS) {
    for (const match of code.matchAll(form)) found.push({ at: match.index, spec: match[1] });
  }
  found.sort((a, b) => a.at - b.at);
  return found.map((f) => f.spec);
}

/** The <script type="module" src> entries of a page, in document order. */
export function moduleScriptSources(html) {
  const out = [];
  for (const tag of html.matchAll(MODULE_SCRIPT_RE)) {
    const src = tag[0].match(SRC_RE)?.[1];
    if (src) out.push(src);
  }
  return out;
}

function isGeneratedDistPath(repoRel) {
  return /^extension\/dist\//u.test(repoRel);
}

/**
 * Census one page: every module statically reachable from its module scripts.
 * @returns {Promise<{ page: string, entries: string[], modules: Array<{ path: string, bytes: number }>, generated: string[], totalBytes: number }>}
 * `modules` is sorted by path; `generated` lists dist/ imports that were NOT
 * counted (they carry their own store budget). A bare (non-relative) specifier
 * fails closed: an unbundled page cannot load one in the browser either.
 */
export async function censusPage({ root, page }) {
  root = path.resolve(root);
  const pageAbs = path.join(root, ...page.split("/"));
  const html = await readFile(pageAbs, "utf8");
  const entries = moduleScriptSources(html);
  if (entries.length === 0) {
    throw new Error(`page import census: ${page} has no <script type="module" src> entry`);
  }
  const seen = new Map();
  const generated = new Set();
  const queue = [];
  for (const src of entries) {
    queue.push({ from: pageAbs, spec: src, html: true });
  }
  while (queue.length) {
    const { from, spec, html: fromHtml } = queue.shift();
    // A JS specifier must be relative (an unbundled page cannot load a bare
    // one in the browser either); an HTML src is a document-relative URL, so
    // `src="directory.js"` is valid there.
    if (!fromHtml && !spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("/")) {
      throw new Error(
        `page import census: ${page}: bare specifier "${spec}" imported from ${path.relative(root, from)} — an unbundled page cannot resolve it`,
      );
    }
    const abs = spec.startsWith("/")
      ? path.join(root, "extension", spec)
      : path.resolve(path.dirname(from), spec);
    const repoRel = path.relative(root, abs).split(path.sep).join("/");
    if (isGeneratedDistPath(repoRel)) {
      generated.add(repoRel);
      continue;
    }
    if (seen.has(repoRel)) continue;
    let source;
    try {
      source = await readFile(abs, "utf8");
    } catch (err) {
      throw new Error(
        `page import census: ${page}: cannot read ${repoRel} (imported from ${path.relative(root, from)}): ${err?.message ?? err}`,
      );
    }
    seen.set(repoRel, Buffer.byteLength(source, "utf8"));
    for (const next of staticImportSpecifiers(source)) {
      queue.push({ from: abs, spec: next });
    }
  }
  const modules = [...seen.entries()]
    .map(([p, bytes]) => ({ path: p, bytes }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const totalBytes = modules.reduce((sum, m) => sum + m.bytes, 0);
  return Object.freeze({
    page,
    entries,
    modules: Object.freeze(modules),
    generated: Object.freeze([...generated].sort()),
    totalBytes,
  });
}

/** Census every unbundled page. */
export async function censusAllPages({ root, pages = UNBUNDLED_PAGES }) {
  const out = [];
  for (const page of pages) out.push(await censusPage({ root, page }));
  return out;
}

/** The ratchet table as the test pins it: one line per page. */
export function formatCensus(results) {
  return results
    .map((r) => `  ${String(r.totalBytes).padStart(9)}  ${r.page}  (${r.modules.length} modules${r.generated.length ? `; +${r.generated.length} generated, budgeted separately` : ""})`)
    .join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ?? process.cwd();
  const results = await censusAllPages({ root });
  console.log(formatCensus(results));
  if (process.argv.includes("--modules")) {
    for (const r of results) {
      console.log(`\n${r.page}`);
      for (const m of r.modules) console.log(`  ${String(m.bytes).padStart(9)}  ${m.path}`);
      for (const g of r.generated) console.log(`  generated  ${g}`);
    }
  }
}
