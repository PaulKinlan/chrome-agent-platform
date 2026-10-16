#!/usr/bin/env node

// Bump the version across package.json + package-lock.json + extension/manifest.json + CHANGELOG.md.
// Adapted from the owner's earlier extension pattern.
//
// Usage:
//   node scripts/bump-version.mjs patch                   # 0.2.0 -> 0.2.1
//   node scripts/bump-version.mjs minor                   # 0.2.0 -> 0.3.0
//   node scripts/bump-version.mjs major                   # 0.2.0 -> 1.0.0
//   node scripts/bump-version.mjs 1.2.3                   # set explicit version
//   node scripts/bump-version.mjs patch --message "..."   # use the commit message as the changelog entry
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
// --hook (8nec): the post-commit mode. The note is EXPLICIT — --user-note only,
// never inferred from the subject — and the bump is once per branch: when the
// working version no longer matches origin/main's, this branch already carries the
// bump (or is behind main) and nothing is written. scripts/git-hooks/post-commit
// is the author interface (a `Release-note:` trailer or CAP_USER_NOTE).

import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
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
import { isInternalEntry, isUserFacingEntry, parseChangelog } from "../extension/options/changelog-filter.js";

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
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--user-note" || argv[i] === "--note") notes.push(argv[++i]);
  if (argv[i] === "--internal") internalRefs.push(commitSha(argv[++i], "--internal"));
  if (argv[i] === "--from") {
    const sha = commitSha(argv[++i], "--from");
    const body = execFileSync("git", ["show", "-s", "--format=%B", sha], { cwd: ROOT, encoding: "utf8" });
    const trailers = [...body.matchAll(/^Release-note:\s*(.*)$/gim)].map((match) => match[1]);
    candidates.push({ sha, trailers });
    notes.push(...trailers);
  }
}
if (landingMode) {
  const internal = new Set(internalRefs);
  const seen = new Set();
  for (const { sha, trailers } of candidates) {
    if (seen.has(sha)) {
      console.error(`[bump-version] ERROR: duplicate landing candidate ${sha}`);
      process.exit(1);
    }
    seen.add(sha);
    if (!trailers.length && !internal.has(sha)) {
      console.error(`[bump-version] ERROR: candidate ${sha} has no Release-note trailer; pass --internal ${sha} explicitly if it is internal-only`);
      process.exit(1);
    }
    if (trailers.length && internal.has(sha)) {
      console.error(`[bump-version] ERROR: candidate ${sha} has a Release-note trailer and cannot be declared --internal`);
      process.exit(1);
    }
    console.error(`[bump-version] landing candidate ${sha}: ${trailers.length ? `${trailers.length} note(s)` : "explicitly internal (no release note)"}`);
  }
  for (const sha of internal) {
    if (!seen.has(sha)) {
      console.error(`[bump-version] ERROR: --internal ${sha} is not a --from candidate`);
      process.exit(1);
    }
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

// Release notes are for the person using the extension, not the VCS: strip
// conventional-commit prefixes, bare SHAs and CAP-FB tracker ids so the
// automated plain-language check (tests/changelog.test.ts) keeps passing no
// matter what the commit subject said (CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01 follow-through).
const sanitizeEntry = (note) => String(note)
  .replace(/^(merge|chore|fix|test|ci|docs|tasks|feat|refactor)(?:\([^)]*\))?\s*:\s*/i, "")
  .replace(/^chrome-agent-platform-[a-z0-9.]+:?\s*/i, "")
  .replace(/\bchrome-agent-platform-[a-z0-9.]+\b/gi, "")
  .replace(/\(\s*[0-9a-f]{7,40}\s*\)/gi, "")
  .replace(/\[\s*CAP-FB-\d{8}-[A-Z0-9-]+\s*\]/gi, "")
  .replace(/\bCAP-FB-\d{8}-[A-Z0-9-]+\b/g, "")
  .replace(/\[\s*\]/g, "")
  .replace(/\b\w+ lane\b/gi, "work")
  .replace(/\bjourneys\b/gi, "checks")
  .replace(/\bjourney\b/gi, "check")
  .replace(/^\s*(Merge remote-tracking branch|Merge branch)\b.*$/i, "")
  .replace(/^\s*(cap-beads-|cap-|work-)[a-z0-9-]+\s*$/i, "")
  .replace(/\s{2,}/g, " ")
  .trim()
  // y6z6: a subject that closes several beads at once ("<id> + <id>: the
  // change") loses EVERY id to the strips above and keeps the joiner, so the
  // entry read "- + : the change". Drop a leading run of joiner punctuation —
  // but only when whitespace (or the end) follows it: "/folder work" is copy,
  // not a leaked joiner. A subject that is nothing but ids and joiners now
  // sanitizes to EMPTY, so skip-on-empty treats it as bookkeeping.
  .replace(/^(?:[+&:;,./|—–-]+(?:\s+|$))+/, "")
  .trim();
const cleanNote = finalNote ? sanitizeEntry(finalNote) : null;
const landingNotes = landingMode ? notes.map((note) => sanitizeEntry(note ?? "")) : [];
// Reject the whole union before writing any surface; a self-declared internal
// note cannot be hidden behind another branch's legitimate release note.
if (landingMode && landingNotes.some((note) => /^none:\s*internal\b/i.test(note))) {
  console.error("[bump-version] ERROR: none: internal cannot mint a release; omit that trailer");
  process.exit(1);
}
if (landingMode && landingNotes.some((note) => !note || !isUserFacingEntry(note))) {
  console.error("[bump-version] ERROR: landing note is empty or not user-facing");
  process.exit(1);
}

if (cleanNote && !isUserFacingEntry(cleanNote)) {
  if (isInternalEntry(cleanNote) && /^none:\s*internal\b/i.test(cleanNote)) {
    console.error(`[bump-version] ERROR: note "${cleanNote}" declares no user-facing change (none: internal); omit the Release-note trailer for internal work.`);
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
