// @ts-nocheck
// tests/mutation-claim-check.test.ts — runtime honesty backstop for mutation
// claims (the prompt clause alone depends on model compliance — the owner's
// "I created the agent" with ZERO tool calls must be caught at runtime).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { correctUnsupportedMutationClaims } from "../extension/lib/mutation-claim-check.js";
import { toolRowsFromRunLog } from "../extension/shared/conversation.js";

Deno.test("claim-check: a fabricated create claim with NO tool call is detected and corrected", () => {
  const { text, corrections } = correctUnsupportedMutationClaims(
    "Done — I've created the Research Analyst agent for you.",
    [],
  );
  assertEquals(corrections.length, 1);
  assertStringIncludes(text, "Correction");
  assertStringIncludes(text, "no such change was made");
});

Deno.test("claim-check: passive claim shapes are caught too", () => {
  for (const t of [
    "The agent was created successfully.",
    "Your agent is now scheduled.",
    "The agent has been deleted.",
    "The agent was updated.",
  ]) {
    const { corrections } = correctUnsupportedMutationClaims(t, []);
    assertEquals(corrections.length, 1, `expected correction for: ${t}`);
  }
});

Deno.test("claim-check: a claim BACKED by a successful create_named_agent is not flagged", () => {
  const { text, corrections } = correctUnsupportedMutationClaims(
    "I've created the Research Analyst agent.",
    ["search_tools", "create_named_agent"],
  );
  assertEquals(corrections.length, 0);
  assertEquals(text, "I've created the Research Analyst agent.");
});

Deno.test("claim-check: a claim backed only by a FAILED call is still flagged", () => {
  // Failed calls never enter the successful set — only the reads did.
  const { corrections } = correctUnsupportedMutationClaims(
    "I've created the agent.",
    ["search_tools", "list_named_agents"],
  );
  assertEquals(corrections.length, 1);
});

Deno.test("claim-check: update/delete/schedule claims each need their own backing tool", () => {
  assertEquals(correctUnsupportedMutationClaims("I updated the agent.", ["update_named_agent"]).corrections.length, 0);
  assertEquals(correctUnsupportedMutationClaims("I deleted the agent.", ["delete_named_agent"]).corrections.length, 0);
  assertEquals(correctUnsupportedMutationClaims("I scheduled the agent.", ["schedule_task"]).corrections.length, 0);
  // The WRONG kind of success does not back the claim.
  assertEquals(correctUnsupportedMutationClaims("I deleted the agent.", ["create_named_agent"]).corrections.length, 1);
  assertEquals(correctUnsupportedMutationClaims("I scheduled the task.", ["create_named_agent"]).corrections.length, 1);
});

Deno.test("claim-check: non-claim text passes through untouched", () => {
  for (const t of [
    "Here's the list of agents you currently have.",
    "I couldn't create the agent — the tool call failed.",
    "To create an agent, ask me and I'll run the tool.",
    "",
  ]) {
    const { text, corrections } = correctUnsupportedMutationClaims(t, []);
    assertEquals(corrections.length, 0, `false positive on: ${t}`);
    assertEquals(text, t);
  }
});

Deno.test("claim-check: multiple unsupported claims each get a correction", () => {
  const { corrections } = correctUnsupportedMutationClaims(
    "I created the agent and then deleted the agent.",
    [],
  );
  assertEquals(corrections.length, 2);
});

Deno.test("claim-check: NEGATED claims are NOT corrected (no false positives)", () => {
  for (const t of [
    "I haven't created the agent yet — the tool call was denied.",
    "I did not delete the agent.",
    "I've not scheduled the task.",
    "I couldn't update the agent — it failed.",
    "I never created the agent.",
  ]) {
    const { text, corrections } = correctUnsupportedMutationClaims(t, []);
    assertEquals(corrections.length, 0, `false correction on negation: ${t}`);
    assertEquals(text, t);
  }
});

Deno.test("claim-check: THIRD-PARTY statements are NOT corrected", () => {
  for (const t of [
    "OpenAI created an agent last week.",
    "The system created an agent for the demo.",
    "Another process deleted the agent.",
    "The scheduler service scheduled the task.",
  ]) {
    const { text, corrections } = correctUnsupportedMutationClaims(t, []);
    assertEquals(corrections.length, 0, `false correction on third-party: ${t}`);
    assertEquals(text, t);
  }
});

Deno.test("claim-check: first-person / terse / coordinated / passive TRUE positives still caught", () => {
  for (const t of [
    "I've created the agent.",
    "I created the agent.",
    "We created the agent.",
    "Our team created the agent.",
    "Created the agent for you.",
    "Successfully created the agent.",
    "Done — created the agent.",
    "All set — created the agent.",
    "Done! Created the agent.",
    "I created the agent and then deleted the agent.",
    "The Research Analyst agent was created successfully.",
    "Your agent is now scheduled.",
    "The agent has been deleted.",
  ]) {
    const { corrections } = correctUnsupportedMutationClaims(t, []);
    assert(corrections.length >= 1, `missed true claim: ${t}`);
  }
});

