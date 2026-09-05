// lib/webmcp-authority.js — live WebMCP enrollment, exact-tool consent and
// run-generation authorization. The model may discover an ASK tool, validate
// its arguments, and then pause on the owner card; DENY and every stale fence
// fail before page dispatch, while after-dispatch publication requires a live
// durable Allow.

import { sha256Hex } from "./pure.js";

/** Prototype-safe own-property accessor for page-derived descriptor inputs. */
function ownData(value, key) {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export const WEBMCP_AUTHORITY_REASONS = Object.freeze([
  "not-enrolled",
  "site-policy-denied",
  "tool-not-in-directory",
  "tool-consent-denied",
  "tool-consent-required",
  "tool-consent-generation-stale",
  "run-generation-missing",
  "run-generation-stale",
  "permission-digest-drift",
]);

/** Stable execution-realm generation for a site tool. Snapshot `seq` is an
 * authenticated replay/order fence, not a new execution realm: identical
 * asynchronous discovery re-polls must not invalidate an in-flight owner card
 * after the page action has already run. Tool-definition drift is fenced by
 * the descriptor + consent identity digests; navigation remains fenced by the
 * exact document and monotonic epoch. */
export function siteToolSourceGeneration(enrollmentGen, binding = {}) {
  const documentId = ownData(binding, "documentId");
  const epoch = ownData(binding, "epoch");
  return [
    `enrollment:${Number.isSafeInteger(enrollmentGen) && enrollmentGen >= 0 ? enrollmentGen : 0}`,
    `document:${typeof documentId === "string" && documentId.length <= 200 ? documentId : ""}`,
    `epoch:${Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0}`,
  ].join(":");
}

/** Catalog identity for a consent snapshot. Every authority mutation advances
 * revision, invalidating already-issued selections. Descriptor drift changes
 * identityDigest even before a decision is stored. */
export function siteToolConsentPermissionDigest(consent) {
  const identityDigest = ownData(consent, "identityDigest");
  const enrollmentGen = ownData(consent, "enrollmentGen");
  const revision = ownData(consent, "revision");
  const state = ownData(consent, "state");
  if (
    typeof identityDigest !== "string" || !/^[0-9a-f]{64}$/u.test(identityDigest) ||
    !Number.isSafeInteger(enrollmentGen) || enrollmentGen < 1 ||
    !Number.isSafeInteger(revision) || revision < 0 ||
    (state !== "ask" && state !== "allowed" && state !== "denied")
  ) return "invalid";
  return sha256Hex(`webmcp-consent-v1\u0000${identityDigest}\u0000${enrollmentGen}\u0000${revision}\u0000${state}`);
}

/** Pure authorization decision for one lazy-protocol phase. ASK is allowed only
 * before the dispatch closure, which owns the genuine first-use card. The live
 * after-dispatch check requires ALLOW, so reset/revoke withholds late output. */
export function evaluateWebmcpAuthority({
  enrolled,
  enrollmentGen,
  policy,
  toolPresent,
  consentState,
  consentEnrollmentGen,
  consentRevision,
  identityDigest,
  runGen,
  phase = "before-dispatch",
  descriptorInput,
} = {}) {
  const permissionDigest = siteToolConsentPermissionDigest({
    identityDigest,
    enrollmentGen: consentEnrollmentGen,
    revision: consentRevision,
    state: consentState,
  });
  const grantDigest = ownData(descriptorInput, "grantDigest") ?? "none";
  const expectedPermissionDigest = ownData(descriptorInput, "permissionDigest") ?? "none";
  let reason = "ok";
  if (enrolled !== true) reason = "not-enrolled";
  else if (policy === "deny") reason = "site-policy-denied";
  else if (toolPresent !== true) reason = "tool-not-in-directory";
  else if (consentState === "denied") reason = "tool-consent-denied";
  else if (consentState !== "ask" && consentState !== "allowed") reason = "tool-consent-required";
  else if (consentEnrollmentGen !== enrollmentGen) reason = "tool-consent-generation-stale";
  else if (phase === "after-dispatch" && consentState !== "allowed") reason = "tool-consent-required";
  else if (runGen == null) reason = "run-generation-missing";
  else if ((enrollmentGen ?? 0) !== runGen) reason = "run-generation-stale";
  else if (permissionDigest !== expectedPermissionDigest) reason = "permission-digest-drift";
  return Object.freeze({
    ok: reason === "ok",
    reason,
    permissionDigest,
    grantDigest,
    consentState,
  });
}

/** Build the exact live guard used by readSiteLazySources. */
export function createWebmcpAuthorizationGuard({
  origin,
  enrollmentSnapshot,
  listTools,
  consentSnapshot,
  runGenCell,
  onDeny = null,
}) {
  return async ({ name, source, args, phase, context, descriptorInput }) => {
    const nowEnrollment = await enrollmentSnapshot(origin);
    const current = (await listTools(origin)).find((row) =>
      row?.name === name && row?.source === source
    );
    let consent = null;
    try {
      consent = current
        ? await consentSnapshot(origin, name)
        : null;
    } catch {
      consent = null;
    }
    const decision = evaluateWebmcpAuthority({
      enrolled: nowEnrollment?.enrolled === true,
      enrollmentGen: nowEnrollment?.gen ?? 0,
      policy: nowEnrollment?.policy ?? "allow",
      toolPresent: Boolean(current),
      consentState: consent?.state ?? "invalid",
      consentEnrollmentGen: consent?.enrollmentGen ?? null,
      consentRevision: consent?.revision ?? null,
      identityDigest: consent?.identityDigest ?? "invalid",
      runGen: runGenCell?.get?.() ?? null,
      phase,
      descriptorInput,
    });
    if (!decision.ok && typeof onDeny === "function") {
      try {
        await onDeny(decision, { name, source, origin, args, phase, context, consent });
      } catch {
        // The call is already refused. Audit failure must never turn a denial
        // into permission; the service worker records a local diagnostic.
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

/** Dispatch-time first-use gate. Site policy is the coarse off switch; exact
 * durable consent decides whether to run, ask once, or sticky-block. */
export async function gateWebmcpToolDispatch({
  enrolled,
  policy,
  consentState,
  askGate = null,
  askPayload = null,
} = {}) {
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
  if (consentState === "denied") {
    return Object.freeze({
      ok: false,
      reason: "tool-consent-denied",
      approvalDenied: true,
      sticky: true,
      error: "the owner blocked this site tool; enable it in Settings to try again",
    });
  }
  if (consentState !== "ask" && consentState !== "allowed") {
    return Object.freeze({ ok: false, reason: "tool-consent-unavailable", error: "site tool consent is unavailable" });
  }
  if (consentState === "ask") {
    if (typeof askGate !== "function") {
      return Object.freeze({
        ok: false,
        reason: "owner-approval-channel-missing",
        error: "this site tool needs first-use approval, but this run has no owner conversation",
      });
    }
    let result;
    try {
      result = await askGate(askPayload ?? {});
    } catch (error) {
      return Object.freeze({ ok: false, reason: "owner-approval-failed", error: String(error?.message ?? error) });
    }
    if (result?.ok !== true) {
      return Object.freeze({
        ok: false,
        reason: result?.reason ?? "owner-approval-denied",
        approvalDenied: result?.approvalDenied === true,
        approvalExpired: result?.approvalExpired === true,
        sticky: result?.sticky === true,
        error: String(result?.error ?? "the owner did not allow this site tool"),
      });
    }
  }
  return Object.freeze({ ok: true });
}
