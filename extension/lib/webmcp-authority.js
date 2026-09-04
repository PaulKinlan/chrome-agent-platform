// lib/webmcp-authority.js — the WebMCP live-authorization decision, extracted
// from the service worker's readSiteLazySources guard
// (CAP-FB-20260824-WEBMCP-LAZYAUTH-01).
//
// WHY THIS MODULE EXISTS: the inline guard referenced `ownData(...)`, which is
// a per-module LOCAL helper in lib/*.js and was NEVER imported into the
// service worker — so every guard evaluation threw ReferenceError, the lazy
// protocol's catch mapped it to { ok:false }, and every enrolled WebMCP tool
// failed closed with the opaque `lazy-authority-stale-or-denied`. Extracting
// the decision here makes the consent chain unit-testable end-to-end and every
// denial SELF-DIAGNOSING (the `reason` names the exact failing conjunct).
//
// Consent model: ENROLLMENT IS THE OWNER'S CONSENT (see tools.js isApproved —
// the enrolled origin's tools are approved as a class). This module keeps the
// WHAT-runs fences: descriptor still in the live directory, live enrollment,
// and the immutable run-generation echo (a stale run captured before a
// re-enrollment must never operate under the new generation). It owns the
// OWNER-CONSENT gates (approved + the permission-digest pair) and the
// run-generation precondition.

import { sha256Hex } from "./pure.js";

/** Prototype-safe own-property accessor (the same shape the other lib modules
 * carry locally). Page-derived descriptor inputs are never trusted blindly. */
