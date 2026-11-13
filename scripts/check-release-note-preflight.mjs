#!/usr/bin/env node

// scripts/check-release-note-preflight.mjs — the lane-side release-note
// pre-flight (chrome-agent-platform-2h4j7). The merger's release stamp
// (scripts/bump-version.mjs --landing) refuses three things, and until this
// check existed a lane learned about every one of them only when the merge
// refused — five branches in one queue round, each fixed by a one-line author
// edit plus a fresh pinned gate:
//   1. a `Release-note:` trailer that declares no user-facing change in ANY
//      spelling — `none: internal …`, `none — …`, `none - …`, a bare `none`
//      (bump-version: "cannot mint a release; omit that trailer"). The
//      colon-only form was the original text; 2rfyx found the prose spelling
//      walking through both gates and publishing a What's-new bullet;
//   2. a trailer the user-facing filter rejects (the merger cannot mint a
//      release the reader cannot read);
//   3. a PRODUCT commit (extension/ surface, per the owed ledger's own
//      predicate) carrying NO trailer — the owed ledger then reds main.
// This script walks the commits about to be handed off (origin/main..HEAD,
// no merges) and applies the SAME predicates bump-version applies — the filter
// from extension/options/changelog-filter.js, the sanitiser and trailer
// matcher from scripts/lib/release-note.mjs, and the product-path ruling from
// scripts/check-owed-changelog.mjs. Nothing here re-implements those rules; a
// second copy would drift and then disagree with the thing that decides.
//
// Coord's binding constraint: FAIL only on a trailer that would be REJECTED
// (or a product change with none) — never on a MISSING trailer for an
// internal-only delta (scripts/tests/docs/beads), or every internal merge
// starts red and the check becomes a permanent false alarm.
//
// Usage:
//   node scripts/check-release-note-preflight.mjs            # this repo, vs origin/main
//   node scripts/check-release-note-preflight.mjs --repo X --base <ref>
//
// Exit 0 = every commit in range would pass the release stamp. Exit 1 = at
// least one commit names the exact refusal bump-version would print.

import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
// bump-version.mjs's OWN user-facing filter — the single source of truth.
import { explainUserFacingEntry, isInternalEntry } from "../extension/options/changelog-filter.js";
// bump-version.mjs's OWN trailer matcher and sanitiser (2h4j7 extraction), and
// the "declares no user-facing change" predicate 2rfyx added there — the same
// one call decides both gates, so they cannot disagree about a spelling.
import { declaresNoUserFacingChange, releaseNoteTrailers, sanitizeEntry } from "./lib/release-note.mjs";
// The owed ledger's OWN product-path ruling: what a user can get.
import { commitOwesProductChange } from "./check-owed-changelog.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const TEACHING =
  `Release-note trailers are how this project talks to its users: the merger's ` +
  `release stamp (scripts/bump-version.mjs --landing) publishes them VERBATIM ` +
  `into the What's new list, and refuses wording a reader cannot use. The ` +
  `refusal above is the refusal the merge would print — fix it here and the ` +
  `merge goes through. Write what a user notices ("imported skill titles can ` +
  `no longer pose as instructions to the agent"), not how the change works ` +
  `(harness, fence, lane, gate, worktree are engineering vocabulary). If the ` +
  `change is internal-only (scripts/tests/docs), omit the trailer entirely — ` +
  `a trailer that says so is itself refused.`;

/** Judge one commit about to be handed off. The filter is injectable so a
 *  test can mutate it and prove this check follows the real predicate rather
 *  than a copy; production wiring passes bump-version's own module.
 * @param {{ sha?: string, files: string[], body: string }} commit
 * @param {{ explainUserFacingEntry: Function, isInternalEntry: Function }} filter
 * @returns {{ ok: true } | { ok: false, reason: string }} */
