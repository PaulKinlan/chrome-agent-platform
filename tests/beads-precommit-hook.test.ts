// tests/beads-precommit-hook.test.ts — the beads pre-commit hook guards the
// tracker export (.beads/issues.jsonl) but NEVER regenerates or stages it
// (chrome-agent-platform-xcffx, the tracker-export contract, coord 2026-11-12).
//
// The contract: a lane commit carries ONLY what its author staged. The old hook
// force-staged a fresh `bd export` into every ordinary commit, so every commit
// carried tracker churn nobody authored (three review rounds spent on a file the
// author did not intend to change; 6i9df FAILed review on that churn alone), and
// a rebase conflicted on the baked-in diff at patch-apply. The export is now
// refreshed once per landing by the merger (chrome-agent-platform-jztvo).
//
// What the hook still does, in every mode: refuses a conflict-marked export (on
// disk or staged — iaccg/g1a09), passes a REPLAY through untouched, and validates
// a DELIBERATELY STAGED export change against the vf69 divergence guard (the
// staged candidate must not silently drop a committed/on-disk issue ID).
//
// Every case builds a scratch primary + linked worktree, installs the TRACKED
// reference hook (scripts/git-hooks/pre-commit) into the primary's hooks dir,
// puts a fake `bd` first on PATH that records its invocations (the reference hook
// must never call it), and commits. The harness-honesty case runs the pre-ufrr
// hook text through the same harness and DEMANDS the historical defect: a harness
// that cannot see the bug would prove nothing about the fix.

import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HOOKS_DIR = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), "..", "scripts", "git-hooks");
const BASE = '{"_type":"issue","id":"base-1"}\n';
const FRESH = BASE + '{"_type":"issue","id":"fresh-1"}\n{"_type":"issue","id":"fresh-2"}\n';

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
// and emits the fresh export — or fails / emits nothing when told to. The
// REFERENCE hook must never invoke it at all (xcffx).
const FAKE_BD = `#!/bin/sh
pwd >> "$FAKE_BD_LOG"
for a in "$@"; do [ "$a" = "--path" ] && { echo "Error: unknown flag: --path" >&2; exit 1; }; done
[ "$1" = "export" ] || exit 2
[ -n "$FAKE_BD_FAIL" ] && { echo "database locked (fake)" >&2; exit 1; }
[ -n "$FAKE_BD_EMPTY" ] && exit 0
[ -n "$FAKE_BD_REQUIRE_ALL" ] && [ "$2" != "--all" ] && { echo "export must use --all (fake)" >&2; exit 2; }
printf '%s' "$FAKE_BD_OUT"
`;

