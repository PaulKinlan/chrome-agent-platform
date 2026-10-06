// tests/build-bootstrap.test.ts — regression for the K3 finding: the
// steady-state dist SYMLINK must NOT re-run the legacy-dir bootstrap, and
// dangling v-boot symlink residue under dist-versions must be GC'd.
// @ts-nocheck: dynamic Node filesystem imports exercise real build pointers.
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { packageExtensionArchive } from "../scripts/package-archive.mjs";
import { PRODUCTION_BUILD_TIMEOUT_MS } from "../scripts/test-partition.mjs";
const fsMod = "node:fs/promises";
const { lstat, symlink, readdir, readFile } = await import(fsMod);
const cpMod = "node:child_process";
const { execFileSync } = await import(cpMod);
const pathMod = "node:path";
const path = (await import(pathMod)).default;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = path.join(ROOT, "extension");
const DIST = path.join(EXT, "dist");
const VERSIONS = path.join(EXT, "dist-versions");

function build() {
  return execFileSync("node", ["build.mjs", "--target=store"], {
    cwd: ROOT,
    encoding: "utf8",
    // chrome-agent-platform-kj9s: a MEASURED child bound (see PRODUCTION_BUILD_TIMEOUT_MS), not a
    // hard-coded 180s. The old 180s sat ~2.5x above the ~72s measured store build, so a loaded box
    // SIGKILLed the build — and a killed build cannot release its lock, which is the second-order
    // defect this bead names. The FILE window (SERIAL_FILE_TIMEOUTS) still governs the whole file,
    // so a genuinely hung build is still killed and named.
    timeout: PRODUCTION_BUILD_TIMEOUT_MS,
  });
}

// ── chrome-agent-platform-kj9s: 7 builds -> 3, regrouped by WHICH BUILD each assertion depends on ──
// Condition (coord, 2026-10-06): no assertion may become vacuous or shared-state-dependent; anything
// depending on a DISTINCT build (a fresh state, a state change, a clean consecutive pair) keeps its
// own build, and no assertion may read a build made by ANOTHER test. Mapping, assertion by assertion:
//   symlink is a pointer                     -> build #1  (the file's first build: fresh state; a
//                                              legacy-dir bootstrap would replace the symlink) [kept]
//   CHANGELOG materialized by the build      -> build #1  (fresh state)                          [kept]
//   NO v-boot created for a symlink dist     -> build #1  (fresh state)                          [kept]
//   exactly one live version after repeated  -> reads builds #1 + #2 (the same consecutive pair —
//   builds                                     "repeated builds do not accumulate" is a property
//                                              of that pair; it moved OFF its own build)         [merged]
//   two builds byte-identical (schema,       -> builds #1 + #2 (a CLEAN CONSECUTIVE pair with no
//   target, key set, marker bytes, archive      state change between them — the determinism
//   sha, ZIP bytes)                            comparison needs exactly that)                    [kept]
//   dangling v-boot symlink GC'd             -> build #3  (planted, then ONE build — a build after
//                                              a state change)                                   [kept]
//   .DS_Store / ._* metadata GC'd            -> build #3  (planted into the SAME pre-build state;
//                                              the GC sweep covers the whole dir and each class is
//                                              an independent plant, so removing either reds its
//                                              own assertion)                                   [merged]
// ORDER MATTERS, deliberately: the one-live-version assertion runs BEFORE the byte-identical
// comparison, and the comparison is LAST. The comparison is the ONLY assertion in this file with a
// known pre-existing nondeterminism behind it (3337: workers/agent-worker.js drifts 846613 <->
// 846617 between builds), so putting it last keeps a 3337 flake from masking the deterministic
// assertions. Every assertion can still go RED on its own: nothing is read from another test.
// Net: 7 -> 3 builds, i.e. ~504s -> ~216s of build work on the measured ~72s store build.

