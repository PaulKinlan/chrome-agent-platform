#!/usr/bin/env node

// Stamp the release identity ONCE per landed union (x0vas): package.json +
// package-lock.json + extension/manifest.json + CHANGELOG.md + the generated
// extension/CHANGELOG.md, the About page and the bundled inventory's release
// field. Lanes never run this; the merger does, on the union tip (--landing).
// Adapted from the owner's earlier extension pattern.
//
// Usage:
//   node scripts/bump-version.mjs patch                   # 0.2.0 -> 0.2.1
//   node scripts/bump-version.mjs minor                   # 0.2.0 -> 0.3.0
//   node scripts/bump-version.mjs major                   # 0.2.0 -> 1.0.0
//   node scripts/bump-version.mjs 1.2.3                   # set explicit version
//   node scripts/bump-version.mjs patch --message "..."   # use the commit message as the changelog entry
//   node scripts/bump-version.mjs patch --landing --from <base>..<tip>
//                                                         # stamp ONE release for a whole landing (merger)
//
// --from <base>..<tip> (a4o1s): the batch is a RANGE, and every commit in it
// contributes its own Release-note trailer; a commit that declares `none.`
// suppresses only its own note, and a range that collects no note is refused
// instead of stamped "none". A single `--from <sha>` still reads one commit and
// warns that it does, because that is how main 88b0dc8b6 was stamped "- none."
// under five commits carrying a security feature.
//
// The changelog entry is derived from --message (the commit message). No message
// → no placeholder entry is written (the version is still bumped).
//
// --skip-if-no-note (hook mode, xk2u): if the note sanitizes to EMPTY (merge
// subjects, bare branch names), do NOTHING — no bump, no entry, exit 0 with a
// loud stderr notice. Bookkeeping commits must not consume versions, and the
// placeholder text this replaces ("Maintenance and fixes.") is exactly how
// 93 fake entries landed on 2026-09-05. With skip-on-empty, version numbers
// are only ever consumed by commits that also write a real user-language entry,
// which keeps the changelog contiguous by construction.
//
// --hook (8nec): the LEGACY post-commit mode, kept for the sanitize tests and
// --reconcile-merge repair. It is INVOKED BY NOBODY since uikt5: the tracked
// scripts/git-hooks/post-commit is a stamping no-op — lanes never mint releases;
// the merger stamps the union with --landing. The note is EXPLICIT — --user-note
// only, never inferred from the subject — and the bump is once per branch: when
// the working version no longer matches origin/main's, nothing is written.

import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, relative, sep } from "path";
import { execSync, execFileSync } from "child_process";
// ONE source of truth for what counts as a user-facing bullet. This file used to
// carry its own copy of the six filter regexes plus isUserFacingEntry, justified
// as "so the standalone script functions in scratch temporary test mirrors". The
// copies agreed only until the real filter gained the `internal:` marker
// (chrome-agent-platform-whatsnew-449): the duplicate did not know it, scored a
// marked note user-facing, and the post-commit hook therefore PUBLISHED three
// `internal:` notes as release entries and burned a version on one of them. The
// mirrors now copy the module too, so the standalone rationale no longer applies —
// a second copy of a rule is how two gates drift apart.
import { isUserFacingEntry, parseChangelog } from "../extension/options/changelog-filter.js";
// The trailer matcher and sanitiser are shared with the lane's pre-flight gate
// (scripts/check-release-note-preflight.mjs, chrome-agent-platform-2h4j7) — one
// implementation, so what the lane checks is what the merger's stamp applies.
import { declaresNoUserFacingChange, releaseNoteShapeProblems, releaseNoteTrailers, sanitizeEntry } from "./lib/release-note.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}
function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}
function bumpSemver(current, type) {
  const [major, minor, patch] = current.split(".").map(Number);
  switch (type) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
    default:
      if (/^\d+\.\d+\.\d+/.test(type)) return type;
      console.error(`Unknown bump type: ${type}`);
      process.exit(1);
  }
}

