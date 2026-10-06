#!/usr/bin/env node
// scripts/check-owed-changelog.mjs — the owed-changelog ledger (chrome-agent-platform-xe11).
//
// WHY THIS EXISTS: the repo's version/changelog gates (check-changelog.mjs) verify the
// changelog against package.json — and both were GREEN for a full day while 200+
// commits landed and neither moved (0.3.577, 2026-10-05 → 2026-10-06), because a
// stall keeps both sides of the comparison equally stale. The missing check is the
// one web-uplift installed after the identical rot there (its CHANGELOG silently sat
// at 0.2.3 while the package reached 0.4.1): derive from GIT HISTORY which committed
// product changes are OWED a changelog entry and have none, and fail naming them.
// Same shape as web-uplift's ledger (its kdk bead): every landing after the last
// release commit is classified owed / not-owed; owed > 0 fails the gate.
//
// WHAT IT CHECKS (all against the COMMITTED tree — HEAD, never the working tree;
// a release exists when it is committed, the same philosophy as dist.complete):
//   1. The newest CHANGELOG.md heading matches EVERY surface that declares the
//      version: package.json, extension/manifest.json (version + version_name —
//      the extension's build identity, the load-bearing one), package-lock.json
//      (root + packages[""]) and the generated inventory's `release`. A heading
//      quoted inside a fenced code block is documentation, not a release, and
//      cannot satisfy either leg (fences are stripped before the scan — the
//      reviewed web-uplift reference's rule, sha256 c01a65f5).
//   2. No COMMIT after the commit that introduced the newest changelog heading
//      changes shipped product code without a release. Product code = files under
//      extension/ except Markdown docs (*.md), the generated bundled-inventory-data.js
//      and the build output (dist/). Merge commits are out of the ledger by
//      construction (--no-merges): a merge's own subject is bookkeeping; the lane
//      commits beneath it are classified individually. Tests, scripts, docs, beads
//      re-exports and root tooling are NOT owed — they change nothing the user gets.
//
//   node scripts/check-owed-changelog.mjs            # checks this repo
//   node scripts/check-owed-changelog.mjs --repo X   # checks another checkout
//
// Exit 0 = ledger clean. Exit 1 = owed entries (or the derivation failed — fail
// closed with diagnostics, never a silent pass).

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const SELF = pathToFileURL(process.argv[1] ?? "").href;
const DEFAULT_REPO = fileURLToPath(new URL("..", import.meta.url));

// --- pure helpers (unit-tested in tests/owed-changelog-ledger.test.ts) ---

/** Drop fenced code blocks before scanning. A version heading quoted inside a
 *  ``` / ~~~ fence is documentation (an example, a pasted transcript), not a
 *  release entry — treated as one, it satisfies the check and hides a missing
 *  entry. Ported from the reviewed web-uplift reference: the opener tolerates
 *  trailing text (an info string) and up to 3 leading spaces; only a fence of
 *  the SAME character, at least as long, closes it. */
export function stripFencedCode(text) {
  const opener = /^\s{0,3}(`{3,}|~{3,})/;
  const closer = /^\s{0,3}(`{3,}|~{3,})\s*$/;
  const kept = [];
  let fence = null;
  for (const line of String(text ?? "").split("\n")) {
    if (fence === null) {
      const open = opener.exec(line);
      if (open) fence = open[1];
      else kept.push(line);
    } else {
      const close = closer.exec(line);
      // Only a fence of the same character, at least as long, closes it.
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null;
      }
    }
  }
  return kept.join("\n");
}

/** Newest `## [x.y.z] — date` heading in a changelog body (the file is
 *  newest-first). Fenced blocks are stripped first, so a heading quoted inside
 *  a fence is never the newest release. */
