// tests/wasm-catalogue-status-truth.test.ts — bead chrome-agent-platform-qazo.
//
// docs/wasm-tool-catalogue.md is a STATUS document: it tells a reader which
// managed-tool capabilities are BUILT and which are only SPECIFIED, NOT BUILT.
// An independent review found its status words had drifted from the code — an
// install path was described as built when it was not, lanes were described as
// built with no shipped tool, and SPECIFIED items carried no owning bead — and
// that the gates cited as verification (docs-process-truth, check:vocabulary)
// never read this doc. This test makes the status words checkable:
//
//   1. every BUILT claim that cites a repo path names a path that exists;
//   2. every SPECIFIED, NOT BUILT item names an owning bead that exists in the
//      beads export, or says PROPOSED (no owner);
//   3. the §65 verdict does not claim present realization across lanes;
//   4. the lane census in the doc equals the manifests on disk.
//
// It reads tracked source as data, so it is declared in SOURCE_INSPECTING_GUARDS
// (scripts/select-tests.mjs) and runs in every subset gate — a doc-only change
// otherwise selects no test at all (select-tests.mjs filters out `docs/`).

import { assert } from "jsr:@std/assert@1";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = "docs/wasm-tool-catalogue.md";
const MANIFEST_DIR = "extension/wasm/manifests";
const BEADS_EXPORT = ".beads/issues.jsonl";

const doc = readFileSync(join(ROOT, DOC_PATH), "utf8");
const docLines = doc.split("\n");
const manifestFiles = readdirSync(join(ROOT, MANIFEST_DIR)).filter((f) => f.endsWith(".manifest.json"));
const beadsExport = readFileSync(join(ROOT, BEADS_EXPORT), "utf8");

/** A repo path a BUILT claim can be checked against: backticked, with a
 * directory separator and a real source/artifact extension. Package ids
 * (`cap.bundled.x`) and URLs are deliberately not path claims. */
const PATH_TOKEN_RE = /`([A-Za-z0-9_./-]+\/[A-Za-z0-9_./-]+\.(?:js|mjs|ts|json|sh|html|wasm))`/g;

function beadExists(id: string): boolean {
  return beadsExport.includes(`"${id}"`);
}

Deno.test("qazo: the catalogue carries the execution-lane and import-pipeline section", () => {
  assert(
    doc.includes("## Wasm Tool Execution Architecture & Import Pipeline"),
    "the pipeline section must exist",
  );
  assert(doc.includes("### A. The Three Execution Host Lanes"), "the lane section must exist");
  assert(doc.includes("### B. The 5-Step Admission & Import Pipeline"), "the pipeline steps must exist");
  assert(doc.includes("Lane A:"), "Lane A must be described");
  assert(doc.includes("Lane B:"), "Lane B must be described");
  assert(doc.includes("Lane C:"), "Lane C must be described");
});

Deno.test("qazo: every BUILT claim in the catalogue cites a path that exists", () => {
  const builtLines = docLines.filter((line) => /\*\*BUILT/.test(line));
  assert(builtLines.length >= 5, `expected several BUILT claims, found ${builtLines.length}`);
  const cited: string[] = [];
  for (const line of builtLines) {
    for (const m of line.matchAll(PATH_TOKEN_RE)) cited.push(m[1]);
  }
  assert(cited.length >= 6, `expected several cited paths on BUILT lines, found ${cited.length}`);
  const missing = cited.filter((p) => !existsSync(join(ROOT, p)));
  assert(missing.length === 0, `BUILT claims cite paths that do not exist: ${missing.join(", ")}`);
});

Deno.test("qazo: every SPECIFIED, NOT BUILT item is owned or marked PROPOSED", () => {
  const claimLines = docLines.filter(
    (line) => !line.startsWith("#") && line.includes("SPECIFIED, NOT BUILT"),
  );
  assert(claimLines.length >= 2, `expected several SPECIFIED claims, found ${claimLines.length}`);
  const unowned: string[] = [];
  for (const line of claimLines) {
    if (/PROPOSED/.test(line)) continue; // explicitly ownerless — honest
    const owners = [...line.matchAll(/owning (?:bead|epic): `([^`]+)`/g)]
      .map((m) => m[1])
      .filter((id) => id.startsWith("chrome-agent-platform-"));
    if (owners.length === 0 || owners.some((id) => !beadExists(id))) {
      unowned.push(line.trim());
    }
  }
  assert(
    unowned.length === 0,
    `SPECIFIED, NOT BUILT items must name an existing owning bead or be marked PROPOSED:\n${unowned.join("\n")}`,
  );
});

Deno.test("qazo: the §65 productivity verdict is future-tense and claims no unbuilt lane", () => {
  const verdict = docLines.find((line) => line.includes("Verdict for the category itself"));
  assert(verdict, "the §65 verdict line must exist");
  assert(
    /\*\*would be\*\* realized/.test(verdict),
    "the verdict must be future-tense (would be realized), never present-tense",
  );
  assert(!/\bis realized\b/.test(verdict), "the verdict must not claim present realization");
  assert(
    !/across Lanes A, B, and C/.test(verdict),
    "the verdict must not claim composition across lanes that ship no tool",
  );
});

Deno.test("qazo: the doc's Lane A census equals the manifests on disk", () => {
  const callExport = manifestFiles.filter((f) =>
    readFileSync(join(ROOT, MANIFEST_DIR, f), "utf8").includes('"callExport"')
  ).length;
  const command = manifestFiles.length - callExport;
  assert(command >= 1 && callExport >= 1, "the census needs both lane shapes to be meaningful");
  assert(
    doc.includes(`${command} admitted command tool packages`),
    `the doc must say ${command} admitted command tool packages (manifests: ${manifestFiles.length}, call-export: ${callExport})`,
  );
});
