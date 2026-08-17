// Unit tests for the tool-result summarizer — a raw {modelContent, userSummary}
// JSON dump must render as a readable one-line summary, never the raw JSON.
// @ts-nocheck — pure module, no chrome/browser globals needed.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { summarizeToolResult } from "../extension/lib/tool-summary.js";

Deno.test("list_agents envelope → 'N agent(s): …' (not raw JSON)", () => {
  const raw = JSON.stringify({
    modelContent: JSON.stringify({ agents: [{ origin: "https://paul.kinlan.me", name: "https://paul.kinlan.me", enrolled: true, gen: 1, tools: [], toolCount: 0, memoryKeys: ["enrolled", "paul_kinlan_summary"], memoryKeyCount: 2 }] }),
    userSummary: JSON.stringify({ agents: [{ origin: "https://paul.kinlan.me", name: "https://paul.kinlan.me", enrolled: true, gen: 1, tools: [], toolCount: 0, memoryKeys: ["enrolled", "paul_kinlan_summary"], memoryKeyCount: 2 }] }),
  });
  const s = summarizeToolResult("list_agents", raw);
  assert(s.includes("1 agent"), `expected '1 agent', got: ${s}`);
  assert(s.includes("paul.kinlan.me"), `expected the origin, got: ${s}`);
  assert(s.includes("2 memory keys"), `expected the memory count, got: ${s}`);
  assert(!s.includes("modelContent"), `must not leak the envelope, got: ${s}`);
});

Deno.test("list_named_agents envelope → '1 named agent: Paul — role'", () => {
  const raw = JSON.stringify({
    modelContent: JSON.stringify({ agents: [{ id: "paul", name: "Paul", role: "Summarizes the latest content" }] }),
    userSummary: JSON.stringify({ agents: [{ id: "paul", name: "Paul", role: "Summarizes the latest content" }] }),
  });
  const s = summarizeToolResult("list_named_agents", raw);
  assert(s.includes("1 named agent"), `got: ${s}`);
  assert(s.includes("Paul"), `got: ${s}`);
  assert(!s.includes("modelContent"), `got: ${s}`);
});

Deno.test("create_named_agent object → 'created <name> (role)'", () => {
  const s = summarizeToolResult("create_named_agent", { ok: true, agent: { id: "paul", name: "Paul", role: "Summarizes paul.kinlan.me" } });
  assert(s.startsWith("created Paul"), `got: ${s}`);
});

Deno.test("schedule_task result → 'scheduled: …'", () => {
  const s = summarizeToolResult("schedule_task", { ok: true, id: "task_1", name: "every 10 min summary" });
  assert(s.startsWith("scheduled:"), `got: ${s}`);
});

Deno.test("a bare string result passes through (truncated)", () => {
  const s = summarizeToolResult("some_tool", "a plain string result");
  assertEquals(s, "a plain string result");
});

Deno.test("a null/empty result → 'done'", () => {
  assertEquals(summarizeToolResult("some_tool", null), "done");
  assertEquals(summarizeToolResult("some_tool", ""), "done");
});

Deno.test("an unknown small object → compact key: value pairs, not JSON", () => {
  const s = summarizeToolResult("weird_tool", { a: 1, b: "two" });
  assert(s.includes("a: 1"), `got: ${s}`);
  assert(s.includes("b: two"), `got: ${s}`);
  assert(!s.includes("{"), `must not be a JSON blob, got: ${s}`);
});