export function parseNewestEntry(md) {
  const m = stripFencedCode(md).match(/^## \[(\d+\.\d+\.\d+)\][^\n]*$/m);
  return m ? { version: m[1] } : null;
}

/** Does this path change what the user gets? Product surface = extension/ minus
 *  docs, generated data and build output. Deliberately COARSE: a comment-only edit
 *  inside a product file still counts as owed. The ledger errs toward flagging; a
 *  false "owed" costs one internal: bullet, a false "not owed" costs a silent
 *  half-shipped fix (the kdk lesson: a fix nobody can read about is half-shipped). */
export function isProductPath(path) {
  if (typeof path !== "string" || path === "") return false;
  if (!path.startsWith("extension/")) return false;
  if (path === "extension/lib/bundled-inventory-data.js") return false; // generated
  if (path.startsWith("extension/dist/")) return false; // build output
  if (path.endsWith(".md")) return false; // in-tree docs (ROUTE_MAP.md, READMEs)
  return true;
}

/** One commit for the ledger: owed when any changed file is a product path.
 *  Merge commits never reach this (the walk is --no-merges). */
export function commitOwesProductChange({ files }) {
  return Array.isArray(files) && files.some(isProductPath);
}

// --- git plumbing (HEAD-only reads; never mutates) ---

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The commit that introduced the newest changelog heading: the most recent commit
 *  where that heading string's occurrence count changed (pickaxe). Headings are
 *  unique and never deleted (check-changelog enforces uniqueness/descending), and a
 *  date-only edit does not change the `## [v]` count, so this is the introducer. */
export function bumpCommitFor(repo, version, run = git) {
  const out = run(repo, [
    "log", `-S## [${version}]`, "--format=%H", "-n", "1", "--", "CHANGELOG.md",
  ]).trim();
  return out || null;
}

// Every surface where this repo declares its version — the release-identity
// rule: a release carries the version in every file it appears in, and
// bump-version.mjs keeps all of these in lockstep. extension/manifest.json is
// the extension's BUILD identity: a package.json that agrees while the manifest
// drifts still ships the wrong extension, so each surface is read independently
// rather than one standing in for the rest. Surfaces absent from HEAD declare
// nothing and are skipped (fixture repos, partial checkouts); present-but-
// unreadable ones fail closed, named.
const VERSION_SURFACES = [
  { path: "package.json", label: "package.json", read: (text) => JSON.parse(text)?.version },
  {
    path: "extension/manifest.json",
    label: "extension/manifest.json version",
    read: (text) => JSON.parse(text)?.version,
  },
  {
    path: "extension/manifest.json",
    label: "extension/manifest.json version_name",
    read: (text) => JSON.parse(text)?.version_name,
  },
  {
    path: "package-lock.json",
    label: "package-lock.json (root)",
    read: (text) => JSON.parse(text)?.version,
  },
  {
    path: "package-lock.json",
    label: "package-lock.json (packages[\"\"])",
    read: (text) => JSON.parse(text)?.packages?.[""]?.version,
  },
  {
    path: "extension/lib/bundled-inventory-data.js",
    label: "bundled-inventory-data.js release",
    // A JS module, not JSON: read the unique top-level `release` field. Per-package
    // manifests use "version" and SBOM refs use "rel", so the key is unambiguous
    // (the same reasoning as bump-version.mjs's targeted patch).
    read: (text) => /"release"\s*:\s*"([^"]*)"/.exec(text)?.[1],
  },
];

/** Every version-declaring surface at HEAD, as { label, path, version }. One
 *  `git show` per unique path; absent paths are skipped, broken ones throw
 *  naming the surface. */
function readVersionSurfaces(repo, run = git) {
  const texts = new Map();
  const surfaces = [];
  for (const surface of VERSION_SURFACES) {
    if (!texts.has(surface.path)) {
      try {
        texts.set(surface.path, run(repo, ["show", `HEAD:${surface.path}`]));
      } catch {
        texts.set(surface.path, null); // absent from HEAD: it declares nothing
      }
    }
    const text = texts.get(surface.path);
    if (text === null) continue;
    let version;
    try {
      version = surface.read(text);
    } catch (err) {
      throw new Error(`${surface.label}: cannot read the declared version — ${err.message}`);
    }
    if (typeof version !== "string" || version === "") {
      throw new Error(`${surface.label}: declares no usable version`);
    }
    surfaces.push({ label: surface.label, path: surface.path, version });
  }
  return surfaces;
}

