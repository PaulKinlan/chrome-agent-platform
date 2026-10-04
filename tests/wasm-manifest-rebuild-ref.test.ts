// tests/wasm-manifest-rebuild-ref.test.ts — bead chrome-agent-platform-7rok.
//
// Every bundled-Wasm manifest may declare `build.rebuildRef`: the script that
// reproduces the artifact the manifest pins. Nothing executes it, so a wrong
// value rots in silence. On 2026-10-04, 7 of the 38 manifests pointed at
// `packages/bundled/<name>/build.sh` — a path that does not exist — while the
// real script sat one directory deeper under `packages/bundled/evidence/<name>/`
// (and `hashwasm-blake3` reproduces by extraction, not by a build script).
//
// The rule here is small and total: if `build.rebuildRef` is present it must name
// a file that exists. Absence stays legal — `wasm-package-authority.js` keeps the
// key optional, and a package whose reproduction is an extraction has no build
// script, so requiring the key would be a different (and false) claim.
//
// It reads tracked manifests as data, with no import edge from any changed file,
// so it is declared in SOURCE_INSPECTING_GUARDS (scripts/select-tests.mjs) and
// runs in every subset gate — a manifest-only diff selects no test otherwise.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_DIR = "extension/wasm/manifests";

const manifestFiles = readdirSync(join(ROOT, MANIFEST_DIR)).filter((f) => f.endsWith(".manifest.json"));
const manifests = manifestFiles.map((file) => ({
  file,
  json: JSON.parse(readFileSync(join(ROOT, MANIFEST_DIR, file), "utf8")),
}));

Deno.test("7rok: the bundled manifest set is present and non-trivial", () => {
  assert(manifestFiles.length >= 30, `expected the bundled manifest set, found ${manifestFiles.length}`);
});

Deno.test("7rok: every manifest's build.rebuildRef names a file that exists", () => {
  const violations: string[] = [];
  let declared = 0;
  for (const { file, json } of manifests) {
    const ref = json?.build?.rebuildRef;
    if (ref === undefined) continue; // absent is legal: extraction-only packages
    declared += 1;
    assert(
      typeof ref === "string" && ref.length > 0,
      `${file}: build.rebuildRef must be a non-empty string`,
    );
    const abs = join(ROOT, ref);
    if (!existsSync(abs) || !statSync(abs).isFile()) violations.push(`${file} -> ${ref}`);
  }
  assert(
    declared >= 30,
    `expected most manifests to declare build.rebuildRef, found ${declared} — the check would be vacuous`,
  );
  assertEquals(violations, [], `build.rebuildRef must name an existing file:\n${violations.join("\n")}`);
});
