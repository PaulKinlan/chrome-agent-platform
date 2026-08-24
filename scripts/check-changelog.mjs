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
console.log(`changelog identities: ${strs.length} entries, unique + descending ✓ (latest: ${strs[0]})`);
