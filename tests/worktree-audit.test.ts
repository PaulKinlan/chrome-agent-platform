// CAP-FB-20260821-WORKTREE-HYGIENE-01 — the read-only audit over fixture
// repos: dirty/untracked/detached/rescue/branch reachability + the
// fail-closed output. The audit NEVER mutates.
import { fileURLToPath } from "node:url";
import { assertEquals, assert } from "jsr:@std/assert@1";

const script = fileURLToPath(new URL("../scripts/worktree-audit.mjs", import.meta.url));

function runIn(repo: string, args: string[] = [], cwd?: string) {
  const base = { args: [script, repo, ...args], stdout: "piped" as const, stderr: "piped" as const };
  const p = new Deno.Command("node", cwd ? { ...base, cwd } : base).outputSync();
  return { code: p.code, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
}

// Every fixture repo is removed at the end of its test. Before this, each full
// suite run leaked ~30 tiny git repos into /tmp (a tmpfs); after a few days
// that was 8,960 directories and a third of the filesystem's inodes, and
// tests that copy a worktree into /tmp began failing with ENOSPC.
const fixtures: string[] = [];
async function cleanupFixtures() {
  for (const dir of fixtures.splice(0)) {
    // Tests add sibling worktrees as `${dir}-wt` / `${dir}-orphan-wt`; remove those too.
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    const base = dir.slice(dir.lastIndexOf("/") + 1);
    for await (const entry of Deno.readDir(parent)) {
      if (entry.name === base || entry.name.startsWith(base + "-")) {
        try { await Deno.remove(`${parent}/${entry.name}`, { recursive: true }); } catch { /* already gone */ }
      }
    }
  }
}

async function mkRepo(name: string) {
  const dir = await Deno.makeTempDir({ prefix: `hygiene-${name}-` });
  fixtures.push(dir);
  const git = (args: string[]) => {
    const p = new Deno.Command("git", { args, cwd: dir, stdout: "piped", stderr: "piped" }).outputSync();
    if (p.code !== 0) {
      const err = new TextDecoder().decode(p.stderr).trim();
      throw new Error(`fixture git ${args.join(" ")} failed (exit ${p.code}): ${err}`);
    }
    return p;
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "CAP Test"]);
  git(["config", "user.email", "cap-test@example.com"]);
  Deno.writeTextFileSync(`${dir}/file.txt`, "x");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return { dir, git };
}

Deno.test("audit: a clean main worktree is reported clean + safe", async () => { try { await (async () => {
  const { dir } = await mkRepo("clean");
  const result = runIn(dir);
  assertEquals(result.code, 0);
  const audit = JSON.parse(result.out);
  assertEquals(audit.counts.total, 1);
  assertEquals(audit.counts.dirtyWorktrees, 0);
  assert(audit.safeToOperate === true);
})(); } finally { await cleanupFixtures(); }
});

Deno.test("audit: a dirty worktree reports the tracked + untracked counts (never destroyed)", async () => { try { await (async () => {
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
})(); } finally { await cleanupFixtures(); }
});

Deno.test("audit: an unreachable detached head fails closed (refuses destructive ops)", async () => { try { await (async () => {
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
  const orphanWt = audit.worktrees.find((w: { reach: string }) => w.reach === "unreachable");
  assert(orphanWt, "the detached linked head must be flagged unreachable");
  assert(audit.safeToOperate === false, "an unreachable head fails closed");
  assertEquals(result.code, 1);
})(); } finally { await cleanupFixtures(); }
});

Deno.test("audit: a rescue tag makes an otherwise-orphaned head reachable", async () => { try { await (async () => {
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
  const wt = audit.worktrees.find((w: { reach: string }) => w.reach.startsWith("rescue:"));
  assert(wt, "the rescue tag binds the orphan head");
  assert(wt.rescueTagged === true);
})(); } finally { await cleanupFixtures(); }
});
Deno.test("audit: the output is PUBLIC-SAFE (no private absolute paths in the committed shape)", async () => { try { await (async () => {
  const { dir } = await mkRepo("private");
  const result = runIn(dir);
  const audit = JSON.parse(result.out);
  // The worktree entries carry only the path CLASS + the counts, never a full path list.
  for (const w of audit.worktrees) {
    assert(!("path" in w), "the committed output must not carry absolute paths");
    assert(typeof w.pathClass === "string" && typeof w.dirty === "number");
  }
})(); } finally { await cleanupFixtures(); }
});

Deno.test("audit fixtures: broken git setup fails explicitly naming the setup failure (2d36)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hygiene-broken-" });
  fixtures.push(dir);
  let threw = false;
  try {
    const git = (args: string[]) => {
      const p = new Deno.Command("git", { args, cwd: dir, stdout: "piped", stderr: "piped" }).outputSync();
      if (p.code !== 0) {
        const err = new TextDecoder().decode(p.stderr).trim();
        throw new Error(`fixture git ${args.join(" ")} failed (exit ${p.code}): ${err}`);
      }
      return p;
    };
    git(["nonexistent-command"]);
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes("fixture git nonexistent-command failed (exit 1)"));
  } finally {
    await cleanupFixtures();
  }
  assert(threw, "broken git setup must fail explicitly rather than silently continuing");
});

