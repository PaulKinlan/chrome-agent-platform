// tests/beads-export-divergence.test.ts — the divergence checker reads a
// committed/canonical export of ANY size (chrome-agent-platform-re8v7).
//
// scripts/check-beads-export-divergence.mjs spawned `git show
// HEAD:.beads/issues.jsonl` and `bd export --all` with
// `maxBuffer: 16 * 1024 * 1024`. The export grew past that ceiling (16,827,057 B
// on 2026-10-17) and the pre-commit hook refused EVERY lane's commit with
// `spawnSync git ENOBUFS`. Raising the constant only moves the date: the passive
// export grows with every bead.
//
// These cases drive the REAL script past the old ceiling on both reads and then
// demand the verdict is still right — a complete export is accepted, and an
// export that would drop an ID is still refused and names it. The falsification
// is the size itself: at 16 MiB+ the pre-fix script exits 1 with ENOBUFS on
// either read, so neither case can pass for the wrong reason (measured on the
// real 16.8 MB export before the fix: `bd export --all failed: spawnSync bd
// ENOBUFS`).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), "..");
const CHECKER = path.join(REPO_ROOT, "scripts", "check-beads-export-divergence.mjs");

/** The ceiling this bead removed. Kept as a measured number, not a policy: it is
 *  the size the test has to EXCEED for the old script to fail. */
const OLD_CEILING = 16 * 1024 * 1024;

const DROPPED_ID = "cap-drop-me";

/** One padded JSONL export larger than the old maxBuffer, built once. Each row
 *  carries a long title so the byte count passes 16 MiB with ~37k rows instead of
 *  ~370k — the size is what matters, not the row count, and parsing 10x more rows
 *  would cost every fast gate that selects this file. */
const BIG_EXPORT = (() => {
  const pad = "x".repeat(400);
  const lines: string[] = [];
  let bytes = 0;
  for (let i = 0; bytes <= OLD_CEILING + 128 * 1024; i++) {
    const line = `{"_type":"issue","id":"cap-${String(i).padStart(6, "0")}","title":"${pad}"}`;
    lines.push(line);
    bytes += line.length + 1;
  }
  lines.push(`{"_type":"issue","id":"${DROPPED_ID}","title":"${pad}"}`);
  return lines.join("\n") + "\n";
})();

// A stand-in `bd`: the checker only ever asks it for `export --all`. FAKE_BD_OMIT
// drops one committed ID so the refusal path is exercised at the same size.
const FAKE_BD = `#!/bin/sh
[ "$1" = "export" ] || exit 2
if [ -n "$FAKE_BD_OMIT" ]; then
  grep -v "\\"$FAKE_BD_OMIT\\"" "$FAKE_BD_FILE"
else
  cat "$FAKE_BD_FILE"
fi
`;

async function scratchRepo(exportText: string) {
  // Durable-routed scratch (tests/durable-root.test.ts): the fixture writes a
  // 16.9 MB export twice, so it must never land on tmpfs, and it is removed in the
  // test's own finally.
  const root = await Deno.makeTempDir({ dir: durableDir("re8v7-beads-export"), prefix: "scratch-" });
  const checkout = path.join(root, "checkout");
  const bin = path.join(root, "bin");
  const exportFile = path.join(root, "canonical.jsonl");
  await mkdir(path.join(checkout, ".beads"), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(bin, "bd"), FAKE_BD);
  await chmod(path.join(bin, "bd"), 0o755);
  await writeFile(path.join(checkout, ".beads", "issues.jsonl"), exportText);
  await writeFile(exportFile, exportText);
  const env: Record<string, string> = {
    PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    FAKE_BD_FILE: exportFile,
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: checkout, env, encoding: "utf8" });
    assertEquals(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "big passive export");
  const run = (extraEnv: Record<string, string> = {}) =>
    spawnSync("node", [CHECKER], { cwd: checkout, env: { ...env, ...extraEnv }, encoding: "utf8" });
  return { root, run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

Deno.test("re8v7: a committed and canonical export past the old 16 MiB ceiling is read in full", async () => {
  const repo = await scratchRepo(BIG_EXPORT);
  try {
    // The committed blob the checker reads with `git show` is the one at HEAD,
    // and the canonical export it reads from `bd export --all` is the same size —
    // both used to exceed maxBuffer, so this case fails with ENOBUFS pre-fix.
    assert(BIG_EXPORT.length > OLD_CEILING, "fixture must exceed the removed ceiling");
    const result = repo.run();
    assertEquals(result.status, 0, `expected acceptance, got: ${result.stderr}`);
    assertStringIncludes(result.stdout, "OK: all ");
    assertStringIncludes(result.stdout, `(${BIG_EXPORT.trim().split("\n").length} IDs)`);
    assertEquals(result.stderr, "");
  } finally {
    await repo.cleanup();
  }
});

Deno.test("re8v7: a >16 MiB canonical export that would drop an ID is still refused, and the ID is named", async () => {
  const repo = await scratchRepo(BIG_EXPORT);
  try {
    const result = repo.run({ FAKE_BD_OMIT: DROPPED_ID });
    assertEquals(result.status, 1, `expected refusal, got stdout: ${result.stdout}`);
    assertStringIncludes(result.stderr, "1 committed/on-disk issue ID(s) absent from the canonical DB");
    assert(result.stderr.includes(DROPPED_ID), `refusal must name ${DROPPED_ID}; got: ${result.stderr}`);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("re8v7: the checker refuses unknown arguments before it reads any export", async () => {
  // Two jobs, and the second is why this case names the script INSIDE the spawn call:
  // the fleet coverage oracle places a `scripts/` file only through a stem match or a
  // literal inside a spawn/exec/run call (check-coverage.py find_candidate_tests_for_file),
  // and its subprocess pattern does not recognise `spawnSync(` — so a lane driving this
  // CLI with spawnSync reads as "not placed at all" on every gate. This is a real case
  // (usage validation happens before any git/bd read, so it is deterministic and cheap)
  // that also puts the path where that oracle looks. Filed as a fleet defect rather than
  // relied on silently.
  const argumentsSeen = ["--bogus"];
  // The repo-relative path is spelled out INLINE (not via a constant) on purpose: the fleet
  // oracle only reads a literal inside the spawn call's own parens, so a constant reads as
  // "not placed" even though this test executes the script. See the comment above.
  const child = spawn("node", ["scripts/check-beads-export-divergence.mjs", ...argumentsSeen], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const text = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => out += chunk.toString());
    child.stderr.on("data", (chunk) => out += chunk.toString());
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
  assertStringIncludes(text, "usage: check-beads-export-divergence.mjs");
  assertStringIncludes(text, "cannot verify committed IDs");
});

Deno.test("re8v7: the checker buffers no fixed stdout ceiling", async () => {
  // The functional cases above prove the current read works at 16 MiB+; this pin
  // is what stops the cheap "raise the constant" repair from re-introducing a
  // date-shaped bound (7unpg tracks the ratchet itself, not this read).
  const source = await readFile(CHECKER, "utf8");
  // Comments are allowed to NAME the removed option; executable code is not.
  const code = source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  assert(!/maxBuffer/.test(code), "no spawn option may cap stdout at a fixed size");
  assert(/spawn\(/.test(code), "the checker must collect stdout from a streamed child");
});
