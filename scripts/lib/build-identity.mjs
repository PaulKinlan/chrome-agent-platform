// scripts/lib/build-identity.mjs — chrome-agent-platform-x0vas: the NODE side of
// the build identity. The RULE (what counts as landed, how the label renders) is
// single-sourced in extension/lib/dev-build-identity.js (chrome-agent-platform-4169y)
// and re-exported here so every node caller renders through the same code the
// extension bundles. This module only adds what node needs and the extension
// cannot have: the git reads. Both accept an injectable `run` so build.mjs can
// pass its BOUNDED child runner (fnmr) — the default execFileSync exists for
// tests and one-shot scripts, never for the build path.
//
// A build must never fail over identity: every read resolves to null on any
// git failure (sanitized env, odd worktree, timeout).

import { execFileSync } from "node:child_process";

export { devVersionLabel, isLandedBranch } from "../../extension/lib/dev-build-identity.js";

/** Run one git arg vector, resolving to its trimmed stdout or null. The
 *  injectable `run` may be sync or async; both are awaited. A null/undefined
 *  result (bounded-runner failure) stays null — never the string "null". */
async function gitOut(root, args, run) {
  const doRun = run ?? ((a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }));
  try {
    const out = await doRun(args);
    if (out === null || out === undefined) return null;
    return String(out).trim() || null;
  } catch {
    return null;
  }
}

/** The current git branch ("--abbrev-ref HEAD"), or null when git is
 *  unavailable. A detached checkout reports "HEAD" (the caller decides what
 *  that renders as — see isLandedBranch/devVersionLabel). */
export async function currentGitBranch(root, run) {
  return gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"], run);
}

/** The current git commit (short form), or null when git is unavailable. */
export async function currentGitCommit(root, run) {
  return gitOut(root, ["rev-parse", "--short", "HEAD"], run);
}
