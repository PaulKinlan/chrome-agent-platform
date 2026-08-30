// scripts/check-changelog.mjs — release-identity gate: entries must be unique
// and strictly descending by version after the provenance note.
// Also verifies the latest changelog entry matches package.json version.
import { readFile } from "node:fs/promises";

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
// read as user-facing copy (mirror of options.js isUserFacingEntry + the
// changelog test). A bullet that looks like an engineering log line fails the
// gate, so an internal note can never ship in the user-visible recent entries.
const isUserFacingEntry = (text) => {
  const line = String(text).trim();
  if (/^(merge|chore|fix\(|test|ci|docs):/i.test(line)) return false;
  if (/\b[0-9a-f]{7,40}\b/i.test(line)) return false;
  if (/journey|KAT|assertion|CDP|harness|worktree|lane|tracker|splice|\bRED\b|\bGREEN\b/i.test(line)) return false;
  return true;
};
const blocks = [...src.matchAll(/^## \[([^\]]+)\][^\n]*\n([\s\S]*?)(?=^## |\z)/gm)].slice(0, 10);
const voiceFail = [];
for (const m of blocks) {
  const bullets = m[2].split(/\r?\n/).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  for (const b of bullets) {
    if (!isUserFacingEntry(b)) voiceFail.push(`v${m[1]}: ${b.slice(0, 80)}`);
  }
}
if (voiceFail.length) {
  console.error("CHANGELOG RECENT-ENTRIES VOICE FAIL (last ten versions must be user-facing):\n" + voiceFail.join("\n"));
  process.exit(1);
}

console.log(`changelog identities: ${strs.length} entries, unique + descending ✓ (latest: ${strs[0]})`);
