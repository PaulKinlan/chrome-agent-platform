// tests/permission-variant.test.ts — the generic permission-variant builder:
// byte-identical copies that pre-hold optional permissions at install, with a
// machine-verifiable integrity manifest, and fail-closed refusals.
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
    new URL("../extension/manifest.json", import.meta.url).pathname,
  ));
  const optional = manifest.optional_permissions ?? [];
  assert(optional.includes("tabGroups"), "tabGroups must stay optional (the matrix variant pre-holds it)");
  assert(optional.includes("history"), "history must stay optional (the matrix variant pre-holds it)");
});
