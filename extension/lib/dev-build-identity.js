// extension/lib/dev-build-identity.js — chrome-agent-platform-x0vas: the About
// surfaces label a dev build with its branch ("v0.3.724 (fleet/imp-stack)").
// The build writes dist/build-identity.json (hashed by dist.complete); this
// module reads it and renders the label. Everything fails soft: a missing or
// unreadable identity means a landed build, which shows the plain version.

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
 * The full version label for an About surface. `identity` null (or a landed
 * branch) renders the bare version; a dev branch renders "v<version> (<branch>)".
 * @param {string|undefined} version
 * @param {{ branch: string|null, commit?: string|null }|null} [identity]
 * @returns {string}
 */
export function devVersionLabel(version, identity) {
  if (!version) return "";
  const branch = identity?.branch;
  const dev = branch && branch !== "main" && branch !== "master" && !branch.startsWith("origin/");
  return dev ? `v${version} (${branch})` : `v${version}`;
}
