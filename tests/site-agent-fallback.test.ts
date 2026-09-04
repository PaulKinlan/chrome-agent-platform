// @ts-nocheck
// tests/site-agent-fallback.test.ts — chrome-agent-platform-922q
//
// Verifies:
// 1. Honest error handling when WebMCP dispatch is unavailable or returns UnknownError.
// 2. Docs fallback mechanism: when site tool execution fails, the agent falls back to
//    fetching documentation directly (read_page) and answers from the fetched content.
// 3. Falsification: prove that the fallback trigger fires upon site-tool error.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createDemoModel } from "../extension/lib/models/demo-model.js";

const MAIN_WORLD = await Deno.readTextFile(new URL("../extension/content/main-world.js", import.meta.url));
const MASTER_SKILL = await Deno.readTextFile(new URL("../extension/lib/master-skill.js", import.meta.url));

const envelope = (selectedTool, result) => ({
  type: "json",
  value: { modelContent: JSON.stringify({ ok: true, selectedTool, result, schemaSummary: "{}" }) },
});
const searchResult = (name) => ({
  type: "json",
  value: { modelContent: JSON.stringify({ ok: true, tools: [{ name, selectionRef: `sel_${"a".repeat(36)}` }] }) },
});
const toolMsg = (toolName, output) => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: `c_${toolName}`, toolName, output }],
});
const assistantCall = (toolName, input = "{}") => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: `c_${toolName}`, toolName, input: typeof input === "string" ? input : JSON.stringify(input) }],
});

function sitePrompt(steps) {
  return [
    { role: "user", content: [{ type: "text", text: "@demo-site-tool search_docs {\"query\":\"installation\"}" }] },
    ...steps,
  ];
}

Deno.test("site-agent: main-world honest error when document.modelContext is unavailable", () => {
  assert(
    MAIN_WORLD.includes("document.modelContext is unavailable"),
    "main-world must state that document.modelContext is unavailable when missing",
  );
  assert(
    MAIN_WORLD.includes("open the page directly or fetch its documentation instead"),
    "main-world must suggest opening page directly or fetching documentation",
  );
});

Deno.test("site-agent: main-world honest error on UnknownError / bare DOMException", () => {
  assert(
    MAIN_WORLD.includes("UnknownError") && MAIN_WORLD.includes("the documentation site's search/dispatch engine or browser WebMCP layer"),
    "main-world must provide clear context for UnknownError DOMExceptions",
  );
});

Deno.test("site-agent: master-skill guides docs fallback on site-tool failure", () => {
  assert(
    MASTER_SKILL.includes("on site-tool failure, fall back to read_page/fetch for documentation"),
    "master-skill must guide model to fall back to read_page/fetch on site-tool failure",
  );
});

Deno.test("site-agent: demo model happy path when site tool succeeds", async () => {
  const model = createDemoModel();
  const prompt = sitePrompt([]);

  // Step 1: Model searches for search_docs
  const r1 = await model.doGenerate({ prompt });
  const c1 = r1.content.find((p) => p.type === "tool-call");
  assert(c1, "Model issues tool call");
  assertEquals(c1.toolName, "search_tools");
  assertEquals(JSON.parse(c1.input).query, "search_docs");

  // Step 2: Feed search result -> Model calls execute_tool
  const p2 = sitePrompt([
    assistantCall("search_tools", c1.input),
    toolMsg("search_tools", searchResult("search_docs")),
  ]);
  const r2 = await model.doGenerate({ prompt: p2 });
  const c2 = r2.content.find((p) => p.type === "tool-call");
  assert(c2, "Model issues execute_tool call");
  assertEquals(c2.toolName, "execute_tool");

  // Step 3: Feed execute_tool success result -> Model returns final success text
  const p3 = sitePrompt([
    assistantCall("search_tools", c1.input),
    toolMsg("search_tools", searchResult("search_docs")),
    assistantCall("execute_tool", c2.input),
    toolMsg("execute_tool", envelope("search_docs", { ok: true, value: "Installation: npm install @beads/bd" })),
  ]);
  const r3 = await model.doGenerate({ prompt: p3 });
  assertEquals(r3.finishReason, "stop");
  const text = r3.content.find((p) => p.type === "text")?.text ?? "";
  assertStringIncludes(text, "Site tool search_docs succeeded");
  assertStringIncludes(text, "npm install @beads/bd");
});

