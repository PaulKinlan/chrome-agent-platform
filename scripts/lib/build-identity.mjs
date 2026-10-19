// scripts/lib/build-identity.mjs — chrome-agent-platform-x0vas: a dev build knows
// WHICH branch produced it. With the per-commit version hook gone, the version in
// the tree is the LAST LANDED version on every dev build, so two loaded worktrees
// would be indistinguishable on the About page. The build writes
// `dist/build-identity.json` { branch, commit } into the staged tree BEFORE the
// dist.complete marker, so the identity is a hashed output: same commit + same
// branch = same bytes (validate-or-build reuse holds); a different branch at the
// same commit rebuilds — the honest cost of an identity that differs.

import { execFileSync } from "node:child_process";

/** The current git branch, or null when git is unavailable (sanitized env).
 *  A build must never fail over identity. */
export function currentGitBranch(root, run = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })) {
  try {
    return String(run(["rev-parse", "--abbrev-ref", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

/** A LANDED build: no branch, or a tracking/landed ref. Anything else is dev. */
export function isLandedBranch(branch) {
  if (!branch) return true;
  const b = String(branch);
  return b === "main" || b === "master" || b.startsWith("origin/");
}

/** The full About-page version label: "v1.2.3" on a landed build, else
 *  "v1.2.3 (fleet/imp-stack)". Absent version → "" (leave the placeholder). */
export function devVersionLabel(version, branch) {
  if (!version) return "";
  if (isLandedBranch(branch)) return `v${version}`;
  return `v${version} (${branch})`;
}