Deno.test("claim-check: first-person framing does not override a subordinate third-party subject", () => {
  for (const t of [
    "I confirmed that OpenAI created an agent.",
    "We reported that the system deleted the agent.",
  ]) {
    const { text, corrections } = correctUnsupportedMutationClaims(t, []);
    assertEquals(corrections.length, 0, `false correction on mixed subject: ${t}`);
    assertEquals(text, t);
  }
});

Deno.test("claim-check: a subjectless modifier-led action report is corrected", () => {
  const { corrections } = correctUnsupportedMutationClaims("Already created the agent.", []);
  assertEquals(corrections.length, 1);
});

Deno.test("claim-check: country US is not first-person evidence", () => {
  const text = "US researchers created an agent.";
  const out = correctUnsupportedMutationClaims(text, []);
  assertEquals(out.corrections.length, 0);
  assertEquals(out.text, text);
});

Deno.test("claim-check: object-pronoun us is not first-person evidence", () => {
  const text = "The vendor asked us to verify the tool created an agent.";
  const out = correctUnsupportedMutationClaims(text, []);
  assertEquals(out.corrections.length, 0);
  assertEquals(out.text, text);
});

Deno.test("claim-check: omitted-that complement keeps its third-party subject", () => {
  const text = "I confirmed OpenAI created an agent.";
  const out = correctUnsupportedMutationClaims(text, []);
  assertEquals(out.corrections.length, 0);
  assertEquals(out.text, text);
});

Deno.test("claim-check: long complement keeps its third-party subject", () => {
  const text = "I confirmed that the external OpenAI platform research team created an agent.";
  const out = correctUnsupportedMutationClaims(text, []);
  assertEquals(out.corrections.length, 0);
  assertEquals(out.text, text);
});

// ── Run-level: the correction must reach the AUTHORITATIVE returned result ──
// (the conversation paints the SW's res.result, not the progress `done` event),
// a FAILED nested lazy dispatch must not back a claim, and the success set
// must not leak across runs.

import { tool } from "ai";
import { z } from "zod";
import { createAgent } from "../extension/lib/agent.js";
import { installFakeIdb, resetFakeIdb, clearFaults } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";

globalThis.chrome = globalThis.chrome ?? { permissions: { contains: async () => false }, storage: undefined };
resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); clearFaults();

const CLAIM_TEXT = "Done — I've created the Research Analyst agent for you.";
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function lastUserText(prompt) {
  // Concatenate ALL text parts across the prompt (the task may not be the
  // last message once system/history frames are in).
  let out = "";
  for (const msg of prompt ?? []) {
    const c = msg?.content;
    if (typeof c === "string") out += c;
    else if (Array.isArray(c)) for (const p of c) { if (p?.type === "text") out += p.text ?? ""; }
  }
  return out;
}

function selectionRefFrom(prompt) {
  const toolMessage = [...prompt].reverse().find((m) => m?.role === "tool");
  if (!toolMessage) return null;
  try { return JSON.stringify(toolMessage).match(/sel_[a-f0-9]{36}/u)?.[0] ?? null; } catch { return null; }
}

// A scripted model: "@test-claim-only" claims a create with NO tool calls;
// "@test-create" runs the REAL lazy search→execute dance for create_named_agent
// and then claims it. Anything else is a plain text turn.
function scriptedModel() {
  const generate = (options) => {
    const prompt = options.prompt;
    const text = lastUserText(prompt);
    const steps = prompt.filter((m) => m?.role === "tool").length;
    const claimOnly = /@test-claim-only/u.test(text);
    const wantsCreate = /@test-create/u.test(text);
    let content, finishReason;
    // agent-do re-prompts with the tool history STRIPPED for the continuation
    // step — re-emit the EXACT final text to end the loop (the demo model's
    // alreadyFinal pattern).
    if (text.includes(CLAIM_TEXT)) {
      content = [{ type: "text", text: CLAIM_TEXT }];
      finishReason = "stop";
    } else if (wantsCreate && steps === 0) {
      content = [{ type: "tool-call", toolCallId: "c_search", toolName: "search_tools", input: JSON.stringify({ query: "create_named_agent", limit: 1 }) }];
      finishReason = "tool-calls";
    } else if (wantsCreate && steps === 1) {
      const ref = selectionRefFrom(prompt);
      if (!ref) throw new Error("no selectionRef in prompt after search");
      content = [{ type: "tool-call", toolCallId: "c_exec", toolName: "execute_tool", input: JSON.stringify({ selectionRef: ref, arguments: { name: "Research Analyst", role: "checks things" } }) }];
      finishReason = "tool-calls";
    } else if (wantsCreate || claimOnly) {
      content = [{ type: "text", text: CLAIM_TEXT }];
      finishReason = "stop";
    } else {
      content = [{ type: "text", text: "ok" }];
      finishReason = "stop";
    }
    return { content, finishReason, usage, warnings: [] };
  };
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "test-scripted",
    supportedUrls: {},
    doGenerate: (options) => Promise.resolve(generate(options)),
    doStream(options) {
      const result = generate(options);
      const stream = new ReadableStream({
        start(controller) {
          const first = result.content[0];
          if (first?.type === "tool-call") {
            controller.enqueue({ type: "tool-call", toolCallId: first.toolCallId, toolName: first.toolName, input: first.input });
            controller.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
          } else {
            const id = "t1";
            controller.enqueue({ type: "text-start", id });
            controller.enqueue({ type: "text-delta", id, delta: first?.text ?? "" });
            controller.enqueue({ type: "text-end", id });
            controller.enqueue({ type: "finish", usage, finishReason: "stop" });
          }
          controller.close();
        },
      });
      return Promise.resolve({ stream });
    },
  };
}

