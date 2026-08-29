// Settings per-agent provider saves must complete the owner-approval capability
// lifecycle: first request, explicit decision, then one exact retry.
// @ts-nocheck — message transport is an intentionally small deterministic fake.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runOwnerApprovedMutation } from "../extension/lib/owner-approved-mutation.js";

const REQUIRED = "This operation requires owner approval.";

function providerService(initial) {
  let saved = structuredClone(initial);
  let pending = null;
  let approved = false;
  const messages = [];
  return {
    messages,
    get saved() { return structuredClone(saved); },
    async send(message) {
      messages.push(structuredClone(message));
      if (message.type === "management.pending-approvals") {
        return { ok: true, approvals: pending && !approved ? [{ approvalId: pending, action: "named-agent.set-provider", targetRef: "private-ref" }] : [] };
      }
      if (message.type === "management.resolve-approval") {
        if (message.approvalId !== pending || approved) return { ok: false, error: "no such pending approval" };
        if (message.approve !== true) { pending = null; return { ok: true, decision: "denied" }; }
        approved = true;
        return { ok: true, decision: "approved" };
      }
      if (message.type === "named-agent.set-provider") {
        if (!approved) {
          pending ??= "ap-provider";
          return { ok: false, error: REQUIRED };
        }
        approved = false;
        pending = null;
        const next = structuredClone(message.config);
        if (!("apiKey" in next) && saved?.provider === next?.provider) next.apiKey = saved.apiKey;
        saved = next;
        return { ok: true, agent: { id: message.id, provider: { ...next, apiKey: undefined } } };
      }
      return { ok: false, error: "unknown" };
    },
  };
}

Deno.test("provider Save UI: only a trusted active owner click can confirm the modal", async () => {
  // The approval dialog was a hand-rolled <dialog> in options.js and this test
  // pinned its exact source lines. It is now the SHARED confirm
  // (CAP-FB-20260827-DIALOG-CONSOLIDATION-01), so the guarantee spans two
  // files: the call site must ASK for the genuine-gesture check, and the shared
  // component must IMPLEMENT it. Both halves are pinned — asserting only the
  // call site would let the flag become a no-op, and asserting only the
  // component would let this call site quietly stop passing it.
  const options = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
  const components = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));

  // -- the call site asks for it, and is a real approval dialog --
  assert(
    /confirmAgentProviderMutation[\s\S]{0,600}?requireGenuineGesture:\s*true/.test(options),
    "the provider approval requests the genuine-gesture check",
  );
  assert(options.includes('title: "Approve provider change?"'), "the product renders an explicit approval dialog");
  assert(options.includes("runOwnerApprovedMutation({"), "Save uses the pending/resolve/retry lifecycle");
  // The hand-rolled duplicate must not come back — that is what made this
  // property re-implementable (and forgettable) in the first place.
  assert(
    !/confirmAgentProviderMutation[\s\S]{0,800}?createElement\("dialog"\)/.test(options),
    "the approval must not hand-roll its own <dialog> again",
  );

  // -- the shared component implements it, and gates the TRUE result on it --
  assert(
    components.includes("!event.isTrusted || navigator.userActivation?.isActive !== true"),
    "the shared confirm checks browser-trusted click + active user activation",
  );
  const acceptHandler = components.slice(
    components.indexOf('accept.addEventListener("click"'),
    components.indexOf('accept.addEventListener("click"') + 500,
  );
  assert(
    acceptHandler.includes("requireGenuineGesture") && acceptHandler.includes("return;"),
    "the guard sits in the accept path and refuses, rather than merely warning",
  );
  assert(
    acceptHandler.indexOf("requireGenuineGesture") < acceptHandler.indexOf("settle(true)"),
    "the guard runs BEFORE the dialog can resolve true",
  );
});

Deno.test("provider Save: explicit approval resolves then retries the exact mutation once", async () => {
  const service = providerService({ provider: "deepseek", model: "old", apiKey: "key-sentinel" });
  const message = {
    type: "named-agent.set-provider",
    id: "agent-a",
    config: { provider: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "custom-model-sentinel" },
  };
  let confirmations = 0;
  const result = await runOwnerApprovedMutation({
    message,
    action: "named-agent.set-provider",
    sendMessage: (value) => service.send(value),
    requestConfirmation: async () => { confirmations++; return true; },
  });

  assertEquals(result.ok, true);
  assertEquals(confirmations, 1, "the owner sees exactly one explicit confirmation");
  const writes = service.messages.filter((entry) => entry.type === "named-agent.set-provider");
  assertEquals(writes.length, 2, "one pending request + one post-approval retry");
  assertEquals(writes[0], message);
  assertEquals(writes[1], message, "the approved retry is byte-for-value identical");
  assertEquals(service.saved.model, "custom-model-sentinel");
  assertEquals(service.saved.apiKey, "key-sentinel", "an omitted same-provider key sentinel is preserved");
});

Deno.test("provider Save: cancel denies the pending capability and performs no write", async () => {
  const before = { provider: "deepseek", model: "before", apiKey: "never-write" };
  const service = providerService(before);
  const result = await runOwnerApprovedMutation({
    message: { type: "named-agent.set-provider", id: "agent-a", config: { provider: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.7-pro", apiKey: "" } },
    action: "named-agent.set-provider",
    sendMessage: (value) => service.send(value),
    requestConfirmation: async () => false,
  });

  assertEquals(result.ok, false);
  assertEquals(result.cancelled, true);
  assertEquals(service.saved, before, "cancel never persists the candidate config");
  assertEquals(service.messages.filter((entry) => entry.type === "named-agent.set-provider").length, 1, "cancel never performs the second call");
  assert(service.messages.some((entry) => entry.type === "management.resolve-approval" && entry.approve === false), "cancel removes the pending approval");
});

Deno.test("provider Save: ambiguous/stale approval rows fail closed without confirmation or retry", async () => {
  const service = providerService({ provider: "deepseek", model: "before", apiKey: "sentinel" });
  let confirmations = 0;
  const sendMessage = async (message) => {
    const response = await service.send(message);
    if (message.type === "management.pending-approvals" && response.approvals?.length === 1) {
      response.approvals.push({ approvalId: "ap-racing", action: "named-agent.set-provider", targetRef: "other" });
    }
    return response;
  };
  const result = await runOwnerApprovedMutation({
    message: { type: "named-agent.set-provider", id: "agent-a", config: null },
    action: "named-agent.set-provider",
    sendMessage,
    requestConfirmation: async () => { confirmations++; return true; },
  });
  assertEquals(result.ok, false);
  assertEquals(result.stale, true);
  assertEquals(confirmations, 0);
  assertEquals(service.messages.filter((entry) => entry.type === "named-agent.set-provider").length, 1);
});
