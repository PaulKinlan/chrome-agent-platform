// tests/changelog.test.ts — verifies CHANGELOG.md validity, uniqueness, ordering,
// and lockstep sync with package.json and extension/CHANGELOG.md.

import { assert, assertEquals } from "jsr:@std/assert@1";

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

Deno.test("changelog: recent entries (last ten versions) are plain user language without internal task IDs, SHAs, or raw jargon", async () => {
  const changelog = await Deno.readTextFile(new URL("../CHANGELOG.md", import.meta.url));
  // Mirror of extension/options/options.js isUserFacingEntry: a bullet a
  // non-engineer can read. Kept in lockstep with the renderer and
  // scripts/check-changelog.mjs (CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01).
  const isUserFacingEntry = (text: string) => {
    const line = String(text).trim();
    if (/^(merge|chore|fix\(|test|ci|docs):/i.test(line)) return false;
    if (/\b[0-9a-f]{7,40}\b/i.test(line)) return false;
    if (/journey|KAT|assertion|CDP|harness|worktree|lane|tracker|splice|\bRED\b|\bGREEN\b/i.test(line)) return false;
    return true;
  };
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
