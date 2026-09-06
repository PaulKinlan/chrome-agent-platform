// tests/beads-precommit-hook.test.ts — the beads pre-commit hook exports the
// tracker into, and stages it from, the checkout being committed
// (chrome-agent-platform-ufrr).
//
// Git runs a hook with the working directory already at the root of the
// worktree being committed, but hooks live only in the common .git/hooks — so
// from a linked worktree $0 is the PRIMARY checkout's hook file. The old hook
// did `cd "$(dirname "$0")/../.."`, landed in the primary, wrote the fresh
// export there (dirtying the shared checkout for every session) and, with
// GIT_INDEX_FILE still bound to the worktree, staged the primary's on-disk
// file into the worktree's index while the worktree's own copy stayed stale.
// 83 of 351 registered worktrees carried that stale copy when this was fixed.
// It also ran `bd export > .beads/issues.jsonl`, which truncates the file
// before bd starts, so a failing bd would have staged an EMPTY export.
//
// Every case builds a scratch primary + linked worktree, installs the TRACKED
// reference hook (scripts/git-hooks/pre-commit) into the primary's hooks dir,
// puts a fake `bd` first on PATH that records its working directory and emits
// a known export, and commits. The harness-honesty case runs the pre-ufrr hook
// text through the same harness and DEMANDS the defect: a harness that cannot
// see the bug would prove nothing about the fix.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HOOKS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts", "git-hooks");
const BASE = '{"_type":"issue","id":"base-1"}\n';
const FRESH = '{"_type":"issue","id":"fresh-1"}\n{"_type":"issue","id":"fresh-2"}\n';

// The hook installed on this machine before ufrr, byte for byte.
const OLD_HOOK = `#!/bin/sh
# Beads: refresh .beads/issues.jsonl export before each commit (export.auto=true)
(
  cd "$(dirname "$0")/../.." 2>/dev/null
  bd export --quiet --path .beads/issues.jsonl 2>/dev/null || bd export > .beads/issues.jsonl 2>/dev/null
  git add .beads/issues.jsonl 2>/dev/null
) &
wait
`;

// A stand-in bd: records every working directory it is invoked from, rejects
// the --path flag exactly like the real CLI (so the old hook's fallback runs),
// and emits the fresh export — or fails / emits nothing when told to.
const FAKE_BD = `#!/bin/sh
pwd >> "$FAKE_BD_LOG"
for a in "$@"; do [ "$a" = "--path" ] && { echo "Error: unknown flag: --path" >&2; exit 1; }; done
[ "$1" = "export" ] || exit 2
[ -n "$FAKE_BD_FAIL" ] && { echo "database locked (fake)" >&2; exit 1; }
[ -n "$FAKE_BD_EMPTY" ] && exit 0
printf '%s' "$FAKE_BD_OUT"
`;

type Opts = { fail?: boolean; empty?: boolean; commitIn?: "worktree" | "primary" };