Deno.test("site-agent: demo model triggers docs fallback when site tool fails (falsification-gated)", async () => {
  const model = createDemoModel();

  // Step 1: Model searches for search_docs
  const r1 = await model.doGenerate({ prompt: sitePrompt([]) });
  const c1 = r1.content.find((p) => p.type === "tool-call");
  assertEquals(c1.toolName, "search_tools");

  // Step 2: Feed search result -> Model calls execute_tool
  const p2 = sitePrompt([
    assistantCall("search_tools", c1.input),
    toolMsg("search_tools", searchResult("search_docs")),
  ]);
  const r2 = await model.doGenerate({ prompt: p2 });
  const c2 = r2.content.find((p) => p.type === "tool-call");
  assertEquals(c2.toolName, "execute_tool");

  // Step 3: Feed back ERROR result from site tool (DOMException: UnknownError)
  const p3 = sitePrompt([
    assistantCall("search_tools", c1.input),
    toolMsg("search_tools", searchResult("search_docs")),
    assistantCall("execute_tool", c2.input),
    toolMsg("execute_tool", envelope("search_docs", {
      ok: false,
      error: "tool search_docs failed (DOMException: UnknownError) — browser WebMCP dispatch layer unavailable",
    })),
  ]);

  // FALLBACK TRIGGER ASSERTION: When site tool fails, model MUST search for read_page
  const r3 = await model.doGenerate({ prompt: p3 });
  const c3 = r3.content.find((p) => p.type === "tool-call");
  assert(c3, "Model searches for fallback tool after site tool failure");
  assertEquals(c3.toolName, "search_tools");
  assertEquals(JSON.parse(c3.input).query, "read_page");

  // Step 4: Feed back search_tools result for read_page -> Model executes read_page
  const p4 = sitePrompt([
    assistantCall("search_tools", c1.input),
    toolMsg("search_tools", searchResult("search_docs")),
    assistantCall("execute_tool", c2.input),
    toolMsg("execute_tool", envelope("search_docs", {
      ok: false,
      error: "tool search_docs failed (DOMException: UnknownError) — browser WebMCP dispatch layer unavailable",
    })),
    assistantCall("search_tools", c3.input),
    toolMsg("search_tools", searchResult("read_page")),
  ]);
  const r4 = await model.doGenerate({ prompt: p4 });
  const c4 = r4.content.find((p) => p.type === "tool-call");
  assert(c4, "Model executes fallback tool");
  assertEquals(c4.toolName, "execute_tool");

  // Step 5: Feed back read_page result -> Model produces final answer with fallback note
  const p5 = sitePrompt([
    assistantCall("search_tools", c1.input),
    toolMsg("search_tools", searchResult("search_docs")),
    assistantCall("execute_tool", c2.input),
    toolMsg("execute_tool", envelope("search_docs", {
      ok: false,
      error: "tool search_docs failed (DOMException: UnknownError) — browser WebMCP dispatch layer unavailable",
    })),
    assistantCall("search_tools", c3.input),
    toolMsg("search_tools", searchResult("read_page")),
    assistantCall("execute_tool", c4.input),
    toolMsg("execute_tool", envelope("read_page", {
      ok: true,
      text: "Beads Documentation. Quick start: install bd CLI via npm or brew.",
    })),
  ]);
  const r5 = await model.doGenerate({ prompt: p5 });
  assertEquals(r5.finishReason, "stop");
  const text = r5.content.find((p) => p.type === "text")?.text ?? "";
  assertStringIncludes(text, "Fallback: fetched documentation directly via read_page");
  assertStringIncludes(text, "Beads is a dependency-aware, Dolt-backed issue tracker");
});
