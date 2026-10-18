// fdjme: exercise the real Store archive mapper with an admitted schema-2
// package. The fixture builder registers schema-2 authority as a SIDE EFFECT;
// run it in a separate process so it cannot silently prime the mapper's realm.
// @ts-nocheck
import { assertEquals } from "jsr:@std/assert@1";
import { join } from "node:path";
import { buildBundledWasmManifestMap } from "../scripts/package-archive.mjs";

Deno.test("fdjme: Store archive mapper itself registers schema-2 authority before its probe", async () => {
  const root = await Deno.makeTempDir({ prefix: "cap-fdjme-schema2-" });
  try {
    const builder = new URL("../scripts/lib/emscripten-numeric-acceptance.mjs", import.meta.url).href;
    // Deliberate process boundary: buildNumericAcceptancePackage calls
    // registerSchema2Surface. Running it in THIS process would make the test
    // green even if package-archive.mjs's admission import never executed.
    const generator = `
      import { createHash } from "node:crypto";
      import { mkdir, writeFile } from "node:fs/promises";
      import { dirname, join } from "node:path";
      import { buildNumericAcceptancePackage } from ${JSON.stringify(builder)};
      const root = process.argv[1];
      const fixture = await buildNumericAcceptancePackage();
      const inventory = {
        files: fixture.files.map(({ rel, bytes }) => ({
          rel, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
        })),
        manifests: [fixture.inventoryManifestRow],
      };
      for (const { rel, bytes } of fixture.files) {
        const target = join(root, rel);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      await writeFile(join(root, "inventory.json"), JSON.stringify(inventory));
    `;
    const child = await new Deno.Command("node", {
      args: ["--input-type=module", "-e", generator, root], stdout: "piped", stderr: "piped",
    }).output();
    if (!child.success) throw new Error(`schema-2 fixture generator failed: ${new TextDecoder().decode(child.stderr)}`);
    const inventory = JSON.parse(await Deno.readTextFile(join(root, "inventory.json")));
    const manifestRel = inventory.files.find(({ rel }) => rel.endsWith(".manifest.json")).rel;
    const manifest = JSON.parse(await Deno.readTextFile(join(root, manifestRel)));
    const main = manifest.assets.find((asset) => asset.role === "main-wasm");
    const mapped = await buildBundledWasmManifestMap(root, { inventory });
    assertEquals([...mapped], [[main.path.slice("extension/".length), {
      schemaVersion: 2,
      id: main.id,
      sha256: main.sha256,
      size: main.size,
    }]], "the schema-2 authority was actually registered before mapping a declared CAS binary");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
