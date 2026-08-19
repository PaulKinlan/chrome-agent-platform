// scripts/test-seam.snippet.js — TEST-ONLY routes appended to the service
// worker bundle when (and ONLY when) build.mjs runs with CAP_TEST_SEAM=1.
// This file is NEVER imported by production code; the default build does not
// touch it. It exists so e2e journeys can assert key persistence WITHOUT the
// raw key ever crossing into a page — the sentinel is a non-reversible hash
// computed inside the SW, and it is absent from production builds entirely
// (the final review's CRITICAL: no stable key oracle in production).

// The snippet is appended at the END of the bundled module, where `handlers`
// and the named-agents module functions are in scope.
globalThis.__CAP_TEST_SEAM = true;
handlers["named-agent.key-sentinel"] = async ({ id }) => {
  const full = await getNamedAgentProvider(String(id ?? ""));
  const key = full?.apiKey ?? "";
  if (!key) return { ok: true, sentinel: null };
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return { ok: true, sentinel: `fnv:${h.toString(36)}` };
};
