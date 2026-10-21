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
import { parse as parseJs } from "npm:acorn";
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
  const { code, text } = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => out += chunk.toString());
    child.stderr.on("data", (chunk) => out += chunk.toString());
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, text: out }));
  });
  assertEquals(code, 1, "checker must exit with code 1 on unknown arguments");
  assertStringIncludes(text, "usage: check-beads-export-divergence.mjs");
  assertStringIncludes(text, "cannot verify committed IDs");
  assert(!text.includes("export failed"), "must refuse usage before attempting git or bd export read");
});

function stripComments(source: string): string {
  // Strip block comments /* ... */
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments // to end of line
  return withoutBlock.replace(/\/\/.*$/gm, "");
}

Deno.test("re8v7: the checker buffers no fixed stdout ceiling", async () => {
  // The functional cases above prove the current read works at 16 MiB+; this pin
  // is what stops the cheap "raise the constant" repair from re-introducing a
  // date-shaped bound (7unpg tracks the ratchet itself, not this read).
  const source = await readFile(CHECKER, "utf8");
  // Comments (line, block, trailing) are allowed to NAME the removed option; executable code is not.
  const code = stripComments(source);
  assert(!/maxBuffer/.test(code), "no spawn option may cap stdout at a fixed size");
  assert(/spawn\(/.test(code), "the checker must collect stdout from a streamed child");
});

Deno.test("o3i89 / nabuw / moomc: buffer capacity constants are bounded finite numbers >= 1MiB and within design ceilings", async () => {
  const { MAX_GIT_BUFFER_BYTES: gitLandingCap } = await import("../scripts/beads-landing-link.mjs");
  const { MAX_GIT_BUFFER_BYTES: gitOwedCap } = await import("../scripts/check-owed-changelog.mjs");
  const { MAX_ARCHIVE_BUFFER_BYTES: archiveCap } = await import("../scripts/package-archive.mjs");
  const { PS_MAX_BUFFER_BYTES: psCap, FLOCK_MAX_BUFFER_BYTES: flockCap } = await import("../scripts/security-suite-custody.mjs");

  for (const [name, cap, maxExpected] of [
    ["beads-landing-link MAX_GIT_BUFFER_BYTES", gitLandingCap, 256 * 1024 * 1024],
    ["check-owed-changelog MAX_GIT_BUFFER_BYTES", gitOwedCap, 256 * 1024 * 1024],
    ["package-archive MAX_ARCHIVE_BUFFER_BYTES", archiveCap, 128 * 1024 * 1024],
    ["security-suite-custody PS_MAX_BUFFER_BYTES", psCap, 32 * 1024 * 1024],
    ["security-suite-custody FLOCK_MAX_BUFFER_BYTES", flockCap, 1024 * 1024],
  ] as const) {
    assert(typeof cap === "number", `${name} must be a number`);
    assert(Number.isFinite(cap), `${name} must be finite (not Infinity)`);
    assert(cap >= 1024 * 1024, `${name} must be at least 1MiB`);
    assert(cap <= maxExpected, `${name} (${cap}) must not exceed design ceiling of ${maxExpected} bytes`);
  }
});

Deno.test("nabuw / o3i89: buffer overflow triggers reachable capacity errors with clear diagnostics", async () => {
  const { execGit: execGitLanding } = await import("../scripts/beads-landing-link.mjs");
  const { execGit: execGitOwed } = await import("../scripts/check-owed-changelog.mjs");
  const { makePsRun, readProcIdentity, probeCanonicalLockHeld } = await import("../scripts/security-suite-custody.mjs");

  // 1. beads-landing-link execGit
  try {
    execGitLanding(process.cwd(), ["status"], { maxBuffer: 1 });
    assert(false, "execGitLanding should have thrown on buffer overflow");
  } catch (err: any) {
    assert(err.message.includes("exceeded buffer capacity"), `Expected capacity error, got: ${err.message}`);
  }

  // 2. check-owed-changelog execGit
  try {
    execGitOwed(process.cwd(), ["status"], { maxBuffer: 1 });
    assert(false, "execGitOwed should have thrown on buffer overflow");
  } catch (err: any) {
    assert(err.message.includes("exceeded buffer capacity"), `Expected capacity error, got: ${err.message}`);
  }

  // 3. security-suite-custody makePsRun / readProcIdentity
  const tinyPsRun = makePsRun(5000, 1);
  try {
    await readProcIdentity(process.pid, { hasProc: false, run: tinyPsRun });
    assert(false, "readProcIdentity should have thrown ProcessUnreadableError on buffer overflow");
  } catch (err: any) {
    assert(err.message.includes("exceeded buffer capacity"), `Expected capacity error, got: ${err.message}`);
  }

  // 4. security-suite-custody probeCanonicalLockHeld
  const enobufsFlock = async () => {
    const error = new Error("buffer overflow") as any;
    error.code = "ENOBUFS";
    throw error;
  };
  const lockVerdict = await probeCanonicalLockHeld("/dev/null", enobufsFlock);
  assert(lockVerdict?.includes("exceeded buffer capacity"), `Expected capacity error verdict, got: ${lockVerdict}`);

  // 5. package-archive trackedExtensionIndex
  const { trackedExtensionIndex, verifyPackageArchive } = await import("../scripts/package-archive.mjs");
  try {
    trackedExtensionIndex(process.cwd(), { maxBuffer: 1 });
    assert(false, "trackedExtensionIndex should have thrown on buffer overflow");
  } catch (err: any) {
    assert(err.message.includes("exceeded buffer capacity"), `Expected capacity error, got: ${err.message}`);
  }

  // 6. package-archive verifyPackageArchive (unzip -Z1 capacity guard)
  const scratch = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-beads-divergence-" });
  const tmpZip = `${scratch}/test.zip`;
  try {
    const zipCmd = new Deno.Command("zip", { args: ["-q", tmpZip, "package.json"] });
    const { code } = await zipCmd.output();
    assert(code === 0, "zip creation failed");
    try {
      await verifyPackageArchive(
        { archive: tmpZip, expected: [], scratchParent: scratch },
        { maxBuffer: 1 },
      );
      assert(false, "verifyPackageArchive should have thrown on buffer overflow");
    } catch (err: any) {
      assert(err.message.includes("exceeded buffer capacity"), `Expected capacity error, got: ${err.message}`);
    }
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }

  // 7. package-archive source code does not use unbounded maxBuffer (05x0v, o3vrq, wh98h, stvca, 8gnu0, moomc).
  // Uses AST parsing so comments, string literals, quoted keys, default parameters, and constant bounds are strictly evaluated.
  const packageArchiveSrc = await Deno.readTextFile(new URL("../scripts/package-archive.mjs", import.meta.url));
  const ast = parseJs(packageArchiveSrc, { ecmaVersion: "latest", sourceType: "module" });
  function evalStaticNumeric(node: any): number {
    if (!node) return NaN;
    if (node.type === "Literal" && typeof node.value === "number") return node.value;
    if (node.type === "UnaryExpression" && node.operator === "-" && node.argument) {
      return -evalStaticNumeric(node.argument);
    }
    if (node.type === "BinaryExpression") {
      const left = evalStaticNumeric(node.left);
      const right = evalStaticNumeric(node.right);
      if (node.operator === "*") return left * right;
      if (node.operator === "+") return left + right;
      if (node.operator === "-") return left - right;
      if (node.operator === "/") return left / right;
      if (node.operator === "**") return left ** right;
    }
    return NaN;
  }
  let foundArchiveBufferConstant = false;
  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator" && node.id?.name === "MAX_ARCHIVE_BUFFER_BYTES") {
      foundArchiveBufferConstant = true;
      const declaredBytes = evalStaticNumeric(node.init);
      assert(
        Number.isFinite(declaredBytes) && declaredBytes >= 1024 * 1024 && declaredBytes <= 128 * 1024 * 1024,
        `scripts/package-archive.mjs MAX_ARCHIVE_BUFFER_BYTES declaration must be statically bounded between 1MiB and 128MiB, got ${declaredBytes}`,
      );
    }
    if (node.type === "AssignmentExpression") {
      const targetName = node.left.type === "Identifier" ? node.left.name : null;
      assert(
        targetName !== "maxBuffer" && targetName !== "MAX_ARCHIVE_BUFFER_BYTES",
        `scripts/package-archive.mjs must not reassign ${targetName} via AssignmentExpression`,
      );
    }
    if (node.type === "Property") {
      const keyName = node.key.type === "Identifier" ? node.key.name : node.key.value;
      if (keyName === "maxBuffer") {
        if (node.value.type === "Identifier") {
          assert(
            ["maxBuffer", "MAX_ARCHIVE_BUFFER_BYTES"].includes(node.value.name),
            `scripts/package-archive.mjs Property maxBuffer must bind to maxBuffer or MAX_ARCHIVE_BUFFER_BYTES, got identifier ${node.value.name}`,
          );
        } else if (node.value.type === "AssignmentPattern") {
          assert(
            node.value.right.type === "Identifier" && node.value.right.name === "MAX_ARCHIVE_BUFFER_BYTES",
            "scripts/package-archive.mjs Property maxBuffer default must bind to MAX_ARCHIVE_BUFFER_BYTES",
          );
        } else {
          assert(
            false,
            `scripts/package-archive.mjs Property maxBuffer must bind to maxBuffer or MAX_ARCHIVE_BUFFER_BYTES, got ${node.value.type}`,
          );
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (Array.isArray(node[key])) {
        for (const child of node[key]) walk(child);
      } else if (node[key] && typeof node[key] === "object") {
        walk(node[key]);
      }
    }
  }
  walk(ast);
  assert(foundArchiveBufferConstant, "scripts/package-archive.mjs must declare MAX_ARCHIVE_BUFFER_BYTES");
});

