#!/usr/bin/env node
// scripts/permission-variant.mjs — build a byte-identical extension VARIANT
// that pre-holds a chosen set of optional permissions at install time.
//
// Why: chrome.permissions.request() for a WARNED permission (history,
// tabGroups, bookmarks, …) never resolves headless — Chrome shows no prompt
// and the request stays pending until the requesting page closes. But a
// permission listed in manifest `permissions` (rather than
// `optional_permissions`) is granted AT INSTALL for an unpacked extension,
// with no prompt and no display — verified empirically 2026-08-30 (a variant
// holding `history` answers chrome.permissions.contains({permissions:[
// "history"]}) === true under --headless=new). Moving a permission between
// the two manifest arrays changes ONLY when Chrome grants it — the product
// code paths under test (Settings panel states, revoke, feature behavior
// under a grant) are identical.
//
// This is the grant-path half of the permission-state matrix; the deny path
// is the headless auto-pending/cancel behavior, and warningless permissions
// (contextMenus, scripting) auto-grant from a trusted CDP click.
//
// CLI:
//   node scripts/permission-variant.mjs --out <dir> --permissions tabGroups,history [--src <dir>]
//
// Programmatic:
//   import { buildVariant } from "./permission-variant.mjs";
//   const { dir, integrityPath } = await buildVariant({ outDir, permissions: ["tabGroups"] });
//
// Every build writes <outDir>/VARIANT-INTEGRITY.json: the sha256 of every
// file, and the assertion that ONLY manifest.json differs from the source.

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

async function treeHashes(dir) {
  const files = {};
  for await (const path of walk(dir)) {
    files[relative(dir, path)] = sha256(await readFile(path));
  }
  return files;
}

/**
 * @param {{ srcDir?: string, outDir: string, permissions: string[] }} opts
 * Fail-closed: refuses to move a permission that is not currently in the
 * source manifest's optional_permissions (moving an undeclared permission
 * would silently test a different product; re-moving a required one is a
 * no-op that would hide a drifted manifest).
 */
export async function buildVariant({ srcDir, outDir, permissions }) {
  const src = resolve(srcDir ?? new URL("../extension", import.meta.url).pathname);
  const out = resolve(outDir);
  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw new Error("buildVariant: permissions must be a non-empty array");
  }
  if (out === src || out.startsWith(src + sep)) {
    throw new Error("buildVariant: outDir must not be the source tree or inside it");
  }
  if (src.startsWith(out + sep)) {
    // The build rm -rf's `out` before copying — an ANCESTOR outDir would
    // delete the source tree first. Refuse.
    throw new Error("buildVariant: outDir must not be an ancestor of the source tree (the build would delete the source)");
  }

  const sourceManifest = JSON.parse(await readFile(join(src, "manifest.json"), "utf8"));
  const optional = new Set(sourceManifest.optional_permissions ?? []);
  const required = new Set(sourceManifest.permissions ?? []);
  for (const p of permissions) {
    if (required.has(p)) {
      throw new Error(`buildVariant: "${p}" is already install-granted (manifest permissions) — no variant needed`);
    }
    if (!optional.has(p)) {
      throw new Error(`buildVariant: "${p}" is not in the source manifest's optional_permissions — refusing to test a different product`);
    }
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(src, out, { recursive: true });

  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), ...permissions])].sort();
  manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => !permissions.includes(p));
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Integrity: every file byte-identical to the source EXCEPT manifest.json.
  const variantFiles = await treeHashes(out);
  const sourceFiles = await treeHashes(src);
  const differs = [];
  for (const [rel, hash] of Object.entries(variantFiles)) {
    if (sourceFiles[rel] !== hash) differs.push(rel);
  }
  for (const rel of Object.keys(sourceFiles)) {
    if (!(rel in variantFiles)) differs.push(`${rel} (missing from variant)`);
  }
  differs.sort();
  const expected = ["manifest.json"];
  if (JSON.stringify(differs) !== JSON.stringify(expected)) {
    throw new Error(`buildVariant: integrity failure — expected only manifest.json to differ, got: ${differs.join(", ")}`);
  }

  const integrity = {
    kind: "permission-variant-integrity",
    createdAt: new Date().toISOString(),
    sourceDir: src,
    permissionsPreHeld: permissions,
    fileCount: Object.keys(variantFiles).length,
    differsFromSource: differs,
    files: variantFiles,
  };
  const integrityPath = join(out, "VARIANT-INTEGRITY.json");
  await writeFile(integrityPath, JSON.stringify(integrity, null, 2) + "\n");
  return { dir: out, integrityPath, fileCount: integrity.fileCount };
}

