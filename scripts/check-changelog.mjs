// scripts/check-changelog.mjs — release-identity gate: entries must be unique
// and strictly descending by version after the provenance note.
// Also verifies the latest changelog entry matches package.json version, and
// (CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01) that the most recent versions
// read as user-facing copy — the SAME rules the About renderer ships and the
// unit tests pin (imported from extension/options/changelog-filter.js so the
// three cannot drift).
import { readFile } from "node:fs/promises";
import { isUserFacingEntry } from "../extension/options/changelog-filter.js";

const changelogUrl = new URL("../CHANGELOG.md", import.meta.url);
const pkgUrl = new URL("../package.json", import.meta.url);

const src = await readFile(changelogUrl, "utf8");
const pkg = JSON.parse(await readFile(pkgUrl, "utf8"));

const entries = [...src.matchAll(/^## \[(\d+)\.(\d+)\.(\d+)\]/gm)].map((m) => [ +m[1], +m[2], +m[3] ]);
const strs = entries.map((k) => k.join("."));
const key = (k) => k;
let fail = [];

if (strs.length === 0) {
  fail.push("no version entries found in CHANGELOG.md");
} else if (strs[0] !== pkg.version) {
  fail.push(`latest changelog version ${strs[0]} does not match package.json version ${pkg.version}`);
}

if (new Set(strs).size !== strs.length) {
  const seen = new Set();
  for (const s of strs) { if (seen.has(s)) fail.push(`duplicate release identity ${s}`); seen.add(s); }
}
for (let i = 0; i + 1 < entries.length; i++) {
  const a = key(entries[i]), b = key(entries[i + 1]);
  if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) {
    fail.push(`out of order: ${strs[i]} before ${strs[i + 1]}`);
  }
}
if (fail.length) { console.error("CHANGELOG ORDER/UNIQUENESS FAIL:\n" + fail.join("\n")); process.exit(1); }

// CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01: the most recent versions must
// read as user-facing copy. A bullet that fails isUserFacingEntry (commit
// prefixes, SHAs, internal vocab, workflow status words) fails the gate, so an
// internal note can never ship in the user-visible recent entries.
const blocks = [...src.matchAll(/^## \[([^\]]+)\][^\n]*\n([\s\S]*?)(?=^## |\z)/gm)].slice(0, 10);
const voiceFail = [];
for (const m of blocks) {
  const bullets = m[2].split(/\r?\n/).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  for (const b of bullets) {
    if (!isUserFacingEntry(b)) voiceFail.push(`v${m[1]}: ${b.slice(0, 80)}`);
  }
}
// The broad bans stay in force over the whole recent section (mirror of the
// changelog test): internal task ids and known jargon must not appear anywhere
// since the 0.2.208 boundary.
const recentSection = src.split("## [0.2.208]")[0];
for (const [needle, label] of [
  ["CAP-FB-", "internal task IDs (CAP-FB-...)"],
  ["collision lattice", "'collision lattice' jargon"],
  ["six-import", "'six-import' jargon"],
  ["whole-tuple", "'whole-tuple' jargon"],
]) {
  if (recentSection.includes(needle)) voiceFail.push(`recent section contains ${label}`);
}
if (voiceFail.length) {
  console.error("CHANGELOG RECENT-ENTRIES VOICE FAIL (last ten versions must be user-facing):\n" + voiceFail.join("\n"));
  process.exit(1);
}

// xk2u (2026-09-05): placeholder text is how 93 fake entries shipped — ban it
// across the WHOLE file, not just the recent section. And the modern (0.3.x)
// series must be contiguous: a gap means a version was consumed by a
// bookkeeping bump with no entry (the parallel-lane race).
const PLACEHOLDER_RE = /^-\s*(Maintenance and fixes\.?|Bug fixes and improvements\.?|Various (improvements|updates)\.?|General (updates|improvements)\.?|Stability improvements\.?)\s*$/gim;
const placeholders = [...src.matchAll(PLACEHOLDER_RE)];
if (placeholders.length) {
  console.error(`CHANGELOG PLACEHOLDER FAIL (${placeholders.length} hits): every entry must name what the user gets`);
  process.exit(1);
}
const modern = entries.filter(([maj, min]) => maj === 0 && min === 3).map(([, , p]) => p);
if (modern.length) {
  const gaps = [];
  for (let p = Math.min(...modern); p <= Math.max(...modern); p++) {
    if (!modern.includes(p)) gaps.push(`0.3.${p}`);
  }
  if (gaps.length) {
    console.error(`CHANGELOG CONTIGUITY FAIL: versions consumed without entries: ${gaps.join(", ")}`);
    process.exit(1);
  }
}

console.log(`changelog identities: ${strs.length} entries, unique + descending ✓ (latest: ${strs[0]})`);