// The version on origin/main, or null when git or the ref is unavailable. Used only by hook
// mode: a missing answer skips the branch check rather than guessing (8nec).
function originMainVersion() {
  try {
    const raw = execSync("git show origin/main:extension/manifest.json", {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(raw).version || null;
  } catch {
    return null;
  }
}

// Parse argv: the bump type is the first non-flag arg; --message/-m takes the next value.
const argv = process.argv.slice(2);
const type = argv.find((a) => !a.startsWith("-")) || "patch";
const mi = argv.findIndex((a) => a === "--message" || a === "-m");
const message = mi >= 0 ? argv[mi + 1] : null;
const landingMode = argv.includes("--landing");
const hookMode = argv.includes("--hook");
if (landingMode && hookMode) {
  console.error("[bump-version] ERROR: --landing cannot be combined with --hook");
  process.exit(1);
}
const notes = [];
const candidates = [];
const internalRefs = [];
/** Commits whose only trailers declare no user-facing change (ym066): they agree with --internal. */
const selfDeclaredInternal = new Set();
const userNoteGiven = argv.includes("--user-note") || argv.includes("--note");
function commitSha(value, flag) {
  if (!landingMode || !value || !/^[a-f0-9]{7,64}$/i.test(value)) {
    console.error(`[bump-version] ERROR: ${flag} requires --landing and a commit SHA`);
    process.exit(1);
  }
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${value}^{commit}`], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    console.error(`[bump-version] ERROR: cannot resolve ${flag} commit ${value}`);
    process.exit(1);
  }
}
/**
 * Resolve ONE --from argument to the commits whose Release-note trailers belong
 * to this batch (chrome-agent-platform-a4o1s).
 *
 * A LANDING IS A RANGE, NOT A TIP. `--from <base>..<tip>` names the whole
 * batch: every commit in it contributes its own note. A single sha keeps its
 * old meaning (THAT commit is the candidate) and still works, but says so
 * loudly, because it is the shape that invited the defect: main 88b0dc8b6 was
 * stamped "- none." from the tip of a landing whose five commits underneath
 * carried the vault-encryption feature, and nothing in the interface objected.
 * Inside a range a `none.` declaration suppresses THAT commit's note and
 * nothing else, so one internal commit can no longer vote a sibling's copy away.
 */
function fromCandidate(value) {
  if (!landingMode || !value) {
    console.error("[bump-version] ERROR: --from requires --landing and a commit SHA or <base>..<tip> range");
    process.exit(1);
  }
  if (value.includes("..")) {
    const parts = value.split("..");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      console.error(`[bump-version] ERROR: --from range "${value}" must be exactly <base>..<tip>`);
      process.exit(1);
    }
    const from = commitSha(parts[0], "--from");
    const to = commitSha(parts[1], "--from");
    let commits;
    try {
      commits = execFileSync("git", ["rev-list", "--reverse", `${from}..${to}`], {
        cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).split("\n").map((line) => line.trim()).filter(Boolean);
    } catch {
      console.error(`[bump-version] ERROR: cannot list the commits in --from range ${value}`);
      process.exit(1);
    }
    if (!commits.length) {
      console.error(`[bump-version] ERROR: --from range ${value} contains no commits`);
      process.exit(1);
    }
    return { sha: to, range: value, commits };
  }
  const sha = commitSha(value, "--from");
  console.error(
    `[bump-version] WARNING: --from ${value} reads ONE commit's Release-note trailers. ` +
    `A multi-commit landing stamped from its tip writes "- none." when the tip declares none ` +
    `(main 88b0dc8b6 did — a4o1s). Pass the batch as a range instead: --from <base>..<tip>`,
  );
  return { sha, commits: [sha] };
}
function commitBody(sha) {
  return execFileSync("git", ["show", "-s", "--format=%B", sha], { cwd: ROOT, encoding: "utf8" });
}
/**
 * Every note a --from argument brings, WITH the commit it came from and whether
 * that argument was a range. The drop decision needs the complete --internal set
 * (ym066), so it is taken after the argv loop — otherwise the result depends on
 * whether `--internal SHA` happened to be written before or after `--from …`,
 * which is exactly the kind of order-dependent rule this file has paid for
 * before (the a4o1s refusal itself).
 */
/** argv order is preserved for notes: an explicit --user-note (collected in the loop) stays first, then
 *  the batch's trailers in commit order — so the primary note never depends on flag order. */
const fromNotes = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--user-note" || argv[i] === "--note") notes.push(argv[++i]);
  if (argv[i] === "--internal") internalRefs.push(commitSha(argv[++i], "--internal"));
  if (argv[i] === "--from") {
    const candidate = fromCandidate(argv[++i]);
    const trailed = new Set();
    const userFacingTrailed = new Set();
    for (const sha of candidate.commits) {
      const body = commitBody(sha);
      const trailers = releaseNoteTrailers(body);
      // g0bfz: the stamp reads a `Release-note:` line ANYWHERE in the message; git
      // reads only a trailer block at the end. Warn, never refuse — an existing
      // cleared branch must not become unlandable — but name the disagreement so
      // the note is never accepted-and-invisible. The lane pre-flight REFUSES this
      // shape at authoring time; this is the landing-time backstop.
      if (landingMode) {
        for (const problem of releaseNoteShapeProblems(body)) console.error(`[bump-version] WARNING: candidate ${sha} — ${problem}`);
      }
      if (trailers.length) trailed.add(sha);
      const userFacing = trailers.filter((trailer) => !declaresNoUserFacingChange(sanitizeEntry(trailer ?? "")));
      if (trailers.length && userFacing.length === 0) selfDeclaredInternal.add(sha);
      if (userFacing.length) userFacingTrailed.add(sha);
      for (const trailer of trailers) fromNotes.push({ sha, note: trailer, range: Boolean(candidate.range) });
    }
    candidate.trailers = [];
    candidate.trailed = trailed;
    candidate.userFacingTrailed = userFacingTrailed;
    candidates.push(candidate);
  }
}
// a4o1s: a commit that declares no user-facing change suppresses ITS OWN note and
// nothing else — the union-level refusal below still catches a batch that hides an
// internal note behind a sibling's real one, and this is what stops one commit's
// "none." from erasing the five commits under it (the 88b0dc8b6 shape). ym066: a
// commit the merger DECLARED --internal still gets its `none.` dropped when the
// declaration and the trailer agree (that is what makes an all-internal range
// expressible at all).
const internalSetForNotes = new Set(internalRefs);
for (const entry of fromNotes) {
  const selfDeclared = declaresNoUserFacingChange(sanitizeEntry(entry.note ?? ""));
  const internalDeclared = internalSetForNotes.has(entry.sha);
  if (selfDeclared && (entry.range || internalDeclared)) {
    console.error(`[bump-version] candidate ${entry.sha}: "${entry.note}" declares no user-facing change — dropped for that commit only`);
    continue;
  }
  const candidate = candidates.find((candidate) => candidate.commits.includes(entry.sha));
  if (!candidate.trailers.includes(entry.note)) candidate.trailers.push(entry.note);
  if (!notes.includes(entry.note)) notes.push(entry.note);
}
const fromNoteCount = candidates.reduce((total, candidate) => total + candidate.trailers.length, 0);
if (landingMode) {
  const internal = new Set(internalRefs);
  const claimed = new Set();
  const known = new Set();
  for (const candidate of candidates) {
    if (claimed.has(candidate.sha)) {
      console.error(`[bump-version] ERROR: duplicate landing candidate ${candidate.sha}`);
      process.exit(1);
    }
    claimed.add(candidate.sha);
    for (const sha of candidate.commits) known.add(sha);
  }
  for (const candidate of candidates) {
    const { sha, trailers } = candidate;
    // A range names its batch's history, so a commit inside it with no trailer is
    // internal by construction and needs no --internal declaration; only an
    // explicitly NAMED candidate must account for a missing note.
    if (!candidate.range && !trailers.length && !internal.has(sha)) {
      console.error(`[bump-version] ERROR: candidate ${sha} has no Release-note trailer; pass --internal ${sha} explicitly if it is internal-only`);
      process.exit(1);
    }
    for (const member of candidate.commits) {
      // ym066: the contradiction is between a USER-FACING note and an internal
      // declaration. A commit whose only trailers declare no user-facing change
      // agrees with --internal, so it is not a contradiction (2rfyx/3er9j's case —
      // a real note plus --internal — is still refused).
      if (internal.has(member) && candidate.userFacingTrailed.has(member)) {
        console.error(`[bump-version] ERROR: candidate ${member} has a Release-note trailer and cannot be declared --internal`);
        process.exit(1);
      }
    }
    console.error(`[bump-version] landing candidate ${candidate.range ? `${candidate.range} (tip ${sha.slice(0, 12)}; ${candidate.commits.length} commits)` : sha}: ${trailers.length ? `${trailers.length} note(s)` : "explicitly internal (no release note)"}`);
  }
  for (const sha of internal) {
    if (!known.has(sha)) {
      console.error(`[bump-version] ERROR: --internal ${sha} is not a --from candidate`);
      process.exit(1);
    }
  }
  // a4o1s (b): a version with no note is a decision, not a default. A range that
  // collected nothing must not be stamped "- none." — refuse and make the
  // merger state the copy, or declare the batch internal.
  //
  // rfy90 (review of a4o1s): the first version of this refusal suggested
  // `--internal` while ignoring it, so the printed remedy could not be taken —
  // the merger could pass exactly the flags the message asked for and get the
  // same exit 1 back. Now the remedy WORKS and the refusal is only for a batch
  // that is not fully declared: if every commit of every range is named
  // `--internal`, the union has no user surface, which is the same answer a
  // single internal candidate already gets ("no user-facing note … NOT
  // bumping", exit 0) — a release is not minted for internal-only work.
  // ym066: a commit that declares itself internal in its own trailer needs no
  // --internal flag, and MUST NOT be blocked by the contradiction check when it
  // has one — so "is this commit internal?" means either declaration.
  const declaresItselfInternal = (sha) => selfDeclaredInternal.has(sha);
  const rangeCommits = candidates.filter((candidate) => candidate.range).flatMap((candidate) => candidate.commits);
  const internalOnlyBatch = rangeCommits.length > 0 &&
    rangeCommits.every((sha) => internal.has(sha) || declaresItselfInternal(sha));
  if (candidates.some((candidate) => candidate.range) && fromNoteCount === 0 && !userNoteGiven && !internalOnlyBatch) {
    const undeclared = rangeCommits.filter((sha) => !internal.has(sha) && !declaresItselfInternal(sha)).length;
    console.error(
      "[bump-version] ERROR: no --from range collected a Release-note trailer, so this landing would be " +
      `stamped "none". Refusing: say what the user gets with --user-note "<what the user gets>"; if the whole ` +
      `batch is internal (no user surface at all), declare EVERY commit of the range with --internal <sha> ` +
      `(${undeclared} of ${rangeCommits.length} range commit(s) are not declared yet)`,
    );
    process.exit(1);
  }
}
const userNote = notes[0] ?? null;
const skipIfNoNote = argv.includes("--skip-if-no-note") || hookMode || landingMode;
// Explicit merger-only repair (also available with --landing): after a union leaves the surfaces one patch ahead
// of CHANGELOG, use the changelog as the release anchor instead of resetting
// six files by hand. Never infer this mode during a normal author/hook bump.
const reconcileMerge = argv.includes("--reconcile-merge");
// 8nec: in hook mode the subject is NOT a note source, not even a fallback. The author
// states the user-facing copy with --user-note (the hook extracts it from a Release-note:
// trailer or CAP_USER_NOTE); without it, nothing is bumped.
const finalNote = userNote ? userNote.trim() : (hookMode || !message ? null : message.replace(/^\[[^\]]*\]\s*/, "").trim());