/**
 * Independently re-verify a built variant BEFORE it is loaded into Chrome:
 * recompute every file's sha256 and compare against the recorded hashes, and
 * (when srcDir is given) recompute the source tree to confirm only
 * manifest.json differs. VARIANT-INTEGRITY.json is the one explicit metadata
 * addition (it is written after the tree is hashed, so it is not in `files`).
 * Fail-closed: any mismatch throws.
 * @param {{ dir: string, srcDir?: string }} opts
 */
export async function verifyVariantIntegrity({ dir, srcDir }) {
  const out = resolve(dir);
  const integrityPath = join(out, "VARIANT-INTEGRITY.json");
  let integrity;
  try {
    integrity = JSON.parse(await readFile(integrityPath, "utf8"));
  } catch {
    throw new Error("verifyVariantIntegrity: no readable VARIANT-INTEGRITY.json — never load an unattested variant");
  }
  if (integrity.kind !== "permission-variant-integrity" || typeof integrity.files !== "object" || integrity.files === null) {
    throw new Error("verifyVariantIntegrity: integrity file is not a permission-variant-integrity record");
  }
  const actual = await treeHashes(out);
  const problems = [];
  for (const [rel, hash] of Object.entries(actual)) {
    if (rel === "VARIANT-INTEGRITY.json") continue; // the one metadata addition
    if (integrity.files[rel] !== hash) problems.push(`${rel}: hash mismatch vs recorded`);
  }
  for (const rel of Object.keys(integrity.files)) {
    if (!(rel in actual)) problems.push(`${rel}: recorded but missing from the tree`);
  }
  if (srcDir) {
    const src = resolve(srcDir);
    const sourceFiles = await treeHashes(src);
    const differs = [];
    for (const [rel, hash] of Object.entries(actual)) {
      if (rel === "VARIANT-INTEGRITY.json") continue;
      if (sourceFiles[rel] !== hash) differs.push(rel);
    }
    for (const rel of Object.keys(sourceFiles)) {
      if (!(rel in actual)) differs.push(`${rel} (missing from variant)`);
    }
    differs.sort();
    if (JSON.stringify(differs) !== JSON.stringify(["manifest.json"])) {
      problems.push(`source divergence is not exactly [manifest.json]: ${differs.join(", ")}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`verifyVariantIntegrity: FAILED — ${problems.join("; ")}`);
  }
  return { ok: true, fileCount: Object.keys(actual).length - 1 };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : null;
  };
  const outDir = opt("out");
  const permissions = (opt("permissions") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const srcDir = opt("src") ?? undefined;
  if (!outDir || permissions.length === 0) {
    console.error("usage: node scripts/permission-variant.mjs --out <dir> --permissions a,b,c [--src <dir>]");
    process.exit(2);
  }
  try {
    const { dir, integrityPath, fileCount } = await buildVariant({ srcDir, outDir, permissions });
    console.log(`variant: ${dir} (pre-holds ${permissions.join(", ")}; ${fileCount} files, integrity ${integrityPath})`);
  } catch (e) {
    console.error(`REFUSED: ${e.message}`);
    process.exit(1);
  }
}
