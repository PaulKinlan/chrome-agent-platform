#!/usr/bin/env node
// scripts/check-models.mjs — no retired model id anywhere a user could meet it.
//
// CAP-FB-20260830-MODEL-CATALOG-CURRENT-01: the product's OpenAI support aged
// out silently — the picker offered gpt-4.x / o-series / gemini-2.x ids and a
// pricing pseudo-id that 404s, and nothing in the repo noticed because every
// gate uses fake providers. This gate walks the user-facing source and fails on
// any RETIRED_MODEL_PATTERNS hit (extension/lib/model-catalog.js is the single
// authority for what "retired" means), printing file:line.
//
// Scope: extension/, scripts/, docs/, README.md, PLAN.md.
// Allowlisted BY PATH (never by content):
//   - extension/dist/            build output
//   - extension/vendor/          third-party code
//   - extension/lib/model-prices.js   the price table keeps historical rows
//   - tests/                     fixtures test normalisation/redaction, not currency
//   - CHANGELOG.md / TASKS*.md / KNOWN-ISSUES*.md / REVIEW-*.md   history records
//   - *.worker.js bundled/minified workers (a `\bo3\b`-shaped token is not an id)
//   - this script, the catalogue module, and the server-tools id-shape gates
//     (they spell the patterns out as history, not as offers)
//
// Exit 1 on any hit. `--json` prints machine-readable findings.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const ROOTS = ["extension", "scripts", "docs", "README.md", "PLAN.md"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-versions", "vendor", "evidence"]);
const SKIP_PATHS = [
  "extension/lib/model-prices.js",
  "extension/lib/model-catalog.js",
  "scripts/check-models.mjs",
  "scripts/refresh-model-prices.mjs",
  // The server-tools id-SHAPE gates intentionally name the claude-3/4 families
  // as history (which ids can never run web_search) — not a catalogue.
  "extension/lib/provider-server-tools.js",
];
const SKIP_PREFIX = ["tests/", "docs/KNOWN-ISSUES-ARCHIVE", "docs/evidence", "docs/reviews"];
const SKIP_NAME = /(^|\/)(CHANGELOG\.md|TASKS(-DONE)?\.md|KNOWN-ISSUES\.md|REVIEW-[^/]*\.md)$|\.worker\.js$|\.min\.js$|\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|wasm|zip|pdf|lock)$/;

const { RETIRED_MODEL_PATTERNS } = await import(pathToFileURL(join(ROOT, "extension/lib/model-catalog.js")).href);

const json = process.argv.includes("--json");
const hits = [];

async function walk(path) {
  const rel = relative(ROOT, path).split(sep).join("/");
  if (rel && SKIP_DIRS.has(rel.split("/").pop())) return;
  const st = await stat(path);
  if (st.isDirectory()) {
    for (const name of await readdir(path)) await walk(join(path, name));
    return;
  }
  if (SKIP_PATHS.includes(rel) || SKIP_PREFIX.some((p) => rel.startsWith(p)) || SKIP_NAME.test(rel)) return;
  if (st.size > 4_000_000) return;
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const re of RETIRED_MODEL_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        hits.push({ file: rel, line: i + 1, match: m[0], text: line.trim().slice(0, 140) });
        break;
      }
    }
  });
}

for (const r of ROOTS) {
  try { await walk(join(ROOT, r)); } catch (e) { if (e?.code !== "ENOENT") throw e; }
}

if (json) {
  console.log(JSON.stringify({ ok: hits.length === 0, hits }, null, 2));
} else if (hits.length) {
  console.error(`check-models: ${hits.length} retired model id hit(s) — every id a user can meet must be current (extension/lib/model-catalog.js):`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.match}  — ${h.text}`);
} else {
  console.log("check-models: no retired model id under extension/, scripts/, docs/, README.md, PLAN.md");
}
process.exit(hits.length ? 1 : 0);