const cleanNote = finalNote ? sanitizeEntry(finalNote) : null;
const landingNotes = landingMode ? notes.map((note) => sanitizeEntry(note ?? "")) : [];
// Reject the whole union before writing any surface; a self-declared internal
// note cannot be hidden behind another branch's legitimate release note. The
// declaration is recognised in every spelling (2rfyx): the colon-only test let
// `none — internal gate classification; no user surface.` through as a
// user-facing bullet.
if (landingMode && landingNotes.some((note) => declaresNoUserFacingChange(note))) {
  console.error("[bump-version] ERROR: a note that declares no user-facing change (none: internal, none — …) cannot mint a release; omit that trailer");
  process.exit(1);
}
if (landingMode && landingNotes.some((note) => !note || !isUserFacingEntry(note))) {
  console.error("[bump-version] ERROR: landing note is empty or not user-facing");
  process.exit(1);
}

if (cleanNote && (declaresNoUserFacingChange(cleanNote) || !isUserFacingEntry(cleanNote))) {
  if (declaresNoUserFacingChange(cleanNote)) {
    console.error(`[bump-version] ERROR: note "${cleanNote}" declares no user-facing change; omit the Release-note trailer for internal work.`);
    process.exit(1);
  }
  if (skipIfNoNote) {
    console.error(
      `[bump-version] commit note "${cleanNote.slice(0, 72)}" does not pass user-facing filter — ` +
      `NOT bumping version (treating as non-user-facing bookkeeping). ` +
      `If this commit lands user-visible work, rephrase or bump explicitly: ` +
      `node scripts/bump-version.mjs patch --user-note "<what the user gets>"`
    );
    process.exit(0);
  } else {
    console.error(
      `[bump-version] ERROR: changelog note "${cleanNote}" fails user-facing check ` +
      `(contains engineering jargon, unhandled prefix, or internal state words).`
    );
    process.exit(1);
  }
}

