// CAP-FB-20260821-WORKTREE-HYGIENE-01 — the read-only audit over fixture
// repos: dirty/untracked/detached/rescue/branch reachability + the
// fail-closed output. The audit NEVER mutates.
import { assertEquals, assert } from "jsr:@std/assert@1";

const script = new URL("../scripts/worktree-audit.mjs", import.meta.url).pathname;

function runIn(repo, args = []) {
  const p = new Deno.Command("node", { args: [script, repo, ...args], stdout: "piped", stderr: "piped" }).outputSync();
  return { code: p.code, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
}

async function mkRepo(name) {
  const dir = await Deno.makeTempDir({ prefix: `hygiene-${name}-` });
  const git = (args) => new Deno.Command("git", { args, cwd: dir, stdout: "piped", stderr: "piped" }).outputSync();
  git(["init", "-q", "-b", "main"]);
  Deno.writeTextFileSync(`${dir}/file.txt`, "x");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return { dir, git };
}

Deno.test("audit: a clean main worktree is reported clean + safe", async () => {
  const { dir } = await mkRepo("clean");
  const result = runIn(dir);
  assertEquals(result.code, 0);
  const audit = JSON.parse(result.out);
  assertEquals(audit.counts.total, 1);
  assertEquals(audit.counts.dirtyWorktrees, 0);
  assert(audit.safeToOperate === true);
});

Deno.test("audit: a dirty worktree reports the tracked + untracked counts (never destroyed)", async () => {
  const { dir, git } = await mkRepo("dirty");
  Deno.writeTextFileSync(`${dir}/file.txt`, "changed");
  Deno.writeTextFileSync(`${dir}/new.txt`, "new");
  const result = runIn(dir);
  const audit = JSON.parse(result.out);
  assertEquals(audit.counts.total, 1);
  assertEquals(audit.counts.dirtyTrackedPaths, 1);
  assertEquals(audit.counts.dirtyUntrackedPaths, 1);
  // The audit performs NO mutation.
  git(["status", "--porcelain"]);
  assert(Deno.readTextFileSync(`${dir}/new.txt`) === "new", "the untracked file survives");
});

Deno.test("audit: an unreachable detached head fails closed (refuses destructive ops)", async () => {
  const { dir, git } = await mkRepo("detached");
  // A LINKED worktree carries a detached orphan head while the repo HEAD stays
  // on main — the realistic case the audit must flag as unreachable.
  Deno.writeTextFileSync(`${dir}/orphan.txt`, "o");
  git(["checkout", "-q", "-b", "orphan-branch"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "orphan"]);
  git(["checkout", "-q", "main"]);
  git(["worktree", "add", "-q", "--detach", `${dir}-wt`, "orphan-branch"]);
  const result = runIn(dir);
  const audit = JSON.parse(result.out);
  const orphanWt = audit.worktrees.find((w) => w.reach === "unreachable");
  assert(orphanWt, "the detached linked head must be flagged unreachable");
  assert(audit.safeToOperate === false, "an unreachable head fails closed");
  assertEquals(result.code, 1);
});

Deno.test("audit: a rescue tag makes an otherwise-orphaned head reachable", async () => {
  const { dir, git } = await mkRepo("rescue");
  Deno.writeTextFileSync(`${dir}/orphan.txt`, "o");
  git(["checkout", "-q", "-b", "orphan-branch"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "orphan"]);
  git(["checkout", "-q", "main"]);
  git(["worktree", "add", "-q", "--detach", `${dir}-orphan-wt`, "orphan-branch"]);
  const head = new TextDecoder().decode(git(["rev-parse", "orphan-branch"]).stdout).trim();
  git(["tag", `rescue/fixture-${head.slice(0, 8)}`, head]);
  const result = runIn(dir);
  const audit = JSON.parse(result.out);
  const wt = audit.worktrees.find((w) => w.reach.startsWith("rescue:"));
  assert(wt, "the rescue tag binds the orphan head");
  assert(wt.rescueTagged === true);
});
Deno.test("audit: the output is PUBLIC-SAFE (no private absolute paths in the committed shape)", async () => {
  const { dir } = await mkRepo("private");
  const result = runIn(dir);
  const audit = JSON.parse(result.out);
  // The worktree entries carry only the path CLASS + the counts, never a full path list.
  for (const w of audit.worktrees) {
    assert(!("path" in w), "the committed output must not carry absolute paths");
    assert(typeof w.pathClass === "string" && typeof w.dirty === "number");
  }
});
