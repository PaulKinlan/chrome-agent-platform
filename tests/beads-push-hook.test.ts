// tests/beads-push-hook.test.ts — the post-commit hook's Dolt push is LOUD on
// failure (chrome-agent-platform-f151).
//
// The hook used to run `bd dolt push 2>/dev/null &`: stderr was discarded and
// the background job's exit code never checked, so a rejected push
// (non-fast-forward divergence, no network) failed silently on every commit.
// The fix keeps the push async (a commit is never blocked) but moves the push
// into scripts/git-hooks/beads-push.sh, which captures the full output to
// <git-dir>/beads-push.log and prints one named stderr line on failure with
// the exit code, UTC timestamp, log path and remediation. Quiet on success,
// always exit 0.
//
// These tests run the extracted helper directly with a fake `bd` on PATH, so
// the loud-failure behaviour is asserted synchronously (the hook backgrounds
// the helper, so its stderr timing through `git commit` is not deterministic).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), "..");
const HELPER = path.join(REPO_ROOT, "scripts", "git-hooks", "beads-push.sh");
const POST_COMMIT = path.join(REPO_ROOT, "scripts", "git-hooks", "post-commit");

// A stand-in bd: on demand it writes a known line to stdout and stderr and
// exits non-zero (the failure under test), otherwise it is silent and exits 0.
const FAKE_BD = `#!/bin/sh
if [ -n "$FAKE_BD_FAIL" ]; then
  printf '%s\\n' "fake bd: stdout failure detail"
  printf '%s\\n' "fake bd: stderr failure detail" >&2
  exit 7
fi
exit 0
`;

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "cap-f151-"));
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "bd"), FAKE_BD);
  await chmod(path.join(bin, "bd"), 0o755);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "f151@example.invalid"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "f151 fixture"], { cwd: dir, encoding: "utf8" });
  const env: Record<string, string> = {
    PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return { dir, bin, env };
}

Deno.test("f151: a failing bd dolt push is LOUD — exit 0, one named stderr line, full output in the log", async () => {
  const s = await scratch();
  try {
    const r = spawnSync("sh", [HELPER], {
      cwd: s.dir,
      encoding: "utf8",
      env: { ...s.env, FAKE_BD_FAIL: "1" },
    });
    assertEquals(r.status, 0, `the push helper must never block a commit: ${r.stderr}`);
    const err = r.stderr ?? "";
    assert(/beads: dolt push FAILED/.test(err), `a named failure line is required: ${err}`);
    assert(/\(exit 7\)/.test(err), `the exit code must be named: ${err}`);
    assert(/bd dolt pull/.test(err), `the remediation must be named: ${err}`);
    assert(/bd conflicts/.test(err), `the divergence remediation must be named: ${err}`);
    assert(/full output: /.test(err), `the log path must be named: ${err}`);
    assert(/beads-push\.log/.test(err), `the log path must point at the captured log: ${err}`);
    assert(/ at 20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ /.test(err), `the attempt timestamp is required: ${err}`);
    const log = await readFile(path.join(s.dir, ".git", "beads-push.log"), "utf8");
    assert(log.includes("fake bd: stdout failure detail"), `stdout must be captured: ${log}`);
    assert(log.includes("fake bd: stderr failure detail"), `stderr must be captured (2>&1): ${log}`);
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});

Deno.test("f151: a successful bd dolt push stays quiet and still exits 0", async () => {
  const s = await scratch();
  try {
    const r = spawnSync("sh", [HELPER], { cwd: s.dir, encoding: "utf8", env: s.env });
    assertEquals(r.status, 0, r.stderr);
    assertEquals(r.stdout ?? "", "", "no console output on success");
    assertEquals(r.stderr ?? "", "", "no console output on success");
    const log = await readFile(path.join(s.dir, ".git", "beads-push.log"), "utf8");
    assertEquals(log, "", "the success log is empty (nothing was printed)");
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});

Deno.test("f151: the post-commit hook wires the helper async and a commit is never blocked", async () => {
  const s = await scratch();
  try {
    // The reference hook itself, plus the helper it invokes, copied into the
    // scratch checkout so the real `git commit` runs the exact shipped files.
    await mkdir(path.join(s.dir, "scripts", "git-hooks"), { recursive: true });
    await writeFile(path.join(s.dir, "scripts", "git-hooks", "beads-push.sh"), await readFile(HELPER, "utf8"));
    await writeFile(path.join(s.dir, ".git", "hooks", "post-commit"), await readFile(POST_COMMIT, "utf8"));
    await chmod(path.join(s.dir, ".git", "hooks", "post-commit"), 0o755);

    // A first commit so the hook's `git log -1` has something to read; the hook
    // is not installed yet, so this one runs nothing.
    await writeFile(path.join(s.dir, "seed.txt"), "seed\n");
    spawnSync("git", ["add", "-A"], { cwd: s.dir, encoding: "utf8", env: s.env });
    const seed = spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: s.dir, encoding: "utf8", env: s.env });
    assertEquals(seed.status, 0, seed.stderr);

    // Now commit WITH the hook installed and a FAILING bd on PATH: the commit
    // must still land (exit 0) — the push is async and cannot block it.
    const r = spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "a change"], {
      cwd: s.dir,
      encoding: "utf8",
      env: { ...s.env, FAKE_BD_FAIL: "1" },
    });
    assertEquals(r.status, 0, `a failing push must never block the commit: ${r.stderr}`);
  } finally {
    await rm(s.dir, { recursive: true, force: true });
  }
});
