// @ts-nocheck
// tests/local-assistant.test.ts — the KEYLESS first result
// (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01).
//
// The local assistant is the model a fresh profile runs with no provider
// configured. These KATs drive it through a FAKE lazy tool surface shaped
// exactly like the real protocol (search_tools → selectionRef → execute_tool
// envelope { ok, selectedTool, result }) and assert what the owner sees: real
// group_tabs calls with the right tab ids, a tab-list artifact, and a
// paragraph that is never the demo provider's plumbing proof.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import {
  classifyIntent,
  clusterTabs,
  createLocalAssistant,
  LOCAL_ASSISTANT_FALLBACK,
  LOCAL_ASSISTANT_MODEL_ID,
  tabListHtml,
} from "../extension/lib/models/local-assistant.js";

const DEMO_LITERAL = /\[demo model\]|Task received/u;

const TABS = [
  { id: 11, title: "Hub", url: "chrome-extension://abc/ntp/ntp.html" },
  { id: 12, title: "MDN <b>Fetch</b>", url: "https://developer.mozilla.org/en-US/docs/Web/API/fetch" },
  { id: 13, title: "MDN Streams", url: "https://developer.mozilla.org/en-US/docs/Web/API/Streams_API" },
  { id: 14, title: "Example", url: "https://example.com/" },
  { id: 15, title: "New tab", url: "chrome://newtab/" },
];