Deno.test("bootstrap: a symlink dist never re-bootstraps, and two consecutive production builds are byte-identical (markers and ZIPs)", async () => {
  // Build #1 — the first build of the file: fresh-build state.
  build();
  // dist is a symlink (steady state)…
  const st = await lstat(DIST);
  assertEquals(st.isSymbolicLink(), true, "dist is the pointer symlink");
  assertEquals(
    await readFile(path.join(EXT, "CHANGELOG.md"), "utf8"),
    await readFile(path.join(ROOT, "CHANGELOG.md"), "utf8"),
    "a production build materializes the exact canonical changelog in the loaded extension",
  );
  // …and NO v-boot version was created this run.
  const entries = await readdir(VERSIONS);
  assertEquals(
    entries.some((e) => e.startsWith("v-boot-")),
    false,
    "no bootstrap ran for a symlink dist",
  );

  const output = await Deno.makeTempDir({
    prefix: "cap-deterministic-build-package-",
  });
  try {
    const firstMarker = await readFile(path.join(DIST, "dist.complete"), "utf8");
    const firstMarkerValue = JSON.parse(firstMarker);
    assertEquals(firstMarkerValue.schema, "cap-dist-complete-v2");
    assertEquals(firstMarkerValue.target, "store");
    assertEquals(Object.keys(firstMarkerValue), [
      "commit",
      "outputs",
      "schema",
      "source",
      "target",
    ]);
    const first = await packageExtensionArchive({
      root: ROOT,
      archive: path.join(output, "first.zip"),
      expectedTarget: "store",
    });

    // Build #2 — the second half of the clean consecutive pair.
    build();

    // Repeated builds must not accumulate live versions. Asserted HERE, before the byte-identical
    // comparison below, so a 3337 flake in that comparison cannot mask this deterministic property.
    const dirs = (await readdir(VERSIONS, { withFileTypes: true })).filter((e) =>
      e.isDirectory()
    );
    assertEquals(
      dirs.length,
      1,
      `one live version after repeated builds, got ${dirs.map((d) => d.name)}`,
    );

    const secondMarker = await readFile(path.join(DIST, "dist.complete"), "utf8");
    const second = await packageExtensionArchive({
      root: ROOT,
      archive: path.join(output, "second.zip"),
      expectedTarget: "store",
    });

    // LAST, deliberately: this is the one assertion with a known pre-existing nondeterminism behind
    // it (3337), so it must not be able to mask any assertion above.
    assertEquals(secondMarker, firstMarker, "dist.complete bytes drifted");
    assertEquals(
      second.archiveSha256,
      first.archiveSha256,
      "two-build archive digest drifted",
    );
    assertEquals(
      await Deno.readFile(path.join(output, "second.zip")),
      await Deno.readFile(path.join(output, "first.zip")),
      "two-build ZIP bytes drifted",
    );
  } finally {
    await Deno.remove(output, { recursive: true });
  }
});

Deno.test("GC: dangling v-boot symlink AND macOS .DS_Store/._* metadata are removed by the next build", async () => {
  const { writeFile } = await import(fsMod);
  // Plant BOTH residue classes into the same pre-build state. The GC pass is one sweep over
  // dist-versions and each class is an independent plant, so a regression in either one reds its own
  // assertion below — the two plants share a build, not a verdict.
  await symlink(
    "dist-versions/v-does-not-exist-0000",
    path.join(VERSIONS, `v-boot-plant-${Date.now()}`),
  ).catch(() => {});
  let planted;
  for (const e of await readdir(VERSIONS, { withFileTypes: true })) {
    if (e.name.startsWith("v-boot-plant-") && e.isSymbolicLink()) {
      planted = e.name;
    }
  }
  assert(planted, "the planted residue exists");
  const dsStore = path.join(VERSIONS, ".DS_Store");
  const appleDouble = path.join(VERSIONS, "._v-test-metadata");
  await writeFile(dsStore, "fake-ds-store");
  await writeFile(appleDouble, "fake-apple-double");

  // Build #3 — the build after this state change; it must GC the residue.
  build();
  const after = await readdir(VERSIONS, { withFileTypes: true });
  assertEquals(
    after.some((e) => e.name === planted),
    false,
    "the dangling v-boot symlink was GC'd",
  );
  assertEquals(after.map((e) => e.name).includes(".DS_Store"), false, ".DS_Store was cleaned by GC");
  assertEquals(after.map((e) => e.name).includes("._v-test-metadata"), false, "AppleDouble was cleaned by GC");
});
