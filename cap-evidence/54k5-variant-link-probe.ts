// cap-evidence/54k5-variant-link-probe.ts — reproduce the permission-variant
// source-linked dist defect (chrome-agent-platform-54k5) on current main.
//
// Two source shapes are exercised with the REAL buildVariant:
//   A. an ABSOLUTE dist -> dist-versions/v1 link (the shape the recorded probe
//      used; the link text is copied verbatim, so the variant's dist points
//      back INTO THE SOURCE);
//   B. a RELATIVE dist -> dist-versions/v1 link (the dev-checkout shape; the
//      link resolves inside the variant only because the target dir was copied
//      too).
// For each: is the variant's dist a link, where does it resolve, does the
// integrity report COVER the runnable dist path, does verifyVariantIntegrity
// accept the tree, and does the variant survive SOURCE GC?
// Exit 1 when the defect is present (the pre-fix expectation).
// @ts-nocheck
import { buildVariant, verifyVariantIntegrity } from "../scripts/permission-variant.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { lstat, mkdir, readlink, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = durableDir(`54k5-probe-${Date.now()}`);
const findings: string[] = [];
let defects = 0;

async function makeSource(linkKind: "absolute" | "relative") {
  const src = join(ROOT, `source-${linkKind}`);
  await mkdir(join(src, "dist-versions", "v1"), { recursive: true });
  await writeFile(join(src, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "fixture", version: "0.0.1",
    permissions: ["storage"], optional_permissions: ["tabGroups"],
  }, null, 2) + "\n");
  await writeFile(join(src, "dist-versions", "v1", "worker.js"), "export const w = 1;\n");
  await writeFile(join(src, "dist-versions", "v1", "extra.js"), "export const e = 2;\n");
  const link = join(src, "dist");
  const target = linkKind === "absolute" ? join(src, "dist-versions", "v1") : join("dist-versions", "v1");
  await Deno.symlink(target, link);
  return src;
}

for (const kind of ["absolute", "relative"] as const) {
  const src = await makeSource(kind);
  const out = join(ROOT, `variant-${kind}`);
  const { dir, integrityPath } = await buildVariant({ srcDir: src, outDir: out, permissions: ["tabGroups"] });
  const dist = join(dir, "dist");
  const distInfo = await lstat(dist).catch(() => null);
  const linkText = distInfo?.isSymbolicLink() ? await readlink(dist) : null;
  const targetAbs = linkText ? (linkText.startsWith("/") ? linkText : join(dir, linkText)) : null;
  const resolvesInsideVariant = targetAbs ? targetAbs.startsWith(dir + "/") : null;
  const workerBefore = await stat(join(dist, "worker.js")).then(() => true).catch(() => false);
  const integrity = JSON.parse(await readFile(integrityPath, "utf8"));
  const integrityCoversDist = Object.keys(integrity.files).some((p) => p.startsWith("dist/"));
  // SOURCE GC: the source's own build is cleaned (exactly what dist-versions GC does)
  await rm(join(src, "dist-versions"), { recursive: true, force: true });
  const workerAfter = await stat(join(dist, "worker.js")).then(() => true).catch(() => false);
  const ownCopyStillThere = await stat(join(dir, "dist-versions", "v1", "worker.js")).then(() => true).catch(() => false);
  // The silent pass: does the attestation still accept the tree?
  let verifyVerdict = "accepted";
  try { await verifyVariantIntegrity({ dir }); } catch (e) { verifyVerdict = `rejected: ${e.message.slice(0, 60)}`; }

  const row = {
    shape: kind,
    isSymlink: distInfo?.isSymbolicLink() ?? false,
    linkText,
    resolvesInsideVariant,
    workerLoadableBeforeGc: workerBefore,
    workerLoadableAfterSourceGc: workerAfter,
    variantOwnCopyAfterSourceGc: ownCopyStillThere,
    integrityCoversDist,
    integrityFileCount: integrity.fileCount,
    verifyVerdictAfterSourceGc: verifyVerdict,
  };
  console.log(`[${kind}] ${JSON.stringify(row)}`);
  // The defect: a variant whose runnable dist is a link, whose integrity report
  // omits that path, and which loses its loaded bytes when the source is GC'd
  // while attracting an "accepted" attestation.
  if (row.isSymlink && !row.integrityCoversDist) {
    findings.push(`${kind}: the variant's runnable dist is a SYMLINK and the integrity report does not cover it (fileCount=${integrity.fileCount})`);
    defects++;
  }
  if (kind === "absolute" && row.isSymlink && !resolvesInsideVariant) {
    findings.push(`${kind}: the copied link points OUTSIDE the variant (${linkText}) — it tests the SOURCE tree`);
    defects++;
  }
  if (kind === "absolute" && !row.workerLoadableAfterSourceGc && row.variantOwnCopyAfterSourceGc) {
    findings.push(`${kind}: after source GC the variant's dist/worker.js is GONE although the variant's own dist-versions copy remains`);
    defects++;
  }
}

console.log(JSON.stringify({ root: ROOT, defects, findings }, null, 2));
if (defects > 0) {
  console.log(`\nPROBE: ${defects} defect(s) reproduced on main.`);
  Deno.exit(1);
}
console.log("\nPROBE: no defects — the variant copy is self-contained and fully attested.");
