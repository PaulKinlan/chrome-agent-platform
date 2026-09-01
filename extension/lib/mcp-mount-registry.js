// extension/lib/mcp-mount-registry.js — a tiny singleton seam for the remote-MCP
// mount. CAP-FB-20260831-MCP-GLOBAL-UI-01.
//
// Why this exists: lib/mcp-client.js imports the @modelcontextprotocol/sdk
// browser-safe transport SUBPATHS. esbuild resolves + bundles them for the
// service worker, but Deno's type-checker cannot resolve the peer-qualified
// subpath in the combined unit-test graph — so the SW SOURCE must not statically
// import lib/mcp-client.js. build.mjs instead INJECTS scripts/mcp-client-sw-
// inject.js (esbuild `inject`, prepended before the entry body); that shim
// imports the real mount and calls registerMcpMount() here. service-worker.js
// imports ONLY this module (pure, SDK-free, Deno-safe) and reads getMcpMount().
// In the bundle they share ONE module instance, so the registration is visible.
// In a Deno unit test (no inject) getMcpMount() is null and the Test-connection
// route reports "unavailable" honestly. Deliberately NOT a `globalThis.__*`
// oracle (the shipped-code scanner forbids those) — an ordinary module singleton.

let mount = null;

/** Install the SDK-backed remote-MCP mount. Called once by the SW-bundle inject. */
export function registerMcpMount(fn) {
  mount = typeof fn === "function" ? fn : null;
}

/** The registered mount, or null when none has been installed (non-bundle). */
export function getMcpMount() {
  return mount;
}