// Hook mode (xk2u): sanitize FIRST and bail BEFORE touching any file when
// nothing user-sayable survives (merge/bookkeeping commits). Never invent
// placeholder text — that is how 93 fake entries landed on 2026-09-05.
if (skipIfNoNote && !cleanNote) {
  console.error(
    `[bump-version] no user-facing note for commit "${(message || "").slice(0, 72)}" — ` +
    `NOT bumping the version (bookkeeping commits do not consume versions). ` +
    (hookMode
      ? `Add a "Release-note: <what the user gets>" line to the commit message (or set ` +
        `CAP_USER_NOTE) and amend, or bump explicitly: `
      : `If this commit lands user-visible work, bump explicitly: `) +
    `node scripts/bump-version.mjs patch --user-note "<what the user gets>"`
  );
  process.exit(0);
}
if (finalNote && !cleanNote) {
  console.error(
    `[bump-version] WARNING: the note sanitized to empty (merge/branch subject?). ` +
    `Version bumps WITHOUT a changelog entry — re-run with --user-note to write one.`
  );
}

const pkgPath = join(ROOT, "package.json");
const lockPath = join(ROOT, "package-lock.json");
const manifestPath = join(ROOT, "extension", "manifest.json");
const pkg = readJson(pkgPath);
const lock = existsSync(lockPath) ? readJson(lockPath) : null;
const manifest = readJson(manifestPath);
const current = manifest.version || pkg.version;
const changelogPath = join(ROOT, "CHANGELOG.md");
const changelogVersion = existsSync(changelogPath)
  ? parseChangelog(readFileSync(changelogPath, "utf-8"))[0]?.version : null;