async function scenario(hookText: string, opts: Opts = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "cap-ufrr-"));
  try {
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const primary = path.join(root, "primary");
    const wt = path.join(root, "wt");
    const log = path.join(root, "bd-cwd.log");
    await mkdir(home);
    await mkdir(bin);
    await writeFile(path.join(bin, "bd"), FAKE_BD);
    await chmod(path.join(bin, "bd"), 0o755);
    const env: Record<string, string> = {
      PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      FAKE_BD_LOG: log,
      FAKE_BD_OUT: FRESH,
      ...(opts.fail ? { FAKE_BD_FAIL: "1" } : {}),
      ...(opts.empty ? { FAKE_BD_EMPTY: "1" } : {}),
    };
    const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
    const ok = (r: ReturnType<typeof git>, what: string) => {
      assertEquals(r.status, 0, `${what}: ${r.stderr}`);
      return r.stdout;
    };
    ok(git(root, "init", "-q", "-b", "main", primary), "init");
    await mkdir(path.join(primary, ".beads"));
    await writeFile(path.join(primary, ".beads", "issues.jsonl"), BASE);
    await writeFile(path.join(primary, "README"), "x\n");
    ok(git(primary, "add", "-A"), "add");
    ok(git(primary, "commit", "-q", "-m", "init"), "init commit");
    // Hooks live ONLY here — the linked worktree has no hooks dir of its own.
    const hookPath = path.join(primary, ".git", "hooks", "pre-commit");
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeFile(hookPath, hookText);
    await chmod(hookPath, 0o755);
    ok(git(primary, "worktree", "add", "-q", "-b", "lane", wt), "worktree add");

    const where = opts.commitIn === "primary" ? primary : wt;
    await writeFile(path.join(where, "change.txt"), "change\n");
    ok(git(where, "add", "change.txt"), "stage the change");
    const commit = git(where, "commit", "-q", "-m", "a change");

    const read = async (p: string) => {
      try { return await readFile(p, "utf8"); } catch { return null; }
    };
    const head = (cwd: string) => {
      const r = git(cwd, "show", "HEAD:.beads/issues.jsonl");
      return r.status === 0 ? r.stdout : null;
    };
    return {
      commit,
      bdCwd: ((await read(log)) ?? "").split("\n").filter(Boolean),
      primaryDisk: await read(path.join(primary, ".beads", "issues.jsonl")),
      primaryHead: head(primary),
      primaryStatus: ok(git(primary, "status", "--porcelain"), "primary status").trim(),
      worktreeDisk: await read(path.join(wt, ".beads", "issues.jsonl")),
      worktreeHead: head(wt),
      worktreeStatus: ok(git(wt, "status", "--porcelain"), "worktree status").trim(),
      litter: (await readdir(path.join(where, ".beads"))).filter((n) => n !== "issues.jsonl"),
      paths: { primary: await realpath(primary), wt: await realpath(wt) },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const referenceHook = () => readFile(path.join(HOOKS_DIR, "pre-commit"), "utf8");

Deno.test("ufrr: a commit from a LINKED WORKTREE exports in that worktree, stages it there, and leaves the primary checkout untouched", async () => {
  const s = await scenario(await referenceHook());
  assertEquals(s.commit.status, 0, s.commit.stderr);
  assertEquals(s.bdCwd, [s.paths.wt], "bd ran exactly once, from the worktree being committed");
  assertEquals(s.worktreeHead, FRESH, "the worktree's commit carries the fresh export");
  assertEquals(s.worktreeDisk, FRESH, "the worktree's on-disk export is the one it committed");
  assertEquals(s.worktreeStatus, "", "the worktree is clean after the commit");
  assertEquals(s.primaryDisk, BASE, "the primary's on-disk export is untouched");
  assertEquals(s.primaryStatus, "", "the shared primary checkout stays clean");
  assertEquals(s.primaryHead, BASE, "the primary's history is untouched");
  assertEquals(s.litter, [], "no temp files left in .beads/");
});

Deno.test("ufrr: a commit from the PRIMARY itself still refreshes and stages the export", async () => {
  const s = await scenario(await referenceHook(), { commitIn: "primary" });
  assertEquals(s.commit.status, 0, s.commit.stderr);
  assertEquals(s.bdCwd, [s.paths.primary]);
  assertEquals(s.primaryHead, FRESH);
  assertEquals(s.primaryDisk, FRESH);
  assertEquals(s.primaryStatus, "");
  assertEquals(s.litter, []);
});

Deno.test("ufrr: a failing or empty bd export never truncates the committed export — the commit proceeds, the hook says so, nothing is left behind", async () => {
  for (const opts of [{ fail: true }, { empty: true }] as Opts[]) {
    const s = await scenario(await referenceHook(), opts);
    const which = JSON.stringify(opts);
    assertEquals(s.commit.status, 0, `${which}: the commit still lands: ${s.commit.stderr}`);
    assertEquals(s.worktreeDisk, BASE, `${which}: on-disk export left as committed (not truncated)`);
    assertEquals(s.worktreeHead, BASE, `${which}: the commit carries the previous export, never an empty one`);
    assertEquals(s.worktreeStatus, "", `${which}: clean afterwards`);
    assertEquals(s.primaryStatus, "", `${which}: primary untouched`);
    assertEquals(s.litter, [], `${which}: no temp files left in .beads/`);
    assert(/\[pre-commit\] bd export failed or empty/.test(s.commit.stderr), `${which}: the hook says what it skipped: ${s.commit.stderr}`);
    if (opts.fail) assert(/database locked \(fake\)/.test(s.commit.stderr), `${which}: bd's own error is relayed: ${s.commit.stderr}`);
  }
});

Deno.test("ufrr harness honesty: the pre-ufrr hook text reproduces the defect here — bd runs in the PRIMARY, the primary is dirtied, the worktree commits a fresh export it does not have on disk", async () => {
  const s = await scenario(OLD_HOOK);
  assertEquals(s.commit.status, 0, s.commit.stderr);
  assert(s.bdCwd.length > 0 && s.bdCwd.every((d) => d === s.paths.primary), `bd ran from the primary: ${JSON.stringify(s.bdCwd)}`);
  assertEquals(s.primaryDisk, FRESH, "the shared primary checkout got the export written into it");
  assertEquals(s.primaryStatus, "M .beads/issues.jsonl", "…and shows as modified there");
  assertEquals(s.worktreeHead, FRESH, "the worktree's commit carries the primary's on-disk file");
  assertEquals(s.worktreeDisk, BASE, "…while the worktree's own copy was never refreshed");
  assertEquals(s.worktreeStatus, "M .beads/issues.jsonl", "…so the worktree reads as modified after its own commit");
});

Deno.test("ufrr: no reference hook resolves the repository from $0 (the pattern that reached the primary), and every hook is executable in the index", async () => {
  const names = (await readdir(HOOKS_DIR)).sort();
  assert(names.includes("pre-commit") && names.includes("post-commit"), `reference hooks present: ${names}`);
  for (const name of names) {
    const text = await readFile(path.join(HOOKS_DIR, name), "utf8");
    // Code lines only: the fixed hook's comment quotes the old pattern to explain it.
    const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    assert(!/\$0\b/.test(code), `${name}: must not locate the repo via $0 — git already runs hooks at the committing checkout's root`);
    assert(/^#!\/bin\/sh/.test(text), `${name}: sh shebang`);
  }
  const ls = spawnSync("git", ["ls-files", "-s", "--", "scripts/git-hooks"], { cwd: path.join(HOOKS_DIR, "..", ".."), encoding: "utf8" });
  assertEquals(ls.status, 0, ls.stderr);
  const modes = ls.stdout.trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0]);
  assertEquals(modes.length, names.length, `every reference hook is tracked: ${ls.stdout}`);
  assert(modes.every((m) => m === "100755"), `every reference hook is executable in the index: ${ls.stdout}`);
});