/** Walk the non-merge commits after `anchor` and classify each owed / not-owed. */
export function deriveLedger({ repo, run = git }) {
  const headChangelog = run(repo, ["show", "HEAD:CHANGELOG.md"]);
  const newest = parseNewestEntry(headChangelog);
  if (!newest) {
    throw new Error("no `## [x.y.z]` heading found in HEAD's CHANGELOG.md");
  }
  const surfaces = readVersionSurfaces(repo, run);
  const pkg = surfaces.find((s) => s.label === "package.json");
  if (!pkg) {
    throw new Error("HEAD's package.json is missing or declares no version");
  }
  const pkgVersion = pkg.version;
  const anchor = bumpCommitFor(repo, newest.version, run);
  if (!anchor) {
    throw new Error(
      `cannot find the commit that introduced "## [${newest.version}]" — ` +
      `history may be shallow; the ledger fails closed rather than guess`,
    );
  }

  const owed = [];
  let notOwed = 0;
  if (anchor !== run(repo, ["rev-parse", "HEAD"]).trim()) {
    // One --name-only walk; the NUL records separate commit metadata from file lists.
    const raw = run(repo, [
      "log", "--no-merges", "--format=%x00%H%x01%s", "--name-only", `${anchor}..HEAD`,
    ]);
    let sha = null, subject = null, files = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("\0")) {
        if (sha !== null && files !== null) {
          if (commitOwesProductChange({ files })) owed.push({ sha, subject, files: files.filter(isProductPath) });
          else notOwed += 1;
        }
        const [, rest] = line.split("\x01");
        [sha, subject] = [line.slice(1).split("\x01")[0], rest ?? ""];
        files = [];
      } else if (line.trim() !== "" && files !== null) {
        files.push(line.trim());
      }
    }
    if (sha !== null && files !== null) {
      if (commitOwesProductChange({ files })) owed.push({ sha, subject, files: files.filter(isProductPath) });
      else notOwed += 1;
    }
  }
  return { newest, pkgVersion, surfaces, anchor, owed, notOwed };
}

// --- CLI ---

if (import.meta.url === SELF) {
  const args = process.argv.slice(2);
  const ri = args.indexOf("--repo");
  const repo = ri >= 0 ? args[ri + 1] : DEFAULT_REPO;
  const fail = (msg) => { console.error(msg); process.exit(1); };

  let ledger;
  try {
    ledger = deriveLedger({ repo });
  } catch (err) {
    fail(`OWED-CHANGELOG FAIL: the ledger could not be derived — ${err.message}`);
  }

  const { newest, surfaces, anchor, owed, notOwed } = ledger;
  const disagreeing = surfaces.filter((s) => s.version !== newest.version);
  if (disagreeing.length > 0) {
    // Name EVERY surface with its version (agreeing ones unmarked), so the
    // message can never shrink back to "package.json says X" while the manifest
    // — the extension's build identity — is what drifted.
    const lines = surfaces.map((s) =>
      `  - ${s.label}: ${s.version}${s.version !== newest.version ? "  (disagrees)" : ""}`);
    fail(
      `OWED-CHANGELOG FAIL: ${disagreeing.length} version-declaring surface(s) disagree with the ` +
      `newest changelog entry [${newest.version}] (introduced by ${anchor.slice(0, 12)}):\n` +
      lines.join("\n") +
      `\nThe version, its entry and every surface that declares it are ONE coherent change — ` +
      `run: node scripts/bump-version.mjs patch --user-note "<what the user gets>"`,
    );
  }
  if (owed.length > 0) {
    const lines = owed.map((c) =>
      `  - ${c.sha.slice(0, 12)} ${c.subject}  (${c.files.slice(0, 2).join(", ")}${c.files.length > 2 ? ", …" : ""})`);
    fail(
      `OWED-CHANGELOG FAIL: ${owed.length} committed product change(s) since the ` +
      `[${newest.version}] entry (${anchor.slice(0, 12)}) have no release entry:\n` +
      lines.join("\n") +
      `\nNot owed (tests/scripts/docs/beads/merges): ${notOwed}. ` +
      `Write what the user gets — a "Release-note: …" trailer on the commit (the ` +
      `post-commit hook turns it into the entry), or ` +
      `node scripts/bump-version.mjs patch --user-note "<what the user gets>". ` +
      `A fix nobody can read about in the changelog is half-shipped.`,
    );
  }
  console.log(
    `changelog ledger: clean — [${newest.version}] covers everything through HEAD ` +
    `(0 owed / ${notOwed} not owed since ${anchor.slice(0, 12)})`,
  );
}