const inventoryPath = join(ROOT, "extension", "lib", "bundled-inventory-data.js");
const inventoryRelease = existsSync(inventoryPath)
  ? readFileSync(inventoryPath, "utf-8").match(/^\s*"release": "([^"]*)",/m)?.[1] : null;
const surfaces = [
  ["bundled-inventory-data.js release", inventoryRelease],
  ["package.json", pkg.version],
  ["package-lock.json", lock?.version],
  ["package-lock.json packages root", lock?.packages?.[""]?.version],
  ["extension/manifest.json", manifest.version],
  ["extension/manifest.json version_name", manifest.version_name],
].filter(([, version]) => version != null);
const expected = reconcileMerge && changelogVersion ? bumpSemver(changelogVersion, "patch") : changelogVersion;
if ((reconcileMerge && (!changelogVersion || hookMode || type !== "patch" || !surfaces.some(([, version]) => version === expected))) ||
    (changelogVersion && surfaces.some(([, version]) => version !== changelogVersion && (!reconcileMerge || version !== expected)))) {
  console.error(`[bump-version] ERROR: version surfaces and latest CHANGELOG disagree (` +
    `changelog=${changelogVersion ?? "missing"}; ${surfaces.map(([name, version]) => `${name}=${version}`).join(", ")}). ` +
    (reconcileMerge ? `Only a one-patch merge collision can be reconciled.` :
      `Resolve the merge or run patch --reconcile-merge --user-note "<what the user gets>" for a one-patch union.`));
  process.exit(1);
}
const releaseBase = reconcileMerge ? changelogVersion : current;

