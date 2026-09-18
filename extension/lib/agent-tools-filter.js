// extension/lib/agent-tools-filter.js — the per-agent tool allow-list filters,
// extracted from the service worker's run builder so BOTH the production
// dispatch path and the tests drive the same code (chrome-agent-platform-1frz:
// the preserved test re-implemented these filters inline and asserted against
// the copy — it could not see a production regression).
//
// Semantics are the service worker's, exactly:
// - tools == null (or the key absent) means UNRESTRICTED: everything passes.
// - an array (even empty) is a closed allow-list: only members pass.
// - origins compare canonically (canonicalOrigin with a lowercase fallback),
//   matching the worker-enrollment filter.

import { canonicalOrigin } from "./memory.js";

/** The agent's WebMCP origin allow-list as a canonical Set — null when
 * unrestricted (tools absent or webmcpOrigins not set). Shared by the worker
 * enrollment filter AND the delegate_task guard. */
export function webmcpAllowlistForAgent(agentTools) {
  return agentTools?.webmcpOrigins != null
    ? new Set(agentTools.webmcpOrigins.map((o) => canonicalOrigin(o) || o.toLowerCase()))
    : null;
}

/** The delegate guard's predicate: is this origin inside the agent's
 * allow-list? (Null allow-list = unrestricted.) */
export function isWebmcpOriginAllowed(allowlist, origin) {
  return allowlist == null || allowlist.has(origin) || allowlist.has(canonicalOrigin(origin));
}

/** The WebMCP origins an agent may drive: all enrolled origins when
 * unrestricted, else the allow-listed subset (canonical comparison). */
export function filterWebmcpOriginsForAgent(agentTools, allOrigins) {
  const allowed = webmcpAllowlistForAgent(agentTools);
  return allowed == null
    ? allOrigins
    : allOrigins.filter((origin) => isWebmcpOriginAllowed(allowed, origin));
}

/** The bundled Wasm package rows an agent may run: all rows when
 * unrestricted, else rows whose packageId OR toolId is allow-listed. */
export function filterBundledWasmRowsForAgent(agentTools, rows) {
  if (agentTools?.bundledWasm == null) return rows;
  const allowed = new Set(agentTools.bundledWasm);
  return rows.filter((row) => allowed.has(row.packageId) || allowed.has(row.toolId));
}