function ref() {
  const hex = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sel_${hex}`;
}

/** A fake lazy tool surface. `tools[name](args)` returns the inner result;
 * a returned `{ __denial: "approved"|"denied" }` simulates the agent loop's
 * paused permission card: "denied" writes the terminal sentence the loop
 * writes; "approved" makes the runtime RE-RUN the same call with the same
 * arguments and hand the model that real result
 * (CAP-FB-20260901-APPROVAL-RESUME-REEXECUTES-01). `toolInvocations` counts
 * the underlying tool runs (the runtime's re-run included); `calls` counts
 * what the MODEL issued. */
function fakeSurface(tools) {
  const refs = new Map();
  const calls = [];
  const toolInvocations = [];
  return {
    calls,
    toolInvocations,
    async run(name, input) {
      if (name === "search_tools") {
        const tool = tools[input.query] ? input.query : null;
        if (!tool) return { ok: true, results: [] };
        const r = ref();
        refs.set(r, tool);
        return { ok: true, results: [{ name: tool, selectionRef: r }] };
      }
      const tool = refs.get(input.selectionRef);
      refs.delete(input.selectionRef);
      if (!tool) return { ok: false, error: "lazy-selection-replay" };
      calls.push({ tool, args: input.arguments });
      toolInvocations.push(tool);
      let inner = await tools[tool](input.arguments);
      if (inner?.__denial === "approved") {
        // The runtime re-runs the paused call itself; the model sees the result.
        toolInvocations.push(tool);
        inner = await tools[tool](input.arguments);
      }
      if (inner?.__denial) {
        const selected = tool;
        const modelContent = `Owner denied the requested capability. ${selected} was not performed; do not retry it.`;
        return { ok: true, selectedTool: tool, result: { waitingForPermission: true, permissionRequirement: { permissions: ["tabs"] } }, modelContent };
      }
      return { ok: true, selectedTool: tool, result: inner };
    },
  };
}

/** Drive the model the way agent-do does: tool-calls → tool results appended
 * → next step, until a text step. Returns the final text + every step. */
async function drive(task, surface, { maxSteps = 12 } = {}) {
  const model = createLocalAssistant();
  const prompt = [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text: task }] },
  ];
  const steps = [];
  for (let i = 0; i < maxSteps; i++) {
    const out = await model.doGenerate({ prompt });
    steps.push(out);
    const toolCalls = out.content.filter((p) => p.type === "tool-call");
    if (!toolCalls.length) {
      return { text: out.content.find((p) => p.type === "text")?.text ?? "", steps };
    }
    prompt.push({ role: "assistant", content: toolCalls.map((c) => ({ type: "tool-call", toolCallId: c.toolCallId, toolName: c.toolName, input: JSON.parse(c.input) })) });
    const results = [];
    for (const c of toolCalls) {
      const value = await surface.run(c.toolName, JSON.parse(c.input));
      results.push({ type: "tool-result", toolCallId: c.toolCallId, toolName: c.toolName, output: { type: "json", value } });
    }
    prompt.push({ role: "tool", content: results });
  }
  throw new Error("the local assistant did not finish within the step budget");
}

Deno.test("local-assistant: intents are recognised by plain phrasing; everything else is null", () => {
  assertEquals(classifyIntent("group my tabs by topic"), "group");
  assertEquals(classifyIntent("Organise my open tabs"), "group");
  assertEquals(classifyIntent("list my tabs"), "list");
  assertEquals(classifyIntent("what tabs do I have open?"), "list");
  assertEquals(classifyIntent("summarise my tabs"), "summarise");
  assertEquals(classifyIntent("find duplicate tabs"), "dedupe");
  assertEquals(classifyIntent("write me a poem"), null);
  assertEquals(classifyIntent("@demo-tools"), null);
});

Deno.test("local-assistant: tabs cluster by site; hub/chrome tabs and single tabs never group", () => {
  const clusters = clusterTabs(TABS);
  assertEquals(clusters.length, 1);
  assertEquals(clusters[0].tabIds, [12, 13]);
  assertEquals(clusters[0].title, "Mozilla");
});

Deno.test("local-assistant: the tab-list artifact escapes page-controlled titles", () => {
  const html = tabListHtml(TABS);
  assertStringIncludes(html, "MDN &lt;b&gt;Fetch&lt;/b&gt;");
  assert(!html.includes("<b>Fetch</b>"), "raw title markup never reaches the artifact");
  assert(!html.includes("chrome-extension://"), "the hub tab is not listed");
});

Deno.test("local-assistant: 'group my tabs by topic' executes group_tabs with the clustered ids, saves the artifact, and the text is never the demo literal", async () => {
  const surface = fakeSurface({
    list_tabs: async () => ({ tabs: TABS }),
    group_tabs: async ({ tabIds }) => ({ ok: true, groupId: 7, tabIds }),
    create_asset: async ({ name, content }) => ({ ok: true, asset: { id: "a1", name, bytes: content.length } }),
  });
  const { text, steps } = await drive("group my tabs by topic", surface);
  const group = surface.calls.filter((c) => c.tool === "group_tabs");
  assertEquals(group.length, 1, "one group_tabs call for the one cluster");
  assertEquals(group[0].args.tabIds, [12, 13]);
  assertEquals(group[0].args.title, "Mozilla");
  const asset = surface.calls.filter((c) => c.tool === "create_asset");
  assertEquals(asset.length, 1);
  assertEquals(asset[0].args.type, "html");
  assertStringIncludes(asset[0].args.content, "developer.mozilla.org");
  assert(!DEMO_LITERAL.test(text), `the answer is never the demo literal: ${text}`);
  assertMatch(text, /Grouped 2 tabs into one group by site: Mozilla \(2\)/u);
  assertStringIncludes(text, "1 tab stayed ungrouped");
  assertStringIncludes(text, 'saved as the artifact "Your open tabs"');
  assert(steps.length <= 6, `bounded plan (${steps.length} steps)`);
  // the model's identity is the local assistant, not the demo provider
  assertEquals(createLocalAssistant().modelId, LOCAL_ASSISTANT_MODEL_ID);
});

Deno.test("local-assistant: a continuation after the answer re-emits the answer (never restarts the plan)", async () => {
  const model = createLocalAssistant();
  const prompt = [
    { role: "user", content: [{ type: "text", text: "group my tabs by topic" }] },
    { role: "assistant", content: [{ type: "text", text: "Grouped 2 tabs into one group by site: Mozilla (2)." }] },
    { role: "user", content: [{ type: "text", text: "Continue working on the task. Respond with your final summary." }] },
  ];
  const out = await model.doGenerate({ prompt });
  assertEquals(out.content.filter((p) => p.type === "tool-call").length, 0);
  assertEquals(out.content[0].text, "Grouped 2 tabs into one group by site: Mozilla (2).");
});

Deno.test("local-assistant: an owner-approved tabs permission is re-run by the runtime (the model never retries); a denial ends honestly", async () => {
  let listCalls = 0;
  const approved = fakeSurface({
    list_tabs: async () => (++listCalls === 1 ? { __denial: "approved" } : { tabs: TABS }),
    group_tabs: async ({ tabIds }) => ({ ok: true, groupId: 7, tabIds }),
    create_asset: async () => ({ ok: true, asset: { id: "a1" } }),
  });
  const ok = await drive("group my tabs by topic", approved);
  assertEquals(approved.calls.filter((c) => c.tool === "list_tabs").length, 1, "the model issued list_tabs once — the runtime re-ran it after Allow");
  assertEquals(approved.toolInvocations.filter((t) => t === "list_tabs").length, 2, "denied once, re-run once by the runtime");
  assertMatch(ok.text, /Grouped 2 tabs/u);

  const denied = fakeSurface({ list_tabs: async () => ({ __denial: "denied" }) });
  const no = await drive("group my tabs by topic", denied);
  assertEquals(denied.calls.filter((c) => c.tool === "list_tabs").length, 1, "a denial is never retried");
  assertStringIncludes(no.text, "tabs permission was not granted");
  assert(!DEMO_LITERAL.test(no.text));
});

Deno.test("local-assistant: a tab-groups denial still saves the artifact and says the groups were not made", async () => {
  const surface = fakeSurface({
    list_tabs: async () => ({ tabs: TABS }),
    group_tabs: async () => ({ __denial: "denied" }),
    create_asset: async () => ({ ok: true, asset: { id: "a1" } }),
  });
  const { text } = await drive("group my tabs by topic", surface);
  assertEquals(surface.calls.filter((c) => c.tool === "group_tabs").length, 1);
  assertEquals(surface.calls.filter((c) => c.tool === "create_asset").length, 1);
  assertStringIncludes(text, "tab-groups permission was not granted");
  assertStringIncludes(text, 'saved as the artifact');
});

Deno.test("local-assistant: list / summarise / dedupe intents answer from the real tab list", async () => {
  const dupTabs = [...TABS, { id: 16, title: "Example again", url: "https://example.com/#top" }];
  const surface = fakeSurface({
    list_tabs: async () => ({ tabs: dupTabs }),
    create_asset: async () => ({ ok: true, asset: { id: "a1" } }),
  });
  const listed = await drive("list my tabs", surface);
  assertMatch(listed.text, /You have 4 tabs open across 2 sites/u);
  const dedupe = await drive("find duplicate tabs", surface);
  assertStringIncludes(dedupe.text, "https://example.com/ (2)");
  assertStringIncludes(dedupe.text, "I did not close anything");
  assertEquals(surface.calls.filter((c) => c.tool === "group_tabs").length, 0, "no grouping for non-group intents");
});

Deno.test("local-assistant: an unrecognised task gets the fixed fallback — never a character count", async () => {
  const surface = fakeSurface({});
  const { text, steps } = await drive("write me a poem about the sea", surface);
  assertEquals(text, LOCAL_ASSISTANT_FALLBACK);
  assertEquals(steps.length, 1, "no tool calls for an unknown intent");
  assert(!/\d+ chars/u.test(text));
  // the doStream path carries the same text
  const model = createLocalAssistant();
  const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
  const parts = [];
  for await (const p of stream) parts.push(p);
  const streamed = parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");
  assertEquals(streamed, LOCAL_ASSISTANT_FALLBACK);
  assertEquals(parts.at(-1).finishReason, "stop");
});