Deno.test("audit fixtures: git failure under missing identity fails explicitly with code and stderr (2d36)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hygiene-unconfigured-" });
  fixtures.push(dir);
  new Deno.Command("git", { args: ["init", "-q", "-b", "main"], cwd: dir }).outputSync();
  Deno.writeTextFileSync(`${dir}/file.txt`, "x");
  new Deno.Command("git", { args: ["add", "."], cwd: dir }).outputSync();
  let errorMsg = "";
  try {
    const p = new Deno.Command("git", {
      args: ["commit", "-q", "-m", "fail"],
      cwd: dir,
      env: { HOME: dir },
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (p.code !== 0) {
      const err = new TextDecoder().decode(p.stderr).trim();
      throw new Error(`fixture git commit failed (exit ${p.code}): ${err}`);
    }
  } catch (e) {
    errorMsg = (e as Error).message;
  } finally {
    await cleanupFixtures();
  }
  assert(errorMsg.includes("fixture git commit failed (exit 128)"), "must capture exit code 128");
  assert(errorMsg.includes("Author identity unknown") || errorMsg.includes("unable to auto-detect email"), "must capture stderr reason");
});

// chrome-agent-platform-w0i8: the audit compared each worktree HEAD to the
// INVOKING checkout's HEAD ("HEAD" in the audited repo). Auditing an unmerged
// candidate from its own worktree therefore compared it to itself and reported
// reach=on-main. The anchor is the comparison ref now: origin/main when it
// exists, else main, else HEAD — and `on-main` is claimed only for origin/main.
Deno.test("audit: an unmerged candidate audited from its OWN worktree is not on-main (w0i8)", async () => { try { await (async () => {
  const { dir, git } = await mkRepo("candidate");
  git(["checkout", "-q", "-b", "candidate"]);
  Deno.writeTextFileSync(`${dir}/candidate.txt`, "c");
  git(["add", "."]);
  git(["commit", "-q", "-m", "candidate"]);
  git(["checkout", "-q", "main"]);
  git(["worktree", "add", "-q", `${dir}-wt`, "candidate"]);
  const candidateHead = new TextDecoder().decode(git(["rev-parse", "candidate"]).stdout).trim();
  // Invoked FROM the candidate worktree (cwd) with repo ".": exactly the shape
  // that used to self-compare.
  const result = runIn(".", [], `${dir}-wt`);
  const audit = JSON.parse(result.out);
  assertEquals(audit.comparisonRef, "main", "no origin/main in the fixture: main is the anchor");
  assertEquals(audit.invokingHead, candidateHead.slice(0, 12), "the invoking checkout HEAD is reported as itself");
  const mine = audit.worktrees.find((w: { head: string }) => w.head === candidateHead.slice(0, 12));
  assert(mine, "the candidate worktree is inventoried");
  assertEquals(mine.reach, "unreachable", "an unmerged private commit must never be on-main");
})(); } finally { await cleanupFixtures(); }
});

Deno.test("audit: origin/main is the anchor when it exists, and a merged worktree is on-main (w0i8)", async () => { try { await (async () => {
  const { dir, git } = await mkRepo("remote");
  git(["init", "-q", "--bare", `${dir}-remote.git`]);
  git(["remote", "add", "origin", `${dir}-remote.git`]);
  git(["push", "-q", "origin", "main"]);
  git(["fetch", "-q", "origin"]);
  const mainHead = new TextDecoder().decode(git(["rev-parse", "main"]).stdout).trim();
  git(["checkout", "-q", "-b", "candidate"]);
  Deno.writeTextFileSync(`${dir}/candidate.txt`, "c");
  git(["add", "."]);
  git(["commit", "-q", "-m", "candidate"]);
  git(["checkout", "-q", "main"]);
  git(["worktree", "add", "-q", `${dir}-wt`, "candidate"]);
  const candidateHead = new TextDecoder().decode(git(["rev-parse", "candidate"]).stdout).trim();
  const result = runIn(".", [], `${dir}-wt`);
  const audit = JSON.parse(result.out);
  assertEquals(audit.comparisonRef, "origin/main", "the fetched integration ref is the anchor");
  assertEquals(audit.comparisonRefHead, mainHead.slice(0, 12));
  const merged = audit.worktrees.find((w: { head: string }) => w.head === mainHead.slice(0, 12));
  assert(merged && merged.reach === "on-main", "a worktree at origin/main's commit is on-main");
  const candidate = audit.worktrees.find((w: { head: string }) => w.head === candidateHead.slice(0, 12));
  assert(candidate && candidate.reach === "unreachable", "the unmerged candidate is not on-main");
})(); } finally { await cleanupFixtures(); }
});

// w0i8 verifier observation: `counts.detached` held the ARRAY of detached
// worktree entries while every sibling key held a number. The entries already
// live in `worktrees` (branch === "detached"), so `counts` is counts-only now —
// pinned generally: every value under `counts` must be a number.
Deno.test("audit: counts holds counts, and detached worktrees are listed under worktrees (w0i8)", async () => { try { await (async () => {
  const { dir, git } = await mkRepo("counts");
  git(["worktree", "add", "-q", "--detach", `${dir}-wt`, "main"]);
  const result = runIn(dir);
  const audit = JSON.parse(result.out);
  for (const [key, value] of Object.entries(audit.counts)) {
    assert(typeof value === "number", `counts.${key} must be a number, got ${Array.isArray(value) ? "array" : typeof value}`);
  }
  assertEquals(audit.counts.detached, 1);
  const listed = audit.worktrees.filter((w: { branch: string }) => w.branch === "detached");
  assertEquals(listed.length, 1, "the detached worktree is still inventoried");
})(); } finally { await cleanupFixtures(); }
});
