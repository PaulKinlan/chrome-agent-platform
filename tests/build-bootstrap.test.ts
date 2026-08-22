// tests/build-bootstrap.test.ts — regression for the K3 finding: the
// steady-state dist SYMLINK must NOT re-run the legacy-dir bootstrap, and
// dangling v-boot symlink residue under dist-versions must be GC'd.
// @ts-nocheck: dynamic Node filesystem imports exercise real build pointers.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { packageExtensionArchive } from "../scripts/package-archive.mjs";
const fsMod = "node:fs/promises";
const { lstat, symlink, readdir, readFile } = await import(fsMod);
const cpMod = "node:child_process";
const { execFileSync } = await import(cpMod);
const pathMod = "node:path";
const path = (await import(pathMod)).default;

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = path.join(ROOT, "extension");
const DIST = path.join(EXT, "dist");
const VERSIONS = path.join(EXT, "dist-versions");

function build() {
  return execFileSync("node", ["build.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
  });
}

Deno.test("bootstrap: a dist SYMLINK does not re-run the legacy bootstrap (lstat, not stat)", async () => {
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
});

Deno.test("GC: dangling v-boot symlink residue under dist-versions is removed by the next build", async () => {
  // Plant the exact bug residue: a dangling symlink named v-boot-*.
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
  build();
  const after = await readdir(VERSIONS, { withFileTypes: true });
  assertEquals(
    after.some((e) => e.name === planted),
    false,
    "the dangling v-boot symlink was GC'd",
  );
});

Deno.test("GC: exactly one live version remains after repeated builds", async () => {
  build();
  build();
  const dirs = (await readdir(VERSIONS, { withFileTypes: true })).filter((e) =>
    e.isDirectory()
  );
  assertEquals(
    dirs.length,
    1,
    `one live version, got ${dirs.map((d) => d.name)}`,
  );
});

Deno.test("two production builds produce byte-identical markers and ZIP archives", async () => {
  const output = await Deno.makeTempDir({
    prefix: "cap-deterministic-build-package-",
  });
  try {
    build();
    const firstMarker = await readFile(
      path.join(DIST, "dist.complete"),
      "utf8",
    );
    const first = await packageExtensionArchive({
      root: ROOT,
      archive: path.join(output, "first.zip"),
    });

    build();
    const secondMarker = await readFile(
      path.join(DIST, "dist.complete"),
      "utf8",
    );
    const second = await packageExtensionArchive({
      root: ROOT,
      archive: path.join(output, "second.zip"),
    });

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