// chrome-agent-platform-66voq: attribute the newest CHANGELOG section to the
// commit that introduced it, and test batch membership by git ancestry.
// chrome-agent-platform-axtv2: `-m` is REQUIRED — a section introduced by a
// MERGE commit's second parent is invisible to plain `git log -S`, and a
// missing introduction must never read as "not this batch" on its own. Both
// helpers resolve to "cannot attribute" (null / false) on any git failure —
// and every unattributable case STAMPS: a lost release is worse than a
// duplicate one.
function newestSectionIntroducer(changelogPathArg, version) {
  try {
    const raw = execFileSync(
      "git",
      ["log", "-m", "-S", `## [${version}]`, "--format=%H", "-n", "1", "--", relative(ROOT, changelogPathArg)],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    // axTV2 follow-up: `-m` prints the match once per parent diff, so the first
    // output line is the introduction commit and the rest are duplicates — the
    // whole trimmed blob is NOT a valid object name and would break the
    // ancestry check into "stamp".
    const lines = String(raw).split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[0] ?? null;
  } catch {
    return null;
  }
}

/** Does the COMMITTED (HEAD) CHANGELOG already carry `version` as its newest
 *  section? True/False, or null when git cannot answer.
 *
 *  p0ll0 (review of 178298b4d): "CHANGELOG.md differs from HEAD" is NOT the
 *  fingerprint of an uncommitted stamp — ANY unrelated local edit to the file
 *  satisfies it. The probe asked "does HEAD already have this release?", and a
 *  dirty working tree would then read as an uncommitted stamp of the CURRENT
 *  batch, exiting 0 and losing a release: the exact direction the whole skip
 *  must never fail in. Only the SECTION's presence at HEAD is evidence. */
function headHasNewestSection(changelogPathArg, version) {
  let committed;
  try {
    committed = execFileSync(
      "git",
      ["show", `HEAD:${relative(ROOT, changelogPathArg).split(sep).join("/")}`],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null; // no HEAD:path (unborn HEAD, new tree) — cannot answer
  }
  try {
    return (parseChangelog(committed)[0]?.version ?? null) === version;
  } catch {
    return null;
  }
}

function commitIsAncestor(ancestorCandidate, descendant) {
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", ancestorCandidate, descendant],
      { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] },
    );
    return true;
  } catch {
    return false;
  }
}

