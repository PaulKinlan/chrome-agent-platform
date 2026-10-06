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
//   1. The newest CHANGELOG.md heading matches package.json's version (the
//      "version bumped with no entry" case — self-contained, mirrors check-changelog).
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

/** Newest `## [x.y.z] — date` heading in a changelog body (the file is newest-first). */
export function parseNewestEntry(md) {
  const m = String(md ?? "").match(/^## \[(\d+\.\d+\.\d+)\][^\n]*$/m);
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

/** Walk the non-merge commits after `anchor` and classify each owed / not-owed. */
export function deriveLedger({ repo, run = git }) {
  const headChangelog = run(repo, ["show", "HEAD:CHANGELOG.md"]);
  const headPkgRaw = run(repo, ["show", "HEAD:package.json"]);
  const newest = parseNewestEntry(headChangelog);
  if (!newest) {
    throw new Error("no `## [x.y.z]` heading found in HEAD's CHANGELOG.md");
  }
  let pkgVersion;
  try {
    pkgVersion = JSON.parse(headPkgRaw).version;
  } catch {
    throw new Error(`cannot parse HEAD's package.json`);
  }
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
  return { newest, pkgVersion, anchor, owed, notOwed };
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

  const { newest, pkgVersion, anchor, owed, notOwed } = ledger;
  if (pkgVersion !== newest.version) {
    fail(
      `OWED-CHANGELOG FAIL: package.json says ${pkgVersion} but the newest changelog ` +
      `entry is ${newest.version} (introduced by ${anchor.slice(0, 12)}). A version bump ` +
      `without its entry is an unreleasable tree — add the \`## [${pkgVersion}]\` entry or ` +
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