type Opts = { fail?: boolean; empty?: boolean; out?: string; checkManual?: boolean; missingGuardScript?: boolean; onDiskExtra?: boolean; diskMissing?: boolean; diskEmpty?: boolean; approved?: string; decision?: string; requireAll?: boolean; commitIn?: "worktree" | "primary"; sequencer?: "rebase-merge" | "rebase-apply" | "MERGE_HEAD" | "CHERRY_PICK_HEAD"; diskMarked?: boolean; indexMarked?: boolean; stagedOut?: string; onlyExport?: boolean };

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
      FAKE_BD_OUT: opts.out ?? FRESH,
      ...(opts.fail ? { FAKE_BD_FAIL: "1" } : {}),
      ...(opts.empty ? { FAKE_BD_EMPTY: "1" } : {}),
      ...(opts.requireAll ? { FAKE_BD_REQUIRE_ALL: "1" } : {}),
      ...(opts.approved ? { CAP_BEADS_EXPORT_APPROVED_REMOVALS: opts.approved } : {}),
      ...(opts.decision ? { CAP_BEADS_EXPORT_DECISION_BEAD: opts.decision } : {}),
    };
    const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
    const ok = (r: ReturnType<typeof git>, what: string) => {
      assertEquals(r.status, 0, `${what}: ${r.stderr}`);
      return r.stdout;
    };
    ok(git(root, "init", "-q", "-b", "main", primary), "init");
    await mkdir(path.join(primary, ".beads"));
    await writeFile(path.join(primary, ".beads", "issues.jsonl"), BASE);
    if (!opts.missingGuardScript) {
      await mkdir(path.join(primary, "scripts"));
      await writeFile(path.join(primary, "scripts", "check-beads-export-divergence.mjs"),
        await readFile(path.join(HOOKS_DIR, "..", "check-beads-export-divergence.mjs")));
    }
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
    if (opts.diskMarked) await writeFile(path.join(where, ".beads", "issues.jsonl"), MARKED);
    if (opts.indexMarked) {
      // g1a09: the INDEX is what a commit carries. Stage a marked export, then regenerate the
      // working-tree copy only — exactly what a rebase resolver does when it follows the hook's
      // "regenerate it" remedy without re-staging.
      await writeFile(path.join(where, ".beads", "issues.jsonl"), MARKED);
      ok(git(where, "add", "-f", ".beads/issues.jsonl"), "stage the marked export");
      await writeFile(path.join(where, ".beads", "issues.jsonl"), BASE);
    }
    if (opts.stagedOut !== undefined) {
      // The author DELIBERATELY stages an export change (xcffx contract: the only
      // way the export rides a commit now).
      await writeFile(path.join(where, ".beads", "issues.jsonl"), opts.stagedOut);
      ok(git(where, "add", ".beads/issues.jsonl"), "stage the export change");
    }
    // Disk-state mutations come AFTER any staged export, so the on-disk copy can
    // differ from the staged one (a disk-only ID beside a staged candidate).
    if (opts.onDiskExtra) await writeFile(path.join(where, ".beads", "issues.jsonl"), BASE + '{"_type":"issue","id":"disk-only"}\n');
    if (opts.diskMissing) await rm(path.join(where, ".beads", "issues.jsonl"));
    if (opts.diskEmpty) await writeFile(path.join(where, ".beads", "issues.jsonl"), "");
    const manualCheck = opts.checkManual
      ? spawnSync("node", [path.join(where, "scripts", "check-beads-export-divergence.mjs")], { cwd: where, env, encoding: "utf8" })
      : null;
    if (!opts.onlyExport) {
      await writeFile(path.join(where, "change.txt"), "change\n");
      ok(git(where, "add", "change.txt"), "stage the change");
    }
    // xcffx: git's sequencer state lives in the committing checkout's OWN git dir
    // (a linked worktree's gitdir, never the primary's), which is exactly where the
    // hook has to look — so the fixture creates it there.
    if (opts.sequencer) {
      const gitDir = ok(git(where, "rev-parse", "--absolute-git-dir"), "git dir").trim();
      await mkdir(path.join(gitDir, opts.sequencer), { recursive: true });
    }
    const commit = git(where, "commit", "-q", "-m", "a change");

    const read = async (p: string) => {
      try { return await readFile(p, "utf8"); } catch { return null; }
    };
    const head = (cwd: string) => {
      const r = git(cwd, "show", "HEAD:.beads/issues.jsonl");
      return r.status === 0 ? r.stdout : null;
    };
    const committedFiles = (cwd: string) =>
      ok(git(cwd, "show", "--pretty=format:", "--name-only", "HEAD"), "committed files").split("\n").filter(Boolean).sort();
    return {
      commit,
      manualCheck,
      bdCwd: ((await read(log)) ?? "").split("\n").filter(Boolean),
      primaryDisk: await read(path.join(primary, ".beads", "issues.jsonl")),
      primaryHead: head(primary),
      primaryStatus: ok(git(primary, "status", "--porcelain"), "primary status").trim(),
      worktreeDisk: await read(path.join(wt, ".beads", "issues.jsonl")),
      worktreeHead: head(wt),
      worktreeFiles: committedFiles(wt),
      worktreeStatus: ok(git(wt, "status", "--porcelain"), "worktree status").trim(),
      litter: (await readdir(path.join(where, ".beads"))).filter((n) => n !== "issues.jsonl"),
      paths: { primary: await realpath(primary), wt: await realpath(wt) },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const referenceHook = () => readFile(path.join(HOOKS_DIR, "pre-commit"), "utf8");

// A conflicted export, in the exact shape git writes it.
const MARKED = `${BASE}<<<<<<< HEAD\n{"_type":"issue","id":"mine-1"}\n=======\n{"_type":"issue","id":"theirs-1"}\n>>>>>>> other\n`;

// ── THE CONTRACT (xcffx, coord 2026-11-12): proved by RUNNING the hook ──────

Deno.test("xcffx: a one-file source commit contains EXACTLY that one file — the hook never runs bd and never stages the export", async () => {
  const s = await scenario(await referenceHook());
  assertEquals(s.commit.status, 0, s.commit.stderr);
  assertEquals(s.worktreeFiles, ["change.txt"], "the commit contains the author's file and NOTHING else");
  assertEquals(s.bdCwd, [], "bd never ran: the export is not this hook's to refresh");
  assertEquals(s.worktreeHead, BASE, "the committed export stays the inherited one");
  assertEquals(s.worktreeDisk, BASE, "the on-disk export is untouched");
  assertEquals(s.worktreeStatus, "", "the worktree is clean after the commit");
  assertEquals(s.primaryDisk, BASE, "the primary's on-disk export is untouched");
  assertEquals(s.primaryStatus, "", "the shared primary checkout stays clean");
  assertEquals(s.primaryHead, BASE, "the primary's history is untouched");
  assertEquals(s.litter, [], "no temp files left in .beads/");
});

Deno.test("xcffx: the contract holds from the PRIMARY too — one staged file, one committed file, bd never invoked", async () => {
  const s = await scenario(await referenceHook(), { commitIn: "primary" });
  assertEquals(s.commit.status, 0, s.commit.stderr);
  assertEquals(s.bdCwd, [], "bd never ran");
  assertEquals(s.primaryHead, BASE, "the committed export stays the inherited one");
  assertEquals(s.primaryDisk, BASE, "the on-disk export is untouched");
  assertEquals(s.primaryStatus, "", "clean afterwards");
  assertEquals(s.litter, []);
});

Deno.test("xcffx: the hook never invokes bd, so a broken or empty bd cannot truncate, erase, or block anything", async () => {
  for (const opts of [{ fail: true }, { empty: true }] as Opts[]) {
    const s = await scenario(await referenceHook(), opts);
    const which = JSON.stringify(opts);
    assertEquals(s.commit.status, 0, `${which}: the commit lands: ${s.commit.stderr}`);
    assertEquals(s.bdCwd, [], `${which}: bd was never invoked`);
    assertEquals(s.worktreeDisk, BASE, `${which}: on-disk export untouched (nothing to truncate)`);
    assertEquals(s.worktreeHead, BASE, `${which}: the commit carries the inherited export, never an empty one`);
    assertEquals(s.worktreeStatus, "", `${which}: clean afterwards`);
    assertEquals(s.primaryStatus, "", `${which}: primary untouched`);
    assertEquals(s.litter, [], `${which}: no temp files left in .beads/`);
  }
});

// ── marker guards (iaccg / g1a09), unchanged in every mode ──────────────────

Deno.test("xcffx: a conflict-marked export STAGED for commit is refused, and the refusal says so", async () => {
  const s = await scenario(await referenceHook(), { stagedOut: MARKED });
  assert(s.commit.status !== 0, "a conflicted export must BLOCK the commit, not ride in it");
  assert(/GIT CONFLICT MARKERS/.test(s.commit.stderr), `name the marker refusal: ${s.commit.stderr}`);
  assertEquals(s.worktreeHead, BASE, "the committed export stays the last good one");
  assertEquals(s.litter, [], "no temp file survives the refusal");
});

Deno.test("xcffx: a conflict marker already on disk is refused BEFORE anything else runs", async () => {
  const s = await scenario(await referenceHook(), { diskMarked: true });
  assert(s.commit.status !== 0, "a conflicted on-disk export must block the commit");
  assert(/on disk/.test(s.commit.stderr), `name where the markers are: ${s.commit.stderr}`);
  assertEquals(s.bdCwd, [], "refused before anything ran — nothing can overwrite the evidence first");
});

Deno.test("g1a09: a conflict-marked export STAGED in the index is refused even when the working tree reads clean", async () => {
  const s = await scenario(await referenceHook(), { indexMarked: true });
  assert(s.commit.status !== 0, "the commit carries the INDEX, so a clean working tree must not bless a marked stage");
  assert(/STAGED copy/.test(s.commit.stderr), `name the index as the offender: ${s.commit.stderr}`);
  assertEquals(s.worktreeHead, BASE, "no marker reached the committed export");
});

Deno.test("g1a09: the replay path checks the index too — a marked stage cannot ride a replayed commit silently", async () => {
  const s = await scenario(await referenceHook(), { indexMarked: true, sequencer: "rebase-merge" });
  assert(
    s.commit.status !== 0,
    "the replay branch exits before any staging, so the index check is the only thing standing between a marked stage and history",
  );
  assert(/STAGED copy/.test(s.commit.stderr), `the refusal names the index, and is not silent: ${s.commit.stderr}`);
  assertEquals(s.worktreeHead, BASE, "no marker reached the committed export");
});

// ── replay pass-through (xcffx part 2, landed) ──────────────────────────────

Deno.test("xcffx: a REPLAYED commit (rebase/merge/cherry-pick in progress) keeps the content it was authored with", async () => {
  const s = await scenario(await referenceHook(), { sequencer: "rebase-merge" });
  assertEquals(s.commit.status, 0, s.commit.stderr);
  assertEquals(s.bdCwd, [], "bd never ran: live tracker state must not be stamped into a replayed commit");
  assertEquals(s.worktreeHead, BASE, "the replayed commit keeps the export it replayed, so it cannot conflict here");
  assertEquals(s.worktreeStatus, "", "the hook staged nothing and left nothing dirty");
  assertEquals(s.primaryHead, BASE, "the primary's history is untouched");
  assertEquals(s.primaryStatus, "", "the shared primary checkout stays clean");
  assertEquals(s.litter, [], "no temp file left behind");
});

// ── deliberately STAGED export changes (the only way the export rides) ──────

Deno.test("xcffx: a deliberately staged export change commits cleanly on its own — validated, no churn note", async () => {
  const s = await scenario(await referenceHook(), { stagedOut: FRESH, onlyExport: true });
  assertEquals(s.commit.status, 0, s.commit.stderr);
  assertEquals(s.worktreeFiles, [".beads/issues.jsonl"], "an export-only commit contains only the export");
  assertEquals(s.worktreeHead, FRESH, "the staged export is the committed one");
  assertEquals(s.worktreeDisk, FRESH, "disk and commit agree");
  assert(!/NOTE: .beads\/issues.jsonl rides/.test(s.commit.stderr), `no mixed-content note for an export-only commit: ${s.commit.stderr}`);
  assertEquals(s.litter, []);
});

Deno.test("xcffx: an export riding alongside authored files commits but is NOTED — the labelled-commit shape is the contract", async () => {
  const s = await scenario(await referenceHook(), { stagedOut: FRESH });
  assertEquals(s.commit.status, 0, s.commit.stderr);
  assertEquals(s.worktreeFiles, [".beads/issues.jsonl", "change.txt"]);
  assert(/NOTE: .beads\/issues.jsonl rides this commit alongside authored files/.test(s.commit.stderr), `the note names the preferred shape: ${s.commit.stderr}`);
  assert(/chore\(beads\): tracker export/.test(s.commit.stderr), `the note names the label: ${s.commit.stderr}`);
});

Deno.test("vf69: a staged export that silently drops a committed issue is refused, naming the ID", async () => {
  const s = await scenario(await referenceHook(), { stagedOut: '{"_type":"issue","id":"other-1"}\n' });
  assert(s.commit.status !== 0, "a missing committed ID must block the staged export");
  assert(/base-1/.test(s.commit.stderr), `name the missing ID for human adjudication: ${s.commit.stderr}`);
  assertEquals(s.worktreeHead, BASE, "the committed export remains intact");
  assertEquals(s.litter, [], "no temp file remains after refusal");
});

Deno.test("vf69: a staged export that silently drops a DISK-ONLY issue is refused too", async () => {
  const s = await scenario(await referenceHook(), { stagedOut: FRESH, onDiskExtra: true });
  assert(s.commit.status !== 0, "the staged candidate must not silently remove a disk-only issue");
  assert(/disk-only/.test(s.commit.stderr), s.commit.stderr);
  assertEquals(s.worktreeHead, BASE);
  assertEquals(s.litter, []);
});

Deno.test("vf69: an UNSTAGED on-disk export is never at risk — the hook does not regenerate it at all", async () => {
  const s = await scenario(await referenceHook(), { onDiskExtra: true });
  assertEquals(s.commit.status, 0, s.commit.stderr);
  assertEquals(s.worktreeFiles, ["change.txt"], "the export does not ride the commit");
  assertEquals(s.worktreeHead, BASE, "the committed export is unchanged");
  assertEquals(s.worktreeDisk, BASE + '{"_type":"issue","id":"disk-only"}\n', "the on-disk export is byte-identical — nothing erased it");
});

Deno.test("vf69: a staged export change commits UNVALIDATED (with a warning) on an older worktree without the checker", async () => {
  const s = await scenario(await referenceHook(), { missingGuardScript: true, stagedOut: FRESH, onlyExport: true });
  assertEquals(s.commit.status, 0, s.commit.stderr);
  assertEquals(s.worktreeHead, FRESH);
  assert(/divergence check unavailable/.test(s.commit.stderr), s.commit.stderr);
  assertEquals(s.litter, []);
});

Deno.test("vf69: only an exact owner-decision allowlist permits a deliberate missing ID in a staged export", async () => {
  const approved = await scenario(await referenceHook(), {
    stagedOut: '{"_type":"issue","id":"other-1"}\n', onlyExport: true, approved: "base-1", decision: "chrome-agent-platform-vf69",
  });
  assertEquals(approved.commit.status, 0, approved.commit.stderr);
  assertEquals(approved.worktreeHead, '{"_type":"issue","id":"other-1"}\n');
  assert(/chrome-agent-platform-vf69/.test(approved.commit.stderr), approved.commit.stderr);
  const noDecision = await scenario(await referenceHook(), { stagedOut: '{"_type":"issue","id":"other-1"}\n', approved: "base-1" });
  assert(noDecision.commit.status !== 0, "an ID without a recorded owner-decision bead cannot override the guard");
  assertEquals(noDecision.worktreeHead, BASE);
  const wrongId = await scenario(await referenceHook(), { stagedOut: '{"_type":"issue","id":"other-1"}\n', approved: "not-base-1", decision: "chrome-agent-platform-vf69" });
  assert(wrongId.commit.status !== 0, "a different ID cannot bypass this missing ID");
  assertEquals(wrongId.worktreeHead, BASE);
});

Deno.test("xcffx: a missing or empty on-disk export is left alone — regenerating it is the landing flow's job, not a lane commit's", async () => {
  for (const opts of [{ diskMissing: true }, { diskEmpty: true }] as Opts[]) {
    const s = await scenario(await referenceHook(), { ...opts, checkManual: true });
    const which = JSON.stringify(opts);
    assertEquals(s.manualCheck?.status, 0, which + ": " + s.manualCheck?.stderr);
    assertEquals(s.commit.status, 0, which + ": " + s.commit.stderr);
    assertEquals(s.worktreeHead, BASE, `${which}: the committed export is unchanged`);
    assertEquals(s.worktreeFiles, ["change.txt"], `${which}: the export does not ride the commit`);
  }
});

// ── the manual divergence check (the landing flow's tool) is unchanged ──────

Deno.test("vf69: manual pre-export check compares committed IDs to canonical DB without writing", async () => {
  const ok = await scenario(await referenceHook(), { checkManual: true });
  assertEquals(ok.manualCheck?.status, 0, ok.manualCheck?.stderr);
  assert(/all 1 committed\/on-disk issue IDs exist/.test(ok.manualCheck?.stdout ?? ""));
  const missing = await scenario(await referenceHook(), { out: '{"_type":"issue","id":"other-1"}\n', checkManual: true });
  assert(missing.manualCheck?.status !== 0, "manual check fails before destructive re-export");
  assert(/base-1/.test(missing.manualCheck?.stderr ?? ""), missing.manualCheck?.stderr);
});

Deno.test("vf69: the manual checker compares with the --all export scope", async () => {
  const s = await scenario(await referenceHook(), { requireAll: true, checkManual: true });
  assertEquals(s.manualCheck?.status, 0, `the manual checker's bd export must use --all: ${s.manualCheck?.stderr}`);
});

// ── harness honesty: the historical defect is still reproducible here ───────

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
