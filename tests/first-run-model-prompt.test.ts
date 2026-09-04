// tests/first-run-model-prompt.test.ts — chrome-agent-platform-zbe5: alert
// the user when no model is configured after entering an API key without
// pressing Use. Two falsifiable layers:
//  1. modelPromptState (pure): the Settings card shows "Confirm a model to
//     continue" exactly when a key is present, no model is confirmed, and the
//     provider is not already saved — with the catalogue default suggested.
//  2. The first run on an UNCONFIGURED profile says so in-context (once per
//     surface) instead of letting the demo answer pass as the user's provider.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { modelPromptState } from "../extension/lib/first-run-model-prompt.js";

// ── 1. the pure decision ───────────────────────────────────────────────────

Deno.test("model prompt: key entered + no model + not saved → prompt with the catalogue default suggested", () => {
  const s = modelPromptState({ providerId: "anthropic", apiKey: "sk-ant-x", modelValue: "", isActive: false });
  assertEquals(s.show, true);
  assert(s.suggestedModel.length > 0, "a catalogue default is suggested");
  assert(s.message.includes("Confirm a model to continue"), "the message names the next step");
  assert(s.message.includes(s.suggestedModel), "the message names the suggested model");
  assert(s.message.includes("Use"), "the message names the button that saves");
});

Deno.test("model prompt: no key → no prompt", () => {
  assertEquals(modelPromptState({ providerId: "anthropic", apiKey: "", modelValue: "" }).show, false);
  assertEquals(modelPromptState({ providerId: "anthropic", apiKey: "   ", modelValue: "" }).show, false);
});

Deno.test("model prompt: key + confirmed model → no prompt", () => {
  assertEquals(modelPromptState({ providerId: "anthropic", apiKey: "sk-ant-x", modelValue: "claude-sonnet-5" }).show, false);
});

Deno.test("model prompt: the already-saved default (Update flow) is never nagged", () => {
  assertEquals(modelPromptState({ providerId: "anthropic", apiKey: "sk-ant-x", modelValue: "", isActive: true }).show, false);
});

Deno.test("model prompt: a provider without a catalogue default asks for an explicit choice", () => {
  const s = modelPromptState({ providerId: "no-such-provider", apiKey: "k", modelValue: "" });
  assertEquals(s.show, true);
  assertEquals(s.suggestedModel, "");
  assert(s.message.includes("choose a model"), "no phantom suggestion — an explicit choice is asked");
});

// ── 2. the first-run in-context notice ─────────────────────────────────────

type Bubble = { role: string; content: string };

function makeContainer(bubbles: Bubble[]) {
  return {
    appendUser(text: string) { bubbles.push({ role: "user", content: text }); },
    appendAgent(text: string) { bubbles.push({ role: "agent", content: text }); },
    appendSystem(text: string) { bubbles.push({ role: "system", content: text }); },
    appendError(text: string) { bubbles.push({ role: "error", content: text }); },
    appendTool() { return { setAttribute() {} }; },
  };
}

function installUnconfiguredChrome(configured: boolean) {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg: { type: string; task?: string }, cb: (res: unknown) => void) {
        if (msg.type === "provider.permission-summary") {
          queueMicrotask(() => cb({ ok: true, provider: "demo", local: true, origin: null, reason: "", configured }));
          return;
        }
        if (msg.type === "agent.run") {
          queueMicrotask(() => cb({ ok: true, threadId: "t_first", executionId: "exec_first", result: "[demo] answer" }));
          return;
        }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener() {} },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
  };
}

Deno.test("first run: an unconfigured profile gets the honest 'no model configured' notice and the demo run still proceeds", async () => {
  installUnconfiguredChrome(false);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const res = await runConversationTurn(makeContainer(bubbles) as never, { text: "hello" } as never);
  assertEquals(res.ok, true, "the demo run still proceeds");
  const notice = bubbles.filter((b) => b.role === "system" && /No model is configured yet/.test(b.content));
  assertEquals(notice.length, 1, "exactly one honest notice");
  assert(notice[0].content.includes("Settings → Providers"), "the notice names where to configure a model");
  assert(notice[0].content.includes("confirm a model"), "the notice says what to confirm");
  assert(bubbles.some((b) => b.role === "agent" && b.content === "[demo] answer"), "the demo answer still arrives");
});

Deno.test("first run: the notice appears once per surface, never per turn", async () => {
  installUnconfiguredChrome(false);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const container = makeContainer(bubbles) as never;
  await runConversationTurn(container, { text: "one" } as never);
  await runConversationTurn(container, { text: "two" } as never);
  const notices = bubbles.filter((b) => b.role === "system" && /No model is configured yet/.test(b.content));
  assertEquals(notices.length, 1, "the second turn on the same surface adds no second notice");
});

Deno.test("first run: a configured profile gets no notice", async () => {
  installUnconfiguredChrome(true);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const res = await runConversationTurn(makeContainer(bubbles) as never, { text: "hello" } as never);
  assertEquals(res.ok, true);
  assertEquals(bubbles.filter((b) => /No model is configured/.test(b.content)).length, 0, "no notice when configured");
});

// ── 3. source pins ─────────────────────────────────────────────────────────

Deno.test("source pin: the permission-summary route reports the redacted configured boolean", async () => {
  const route = await Deno.readTextFile(new URL("../extension/background/routes/provider.js", import.meta.url));
  const summaryBlock = route.slice(route.indexOf('"provider.permission-summary"'));
  assert(summaryBlock.includes("configured: keyedProviderConfigured(cfg)"), "the summary carries the configured boolean");
  assert(!summaryBlock.slice(0, 1200).includes("apiKey:"), "the summary never carries the key");
});

Deno.test("source pin: options.js renders the prompt from the pure decision (never its own copy)", async () => {
  const options = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
  assert(options.includes('import { modelPromptState } from "../lib/first-run-model-prompt.js"'), "options.js consumes the pure decision");
  assert(options.includes("model-prompt"), "options.js renders the prompt row");
});
