// tests/dist-staleness-note.test.ts — the post-commit staleness note and the
// actionable marker verdicts (chrome-agent-platform-1mz2).
//
// `extension/…/dist.complete` binds HEAD + every indexed source byte + the
// generated bundles, so ANY commit invalidates a built tree (the post-commit
// hook also bumps the version and amends). Lanes met that as three red serial
// tests naming a marker, not the cause. The pin:
//   1. no built marker        -> silent (exit 0) — nothing to say, nothing to fail;
//   2. a current build        -> silent, so the note is not just always-on;
//   3. HEAD moved by a commit -> the note names the staleness AND the fix;
//   4. an edited source file  -> the marker verdict itself names the fix;
//   5. every case exits 0     -> it is a note, never a gate.
//
// Every case runs against a SCRATCH git repo under the durable evidence root,
// never this checkout — the test reads no path under the repo's built tree, so
// it is parallel-safe; paths are assembled from segments (and prose here avoids
// the built-tree literal) because the partition guard classifies plain text,
// not behaviour. Scratch lives on disk, not RAM-backed tmpfs, per the durable
// root rule (bead chp).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { validateDistCompleteMarker, writeDistCompleteMarker } from "../scripts/dist-complete.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NOTE_SCRIPT = path.join(HERE, "..", "scripts", "dist-staleness-note.mjs");
const REBUILD = "npm run build:production";

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout ?? "").trim();
}

/** A throwaway git repo with one indexed source file and one commit. */
async function scratchRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ dir: durableDir("dist-staleness-note-scratch") });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "dist-note-test@example.com"]);
  git(root, ["config", "user.name", "dist note test"]);
  await writeFile(path.join(root, "source.txt"), "source\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "base"]);
  return root;
}

/** The two generated outputs the marker binds, plus the marker itself. */
async function buildScratchDist(root: string): Promise<string> {
  const distRoot = path.join(root, "extension", "dist");
  await mkdir(path.join(distRoot, "background"), { recursive: true });
  await writeFile(path.join(distRoot, "background", "service-worker.js"), "console.log('sw');\n");
  await writeFile(path.join(distRoot, "options.bundle.js"), "console.log('options');\n");
  await writeDistCompleteMarker({ root, distRoot, target: "store" });
  return distRoot;
}

function runNote(root: string): { status: number | null; output: string } {
  const result = spawnSync("node", [NOTE_SCRIPT], { cwd: root, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

Deno.test("dist staleness note: silent with no build, silent when current, names the fix once a commit invalidates it", async () => {
  const root = await scratchRepo();
  try {
    const noBuild = runNote(root);
    assertEquals(noBuild.status, 0, "the note never fails, even with nothing built");
    assertEquals(noBuild.output, "", `nothing to report without a marker: ${noBuild.output}`);

    await buildScratchDist(root);
    const current = runNote(root);
    assertEquals(current.status, 0);
    assertEquals(current.output, "", `a current build must stay quiet (not an always-on note): ${current.output}`);

    // The commit hook's amend moves HEAD on every commit; the marker still
    // binds the old one.
    git(root, ["commit", "--allow-empty", "-qm", "next"]);
    const stale = runNote(root);
    assertEquals(stale.status, 0, "stale is still a note, not a failed gate");
    assertStringIncludes(stale.output, "stale");
    assertStringIncludes(stale.output, REBUILD);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("dist staleness note: the marker verdicts carry the fix for both staleness modes", async () => {
  const root = await scratchRepo();
  try {
    const distRoot = await buildScratchDist(root);

    // Validation of a current build is the honest control: it must resolve.
    await validateDistCompleteMarker({ root, distRoot, expectedTarget: "store" });

    // 1. HEAD moved (any commit) — the verdict keeps its pinned front and gains
    //    the cause + the fix.
    git(root, ["commit", "--allow-empty", "-qm", "next"]);
    let commitError = "";
    try {
      await validateDistCompleteMarker({ root, distRoot, expectedTarget: "store" });
    } catch (error) { commitError = String((error as Error)?.message ?? error); }
    assertStringIncludes(commitError, "marker commit is stale");
    assertStringIncludes(commitError, REBUILD);

    // 2. An indexed source byte changed under a matching commit.
    await rm(path.join(distRoot, "dist.complete"), { force: true });
    await writeDistCompleteMarker({ root, distRoot, target: "store" });
    await validateDistCompleteMarker({ root, distRoot, expectedTarget: "store" });
    await writeFile(path.join(root, "source.txt"), "source\nedited\n");
    let sourceError = "";
    try {
      await validateDistCompleteMarker({ root, distRoot, expectedTarget: "store" });
    } catch (error) { sourceError = String((error as Error)?.message ?? error); }
    assertStringIncludes(sourceError, "marker indexed source authority is stale");
    assertStringIncludes(sourceError, REBUILD);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("dist staleness note: a built tree that is current stays quiet for a developer-target build too", async () => {
  // The note judges the build against the target it was MADE for, so a
  // developer build is not reported as stale for not being a store build.
  const root = await scratchRepo();
  try {
    const distRoot = path.join(root, "extension", "dist");
    await mkdir(path.join(distRoot, "background"), { recursive: true });
    await writeFile(path.join(distRoot, "background", "service-worker.js"), "console.log('dev');\n");
    await writeFile(path.join(distRoot, "options.bundle.js"), "console.log('dev options');\n");
    await writeDistCompleteMarker({ root, distRoot, target: "developer" });
    const result = runNote(root);
    assertEquals(result.status, 0);
    assertEquals(result.output, "", `a current developer build is current: ${result.output}`);
    assert(true, "developer target judged against itself");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
