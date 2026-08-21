// scripts/sync-changelog.mjs — the SEPARATE changelog sync gate (the review's
// MEDIUM): canonical CHANGELOG.md → the ignored, generated extension package
// file. Run by bump-version.mjs after every bump, by the production build, and
// by `npm run sync:changelog` / `check:changelog`.
import { copyFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SRC = new URL("../CHANGELOG.md", import.meta.url);
const DST = new URL("../extension/CHANGELOG.md", import.meta.url);

export async function syncChangelog({
  check = false,
  source = SRC,
  destination = DST,
  read = readFile,
  copy = copyFile,
} = {}) {
  const canonical = await read(source);
  const shipped = await read(destination).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const same = shipped !== null && Buffer.compare(canonical, shipped) === 0;
  if (check && !same) {
    throw new Error(
      "DRIFT: extension/CHANGELOG.md differs from CHANGELOG.md — run `npm run sync:changelog`",
    );
  }
  if (!check && !same) {
    await copy(source, destination);
    console.log("synced extension/CHANGELOG.md ← CHANGELOG.md");
  } else {
    console.log(check ? "changelog in sync" : "changelog already in sync");
  }
  return { same, written: !check && !same };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const check = process.argv.includes("--check");
  if (check) {
    // Release-identity gate (review a258814): unique + strictly descending
    // entries in the CANONICAL changelog — part of the normal check, not a
    // separate optional script.
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync(
        "node",
        [new URL("./check-changelog.mjs", import.meta.url).pathname.replace(
          /^\/([A-Za-z]:)/,
          "",
        )],
        { stdio: "pipe" },
      );
    } catch (error) {
      console.error(String(error.stderr ?? error.message));
      process.exit(1);
    }
  }
  await syncChangelog({ check });
}
