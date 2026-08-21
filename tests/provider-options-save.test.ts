// Production Settings provider-save sequencing regressions.
// @ts-nocheck — tiny DOM/message fakes drive the exported production binding.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  bindProviderSetDefault,
  providerFieldsFromCard,
  saveProviderFromCard,
} from "../extension/lib/provider-options-save.js";

class FakeButton {
  listener = null;
  addEventListener(type, listener) {
    if (type === "click") this.listener = listener;
  }
  click() {
    assert(this.listener, "the real Set/Update click handler was not bound");
    return this.listener({ type: "click", isTrusted: true });
  }
}

function providerCard({ baseURL, apiKey = "", model }) {
  const button = new FakeButton();
  const nodes = new Map([
    [".set-default", button],
    [".base-url", { value: baseURL }],
    [".api-key", { value: apiKey }],
    ["model-picker", { value: model }],
  ]);
  return {
    button,
    querySelector(selector) {
      return nodes.get(selector) ?? null;
    },
  };
}

const provider = {
  id: "openai-compatible",
  name: "OpenAI-compatible",
  baseURL: "",
};

Deno.test("provider save: Options uses the guarded production binding and no page storage mutation", async () => {
  const optionsSource = await Deno.readTextFile(
    new URL("../extension/options/options.js", import.meta.url),
  );
  const saveSource = await Deno.readTextFile(
    new URL("../extension/lib/provider-options-save.js", import.meta.url),
  );
  const binding = optionsSource.indexOf("bindProviderSetDefault({");
  const guard = optionsSource.indexOf(
    "blockSessionOnlyCredentialSave(credentialInput, durabilityWarning)",
    binding,
  );
  assert(
    binding >= 0 && guard > binding,
    "production binding must install the durability guard",
  );
  assert(saveSource.includes('type: "provider.set"'));
  assertEquals(
    /chrome\.storage|localStorage|sessionStorage/.test(saveSource),
    false,
    "the save path has no direct storage mutation",
  );
});

Deno.test("provider save: synchronous durability block precedes host request and persistence", async () => {
  const card = providerCard({
    baseURL: "https://blocked.example/v1",
    apiKey: "must-not-enter-session-memory",
    model: "blocked-model",
  });
  const trace = [];
  bindProviderSetDefault({
    card,
    provider,
    currentConfig: { provider: "demo" },
    shouldBlock() {
      trace.push("durability-guard");
      return true;
    },
    requestHostAccess() {
      trace.push("permission");
      return Promise.resolve({ granted: true });
    },
    sendMessage(message) {
      trace.push(message.type);
      return Promise.resolve({});
    },
  });
  const result = await card.button.click();
  assertEquals(result, { blocked: true });
  assertEquals(trace, ["durability-guard"]);
});

Deno.test("provider save: denied host request still persists exact DOM provider/baseURL/model", async () => {
  const card = providerCard({
    baseURL: "https://denied.example/v1",
    apiKey: "key-sentinel",
    model: "free-text/model:exact-v3",
  });
  const messages = [];
  const outcome = await saveProviderFromCard({
    card,
    provider,
    currentConfig: { provider: "demo", baseURL: "", model: "" },
    requestHostAccess: async () => ({
      granted: false,
      error: "permission request denied",
    }),
    sendMessage: async (message) => {
      messages.push(structuredClone(message));
      return { provider: message.config.provider };
    },
    pendingAfterMs: 25,
  });
  assertEquals(outcome.access.status, "denied");
  assertEquals(messages, [{
    type: "provider.set",
    config: {
      provider: "openai-compatible",
      baseURL: "https://denied.example/v1",
      apiKey: "key-sentinel",
      model: "free-text/model:exact-v3",
    },
  }]);
});

Deno.test("provider save: hung host prompt persists before bounded pending and does not fabricate denial", async () => {
  const card = providerCard({
    baseURL: "https://hung.example/v1",
    model: "hung-model-exact",
  });
  const trace = [];
  let saved = null;
  const never = new Promise(() => {});
  const started = performance.now();
  const outcome = await saveProviderFromCard({
    card,
    provider,
    currentConfig: { provider: "demo" },
    requestHostAccess(fields) {
      trace.push(`permission:${fields.model}`);
      return never;
    },
    async sendMessage(message) {
      trace.push(message.type);
      saved = structuredClone(message.config);
      return { provider: message.config.provider };
    },
    pendingAfterMs: 15,
  });
  assertEquals(
    trace,
    ["permission:hung-model-exact", "provider.set"],
    "permission begins first, but is never awaited before persistence",
  );
  assertEquals(saved?.provider, "openai-compatible");
  assertEquals(saved?.baseURL, "https://hung.example/v1");
  assertEquals(saved?.model, "hung-model-exact");
  assertEquals(outcome.access, { status: "pending", result: null });
  assert(performance.now() - started < 500, "pending UI is bounded");
});

Deno.test("provider save: model picker committed value is read exactly", () => {
  const exact = "  org/model:Preview+Case  ";
  const card = providerCard({
    baseURL: "https://models.example/v1",
    model: exact,
  });
  const fields = providerFieldsFromCard(card, provider, { provider: "demo" });
  assertEquals(fields.model, exact);
});

Deno.test("provider save: unblocked real binding starts permission then persists and provider.get observes it", async () => {
  const card = providerCard({
    baseURL: "https://real-handler.example/v1",
    model: "real-handler-model",
  });
  let stored = { provider: "demo", baseURL: "", model: "" };
  const statuses = [];
  const trace = [];
  const sendMessage = async (message) => {
    trace.push(message.type);
    if (message.type === "provider.set") {
      stored = structuredClone(message.config);
      return { ...stored, apiKey: "", hasApiKey: false };
    }
    if (message.type === "provider.get") return structuredClone(stored);
    throw new Error(`unexpected route ${message.type}`);
  };
  bindProviderSetDefault({
    card,
    provider,
    currentConfig: stored,
    shouldBlock: () => {
      trace.push("durability-guard");
      return false;
    },
    requestHostAccess: async () => {
      trace.push("permission");
      return { granted: false, error: "permission request denied" };
    },
    sendMessage,
    pendingAfterMs: 25,
    onAccess: (access) => statuses.push(access.status),
  });
  await card.button.click();
  const readback = await sendMessage({ type: "provider.get" });
  assertEquals(readback.provider, "openai-compatible");
  assertEquals(readback.baseURL, "https://real-handler.example/v1");
  assertEquals(readback.model, "real-handler-model");
  assertEquals(statuses, ["denied"]);
  assertEquals(trace.slice(0, 3), [
    "durability-guard",
    "permission",
    "provider.set",
  ]);
});
