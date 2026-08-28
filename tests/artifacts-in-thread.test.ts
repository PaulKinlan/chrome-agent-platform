// @ts-nocheck
// CAP-FB-20260828-ARTIFACTS-IN-THREAD-01 — an artifact renders in the thread
// that produced it.
//
// Owner: "assets created by an agent should also be easily visible in the
// chat/task/agent log so they can be viewed in the context in which they are
// created. I never see assets there and they should be (as well as globally
// visible)."
//
// The load-bearing property is that the LIVE stream and the durable-log REPLAY
// derive the card from the same tool result, so an artifact cannot appear while
// a run streams and then vanish when the thread is reopened. Both call
// `artifactFromToolResult`, so these tests pin that one function plus the
// replay projection that uses it.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { artifactFromToolResult, toolRowsFromRunLog } from "../extension/shared/conversation.js";

const assetResult = (over = {}) => ({
  ok: true,
  id: "a_m1x2y3_ab12cd34",
  asset: {
    id: "a_m1x2y3_ab12cd34",
    name: "Quarterly summary",
    type: "text",
    origin: "https://shop.example",
    size: 4096,
    ...over,
  },
});

Deno.test("in-thread: an artifact-producing result yields a card descriptor", () => {
  const a = artifactFromToolResult("create_asset", assetResult());
  assert(a, "create_asset with an asset must produce a descriptor");
  assertEquals(a.id, "a_m1x2y3_ab12cd34");
  assertEquals(a.name, "Quarterly summary");
  assertEquals(a.type, "text");
  assertEquals(a.origin, "https://shop.example");
  assertEquals(a.size, 4096);
});

Deno.test("in-thread: the SAME derivation accepts the object and the serialized forms", () => {
  // The live path carries an object; a replayed durable log may carry the JSON
  // string. Both must produce the identical descriptor, or the thread would
  // show the artifact during the run and lose it on reopen.
  const fromObject = artifactFromToolResult("create_asset", assetResult());
  const fromString = artifactFromToolResult("create_asset", JSON.stringify(assetResult()));
  assertEquals(fromString, fromObject);
});

Deno.test("in-thread: every artifact-producing tool is covered, and nothing else is", () => {
  for (const tool of ["create_asset", "update_asset", "generate_ui"]) {
    assert(artifactFromToolResult(tool, assetResult()), `${tool} must produce a card`);
  }
  for (const tool of ["list_tabs", "memory_get", "group_tabs", "search_tools", ""]) {
    assertEquals(artifactFromToolResult(tool, assetResult()), null, `${tool} must NOT produce a card`);
  }
});

Deno.test("in-thread: a failed or empty result produces nothing", () => {
  // A create that failed made no artifact; rendering a card for it would tell
  // the owner they have something they do not.
  assertEquals(artifactFromToolResult("create_asset", { ok: false, error: "limit reached" }), null);
  assertEquals(artifactFromToolResult("create_asset", { ok: true }), null, "no asset and no id");
  assertEquals(artifactFromToolResult("create_asset", null), null);
  assertEquals(artifactFromToolResult("create_asset", "not json"), null);
  assertEquals(artifactFromToolResult("create_asset", "null"), null);
  assertEquals(artifactFromToolResult("create_asset", 42), null);
});

Deno.test("in-thread: a missing name/type/origin falls back rather than rendering blanks", () => {
  const a = artifactFromToolResult("create_asset", { ok: true, id: "a_x", asset: { id: "a_x" } });
  assertEquals(a.name, "Untitled");
  assertEquals(a.type, "data");
  assertEquals(a.origin, "master");
  assertEquals(a.size, 0);
});

// ── the replay projection ──────────────────────────────────────────────────
const logs = (result, ok = true) => ([
  { type: "tool-call", callId: "c1", tool: "create_asset", args: { name: "Quarterly summary" }, at: 1000 },
  { type: "tool-result", callId: "c1", tool: "create_asset", result, ok, at: 1200 },
]);

Deno.test("in-thread REPLAY: reopening a thread renders the artifact after the call that made it", () => {
  const rows = toolRowsFromRunLog("exec_1", logs(assetResult()));
  assertEquals(rows.length, 2, "one tool row plus one artifact row");
  assertEquals(rows[0].role, "tool");
  assertEquals(rows[0].toolName, "create_asset");
  assertEquals(rows[1].role, "artifact");
  // Placement matters: the deliverable reads as the outcome of the call above it.
  assertEquals(rows[1].artifact.name, "Quarterly summary");
  assertEquals(rows[1].artifact.origin, "https://shop.example");
  assertEquals(rows[1].executionId, "exec_1");
  assertEquals(rows[1].toolCallId, "c1");
});

Deno.test("in-thread REPLAY: a failed create replays as the tool row alone", () => {
  const rows = toolRowsFromRunLog("exec_2", logs({ ok: false, error: "nope" }, false));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].role, "tool");
  assertEquals(rows[0].toolStatus, "error");
});

Deno.test("in-thread REPLAY: non-artifact tools replay unchanged", () => {
  const rows = toolRowsFromRunLog("exec_3", [
    { type: "tool-call", callId: "c9", tool: "list_tabs", args: {}, at: 1 },
    { type: "tool-result", callId: "c9", tool: "list_tabs", result: { ok: true, tabs: [] }, ok: true, at: 2 },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].role, "tool");
});

Deno.test("in-thread REPLAY: several artifacts in one run each get their own card, in order", () => {
  const rows = toolRowsFromRunLog("exec_4", [
    { type: "tool-call", callId: "c1", tool: "create_asset", args: {}, at: 1 },
    { type: "tool-result", callId: "c1", tool: "create_asset", result: assetResult({ id: "a_one", name: "One" }), ok: true, at: 2 },
    { type: "tool-call", callId: "c2", tool: "create_asset", args: {}, at: 3 },
    { type: "tool-result", callId: "c2", tool: "create_asset", result: assetResult({ id: "a_two", name: "Two" }), ok: true, at: 4 },
  ]);
  const artifacts = rows.filter((r) => r.role === "artifact");
  assertEquals(artifacts.length, 2);
  assertEquals(artifacts.map((r) => r.artifact.name), ["One", "Two"]);
  // Each card sits immediately after its own call.
  assertEquals(rows.map((r) => r.role), ["tool", "artifact", "tool", "artifact"]);
});

Deno.test("in-thread: the derivation is pure — no storage, DOM or messaging", () => {
  const raw = Deno.readTextFileSync(new URL("../extension/shared/conversation.js", import.meta.url));
  const fn = raw.slice(raw.indexOf("export function artifactFromToolResult"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  for (const sink of ["chrome.", "document.", "fetch(", "await ", "innerHTML"]) {
    assert(!body.includes(sink), `artifactFromToolResult must not contain ${sink}`);
  }
});