// chrome-agent-platform-x0vas: a union stamp is IDEMPOTENT per batch. The merger's
// flow can legitimately re-run step 3a (a gate failure after stamping, an amended
// landing message); a re-run must NOT mint a second patch for the same effect.
// chrome-agent-platform-66voq: the skip can NOT be note-text alone — two
// different unions can carry identical Release-note lines, and skipping the
// second would land its effects without a release. The skip requires the batch
// ITSELF to be the one that produced the newest section: the commit that
// introduced `## [changelogVersion]` must already contain every --from sha in
// its ancestry. When git cannot attribute the section (uncommitted stamp: the
// entry exists only in the working tree, introducer null) the tree-state
// equality current === changelogVersion is the evidence instead.
if (landingMode && changelogVersion && landingNotes.length) {
  const newestBullets = existsSync(changelogPath)
    ? (parseChangelog(readFileSync(changelogPath, "utf-8"))[0]?.bullets ?? []).map((b) => String(b).trim())
    : [];
  const notesMatch = newestBullets.length > 0 && landingNotes.every((note) => newestBullets.includes(note));
  if (notesMatch) {
    const introducer = newestSectionIntroducer(changelogPath, changelogVersion);
    const fromShas = candidates.map((c) => c.sha);
    const batchIsInHistory = introducer !== null && fromShas.every((sha) => sha === introducer || commitIsAncestor(sha, introducer));
    if (batchIsInHistory) {
      console.error(
        `[bump-version] this batch is already released as [${changelogVersion}] — the newest CHANGELOG section ` +
        `was produced by this exact batch (introducer ${introducer.slice(0, 12)} contains every --from sha); ` +
        `nothing to stamp (idempotent re-run, x0vas/66voq).`,
      );
      process.exit(0);
    }
    // axtv2: the ONLY other skip is a genuinely UNCOMMITTED stamp — the working
    // tree carries a `## [version]` section that HEAD does NOT have yet (the
    // first stamp wrote the entry but the merger has not committed it). The old
    // tree-state inference (current === changelogVersion) held on EVERY clean
    // checkout, so any attribution failure — git error, shallow clone,
    // merge-introduced section — became a skip and lost the release.
    // p0ll0: and a DIRTY CHANGELOG is not that evidence either; only HEAD's
    // missing section is. Everything else STAMPS.
    const headHasSection = headHasNewestSection(changelogPath, changelogVersion);
    if (headHasSection === false) {
      console.error(
        `[bump-version] this batch is already released as [${changelogVersion}] — HEAD does not carry [${changelogVersion}] ` +
        `yet, so CHANGELOG.md holds an UNCOMMITTED stamp of this batch; nothing to stamp ` +
        `(idempotent re-run, x0vas/axtv2).`,
      );
      process.exit(0);
    }
    // Notes match but this batch did NOT produce the newest section (or its
    // introduction cannot be attributed): STAMP — never suppress (66voq/axtv2).
    console.error(
      `[bump-version] landing notes already appear in [${changelogVersion}], but that section was NOT produced by this batch ` +
      `(66voq${introducer === null ? "; section introduction unattributable, preferring a stamp over a lost release" : ""}) ` +
      `— stamping a new release for this batch's effects.`,
    );
  }
}

// 8nec (B): one bump per branch, not one per commit. If this branch's version no longer
// matches origin/main's, the branch either already carries the bump (its changelog entry
// exists) or is behind main (rebase, then bump). Only git can answer; an unavailable
// origin/main skips the check rather than guessing.
if (hookMode) {
  const onMain = originMainVersion();
  if (onMain && onMain !== current) {
    console.error(
      `[bump-version] this branch carries ${current} while origin/main is at ${onMain} — ` +
      `NOT bumping again (one bump per branch; rebase first if main has moved).`
    );
    process.exit(0);
  }
}

