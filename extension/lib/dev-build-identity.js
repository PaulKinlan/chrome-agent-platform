// extension/lib/dev-build-identity.js — chrome-agent-platform-x0vas: the About
// surfaces label a dev build with its branch ("v<version> (<branch>)"). The
// build writes dist/build-identity.json (hashed by dist.complete); this module
// reads it and renders the label. Everything fails soft: a missing or
// unreadable identity means a landed build, which shows the plain version.
// (No version literals here: build-tier-inputs reserves the version stamp for
// the files the landing bump rewrites.)

/**
 * Read the build identity the build staged. Resolves to `{ branch, commit }`
 * (either field may be null) or null when the file is absent/unreadable — the
 * landed-build shape.
 * @param {{ getURL?: (path: string) => string, fetch?: typeof fetch }} [env]
 *   Injectable chrome.runtime/fetch surface; tests pass fakes.
 * @returns {Promise<{ branch: string|null, commit: string|null }|null>}
 */
export async function loadDevBuildIdentity(env = {}) {
  const getURL = env.getURL
    ?? (typeof chrome !== "undefined" && chrome?.runtime?.getURL ? (p) => chrome.runtime.getURL(p) : null);
  const doFetch = env.fetch ?? (typeof fetch === "function" ? fetch : null);
  if (!getURL || !doFetch) return null;
  try {
    const res = await doFetch(getURL("dist/build-identity.json"));
    if (!res?.ok) return null;
    const identity = await res.json();
    if (!identity || typeof identity !== "object") return null;
    return {
      branch: typeof identity.branch === "string" && identity.branch ? identity.branch : null,
      commit: typeof identity.commit === "string" && identity.commit ? identity.commit : null,
    };
  } catch {
    return null; // landed build, or a context that cannot read extension URLs
  }
}

/**
 * The LANDED-NESS rule — the CANONICAL single source (chrome-agent-platform-4169y).
 * scripts/lib/build-identity.mjs re-exports this for the node side; build.mjs and
 * the About surfaces all render through devVersionLabel, so the rule cannot drift.
 *
 * A LANDED build: no branch at all (the file is absent, or git was unavailable
 * at build time), or a landed ref (main/master/origin-*). A DETACHED checkout
 * reports branch "HEAD" — that is DEV, and 7usma says it must never render the
 * bare ref: the label falls to the commit, "v<ver> (detached <short-sha>)".
 * @param {string|null|undefined} branch
 * @returns {boolean}
 */
export function isLandedBranch(branch) {
  if (!branch) return true;
  const b = String(branch);
  if (b === "HEAD") return false;
  return b === "main" || b === "master" || b.startsWith("origin/");
}

/**
 * The full version label for an About surface. `identity` null (or a landed
 * branch) renders the bare version; a dev branch renders "v<version> (<branch>)";
 * a detached checkout renders "v<version> (detached <commit>)" — never the bare
 * "(HEAD)", which tells the user nothing (chrome-agent-platform-7usma).
 * @param {string|undefined} version
 * @param {{ branch: string|null, commit?: string|null }|null} [identity]
 * @returns {string}
 */
export function devVersionLabel(version, identity) {
  if (!version) return "";
  const branch = identity?.branch;
  if (isLandedBranch(branch)) return `v${version}`;
  const label = branch === "HEAD" ? `detached ${identity?.commit || "unknown"}` : branch;
  return `v${version} (${label})`;
}
