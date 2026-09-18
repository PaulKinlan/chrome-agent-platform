// tests/permission-variant.test.ts — the generic permission-variant builder:
// byte-identical copies that pre-hold optional permissions at install, with a
// machine-verifiable integrity manifest, and fail-closed refusals.
import { fileURLToPath } from "node:url";
import { buildVariant, verifyVariantIntegrity } from "../scripts/permission-variant.mjs";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";

async function makeFixtureExtension(perms: string[], optional: string[]) {
  const dir = `/tmp/pv-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/manifest.json`,
    JSON.stringify({
      manifest_version: 3,
      name: "fixture",
      version: "0.0.1",
      permissions: perms,
      optional_permissions: optional,
    }, null, 2) + "\n",
  );
  await Deno.writeTextFile(`${dir}/code.js`, "export const x = 1;\n");
  await Deno.mkdir(`${dir}/nested`, { recursive: true });
  await Deno.writeTextFile(`${dir}/nested/more.js`, "export const y = 2;\n");
  return dir;
}

Deno.test("permission variant: pre-holds the requested optional permissions, byte-identical except manifest", async () => {
  const src = await makeFixtureExtension(["storage"], ["tabGroups", "history"]);
  const out = `${src}-variant`;
  const { dir, integrityPath } = await buildVariant({ srcDir: src, outDir: out, permissions: ["tabGroups", "history"] });
  const manifest = JSON.parse(await Deno.readTextFile(`${dir}/manifest.json`));
  assertEquals(manifest.permissions, ["history", "storage", "tabGroups"]);
  assertEquals(manifest.optional_permissions, []);
  // Every other file byte-identical.
  assertEquals(await Deno.readTextFile(`${dir}/code.js`), "export const x = 1;\n");
  assertEquals(await Deno.readTextFile(`${dir}/nested/more.js`), "export const y = 2;\n");
  const integrity = JSON.parse(await Deno.readTextFile(integrityPath));
  assertEquals(integrity.differsFromSource, ["manifest.json"]);
  assertEquals(integrity.permissionsPreHeld, ["tabGroups", "history"]);
  assertEquals(integrity.fileCount, 3);
});

Deno.test("permission variant: refuses a permission that is already install-granted", async () => {
  const src = await makeFixtureExtension(["storage"], ["tabGroups"]);
  const err = await assertRejects(
    () => buildVariant({ srcDir: src, outDir: `${src}-v2`, permissions: ["storage"] }),
    Error,
    "already install-granted",
  );
  assert(err.message.includes("storage"));
});

Deno.test("permission variant: refuses a permission the product never declared", async () => {
  const src = await makeFixtureExtension(["storage"], ["tabGroups"]);
  await assertRejects(
    () => buildVariant({ srcDir: src, outDir: `${src}-v3`, permissions: ["nativeMessaging"] }),
    Error,
    "not in the source manifest's optional_permissions",
  );
});

Deno.test("permission variant: refuses to write inside the source tree", async () => {
  const src = await makeFixtureExtension(["storage"], ["tabGroups"]);
  await assertRejects(
    () => buildVariant({ srcDir: src, outDir: `${src}/nested`, permissions: ["tabGroups"] }),
    Error,
    "must not be the source tree or inside it",
  );
});