function ownData(value, key) {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** The named denial reasons — the owner-facing diagnostic for each conjunct. */
export const WEBMCP_AUTHORITY_REASONS = Object.freeze([
  "not-enrolled",
  "site-policy-denied",
  "tool-not-in-directory",
  "not-approved",
  "run-generation-missing",
  "run-generation-stale",
  "permission-digest-drift",
]);

/** The pure authorization decision for one WebMCP tool invocation.
 *
 * Inputs are already-resolved facts (the caller does the async reads):
 *  - enrolled / enrollmentGen: the LIVE enrollment snapshot for the origin.
 *  - policy: the LIVE per-site tool-use policy ("allow" | "deny" | "ask" —
 *    CAP-FB-20260819-DIRECTORY-TOOL-EXPLORER-01). "deny" is the owner's
 *    block: it fails closed BEFORE every other conjunct so a stale catalog
 *    that still carries the site's records (built before the flip) can never
 *    invoke one of them. "ask" passes here — the per-call owner card is paid
 *    at dispatch time, not in the authorization decision (a run with no
 *    owner conversation must fail at the gate, never silently run).
 *  - toolPresent: the descriptor (name + dispatch source) still exists in the
 *    live directory (descriptor re-verification — a WHAT-runs fence).
 *  - approved: the live approval state (enrollment-derived since
 *    CAP-FB-20260824-WEBMCP-AUTOAPPROVE-01).
 *  - runGen: the invoking run's immutable captured enrollment generation, or
 *    null when the run never bound one (a wiring anomaly — fail closed, but
 *    NAMED, so it is diagnosable instead of a blind dead-end).
 *  - descriptorInput: the catalog descriptor input the selection was issued
 *    from; its permissionDigest is re-checked live (the owner-revocable
 *    consent bit), its grantDigest is echoed (the generation/document binding
 *    is enforced by documentId-addressed invocation, not by static equality —
 *    see the delegated-invocation fix).
 *
 * Returns { ok, reason, permissionDigest, grantDigest } — reason is "ok" on
 * success, else one of WEBMCP_AUTHORITY_REASONS naming the FIRST failing
 * conjunct (ordered owner-consent first, then execution identity). */
export function evaluateWebmcpAuthority({
  enrolled,
  enrollmentGen,
  policy,
  toolPresent,
  approved,
  runGen,
  descriptorInput,
} = {}) {
  const isApprovedLive = approved === true;
  const permissionDigest = sha256Hex(`approved:${isApprovedLive}`);
  const grantDigest = ownData(descriptorInput, "grantDigest") ?? "none";
  const expectedPermissionDigest =
    ownData(descriptorInput, "permissionDigest") ?? "none";
  let reason = "ok";
  if (enrolled !== true) reason = "not-enrolled";
  else if (policy === "deny") reason = "site-policy-denied";
  else if (toolPresent !== true) reason = "tool-not-in-directory";
  else if (!isApprovedLive) reason = "not-approved";
  else if (runGen == null) reason = "run-generation-missing";
  else if ((enrollmentGen ?? 0) !== runGen) reason = "run-generation-stale";
  else if (permissionDigest !== expectedPermissionDigest) {
    reason = "permission-digest-drift";
  }
  return Object.freeze({
    ok: reason === "ok",
    reason,
    permissionDigest,
    grantDigest,
  });
}

/** Build the live authorizationGuard for one enrolled origin's lazy WebMCP
 * sources — THE factory the service worker's readSiteLazySources uses, so the
 * shipped guard and the unit-tested guard are the SAME code (the lazy protocol
 * tests previously stubbed this surface, which is how the ReferenceError
 * shipped). `onDeny(decision, { name, origin })` is the diagnostics hook. */
export function createWebmcpAuthorizationGuard({
  origin,
  enrollmentSnapshot,
  listTools,
  isApproved,
  runGenCell,
  onDeny = null,
}) {
  return async ({ name, source, descriptorInput }) => {
    const nowEnrollment = await enrollmentSnapshot(origin);
    const current = (await listTools(origin)).find((row) =>
      row?.name === name && row?.source === source
    );
    const approved = current
      ? await isApproved(origin, name).catch(() => false)
      : false;
    const decision = evaluateWebmcpAuthority({
      enrolled: nowEnrollment?.enrolled === true,
      enrollmentGen: nowEnrollment?.gen ?? 0,
      policy: nowEnrollment?.policy ?? "allow",
      toolPresent: Boolean(current),
      approved,
      runGen: runGenCell?.get?.() ?? null,
      descriptorInput,
    });
    if (!decision.ok && typeof onDeny === "function") {
      try {
        onDeny(decision, { name, origin });
      } catch {
        // diagnostics must never break the fence
      }
    }
    return Object.freeze({
      ok: decision.ok,
      permissionDigest: decision.permissionDigest,
      grantDigest: decision.grantDigest,
      reason: decision.reason,
    });
  };
}

/** The dispatch-time gate for one WebMCP tool call (CAP-FB-20260819-DIRECTORY-
 * TOOL-EXPLORER-01) — THE gate readSiteLazySources' dispatch closure uses, so
 * the shipped fence and the unit-tested fence are the SAME code (same
 * zero-replica-drift rule that created this module). It re-checks the LIVE
 * enrollment + policy the moment a call is about to hit the page:
 *  - not enrolled → refused (never runs);
 *  - policy "deny" → refused with the named reason (a toolset built before a
 *    flip can never invoke one of the now-blocked tools);
 *  - policy "ask" → the owner gate pays the in-conversation Allow-once/Deny
 *    card; a run with NO owner gate (scoped/unattended) fails closed with an
 *    honest error — never a silent auto-run;
 *  - "allow" (and "ask" after the owner approved) → { ok: true }, and the
 *    caller proceeds to the ordinary invokeSiteTool fence (enrollment
 *    generation, descriptor, tab binding — nothing is weakened by the card).
 * @param {{ enrolled?: boolean, policy?: string, askGate?: Function|null,
 *           askPayload?: Object }} facts
 * @returns {Promise<{ ok: boolean, reason?: string, error?: string,
 *           approvalDenied?: boolean, approvalExpired?: boolean }>}
 */
export async function gateWebmcpToolDispatch({ enrolled, policy, askGate = null, askPayload = null } = {}) {
  if (enrolled !== true) {
    return Object.freeze({ ok: false, reason: "not-enrolled", error: "origin is not enrolled" });
  }
  if (policy === "deny") {
    return Object.freeze({
      ok: false,
      reason: "site-policy-denied",
      error: "site tools are blocked by the enrollment policy",
    });
  }
  if (policy === "ask") {
    if (typeof askGate !== "function") {
      return Object.freeze({
        ok: false,
        reason: "owner-approval-channel-missing",
        error: "site tools require owner approval, but this run has no approval channel",
      });
    }
    let res;
    try {
      res = await askGate(askPayload ?? {});
    } catch (e) {
      return Object.freeze({ ok: false, error: String(e?.message ?? e) });
    }
    if (res?.ok !== true) {
      return Object.freeze({
        ok: false,
        approvalDenied: res?.approvalDenied === true,
        approvalExpired: res?.approvalExpired === true,
        error: String(res?.error ?? "the owner did not approve this tool call"),
      });
    }
  }
  return Object.freeze({ ok: true });
}
