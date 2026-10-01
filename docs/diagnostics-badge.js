// lib/diagnostics-badge.js — filter user-expected setup conditions from the
// topbar Diagnostics badge error count (716s.13).
//
// The hub topbar badge (<diagnostics-panel> / #diag-btn) alerts the owner to
// actionable system errors. First-run onboarding conditions (missing provider,
// keyless local-assistant pricing notice, owner-declined permissions) are already
// owned by the first-run banner, provider status chip, and conversation cards.
// Counting them as alarming red/amber "Diagnostics N" errors causes false alarms.
//
// These entries remain visible inside the Diagnostics drawer if opened (classified
// as info rather than error), while genuine platform errors continue to increment
// the badge count.

/**
 * Returns true if a diagnostic entry is an expected setup condition, keyless
 * nudge, or owner permission decision that must NOT increment the error badge.
 *
 * @param {{ level?: string, kind?: string, source?: string, message?: string }} entry
 * @returns {boolean}
 */
export function isExcludedDiagnosticBadgeEntry(entry) {
  if (!entry) return true;
  const level = String(entry.level ?? "").toLowerCase();
  if (level !== "error" && level !== "warn") return true;

  const kind = String(entry.kind ?? "").toLowerCase();
  const msg = String(entry.message ?? "").toLowerCase();

  // Explicit approval / permission refusal decisions
  if (
    kind === "owner-denied" ||
    kind === "user-declined" ||
    kind === "permission-denied" ||
    kind === "user_declined" ||
    kind === "permission_denied"
  ) {
    return true;
  }

  // Pricing warning for local / keyless assistant in agent-do is an expected setup notice
  if (
    msg.includes("no pricing entry for model") ||
    msg.includes("cost tracking and spending limits are disabled")
  ) {
    return true;
  }

  // Provider setup nudges & missing key notices
  if (
    msg.includes("no_provider") ||
    msg.includes("no provider") ||
    msg.includes("missing_api_key") ||
    msg.includes("missing api key") ||
    msg.includes("connect a model") ||
    msg.includes("connect-a-model") ||
    msg.includes("misconfigured: missing api key") ||
    msg.includes("provider is misconfigured") ||
    msg.includes("no model connected yet")
  ) {
    return true;
  }

  // User permission decisions / declines (owner denied capability or approval)
  if (
    msg.includes("permission_denied") ||
    msg.includes("user_declined") ||
    msg.includes("owner-denied") ||
    msg.includes("approval denied") ||
    msg.includes("owner denied") ||
    msg.includes("user declined") ||
    msg.includes("user rejected") ||
    msg.includes("permission not granted") ||
    msg.includes("permission was not granted") ||
    msg.includes("capability was not granted") ||
    msg.includes("capability was not performed") ||
    msg.includes("allow it in the approval card")
  ) {
    return true;
  }

  return false;
}

/**
 * Classify entry level for display in the Diagnostics drawer. Excluded setup
 * conditions are classified as "info" rather than "error" or "warn".
 *
 * @param {{ level?: string }} entry
 * @returns {string}
 */
export function classifyDiagnosticBadgeLevel(entry) {
  if (isExcludedDiagnosticBadgeEntry(entry)) return "info";
  return String(entry?.level ?? "info");
}

/**
 * Compute the actionable error count for the topbar Diagnostics badge.
 *
 * @param {Array<{ level?: string, kind?: string, source?: string, message?: string }> | null | undefined} entries
 * @returns {number}
 */
export function countDiagnosticsBadgeErrors(entries) {
  if (!Array.isArray(entries)) return 0;
  let count = 0;
  for (const e of entries) {
    const level = String(e?.level ?? "").toLowerCase();
    if (level !== "error" && level !== "warn") continue;
    if (!isExcludedDiagnosticBadgeEntry(e)) {
      count++;
    }
  }
  return count;
}