Deno.test("permission variant: refuses when outDir is an ANCESTOR of the source (would delete the source tree)", async () => {
  // The build rm -rf's outDir before copying — out=/tmp/x with
  // src=/tmp/x/extension would destroy the source. Fail closed.
  const root = `/tmp/pv-ancestor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const src = `${root}/extension`;
  await Deno.mkdir(src, { recursive: true });
  await Deno.writeTextFile(`${src}/manifest.json`, JSON.stringify({
    manifest_version: 3, name: "fixture", version: "0.0.1",
    permissions: ["storage"], optional_permissions: ["tabGroups"],
  }) + "\n");
  await Deno.writeTextFile(`${src}/code.js`, "export const x = 1;\n");
  await assertRejects(
    () => buildVariant({ srcDir: src, outDir: root, permissions: ["tabGroups"] }),
    Error,
    "ancestor of the source tree",
  );
  // The source must be untouched.
  assertEquals(await Deno.readTextFile(`${src}/code.js`), "export const x = 1;\n");
});

Deno.test("permission variant: verifyVariantIntegrity passes a clean build and rejects tampering", async () => {
  const src = await makeFixtureExtension(["storage"], ["tabGroups"]);
  const out = `${src}-variant-verify`;
  await buildVariant({ srcDir: src, outDir: out, permissions: ["tabGroups"] });
  const ok = await verifyVariantIntegrity({ dir: out, srcDir: src });
  assertEquals(ok.ok, true);
  // Tamper: flip a byte in a non-manifest file — verification must fail.
  await Deno.writeTextFile(`${out}/code.js`, "export const x = 2;\n");
  await assertRejects(
    () => verifyVariantIntegrity({ dir: out, srcDir: src }),
    Error,
    "hash mismatch",
  );
});

Deno.test("permission variant: verifyVariantIntegrity refuses a tree with no attestation", async () => {
  const src = await makeFixtureExtension(["storage"], ["tabGroups"]);
  const out = `${src}-variant-noattest`;
  await buildVariant({ srcDir: src, outDir: out, permissions: ["tabGroups"] });
  await Deno.remove(`${out}/VARIANT-INTEGRITY.json`);
  await assertRejects(
    () => verifyVariantIntegrity({ dir: out, srcDir: src }),
    Error,
    "no readable VARIANT-INTEGRITY.json",
  );
});

Deno.test("permission variant: the real manifest keeps the matrix capabilities optional (variant legality)", async () => {
  // The acceptance matrix pre-holds tabGroups + history via a variant. If a
  // future change moves either out of optional_permissions, the variant
  // builder refuses — this pins the reason WHY (the matrix depends on it).
  const manifest = JSON.parse(await Deno.readTextFile(
    fileURLToPath(new URL("../extension/manifest.json", import.meta.url)),
  ));
  const optional = manifest.optional_permissions ?? [];
  assert(optional.includes("tabGroups"), "tabGroups must stay optional (the matrix variant pre-holds it)");
  assert(optional.includes("history"), "history must stay optional (the matrix variant pre-holds it)");
});

// ── 54k5: a source-LINKED dist must be materialized into the variant ─────────
// A dev checkout's built output directory is a symlink into dist-versions/.
// fs.cp copies a link AS a link and re-bases its target to an ABSOLUTE path
// inside the SOURCE tree, so the variant's runnable dist/ pointed back at the
// tree that built it, its loaded bytes vanished when source build GC removed
// dist-versions/, and the link-blind attestation covered neither fact. (Prose
// here avoids the built-tree path literal: the partition guard classifies plain
// text, and this test touches only its own /tmp fixtures.)
async function makeLinkedFixtureExtension(linkKind: "absolute" | "relative") {
  const dir = `/tmp/pv-linked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await Deno.mkdir(`${dir}/dist-versions/v1`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/manifest.json`,
    JSON.stringify({
      manifest_version: 3,
      name: "linked fixture",
      version: "0.0.1",
      permissions: ["storage"],
      optional_permissions: ["tabGroups"],
    }, null, 2) + "\n",
  );
  await Deno.writeTextFile(`${dir}/dist-versions/v1/worker.js`, "export const worker = 1;\n");
  const target = linkKind === "absolute" ? `${dir}/dist-versions/v1` : "dist-versions/v1";
  await Deno.symlink(target, `${dir}/dist`);
  return dir;
}

Deno.test("permission variant: a source-LINKED dist is materialized — the variant owns its bytes and survives source build GC (54k5)", async () => {
  for (const linkKind of ["absolute", "relative"] as const) {
    const src = await makeLinkedFixtureExtension(linkKind);
    const out = `${src}-variant`;
    const { dir, integrityPath } = await buildVariant({ srcDir: src, outDir: out, permissions: ["tabGroups"] });
    // BEFORE the fix: a symlink whose target fs.cp had re-based into the SOURCE.
    const distInfo = await Deno.lstat(`${dir}/dist`);
    assert(!distInfo.isSymlink, `${linkKind}: the variant's runnable dist must be materialized, not a link`);
    assertEquals(await Deno.readTextFile(`${dir}/dist/worker.js`), "export const worker = 1;\n");
    const integrity = JSON.parse(await Deno.readTextFile(integrityPath));
    assert(
      Object.keys(integrity.files).includes("dist/worker.js"),
      `${linkKind}: the attestation must COVER the runnable dist path: ${Object.keys(integrity.files)}`,
    );
    assertEquals(integrity.materializedLinks, [{ path: "dist", target: "dist-versions/v1" }]);
    assertEquals(integrity.symlinksInVariant, 0);
    // SOURCE BUILD GC: exactly what removing a versioned dist does.
    await Deno.remove(`${src}/dist-versions`, { recursive: true });
    assertEquals(
      await Deno.readTextFile(`${dir}/dist/worker.js`),
      "export const worker = 1;\n",
      `${linkKind}: source GC must not change the variant's loaded bytes`,
    );
    await verifyVariantIntegrity({ dir });
  }
});

Deno.test("permission variant: a DANGLING source link fails the build closed, never a silently dist-less variant (54k5)", async () => {
  const src = await makeFixtureExtension(["storage"], ["tabGroups"]);
  await Deno.symlink("dist-versions/absent", `${src}/dist`);
  const out = `${src}-variant`;
  await assertRejects(
    () => buildVariant({ srcDir: src, outDir: out, permissions: ["tabGroups"] }),
    Error,
    "dangling symlink",
  );
  assertEquals(
    await Deno.lstat(`${out}/VARIANT-INTEGRITY.json`).then(() => true).catch(() => false),
    false,
    "a refused build must leave no attestation behind",
  );
});
