// Pure, DOM-free helpers for the /agent command + @ mention candidate lists.
// Kept separate from components.js so they are unit-testable in Deno (no DOM).

function shortOrigin(o) {
  return String(o).replace(/^https?:\/\//, "").replace(/\/.*/, "");
}

// Compute the /agent + @ mention agent candidates from the raw agent arrays.
// Only agents that are ACTUALLY callable are listed: the created named agents,
// the ENABLED background agents (the available-but-not-enabled recipes are
// NOT callable), and the enrolled site agents. The current agent (the one the
// composer is scoped to) is excluded — you can't call the agent you're talking
// to. Pure + exported for unit testing.
/**
 * @param {any[]} named
 * @param {any[]} bg
 * @param {any[]} site
 * @param {{ query?: string, currentAgentId?: (string|null) }} [opts]
 */
export function buildAgentCandidates(
  named = [],
  bg = [],
  site = [],
  { query = "", currentAgentId = null } = {},
) {
  const q = (query || "").toLowerCase();
  const matches = (s) => !q || String(s ?? "").toLowerCase().includes(q);
  const isCurrent = (id) =>
    !!currentAgentId && String(id).toLowerCase() === String(currentAgentId).toLowerCase();
  const out = [];
  for (const a of named) {
    const aid = a.id ?? a.name;
    if (isCurrent(aid)) continue;
    if (!matches(a.name) && !matches(a.id)) continue;
    out.push({ id: `agent:${aid}`, label: a.name, description: a.role || "named agent", kind: "agent" });
  }
  for (const a of bg) {
    if (!a.enabled) continue; // only the ENABLED background agents are callable
    if (isCurrent(a.id)) continue;
    if (!matches(a.name) && !matches(a.id)) continue;
    out.push({ id: `agent:${a.id}`, label: a.name, description: a.description || "background agent", kind: "background" });
  }
  for (const a of site.filter((x) => x.enrolled)) {
    if (!matches(a.origin) && !matches(a.name || "")) continue;
    out.push({ id: `agent:${a.origin}`, label: `@${shortOrigin(a.origin)}`, description: `${a.toolCount ?? 0} tools · site agent`, kind: "agent" });
  }
  return out;
}