function makeCreateTool(executeImpl) {
  return tool({
    description: "Create a named agent (test double).",
    inputSchema: z.object({ name: z.string(), role: z.string() }).passthrough(),
    execute: executeImpl,
  });
}

Deno.test("claim-check run: the correction reaches the RETURNED result (not just the progress event)", async () => {
  const agent = createAgent({ model: { model: scriptedModel(), providerName: "test", modelId: "test-scripted" }, id: "hub", name: "hub", memory: null });
  const result = await agent.run("@test-claim-only please", "ctx", []);
  assertEquals(typeof result, "string");
  assertStringIncludes(result, "⚠️ Correction");
  assertStringIncludes(result, "no such change was made");
});

Deno.test("claim-check run: a FAILED nested lazy dispatch publishes and replays as an error", async () => {
  let invoked = 0;
  const events = [];
  const failCreate = makeCreateTool(async () => { invoked++; return { ok: false, error: "owner approval required (test double)" }; });
  const agent = createAgent({
    model: { model: scriptedModel(), providerName: "test", modelId: "test-scripted" },
    id: "hub", name: "hub", memory: null,
    tools: { create_named_agent: failCreate },
    onProgress: (event) => events.push(event),
  });
  const result = await agent.run("@test-create the agent", "ctx", []);
  assertEquals(invoked, 1, "the real create tool ran (and failed)");
  assertStringIncludes(result, "⚠️ Correction");

  const failed = events.find((event) => event?.type === "tool-result" && event?.selectedTool === "create_named_agent");
  assert(failed, "the selected create tool publishes a result event");
  assertEquals(failed.ok, false, "the nested failure publishes ok:false");

  const rows = toolRowsFromRunLog("exec_failed_create", [
    { type: "tool-call", callId: "create_1", tool: "execute_tool", args: {}, at: 1 },
    { type: "tool-result", callId: "create_1", tool: "execute_tool", selectedTool: failed.selectedTool, result: failed.result, ok: failed.ok, at: 2 },
  ]);
  const row = rows.find((candidate) => candidate.role === "tool");
  assert(row, "durable replay produces a tool row");
  assertEquals(row.toolName, "create_named_agent");
  assertEquals(row.toolStatus, "error", "the failed selected tool replays as an error row");
  assertEquals(row.toolOk, false);
});

Deno.test("claim-check run: a SUCCESSFUL create backs the claim in ITS run but NOT the next run", async () => {
  let invoked = 0;
  const okCreate = makeCreateTool(async ({ name, role }) => { invoked++; return { ok: true, id: "na_test_1", name, role }; });
  const agent = createAgent({
    model: { model: scriptedModel(), providerName: "test", modelId: "test-scripted" },
    id: "hub", name: "hub", memory: null,
    tools: { create_named_agent: okCreate },
  });
  const run1 = await agent.run("@test-create the agent", "ctx", []);
  assertEquals(invoked, 1, "the real create tool ran");
  assertEquals(run1.includes("⚠️ Correction"), false, "a backed claim is NOT corrected:\n" + run1);
  // Run 2 claims a create with NO tool call — run 1's success must not leak.
  const run2 = await agent.run("@test-claim-only again", "ctx", []);
  assertStringIncludes(run2, "⚠️ Correction");
});

Deno.test("claim-check wiring: agent.js runs the check on the done path", async () => {
  const src = await Deno.readTextFile(new URL("../extension/lib/agent.js", import.meta.url));
  assertStringIncludes(src, 'from "./mutation-claim-check.js"');
  assertStringIncludes(src, "correctUnsupportedMutationClaims(e.result, okToolNames)");
  // The AUTHORITATIVE returned result gets the same correction.
  assertStringIncludes(src, "correctUnsupportedMutationClaims(result, okToolNames)");
  // The success set is per-run.
  assertStringIncludes(src, "okToolNames.clear()");
  // Nested lazy failures are not successes.
  assertStringIncludes(src, "lazyNestedFailure(e.result)");
});
