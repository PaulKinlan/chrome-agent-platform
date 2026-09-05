// lib/site-tool-audit.js — the per-origin audit trail for site↔agent
// interactions (chrome-agent-platform-eo4d). Every site-tool invocation —
// allowed, denied, or auto-approved — appends one immutable row so the
// owner can see WHAT the site did through the agent, and when. Denials
// audit too: a trail that hides refusals is half a trail.
//
// Store: the same per-origin site memory the approvals map uses
// (siteMemory(origin)). Rows are append-only; the ledger keeps the most
// recent rows and never truncates on write failure (a failed append is
// reported, not swallowed).
import { siteMemory } from "./memory.js";

export const SITE_TOOL_AUDIT_KEY = "cap:site-tool-audit";

/** Append one audit row for an origin. `entry` is
 * { tool, runId, decision, argDigest } — decision is "auto" (enrollment
 * carried it), "allow" (first-call card approved), or "deny". Timestamps
 * are added here, never trusted from the caller. */
export async function auditSiteToolCall(origin, entry) {
  const store = siteMemory(origin);
  const rows = (await store.get(SITE_TOOL_AUDIT_KEY)) ?? [];
  const next = rows.concat([{
    at: Date.now(),
    tool: String(entry?.tool ?? ""),
    runId: typeof entry?.runId === "string" ? entry.runId : null,
    decision: entry?.decision === "allow" || entry?.decision === "deny" ? entry.decision : "auto",
    argDigest: typeof entry?.argDigest === "string" ? entry.argDigest : null,
  }]);
  await store.setTrusted(SITE_TOOL_AUDIT_KEY, next);
  return next[next.length - 1];
}

/** Read the audit rows for an origin, newest LAST (append order). */
export async function readSiteToolAudit(origin) {
  return (await siteMemory(origin).get(SITE_TOOL_AUDIT_KEY)) ?? [];
}

/** Clear one origin's audit trail (Settings: per-site "clear trail"). */
export async function clearSiteToolAudit(origin) {
  await siteMemory(origin).setTrusted(SITE_TOOL_AUDIT_KEY, []);
}
