// scripts/sync-changelog.mjs — the SEPARATE changelog sync gate (the review's
// MEDIUM): canonical CHANGELOG.md → the bundled extension/CHANGELOG.md. Run by
// bump-version.mjs after every bump, by `npm run sync:changelog` /
// `check:changelog`, and checked independently of the gallery.
import { readFile, copyFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SRC = new URL("../CHANGELOG.md", import.meta.url);
const DST = new URL("../extension/CHANGELOG.md", import.meta.url);

export async function syncChangelog({ check = false } = {}) {
  const [a, b] = await Promise.all([readFile(SRC), readFile(DST)]);
  const same = Buffer.compare(a, b) === 0;
  if (check && !same) {
    console.error("DRIFT: extension/CHANGELOG.md differs from CHANGELOG.md — run `npm run sync:changelog`");
    process.exit(1);
  }
  if (!check && !same) {
    await copyFile(SRC, DST);
    console.log("synced extension/CHANGELOG.md ← CHANGELOG.md");
  } else {
    console.log(check ? "changelog in sync" : "changelog already in sync");
  }
}

const check = process.argv.includes("--check");
if (check) {
  // Release-identity gate (review a258814): unique + strictly descending
  // entries in the CANONICAL changelog — part of the normal check, not a
  // separate optional script.
  const { execFileSync } = await import("node:child_process");
  try { execFileSync("node", [new URL("./check-changelog.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, ""), ""], { stdio: "pipe" }); }
  catch (e) { console.error(String(e.stderr ?? e.message)); process.exit(1); }
}
await syncChangelog({ check });