const next = bumpSemver(releaseBase, type);

pkg.version = next;
if (lock) {
  lock.version = next;
  if (lock.packages?.[""]) lock.packages[""].version = next;
}
manifest.version = next;
manifest.version_name = next;
writeJson(pkgPath, pkg);
if (lock) writeJson(lockPath, lock);
writeJson(manifestPath, manifest);

// Keep package-lock.json in lockstep (the final review's MEDIUM): the root
// version + the root packages[""].version entry must match, or release
// metadata is inconsistent. (Single lockPath declaration — the static review's
// finding 3; the earlier lock object already syncs, this block stamps version.)
if (lock) {
  lock.version = next;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = next;
  writeJson(lockPath, lock);
}

// Prepend a CHANGELOG entry ONLY when we have a user-language note that
// survived sanitizing (xk2u: never invent placeholder text).
if (existsSync(changelogPath) && cleanNote) {
  const date = new Date().toISOString().slice(0, 10);
  const existing = readFileSync(changelogPath, "utf-8");
  const bullets = landingMode ? [...new Set(landingNotes)] : [cleanNote];
  const entry = `\n## [${next}] — ${date}\n${bullets.map((note) => `- ${note}\n`).join("")}`;
  const updated = existing.replace(/(#[^\n]*\n)/, `$1${entry}`);
  writeFileSync(changelogPath, updated);
}

// Keep the bundled-tool inventory's top-level `release` field in lockstep with the
// version (CAP-FB-20260825-INVENTORY-DRIFT-01). The generator derives `release` from
// package.json (scripts/build-bundled-tool-packages.mjs) and
// tests/bundled-tool-packages.test.ts asserts inventory.release === manifest.version.
// Without this, every post-commit version bump drifts the committed inventory and
// `npm run build` fails closed on the bundled-tool verify gate. The top-level
// `"release"` key is unique (per-package manifests use "version", SBOM refs use "rel"),
// so a targeted patch is byte-equivalent to a full regeneration for a version-only bump.
if (existsSync(inventoryPath)) {
  const inv = readFileSync(inventoryPath, "utf-8");
  const updatedInv = inv.replace(/^(\s*)"release": "[^"]*",/m, `$1"release": "${next}",`);
  if (updatedInv !== inv) {
    writeFileSync(inventoryPath, updatedInv);
    // Stage it so the post-commit hook's `git commit --amend` bundles the resynced
    // inventory (the hook's explicit `git add` list does not include it). Best-effort.
    if (hookMode) {
      try {
        execSync("git add extension/lib/bundled-inventory-data.js", { cwd: ROOT, stdio: "ignore" });
      } catch { /* not a git repo / git unavailable — the file is still written */ }
    }
  }
}

// Keep the bundled changelog in lockstep + VERIFY (the review's MEDIUM: the
// bump must not leave the bundle stale).
const { syncChangelog } = await import("./sync-changelog.mjs");
await syncChangelog({ check: false });
await syncChangelog({ check: true }); // verify — throws (nonzero) on drift

// Keep the generated About page in lockstep with the version and inventory.
// Guarded for scratch-mirror test runs that only copy minimal scripts (P0-2).
const aboutGenPath = join(ROOT, "scripts/generate-about-page.mjs");
if (existsSync(aboutGenPath)) {
  try {
    const { syncAboutPage } = await import("./generate-about-page.mjs");
    await syncAboutPage({ check: false });
    if (hookMode) {
      try {
        execSync("git add extension/about/about.html", { cwd: ROOT, stdio: "ignore" });
      } catch { /* best-effort staging */ }
    }
  } catch (err) {
    console.warn(`[bump-version] Warning: failed to sync about page: ${err?.message || err}`);
  }
}

console.log(`Bumped ${current} → ${next}${message ? ` (changelog: ${message.slice(0, 60)})` : ""}`);
