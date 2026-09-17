// tests/asset-update-owner-direct.test.ts — chrome-agent-platform-9mz1.
//
// The owner, live: editing an artifact through the extension's OWN UI raised
// "Permission request — The agent wants to asset.update: <id>. approvals are
// available only in Settings" — for his own edit, with no way to answer it in
// the surface that raised it.
//
// TWO FIXES, both pinned here:
//   1. WIDENING (reviewed, owner report + supervisor decision 2026-09-12):
//      the owner's own edit of an artifact body in an extension document IS the
//      approval — the same principle already audited for asset.delete /
//      asset.restore / named-agent.update / script.run / task.update. Before it,
//      the request was bound to `ui:<documentId>`, a row only the Settings
//      document may resolve, so the surface that raised the card could only ever
//      answer "approvals are available only in Settings" (reproduced in a real
//      browser: the write was refused and the content never changed).
//   2. HONEST REFUSAL: when an approval genuinely is needed, the refusal must
//      distinguish an EXPIRED request from one only Settings may decide, and it
//      must carry an actionable category so the existing "Fix in Settings"
//      affordance appears.
//
// The model/agent path is NOT widened: it is proven refused, with a mutant that
// would allow it.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  DESTRUCTIVE_ACTIONS,
  OWNER_DIRECT_ACTIONS,
  approvalResolutionRefusal,
  isOwnerDirectApproval,
  mayResolveApproval,
} from "../extension/lib/owner-approval.js";
import { runStatusActionKind } from "../extension/shared/run-status.js";

const extensionDoc = { principal: "extension", documentId: "chat-doc-1" };
const settingsDoc = { principal: "owner-options", documentId: "settings-doc-1" };
const model = { principal: "model", documentId: "chat-doc-1", executionId: "run-1" };

Deno.test("asset.update: the owner's own edit in an extension document IS the approval", () => {
  assertEquals(isOwnerDirectApproval(extensionDoc, "asset.update"), true);
  assertEquals(isOwnerDirectApproval(settingsDoc, "asset.update"), true);
  assert(OWNER_DIRECT_ACTIONS.has("asset.update"), "the owner's own edit is owner-direct");
});

Deno.test("asset.update: a MODEL edit is still REFUSED owner-direct authority", () => {
  // The widening is extension-document-only. If this ever turns true, an agent
  // could edit artifacts without asking.
  assertEquals(isOwnerDirectApproval(model, "asset.update"), false);
  assert(DESTRUCTIVE_ACTIONS.has("asset.update"), "a model edit must still be able to request an approval");
});

Deno.test("asset.update: a page/content-script principal can never self-approve", () => {
  for (const principal of ["page", "content-script", "web", "", null, undefined]) {
    assertEquals(
      isOwnerDirectApproval({ principal, documentId: "chat-doc-1" }, "asset.update"),
      false,
      `principal ${JSON.stringify(principal)} must not be owner-direct`,
    );
  }
  // A browser-attested document identity is required (never read from a body).
  assertEquals(isOwnerDirectApproval({ principal: "extension" }, "asset.update"), false);
  assertEquals(isOwnerDirectApproval({ principal: "extension", documentId: "" }, "asset.update"), false);
});

Deno.test("the dead end that is now unreachable: a ui:-bound row is unanswerable by its own surface", () => {
  // The custody rule itself is untouched — this is WHY the owner's own edit must
  // not be routed into it.
  const uiBound = { runId: "ui:chat-doc-1", action: "asset.update", target: "opaque", digest: "d".repeat(64) };
  assertEquals(mayResolveApproval(uiBound, "extension", "chat-doc-1"), false);
  assertEquals(mayResolveApproval(uiBound, "owner-options", "settings-doc-1"), true);
  // A run-bound row (a model edit) IS resolvable inline by the originating
  // conversation — the inline path the owner asked for, which the model case has.
  const runBound = { runId: "run-1", action: "asset.update", target: "opaque", digest: "d".repeat(64) };
  assertEquals(mayResolveApproval(runBound, "extension", "chat-doc-1"), true);
});

Deno.test("honest refusal: EXPIRED is not an authority problem", () => {
  const uiBound = { runId: "ui:other-doc", action: "asset.update" };
  const runBound = { runId: "run-1", action: "asset.update" };

  // An expired (or unknown) request must NOT claim approvals live only in
  // Settings — the owner would go there and find nothing.
  const expired = approvalResolutionRefusal(undefined, "extension", "chat-doc-1");
  assert(/expired/i.test(expired), expired);
  assert(!/only in Settings/i.test(expired), expired);

  // A row this surface may not decide names the real route.
  const authority = approvalResolutionRefusal(uiBound, "extension", "chat-doc-1");
  assert(/Settings/i.test(authority), authority);

  // An allowed resolution has no refusal at all.
  assertEquals(approvalResolutionRefusal(runBound, "extension", "chat-doc-1"), "");
  assertEquals(approvalResolutionRefusal(uiBound, "owner-options", "settings-doc-1"), "");
});

Deno.test("honest refusal: the owner-approval category offers the Settings route", () => {
  // The refusal carries errorCategory "owner-approval" (the service worker); the
  // run-status projection turns that into the EXISTING "Fix in Settings"
  // affordance rather than a dead sentence.
  assertEquals(runStatusActionKind({ state: "failed", errorCategory: "owner-approval" }), "settings");
  // And a category nobody can act on still yields no button.
  assertEquals(runStatusActionKind({ state: "failed", errorCategory: "harness-error" }), null);
});
