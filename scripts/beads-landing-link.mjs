// scripts/beads-landing-link.mjs — connect a landing back to the beads its
// commits carry (chrome-agent-platform-j4t1).
//
// Measured 2026-09-18: 28 of the last 30 commits on main name a bead in the
// subject, yet nothing walked them back to the tracker — so beads read OPEN
// while their behaviour was already on main, and lanes spent passes verifying
// work that was done (three such closures in one hour). The mirror failure is
// worse: beads CLOSED whose work never landed. Ancestry proves nothing in either
// direction (a merged re-implementation leaves the originating branch unmerged;
// an ancestor branch can contain zero commits), so the durable link is the
// commit-message reference itself — which every lane already writes.
//
// Usage:
//   node scripts/beads-landing-link.mjs <range>              # report
//   node scripts/beads-landing-link.mjs <range> --json       # machine-readable
//   node scripts/beads-landing-link.mjs <range> --comment <landing-sha> [--bundle <path>]
//   node scripts/beads-landing-link.mjs --verify <bead-id>
//
// `--comment` is opt-in and additive: it appends one comment per referenced bead
// naming the landing commit (and the evidence bundle when given), so a later
// lane finds the work from the record instead of re-deriving it. Nothing is
// closed automatically: a landing that RE-IMPLEMENTED a bead's behaviour is a
// judgement, and this tool reports the link, not the verdict.
//
// Durable by construction: plain node + git + bd, no machine-local state, and
// the convention it relies on (bead id in the commit subject) is already the
// fleet's practice.

import { spawnSync } from "node:child_process";

const DEFAULT_PREFIX = "chrome-agent-platform-";

/**
 * Every bead reference in a git log, as { bead, sha, subject }.
 * @param {string} logText output of git log --format=%H%x1f%s%x1f%b%x1e
 * @param {{ prefix?: string }} [options]
 * @returns {Array<{ bead: string, sha: string, subject: string }>}
 */
export function extractBeadRefs(logText, { prefix = DEFAULT_PREFIX } = {}) {
  const refs = [];
  const pattern = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([a-z0-9][a-z0-9.-]*)`, "gi");
  for (const record of String(logText).split("\x1e")) {
    const [sha, subject, body = ""] = record.trim().split("\x1f");
    if (!sha || !subject) continue;
    const seen = new Set();
    for (const match of `${subject}\n${body}`.matchAll(pattern)) {
      const bead = `${prefix}${match[1].toLowerCase()}`;
      if (seen.has(bead)) continue;
      seen.add(bead);
      refs.push({ bead, sha: sha.trim(), subject: subject.trim() });
    }
  }
  return refs;
}

/** Group `extractBeadRefs` output by bead, most-referenced first. */
export function groupByBead(refs) {
  const byBead = new Map();
  for (const ref of refs) {
    if (!byBead.has(ref.bead)) byBead.set(ref.bead, []);
    byBead.get(ref.bead).push(ref);
  }
  return [...byBead.entries()]
    .map(([bead, commits]) => ({ bead, commits }))
    .sort((a, b) => b.commits.length - a.commits.length || a.bead.localeCompare(b.bead));
}

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function bd(cwd, args) {
  return spawnSync("bd", args, { cwd, encoding: "utf8" });
}

/**
 * Report every bead a range of commits references.
 * @param {{ cwd?: string, range: string, prefix?: string }} options
 */
export function landingLinks({ cwd = process.cwd(), range, prefix = DEFAULT_PREFIX } = {}) {
  if (!range) throw new Error("landingLinks: a git range is required");
  const log = git(cwd, ["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", range]);
  return groupByBead(extractBeadRefs(log, { prefix }));
}

/**
 * Does main carry a commit referencing this bead? (the inverse direction)
 * @param {{ cwd?: string, bead: string, branch?: string }} options
 */
export function verifyBeadLanded({ cwd = process.cwd(), bead, branch = "origin/main" } = {}) {
  if (!bead) throw new Error("verifyBeadLanded: a bead id is required");
  const log = git(cwd, ["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", branch]);
  const commits = extractBeadRefs(log).filter((ref) => ref.bead === bead);
  return { bead, branch, landed: commits.length > 0, commits };
}

function main(argv) {
  const cwd = process.cwd();
  const args = [...argv];
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return null;
    const value = args[i + 1] ?? null;
    args.splice(i, value === null ? 1 : 2);
    return value;
  };

  const asJson = args.includes("--json") ? (args.splice(args.indexOf("--json"), 1), true) : false;
  const commentSha = flag("--comment");
  const bundle = flag("--bundle");
  const verify = flag("--verify");
  const prefix = flag("--prefix") ?? DEFAULT_PREFIX;

  if (verify) {
    const result = verifyBeadLanded({ cwd, bead: verify });
    const state = bd(cwd, ["show", verify]);
    const beadState = /CLOSED/.test(state.stdout ?? "") ? "CLOSED" : /IN_PROGRESS/.test(state.stdout ?? "") ? "IN_PROGRESS" : "OPEN";
    console.log(JSON.stringify({ ...result, beadState }, null, asJson ? 0 : 2));
    // Fail closed on the inverse failure: a CLOSED bead with no landing reference.
    if (beadState === "CLOSED" && !result.landed) {
      console.error(`beads-landing-link: ${verify} is CLOSED but no commit on ${result.branch} references it — verify how it landed`);
      process.exit(1);
    }
    return;
  }

  const range = args.shift();
  if (!range) {
    console.error("usage: beads-landing-link.mjs <range> [--json] [--comment <sha>] [--bundle <path>] | --verify <bead>");
    process.exit(2);
  }
  const links = landingLinks({ cwd, range, prefix });
  if (asJson) {
    console.log(JSON.stringify({ range, links }, null, 2));
  } else {
    console.log(`${range}: ${links.length} bead(s) referenced by ${links.reduce((n, l) => n + l.commits.length, 0)} commit(s)`);
    for (const { bead, commits } of links) {
      console.log(`  ${bead}  x${commits.length}  ${commits[0].sha.slice(0, 8)}  ${commits[0].subject.slice(0, 70)}`);
    }
  }

  if (commentSha) {
    for (const { bead, commits } of links) {
      const lines = [
        `LANDING LINK (chrome-agent-platform-j4t1): referenced by landing ${commentSha} via ${commits.length} commit(s) in ${range}.`,
        ...commits.slice(0, 8).map((c) => `  ${c.sha.slice(0, 12)} ${c.subject.slice(0, 90)}`),
        bundle ? `Evidence bundle: ${bundle}` : "Evidence bundle: (not given — name it on the bead)",
        "This is a LINK, not a verdict: confirm the behaviour is on main before closing, and say plainly if the landing re-implemented it.",
      ].join("\n");
      const r = bd(cwd, ["comment", bead, lines]);
      console.log(`  commented ${bead}: ${(r.stdout || r.stderr).trim().split("\n").pop()}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
