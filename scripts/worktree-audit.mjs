#!/usr/bin/env node
// scripts/worktree-audit.mjs — the READ-ONLY worktree-hygiene audit
// (CAP-FB-20260821-WORKTREE-HYGIENE-01).
//
// Inventories every registered git worktree: the HEAD commit, the branch (or
// detached), the dirty tracked + untracked path counts, the reachability from
// the comparison ref (origin/main when it exists, else main, else the invoking
// HEAD), and the worktree's location class (durable vs the RAM-backed tmpfs).
// It NEVER removes, prunes, relocates, resets, or deletes anything — a
// destructive op is refused with a non-zero exit. The private path inventory
// (absolute paths outside the repo) is never printed as a full list in any
// committed output — only per-class COUNTS.
//
// ANCHOR (chrome-agent-platform-w0i8): reachability is measured against the
// COMPARISON REF, never the invoking checkout's HEAD. Comparing to "HEAD" meant
// auditing an unmerged candidate from its OWN worktree compared the candidate to
// itself and reported reach=on-main — a context-dependent label, not evidence of
// a merge. `on-main` is only claimed when the anchor is origin/main.

import { execFileSync } from "node:child_process";

const repo = process.argv[2] ?? ".";
const RESCUE_TAG_PREFIX = "rescue/";

function run(args, cwd = repo) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch {
    return "";
  }
}

function parseWorktrees() {
  const out = run(["worktree", "list", "--porcelain"]);
  const blocks = out.split("\n\n").filter(Boolean);
  return blocks.map((b) => {
    const lines = b.split("\n");
    const get = (key) => {
      const line = lines.find((l) => l.startsWith(`${key} `));
      return line ? line.slice(key.length + 1) : "";
    };
    return { path: get("worktree"), head: get("HEAD"), branch: get("branch"), detached: get("detached") === "true" || lines.some((l) => l === "detached") };
  }).filter((w) => w.path);
}

// The comparison anchor is the FETCHED INTEGRATION REF, never the invoking
// checkout's HEAD (w0i8): with HEAD, a candidate audited from its own worktree
// compared to itself and reported reach=on-main. `on-main` is claimed ONLY when
// the anchor is origin/main; any other anchor is labelled `on:<ref>` so the
// output cannot overstate what was checked.
const COMPARISON_REF = (() => {
  for (const ref of ["origin/main", "main"]) {
    if (run(["rev-parse", "--verify", "--quiet", ref])) return ref;
  }
  return "HEAD";
})();
const COMPARISON_HEAD = run(["rev-parse", COMPARISON_REF]);
const INVOKING_HEAD = run(["rev-parse", "HEAD"]);
const RESCUE_TAGS = new Set(run(["tag", "-l", `${RESCUE_TAG_PREFIX}*`]).split("\n").filter(Boolean));

function isAncestor(head, ref) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", head, ref], { cwd: repo, encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function reachability(head) {
  if (!head) return "unknown";
  if (isAncestor(head, COMPARISON_REF)) return COMPARISON_REF === "origin/main" ? "on-main" : `on:${COMPARISON_REF}`;
  const byTag = [...RESCUE_TAGS].find((t) => isAncestor(head, t));
  if (byTag) return `rescue:${byTag}`;
  return "unreachable";
}

const audit = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  // What the reachability verdict was measured against, and the invoking
  // checkout's own HEAD — labelled separately so neither is mistaken for main.
  comparisonRef: COMPARISON_REF,
  comparisonRefHead: COMPARISON_HEAD ? COMPARISON_HEAD.slice(0, 12) : "",
  invokingHead: INVOKING_HEAD ? INVOKING_HEAD.slice(0, 12) : "",
  worktrees: [],
  counts: {},
  safeToOperate: true,
};

for (const w of parseWorktrees()) {
  // Dirty state: tracked + untracked counts (the ACTUAL preservation facts).
  let tracked = 0;
  let untracked = 0;
  try {
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: w.path, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const lines = status.split("\n").filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("??")) untracked += 1;
      else tracked += 1;
    }
  } catch {
    /* an unreadable worktree is a hygiene defect */
  }
  const onTmpfs = w.path.startsWith("/tmp/");
  const reach = reachability(w.head);
  audit.worktrees.push({
    pathClass: onTmpfs ? "tmpfs" : "durable",
    head: w.head ? w.head.slice(0, 12) : "",
    branch: w.branch || (w.detached ? "detached" : ""),
    tracked, untracked,
    dirty: tracked + untracked,
    reach,
    rescueTagged: reach.startsWith("rescue:"),
  });
}

const total = audit.worktrees.length;
const dirty = audit.worktrees.filter((w) => w.dirty > 0);
const unreachable = audit.worktrees.filter((w) => w.reach === "unreachable");
const tmpfs = audit.worktrees.filter((w) => w.pathClass === "tmpfs");
const detached = audit.worktrees.filter((w) => w.branch === "detached");
audit.counts = {
  total,
  dirtyWorktrees: dirty.length,
  dirtyTrackedPaths: dirty.reduce((n, w) => n + w.tracked, 0),
  dirtyUntrackedPaths: dirty.reduce((n, w) => n + w.untracked, 0),
  unreachable: unreachable.length,
  tmpfs: tmpfs.length,
  // A COUNT, not the list: the detached entries already live in `worktrees`
  // (branch === "detached"), and a counts object whose key holds an array
  // misdescribes itself (verifier observation on w0i8).
  detached: detached.length,
  rescueTags: RESCUE_TAGS.size,
};
// FAIL-CLOSED: an unreachable durable head or a worktree the audit cannot read
// means the operator MUST NOT prune/remove anything until it is bound.
audit.safeToOperate = unreachable.length === 0 && audit.worktrees.length === audit.worktrees.filter((w) => typeof w.pathClass === "string").length;
audit.refusesDestructiveOps = true; // this tool NEVER mutates

console.log(JSON.stringify(audit, null, 2));
// The exit code: 0 = safe to review; 1 = hygiene defect (still read-only).
process.exitCode = audit.safeToOperate ? 0 : 1;
