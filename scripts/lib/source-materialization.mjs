// scripts/lib/source-materialization.mjs — the SOURCE CLOSURE a fresh-checkout
// fixture must contain (chrome-agent-platform-woem).
//
// `git ls-files` alone is the TRACKED set. A candidate that adds a source module
// therefore materializes WITHOUT it: the child generator dies with
// ERR_MODULE_NOT_FOUND, the "fresh checkout" evidence describes a tree the
// candidate never built, and the failure looks like a product red. Measured
// 2026-09-18: an untracked module imported by a tracked file made
// tests/evidence-durable.test.ts fail exactly that way.
//
// The closure is: tracked files + NON-IGNORED untracked files (git's own ignore
// rules decide what is source) + any ignored evidence roots the caller names
// explicitly. `--exclude-standard` is what keeps arbitrary scratch, secrets,
// node_modules and .git out, so nothing has to be enumerated by hand.
//
// Deliberately small — no snapshot framework: one enumeration, one copy, both
// fail-closed (a listed file missing on disk is an error, never a silent skip).

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Every file under `dir` (recursively), or nothing when it does not exist. */
function* walkFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (entry.isFile()) yield path;
  }
}

/**
 * The relative paths a faithful materialization must contain, sorted and unique.
 * @param {{ root: string, evidenceRoots?: string[] }} options
 */
export function listSourceClosure({ root, evidenceRoots = [] }) {
  if (!root) throw new Error("listSourceClosure: root is required");
  const absRoot = resolve(root);

  // Tracked + non-ignored untracked, NUL-delimited so no path can be mangled.
  const ls = spawnSync(
    "git",
    ["-C", absRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  if (ls.status !== 0 || !ls.stdout) {
    throw new Error(
      `listSourceClosure: git ls-files failed (exit ${ls.status}): ${String(ls.stderr ?? "").slice(0, 300)}`,
    );
  }
  const files = new Set(
    ls.stdout.toString("utf8").split("\0").filter(Boolean),
  );

  // Ignored evidence inputs stay allowed, but ONLY where the caller says so.
  for (const relRoot of evidenceRoots) {
    const abs = join(absRoot, relRoot);
    if (!existsSync(abs)) continue;
    for (const path of walkFiles(abs)) files.add(relative(absRoot, path));
  }

  return [...files].sort();
}

/**
 * Copy the source closure into `dest`. Fails closed when a listed file is not on
 * disk: an incomplete fixture must never be verified as if it were complete.
 * @param {{ root: string, dest: string, evidenceRoots?: string[] }} options
 */
export function materializeSourceTree({ root, dest, evidenceRoots = [] }) {
  if (!dest) throw new Error("materializeSourceTree: dest is required");
  const absRoot = resolve(root);
  const absDest = resolve(dest);
  if (absDest === absRoot || absDest.startsWith(absRoot + sep)) {
    throw new Error("materializeSourceTree: dest must not be the source tree or inside it");
  }

  const files = listSourceClosure({ root: absRoot, evidenceRoots });
  for (const rel of files) {
    const src = join(absRoot, rel);
    let info;
    try {
      info = statSync(src);
    } catch {
      throw new Error(`materializeSourceTree: listed source is missing on disk: ${rel}`);
    }
    if (!info.isFile()) {
      throw new Error(`materializeSourceTree: listed source is not a regular file: ${rel}`);
    }
    const dst = join(absDest, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  return { files, count: files.length };
}
