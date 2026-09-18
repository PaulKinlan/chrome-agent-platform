// cap-evidence/54k5-real-tree-variant.ts — the REAL consumer shape
// (scripts/permission-matrix-acceptance.ts: buildVariant against the actual
// extension tree + verifyVariantIntegrity) run against the actual built tree,
// whose extension/dist is a symlink into dist-versions/.
//
// Before 54k5's fix this variant's runnable dist/ was a link back into the
// source; after it, the variant owns materialized bytes and the attestation
// covers the dist path. @ts-nocheck
import { buildVariant, verifyVariantIntegrity } from "../scripts/permission-variant.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../extension", import.meta.url)).replace(/\/$/, "");
const outDir = join(durableDir(`54k5-real-tree-${Date.now()}`), "variant");
const link = await Deno.lstat(`${EXT}/dist`).then((i) => Boolean(i.isSymlink)).catch(() => false);
const linkTarget = link ? await Deno.readLink(`${EXT}/dist`) : null;
console.log(JSON.stringify({ srcDistIsSymlink: link, linkTarget, outDir }));

const { dir, integrityPath } = await buildVariant({ srcDir: EXT, outDir, permissions: ["history"] });
const distInfo = await Deno.lstat(`${dir}/dist`);
const integrity = JSON.parse(await Deno.readTextFile(integrityPath));
const coversDist = Object.keys(integrity.files).some((p) => p.startsWith("dist/"));
const worker = await Deno.stat(`${dir}/dist/background/service-worker.js`).then((s) => s.size).catch(() => 0);
let verify = "accepted";
try { await verifyVariantIntegrity({ dir, srcDir: EXT }); } catch (e) { verify = `rejected: ${e.message.slice(0, 80)}`; }
const row = {
  variantDistIsSymlink: Boolean(distInfo.isSymlink ?? (typeof distInfo.isSymbolicLink === "function" ? distInfo.isSymbolicLink() : distInfo.isSymbolicLink)),
  variantDistWorkerBytes: worker,
  attestationCoversDist: coversDist,
  materializedLinks: integrity.materializedLinks,
  symlinksInVariant: integrity.symlinksInVariant,
  differsFromSource: integrity.differsFromSource,
  verify,
};
console.log(JSON.stringify(row, null, 2));
const ok = !row.variantDistIsSymlink && row.variantDistWorkerBytes > 0 && row.attestationCoversDist &&
  row.symlinksInVariant === 0 && JSON.stringify(row.differsFromSource) === JSON.stringify(["manifest.json"]) && row.verify === "accepted";
console.log(ok ? "\nREAL-TREE VARIANT: self-contained and fully attested." : "\nREAL-TREE VARIANT: DEFECT PRESENT.");
Deno.exit(ok ? 0 : 1);
