// shared/agent-registry.js — the canonical agent-reference helpers for the
// unified agent picker (CAP-FB-20260818-AGENT-ACCESS-01). Pure + DOM-free so
// it is unit-testable in Deno (no DOM), like agent-candidates.js.
//
// THE CANONICAL AGENT REF: `named:<id>` / `background:<id>` / `site:<origin>`.
// One unambiguous ID flows from the picker → the composer chip → the run
// request, so routing never depends on a (possibly duplicated) display name.
// The registry itself is fetched from the service worker's `agent.registry`
// route (the redacted single source of truth); these helpers only shape it.

export const AGENT_KINDS = ["named", "background", "site"];

/** Build the canonical ref for an agent. */
export function canonicalRef(kind, id) {
  const k = String(kind ?? "").trim();
  const v = String(id ?? "").trim();
  if (!AGENT_KINDS.includes(k) || !v) return "";
  return `${k}:${v}`;
}

/** Parse a canonical ref → { kind, id } or null (malformed/unknown kind). */
export function parseAgentRef(ref) {
  const s = String(ref ?? "");
  const i = s.indexOf(":");
  if (i <= 0) return null;
  const kind = s.slice(0, i);
  const id = s.slice(i + 1);
  if (!AGENT_KINDS.includes(kind) || !id) return null;
  return { kind, id };
}

/** Flatten the grouped registry into a single agent list (group labels kept). */
export function flattenGroups(groups = []) {
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const a of Array.isArray(g?.agents) ? g.agents : []) {
      out.push({ ...a, group: g.label ?? g.id ?? "" });
    }
  }
  return out;
}

/** Find an agent by canonical ref across the groups (stale-selection checks). */
export function findAgentByRef(groups = [], ref) {
  const parsed = parseAgentRef(ref);
  if (!parsed) return null;
  for (const a of flattenGroups(groups)) {
    if (a?.ref === ref) return a;
    // Tolerate a registry entry without a precomputed ref.
    if (!a?.ref && canonicalRef(a?.kind, a?.id) === ref) return a;
  }
  return null;
}

/** Decide whether an async registry response is safe to apply.
 * Both fences are required: only the latest request may win, and a response
 * carrying a lower service-worker revision may never replace a newer snapshot.
 * Missing revisions remain compatible with older/static registries; request
 * ordering still fences them. Exported so the race contract is unit-testable. */
export function shouldApplyRegistrySnapshot(
  requestSeq,
  latestRequestSeq,
  responseRevision,
  appliedRevision,
) {
  if (requestSeq !== latestRequestSeq) return false;
  const response = Number(responseRevision);
  const applied = Number(appliedRevision);
  if (Number.isFinite(response) && appliedRevision != null && Number.isFinite(applied)) {
    return response >= applied;
  }
  return true;
}

/** Is this agent currently callable? (A disabled background agent is visible
 * in browse views but is NOT callable — matching the /agent command rule.) */
export function isCallable(agent) {
  if (!agent || typeof agent !== "object") return false;
  if (agent.kind === "background") return agent.enabled === true;
  return true; // named agents + enrolled Site Agents are always callable
}

/** Filter the grouped registry by a search query. Returns NEW group arrays
 * (the input is never mutated); empty groups are dropped.
 * Options:
 *   callableOnly — keep only the callable agents (the /agent + +menu rule)
 *   excludeRef   — drop this canonical ref (the agent you are talking to)
 *   excludeId    — drop this bare id (any kind) — the legacy current-agent rule
 */
export function filterGroups(groups = [], query = "", opts = {}) {
  const { callableOnly = false, excludeRef = null, excludeId = null } = opts;
  const q = String(query ?? "").trim().toLowerCase();
  const matches = (s) => !q || String(s ?? "").toLowerCase().includes(q);
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const agents = (Array.isArray(g?.agents) ? g.agents : []).filter((a) => {
      if (!a) return false;
      if (callableOnly && !isCallable(a)) return false;
      if (excludeRef && (a.ref ?? canonicalRef(a.kind, a.id)) === excludeRef) return false;
      if (excludeId && String(a.id).toLowerCase() === String(excludeId).toLowerCase()) return false;
      if (!q) return true;
      return (
        matches(a.name) ||
        matches(a.id) ||
        matches(a.summary) ||
        (Array.isArray(a.skills) && a.skills.some((s) => matches(s)))
      );
    });
    if (agents.length) out.push({ ...g, agents });
  }
  return out;
}

/** The human-readable text inserted when an agent is chosen from an @ mention.
 * Routing NEVER depends on this display text: the adjacent candidate carries a
 * canonical ref, and the composer sends that ref through its selected-agent
 * chip. Strip a site's existing leading @ so the visible mention has one. */
export function mentionTextForAgent(agent) {
  const label = String(agent?.name ?? agent?.label ?? agent?.id ?? "").trim().replace(/^@+/, "");
  return label ? `@${label}` : "";
}

/** Turn a picker/mention candidate into the one canonical composer selection.
 * Fail closed when redundant kind/id fields disagree with the canonical ref;
 * untrusted or stale popup data must never route a run to a different agent. */
export function selectionFromAgentCandidate(candidate) {
  const parsed = parseAgentRef(candidate?.ref);
  if (!parsed) return null;
  const claimedKind = String(candidate?.kind ?? "").trim();
  const claimedId = String(candidate?.agentId ?? candidate?.id ?? "").trim();
  if (claimedKind && claimedKind !== parsed.kind) return null;
  if (claimedId && claimedId !== parsed.id) return null;
  return {
    ref: candidate.ref,
    kind: parsed.kind,
    id: parsed.id,
    name: String(candidate?.name ?? candidate?.label ?? parsed.id),
  };
}

/** Flat picker/popup candidates from the grouped registry. Each item carries:
 *   ref       — the canonical routing ref (named:<id> / background:<id> / site:<origin>)
 *   kind      — named | background | site
 *   agentId   — the bare id (slug / recipe id / origin)
 *   id        — the TEXTUAL reference inserted by the / command:
 *               `agent:<canonical-ref>` (e.g. `agent:named:reader`), so the
 *               inserted `/agent:…` text is the UNAMBIGUOUS canonical form —
 *               never a bare id that could collide across kinds.
 *   mentionText — the display text inserted by @ completion; routing still
 *                 uses ref, never this possibly duplicated display name.
 *   label     — the display name
 *   description — role / status / tool summary
 *   group     — the group label (for grouped rendering)
 */
export function candidatesFromGroups(groups = [], opts = {}) {
  const { query = "", callableOnly = true, excludeRef = null, excludeId = null } = opts;
  const filtered = filterGroups(groups, query, { callableOnly, excludeRef, excludeId });
  const out = [];
  for (const g of filtered) {
    for (const a of g.agents) {
      const ref = a.ref ?? canonicalRef(a.kind, a.id);
      out.push({
        ref,
        kind: a.kind,
        agentId: a.id,
        id: `agent:${ref}`, // the canonical textual form (agent:named:<id>…)
        mentionText: mentionTextForAgent(a),
        label: a.name || a.id,
        description: a.summary || "",
        avatar: a.avatar || null,
        status: a.status || "",
        group: g.label ?? g.id ?? "",
      });
    }
  }
  return out;
}
