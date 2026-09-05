// tests/changelog.test.ts — verifies CHANGELOG.md validity, uniqueness, ordering,
// and lockstep sync with package.json and extension/CHANGELOG.md.
//
// CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01: the user-facing-voice rules and
// the recent/complement partition are tested HERE against the SAME exported
// implementation the About renderer ships (extension/options/changelog-filter.js),
// so the renderer, the unit tests and scripts/check-changelog.mjs cannot drift.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  isUserFacingEntry,
  parseChangelog,
  partitionChangelog,
} from "../extension/options/changelog-filter.js";

Deno.test("changelog: parsed entries are unique and strictly descending semver", async () => {
  const changelog = await Deno.readTextFile(new URL("../CHANGELOG.md", import.meta.url));
  const pkgJson = JSON.parse(await Deno.readTextFile(new URL("../package.json", import.meta.url)));

  const versionMatches = [...changelog.matchAll(/^## \[(\d+)\.(\d+)\.(\d+)\]/gm)];
  assert(versionMatches.length > 0, "must find version entries in CHANGELOG.md");

  const versions = versionMatches.map((m) => [+m[1], +m[2], +m[3]]);
  const versionStrings = versions.map((v) => v.join("."));

  // 1. Current version match
  assertEquals(versionStrings[0], pkgJson.version, "latest changelog entry must match package.json version");

  // 2. Uniqueness
  const seen = new Set();
  const duplicates = [];
  for (const v of versionStrings) {
    if (seen.has(v)) duplicates.push(v);
    seen.add(v);
  }
  assertEquals(duplicates, [], `duplicate changelog entries found: ${duplicates.join(", ")}`);

  // 3. Strictly descending semver order
  for (let i = 0; i + 1 < versions.length; i++) {
    const a = versions[i];
    const b = versions[i + 1];
    const isDescending = a[0] > b[0] ||
      (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
    assert(isDescending, `changelog out of order: ${versionStrings[i]} before ${versionStrings[i + 1]}`);
  }
});

Deno.test("changelog: extension/CHANGELOG.md is in exact lockstep with root CHANGELOG.md", async () => {
  const rootChangelog = await Deno.readTextFile(new URL("../CHANGELOG.md", import.meta.url));
  const extChangelog = await Deno.readTextFile(new URL("../extension/CHANGELOG.md", import.meta.url));
  assertEquals(rootChangelog, extChangelog, "extension/CHANGELOG.md must be byte-identical to root CHANGELOG.md");
});

// ── the exported rules (CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01) ─────────

Deno.test("changelog filter: isUserFacingEntry rejects engineering and workflow copy", () => {
  const reject = [
    "merge: WebMCP acceptance green lane (0c9783c8)",
    "chore(tasks): record bundled-inventory drift fix",
    "fix(build): version bumps now keep inventory in lockstep",
    "test: widen recent-section assertions",
    "ci: run the gate",
    "docs: update the style guide",
    "detector registration restored at discover (a1b2c3d)",
    "journey assertion restored",
    "KAT 10/10",
    "CDP eval context dropped",
    "harness port fixed",
    "worktree hygiene",
    "board deny lane merged",
    "tracker: the diff view component is recorded as landed.",
    "merge splice had folded the check names",
    "the run was RED then GREEN",
    "Landed: a reusable diff view is ready",
    "the change is now in review",
    "two more fixes are in progress",
    "recorded as landed",
    "the job was claimed by the Research agent",
  ];
  for (const s of reject) {
    assert(!isUserFacingEntry(s), `should reject: ${s}`);
  }
});

Deno.test("changelog filter: isUserFacingEntry accepts plain user copy", () => {
  const accept = [
    "The diff view is now ready for the editing flow (side by side or unified).",
    "Tool cards in a conversation now show what the tool actually returned.",
    "Every edit to an artifact keeps the previous version, and any earlier version can be restored.",
    "The hub stays fast as you use it.",
    "Notifications from the agent work again.",
    "The new tab opens on the composer.",
  ];
  for (const s of accept) {
    assert(isUserFacingEntry(s), `should accept: ${s}`);
  }
});

// ── the Show-all-complement rule ────────────────────────────────────────────

const FIXTURE = `# Changelog

## [0.2.4] — 2026-08-30
- A user-facing change in the newest release.
- Tracker: an internal note in the newest release.

## [0.2.3] — 2026-08-30
- Another readable change.

## [0.2.2] — 2026-08-30
- merge: an internal merge line.

## [0.2.1] — 2026-08-30
- A third readable change.

## [0.2.0] — 2026-08-30
- A fourth readable change.

## [0.1.9] — 2026-08-30
- A fifth readable change.

## [0.1.8] — 2026-08-30
- A sixth readable change (beyond the five visible).
`;

Deno.test("changelog filter: partitionChangelog keeps the newest five readable entries and puts EVERY OTHER entry in the complement", () => {
  const { recent, rest } = partitionChangelog(FIXTURE);
  assertEquals(recent.length, 5, "exactly five recent entries");
  // The five visible versions, newest first: 0.2.4, 0.2.3, 0.2.1, 0.2.0, 0.1.9
  // (0.2.2 is skipped — its only bullet is internal).
  assertEquals(recent.map((r) => r.version), ["0.2.4", "0.2.3", "0.2.1", "0.2.0", "0.1.9"]);
  assert(recent.every((r) => r.bullets.every(isUserFacingEntry)), "visible bullets are all user-facing");
  // Pinned invariant: visible set ∩ show-all set = ∅ (by VERSION — a shown
  // version never reappears in the complement, even for its hidden bullets).
  const recentVersions = new Set(recent.map((r) => r.version));
  assert(rest.every((r) => !recentVersions.has(r.version)), "no version appears in both visible and show-all");
  // The complement holds EXACTLY the versions not shown up front, in full.
  const restVersions = rest.map((r) => r.version);
  assert(restVersions.includes("0.2.2"), "the all-internal version is in the complement");
  assert(restVersions.includes("0.1.8"), "versions beyond the five visible are in the complement");
  assert(!restVersions.includes("0.2.4"), "a version shown up front never reappears (even its internal bullet)");
  // Every version with bullets is in exactly one side.
  const allVersions = parseChangelog(FIXTURE).map((v) => v.version);
  assertEquals([...recentVersions, ...restVersions].sort(), [...allVersions].sort(),
    "every version is in exactly one side (visible or show-all)");
  // Rest entries carry their FULL unfiltered text.
  const rest02 = rest.find((r) => r.version === "0.2.2");
  assertEquals(rest02?.bullets, ["merge: an internal merge line."], "non-shown versions show full unfiltered bullets");
});

Deno.test("changelog: recent entries (last ten versions) are plain user language via the exported filter", async () => {
  const changelog = await Deno.readTextFile(new URL("../CHANGELOG.md", import.meta.url));
  const versions = [...changelog.matchAll(/^## \[([^\]]+)\][^\n]*\n([\s\S]*?)(?=^## |\z)/gm)]
    .slice(0, 10)
    .map((m) => ({ version: m[1], bullets: m[2].split(/\r?\n/).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()) }));
  assert(versions.length >= 5, "must have at least five recent versions to check");
  const offenders = [];
  for (const v of versions) {
    for (const b of v.bullets) {
      if (!isUserFacingEntry(b)) offenders.push(`v${v.version}: ${b.slice(0, 80)}`);
    }
  }
  assert(!offenders.length, `recent changelog entries must be user-facing:\n${offenders.join("\n")}`);
  // The broad bans stay in force over the whole recent section (existing behaviour).
  const recentSection = changelog.split("## [0.2.208]")[0];
  assert(!recentSection.includes("CAP-FB-"), "must not contain internal task IDs (CAP-FB-...)");
  assert(!recentSection.includes("collision lattice"), "must not contain 'collision lattice' jargon");
  assert(!recentSection.includes("six-import"), "must not contain 'six-import' jargon");
  assert(!recentSection.includes("whole-tuple"), "must not contain 'whole-tuple' jargon");
});

// ── xk2u hardening (2026-09-05) ────────────────────────────────────────────
// The 2026-09-05 integrity failure: 93 entries said "Maintenance and fixes."
// because bump-version.mjs invented placeholder text when a merge/branch
// subject sanitized to empty, and parallel lanes racing version numbers left
// gaps (0.3.104-107, 0.3.174, 0.3.177, 0.3.235/237/238 never existed).
// These three tests make both failure modes unshippable.

Deno.test("changelog: no placeholder or boilerplate entries anywhere in the file", async () => {
  const changelog = await Deno.readTextFile(new URL("../CHANGELOG.md", import.meta.url));
  const PLACEHOLDER_RE = /^-\s*(Maintenance and fixes\.?|Bug fixes and improvements\.?|Various (improvements|updates)\.?|General (updates|improvements)\.?|Stability improvements\.?)\s*$/gim;
  const hits = [...changelog.matchAll(PLACEHOLDER_RE)];
  assertEquals(hits.length, 0,
    `placeholder/boilerplate entries are banned — every entry must name what the user gets:\n${hits.map((h) => h[0]).join("\n")}`);
});

Deno.test("changelog: every modern (0.3.x) bullet passes the user-facing language filter", async () => {
  const changelog = await Deno.readTextFile(new URL("../CHANGELOG.md", import.meta.url));
  const versions = parseChangelog(changelog);
  const offenders: string[] = [];
  for (const v of versions) {
    const [major, minor] = v.version.split(".").map(Number);
    if (major === 0 && minor < 3) continue; // ancient history is frozen, not rewritten
    for (const b of v.bullets as string[]) {
      if (!isUserFacingEntry(b)) offenders.push(`v${v.version}: ${b.slice(0, 80)}`);
    }
  }
  assertEquals(offenders, [],
    `every modern changelog bullet must read as user-facing copy:\n${offenders.join("\n")}`);
});

Deno.test("changelog: the modern (0.3.x) series is contiguous — no consumed-but-missing versions", async () => {
  const changelog = await Deno.readTextFile(new URL("../CHANGELOG.md", import.meta.url));
  const versions = parseChangelog(changelog)
    .map((v) => v.version.split(".").map(Number))
    .filter(([major, minor]) => major === 0 && minor === 3)
    .map(([, , patch]) => patch);
  assert(versions.length > 0, "must have 0.3.x entries");
  const top = Math.max(...versions);
  const bottom = Math.min(...versions);
  const missing = [];
  for (let p = bottom; p <= top; p++) {
    if (!versions.includes(p)) missing.push(`0.3.${p}`);
  }
  assertEquals(missing, [],
    `gaps in the 0.3 series mean a version number was consumed without an entry ` +
    `(the parallel-lane race) — renumber or restore:\n${missing.join(", ")}`);
});
