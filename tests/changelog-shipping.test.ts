// @ts-nocheck — file URLs exercise the Node build helper from Deno.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const syncModule = "../scripts/sync-changelog.mjs";
const { syncChangelog } = await import(syncModule);

Deno.test("changelog sync materializes a missing generated package file and detects drift", async () => {
  const source = "canonical";
  const destination = "shipped";
  const canonical = new TextEncoder().encode(
    "# Changelog\n\n## [1.0.0]\n- exact\n",
  );
  let generated = null;
  const read = async (name) => {
    if (name === source) return canonical;
    if (generated !== null) return generated;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  const copy = async () => {
    generated = canonical.slice();
  };

  const created = await syncChangelog({
    source,
    destination,
    read,
    copy,
  });
  assertEquals(created.written, true);
  assertEquals(generated, canonical);
  await syncChangelog({ check: true, source, destination, read, copy });

  generated = new TextEncoder().encode("stale\n");
  await assertRejects(
    () =>
      syncChangelog({
        check: true,
        source,
        destination,
        read,
        copy,
      }),
    Error,
    "DRIFT",
  );
});

Deno.test("production build and package gates own the ignored shipped changelog", async () => {
  const [ignore, build, pack] = await Promise.all([
    Deno.readTextFile(new URL("../.gitignore", import.meta.url)),
    Deno.readTextFile(new URL("../build.mjs", import.meta.url)),
    Deno.readTextFile(
      new URL("../scripts/package-extension.mjs", import.meta.url),
    ),
  ]);

  assert(
    ignore.split(/\r?\n/).includes("extension/CHANGELOG.md"),
    "the package copy follows the existing ignored/generated-file precedent",
  );
  assert(
    build.includes("await syncChangelog({ check: false })") &&
      build.includes("await syncChangelog({ check: true })"),
    "a clean-archive production build materializes and verifies the shipped file",
  );
  assert(
    pack.includes("shippedChangelog") &&
      pack.includes("Buffer.compare(canonicalChangelog, packagedChangelog)"),
    "packaging fails closed when the shipped changelog is absent or stale",
  );
});
