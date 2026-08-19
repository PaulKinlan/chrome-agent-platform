// Settings per-agent provider saves must complete the owner-approval capability
// lifecycle: first request, explicit decision, then one exact retry.
// @ts-nocheck — message transport is an intentionally small deterministic fake.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runOwnerApprovedMutation } from "../extension/lib/owner-approved-mutation.js";

const REQUIRED = "This operation requires owner approval in Settings.";

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

Deno.test("provider Save UI: only a trusted active owner click can confirm the native modal", async () => {
  const source = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
  assert(source.includes('dialog.className = "recipe-edit provider-approval-dialog"'), "the product renders an explicit native approval dialog");
  assert(source.includes('if (!event.isTrusted || navigator.userActivation?.isActive !== true)'), "approval checks browser-trusted click + active user activation");
  assert(source.includes('decision = true;\n      dialog.close();'), "only the guarded approval branch returns true");
  assert(source.includes('runOwnerApprovedMutation({'), "Save uses the pending/resolve/retry lifecycle");
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
