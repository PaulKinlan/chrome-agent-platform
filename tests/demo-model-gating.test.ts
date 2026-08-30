// @ts-nocheck
// tests/demo-model-gating.test.ts — the demo provider is a plumbing proof, not
// a demo (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01).
//
// (1) The "demo" provider resolves to the LOCAL ASSISTANT unless the developer
//     flag (`cap:developerFeatures === true` in kv) is on — the "[demo model]
//     Task received (N chars)" literal is unreachable from a default build.
// (2) The @demo-delegate-agent marker accepts an ORIGIN as the agent ref and
//     stops after the first failed delegate (finding 14: `[\w.-]+` captured
//     "http" and the loop retried delegate_to_agent eight times).

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

// A chrome.storage.local mock so kv runs on its persistent path (the
// named-agents-provider.test.ts pattern).
const store = new Map();
globalThis.chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = structuredClone(store.get(k));
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v)); },
      remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
    },
  },
  runtime: { id: "test" },
};

const { resolveModelFromConfig } = await import("../extension/lib/provider.js");
const { kvSet, kvRemove } = await import("../extension/lib/kv.js");
const { createDemoModel } = await import("../extension/lib/models/demo-model.js");

Deno.test("demo-model: the default branch is unreachable without the developer flag", async () => {
  await kvRemove("cap:developerFeatures");
  const resolved = await resolveModelFromConfig({ provider: "demo", baseURL: "", apiKey: "", model: "" });
  assertEquals(resolved.modelId, "local-assistant");
  assertEquals(resolved.model.modelId, "local-assistant");
  assertEquals(resolved.providerName, "local");
  // the model a fresh profile runs never emits the demo literal
  const out = await resolved.model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello there" }] }] });
  const text = out.content.find((p) => p.type === "text")?.text ?? "";
  assert(!/\[demo model\]|Task received/u.test(text), `no demo literal: ${text}`);
});

Deno.test("demo-model: the developer flag brings the marker model back for the journey suite", async () => {
  await kvSet({ "cap:developerFeatures": true });
  try {
    const resolved = await resolveModelFromConfig({ provider: "demo", baseURL: "", apiKey: "", model: "" });
    assertEquals(resolved.modelId, "demo-local");
    assertEquals(resolved.providerName, "demo");
  } finally {
    await kvRemove("cap:developerFeatures");
  }
  // any value other than the literal `true` keeps the flag off
  await kvSet({ "cap:developerFeatures": "true" });
  try {
    assertEquals((await resolveModelFromConfig({ provider: "demo" })).modelId, "local-assistant");
  } finally {
    await kvRemove("cap:developerFeatures");
  }
});

function toolMsg(toolCallId, toolName, value) {
  return { role: "tool", content: [{ type: "tool-result", toolCallId, toolName, output: { type: "json", value } }] };
}

Deno.test("demo-model: @demo-delegate-agent accepts an origin and stops after the first failed delegate", async () => {
  const model = createDemoModel();
  const ref = `sel_${"ab".repeat(18)}`;
  const task = { role: "user", content: [{ type: "text", text: "@demo-delegate-agent http://127.0.0.1:8934" }] };
  // step 0: search
  const s0 = await model.doGenerate({ prompt: [task] });
  assertEquals(s0.content[0].toolName, "search_tools");
  assertEquals(JSON.parse(s0.content[0].input).query, "delegate_to_agent");
  // step 1: execute — the agent ref is the WHOLE origin, not "http"
  const afterSearch = [
    task,
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c0", toolName: "search_tools", input: { query: "delegate_to_agent", limit: 1 } }] },
    toolMsg("c0", "search_tools", { ok: true, results: [{ name: "delegate_to_agent", selectionRef: ref }] }),
  ];
  const s1 = await model.doGenerate({ prompt: afterSearch });
  assertEquals(s1.content[0].toolName, "execute_tool");
  const args = JSON.parse(s1.content[0].input).arguments;
  assertEquals(args.agent, "http://127.0.0.1:8934");
  // step 2: the delegate FAILED — the model answers with the error text and
  // never issues another delegate call
  const failed = [
    ...afterSearch,
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "execute_tool", input: { selectionRef: ref, arguments: args } }] },
    toolMsg("c1", "execute_tool", { ok: true, selectedTool: "delegate_to_agent", result: { ok: false, error: "no such agent: http://127.0.0.1:8934" } }),
  ];
  const s2 = await model.doGenerate({ prompt: failed });
  assertEquals(s2.content.filter((p) => p.type === "tool-call").length, 0, "exactly one delegate attempt");
  assertMatch(s2.content[0].text, /DENIED\/FAILED.*no such agent/u);
  // a continuation whose tool history was compacted away (the failed execute
  // is gone, the search result is not) must STILL not delegate again
  const compacted = [
    ...afterSearch,
    { role: "assistant", content: [{ type: "text", text: s2.content[0].text }] },
    { role: "user", content: [{ type: "text", text: "Continue working on the task. Respond with your final summary." }] },
  ];
  const s3 = await model.doGenerate({ prompt: compacted });
  assertEquals(s3.content.filter((p) => p.type === "tool-call").length, 0, "no retry after the final text");
  // the stream path agrees
  const { stream } = await model.doStream({ prompt: failed });
  const parts = [];
  for await (const p of stream) parts.push(p);
  assertEquals(parts.filter((p) => p.type === "tool-call").length, 0);
  assertMatch(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join(""), /DENIED\/FAILED/u);
});