export function classifyCommit({ files, body }, filter = { explainUserFacingEntry, isInternalEntry }) {
  const trailers = releaseNoteTrailers(body);
  if (trailers.length === 0) {
    if (commitOwesProductChange({ files })) {
      const product = files.filter((f) => f.startsWith("extension/"));
      return {
        ok: false,
        reason:
          `product change with no Release-note trailer (${product.slice(0, 3).join(", ")}` +
          `${product.length > 3 ? ", …" : ""}). bump-version refuses the landing: ` +
          `"candidate <sha> has no Release-note trailer; pass --internal <sha> explicitly if ` +
          `it is internal-only". A user-visible change owes one sentence about what the user gets.`,
      };
    }
    return { ok: true };
  }
  for (const raw of trailers) {
    const note = sanitizeEntry(raw);
    if (!note) {
      return {
        ok: false,
        reason:
          `Release-note trailer sanitises to EMPTY ("${raw.trim().slice(0, 72)}"). ` +
          `bump-version refuses the landing: "landing note is empty or not user-facing".`,
      };
    }
    if (declaresNoUserFacingChange(note)) {
      return {
        ok: false,
        reason:
          `Release-note trailer declares no user-facing change ("${note.slice(0, 72)}"). ` +
          `bump-version refuses it verbatim: "a note that declares no user-facing change ` +
          `(none: internal, none — …) cannot mint a release; omit that trailer". ` +
          `Internal-only work carries NO trailer — and a trailer that says so in prose is ` +
          `refused too, whatever dash or colon it used.`,
      };
    }
    const verdict = filter.explainUserFacingEntry(note);
    if (!verdict.ok) {
      return {
        ok: false,
        reason:
          `Release-note trailer "${note.slice(0, 72)}" is rejected by the project's ` +
          `user-facing filter: ${verdict.why} (offending word: "${verdict.token}"). ` +
          `bump-version refuses the landing: "landing note is empty or not user-facing".`,
      };
    }
  }
  return { ok: true };
}

// --- git plumbing (HEAD-only reads; never mutates) ---

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** The non-merge commits base..HEAD with their files and bodies. */
export function commitsInRange(repo, base) {
  const shas = git(repo, ["log", "--no-merges", "--format=%H", `${base}..HEAD`])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return shas.map((sha) => ({
    sha,
    subject: git(repo, ["show", "-s", "--format=%s", sha]).trim(),
    files: git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    body: git(repo, ["show", "-s", "--format=%B", sha]),
  }));
}

// --- CLI ---

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const repo = arg("--repo", ROOT);
  const base = arg("--base", "origin/main");
  const fail = (msg) => { console.error(msg); process.exit(1); };

  let commits;
  try {
    git(repo, ["rev-parse", "--verify", base]);
    commits = commitsInRange(repo, base);
  } catch (err) {
    // Fail closed, as the owed ledger does: a pre-flight that cannot see the
    // hand-off range has checked nothing.
    fail(`RELEASE-NOTE PRE-FLIGHT FAIL: the hand-off range ${base}..HEAD could not be read — ${err.message}`);
  }

  const failures = [];
  let noted = 0;
  for (const commit of commits) {
    const verdict = classifyCommit(commit);
    if (!verdict.ok) failures.push({ commit, reason: verdict.reason });
    else if (releaseNoteTrailers(commit.body).length > 0) noted++;
  }
  if (failures.length > 0) {
    const lines = failures.map(({ commit, reason }) =>
      `  - ${commit.sha.slice(0, 12)} ${commit.subject}\n    ${reason}`);
    fail(
      `RELEASE-NOTE PRE-FLIGHT FAIL: ${failures.length} of ${commits.length} commit(s) ` +
      `over ${base} would be refused at the merge:\n` +
      lines.join("\n") +
      `\n\n${TEACHING}`,
    );
  }
  console.log(
    `release-note pre-flight: clean — ${commits.length} commit(s) over ${base} ` +
    `(${noted} with user-facing notes, ${commits.length - noted} internal-only without trailers)`,
  );
}