// ── @demo-skill-read (CAP-FB-20260830-SKILLS-UNCAPPED-01) ──────────────────
// The marker drives search → execute(skill_read) through the REAL lazy
// protocol, then a final text naming the read result. Falsification: revert
// the marker dispatch and the model never calls skill_read.

function skillToolMsg(id, toolName, output) {
  return { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName, output }] };
}

Deno.test("demo-model: @demo-skill-read drives search → execute(skill_read) → final text", async () => {
  await kvSet({ "cap:developerFeatures": true });
  try {
    const resolved = await resolveModelFromConfig({ provider: "demo", baseURL: "", apiKey: "", model: "" });
    const model = resolved.model;
    const user = [{ role: "user", content: [{ type: "text", text: "read the skill body with @demo-skill-read big-skill" }] }];
    // step 1: search_tools(skill_read)
    const s1 = await model.doGenerate({ prompt: user });
    assertEquals(s1.content[0].toolName, "search_tools");
    assertEquals(JSON.parse(s1.content[0].input).query, "skill_read");
    // step 2: execute_tool({skill:"big-skill"})
    const afterSearch = [
      ...user,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "s1", toolName: "search_tools", input: JSON.stringify({ query: "skill_read", limit: 1 }) }] },
      skillToolMsg("s1", "search_tools", { ok: true, selectedTool: "skill_read", result: { name: "skill_read", selectionRef: "sel_000000000000000000000000000000000000" } }),
    ];
    const s2 = await model.doGenerate({ prompt: afterSearch });
    assertEquals(s2.content[0].toolName, "execute_tool");
    const args = JSON.parse(s2.content[0].input).arguments;
    assertEquals(args.skill, "big-skill");
    // step 3: final text from the fenced read result
    const body = "lorem ipsum dolor sit amet ".repeat(2048); // > 16KiB → truncated
    const afterExecute = [
      ...afterSearch,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "e1", toolName: "execute_tool", input: s2.content[0].input }] },
      skillToolMsg("e1", "execute_tool", { ok: true, selectedTool: "skill_read", result: { ok: true, skill: "big-skill", path: "SKILL.md", bytes: 16384, totalBytes: body.length, truncated: true, nextOffset: 16384, text: body.slice(0, 16384) } }),
    ];
    const s3 = await model.doGenerate({ prompt: afterExecute });
    assertEquals(s3.content.filter((p) => p.type === "tool-call").length, 0);
    assertMatch(s3.content[0].text, /Skill read completed.*big-skill.*truncated.*lorem ipsum/u);
  } finally {
    await kvRemove("cap:developerFeatures");
  }
});

Deno.test("demo-model: @demo-skill-read reports a missing skill honestly (no success claim)", async () => {
  await kvSet({ "cap:developerFeatures": true });
  try {
    const resolved = await resolveModelFromConfig({ provider: "demo", baseURL: "", apiKey: "", model: "" });
    const model = resolved.model;
    const user = [{ role: "user", content: [{ type: "text", text: "@demo-skill-read nope" }] }];
    const afterSearch = [
      ...user,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "s1", toolName: "search_tools", input: JSON.stringify({ query: "skill_read", limit: 1 }) }] },
      skillToolMsg("s1", "search_tools", { ok: true, selectedTool: "skill_read", result: { name: "skill_read", selectionRef: "sel_000000000000000000000000000000000001" } }),
    ];
    const s2 = await model.doGenerate({ prompt: afterSearch });
    const afterExecute = [
      ...afterSearch,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "e1", toolName: "execute_tool", input: s2.content[0].input }] },
      skillToolMsg("e1", "execute_tool", { ok: true, selectedTool: "skill_read", result: { ok: false, error: 'no imported skill "nope"' } }),
    ];
    const s3 = await model.doGenerate({ prompt: afterExecute });
    assert(s3.content.filter((p) => p.type === "tool-call").length === 0);
    assertMatch(s3.content[0].text, /DENIED\/FAILED.*no imported skill/u);
  } finally {
    await kvRemove("cap:developerFeatures");
  }
});
