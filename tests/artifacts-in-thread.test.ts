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
import { artifactFromToolResult, effectiveToolCall, toolRowsFromRunLog } from "../extension/shared/conversation.js";

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

// ── the REAL lazy-protocol envelope (owner-reported, 2026-08-28) ───────────
// Every provider run gets only search_tools/execute_tool, so in a real run the
// card header is `execute_tool` and the invoked tool is named in the payload.
// These use the exact shape the owner pasted from a live run.
Deno.test("envelope: the owner's real execute_tool payload yields the artifact", () => {
  const inner = JSON.stringify({
    ok: true,
    selectedTool: "create_asset",
    result: { ok: true, id: "a_real_1", asset: { id: "a_real_1", name: "OpenClaw Report", type: "html", origin: "master", size: 12000 } },
    selectionRef: "sel_ba138fffcac9813515d075901fb166802eb9",
    authorizes: false,
    requiresLiveAuthorization: true,
  });
  const a = artifactFromToolResult("execute_tool", { modelContent: inner });
  assert(a, "an execute_tool create must produce a card");
  assertEquals(a.id, "a_real_1");
  assertEquals(a.name, "OpenClaw Report");
  assertEquals(a.type, "html");
});

Deno.test("envelope: the header shows the tool that RAN and its real arguments", () => {
  const args = {
    selectionRef: "sel_ba138fffcac9813515d075901fb166802eb9",
    arguments: { content: "<!DOCTYPE html><html>…</html>", name: "Report", type: "html" },
  };
  const result = { modelContent: JSON.stringify({ ok: true, selectedTool: "create_asset", result: { ok: true, id: "a_1" } }) };
  const eff = effectiveToolCall("execute_tool", args, result);
  assertEquals(eff.name, "create_asset", "the card must name the tool that ran");
  assertEquals(eff.lazy, true);
  // The selectionRef is protocol plumbing and means nothing to a reader.
  assertEquals(eff.args.name, "Report");
  assertEquals(eff.args.content, "<!DOCTYPE html><html>…</html>");
  assertEquals(eff.args.selectionRef, undefined);
});

Deno.test("envelope: a direct (non-lazy) call passes straight through", () => {
  const eff = effectiveToolCall("list_tabs", { windowId: 3 }, { ok: true, tabs: [] });
  assertEquals(eff.name, "list_tabs");
  assertEquals(eff.lazy, false);
  assertEquals(eff.args.windowId, 3);
});

Deno.test("envelope: a bounded/degraded result still yields the artifact when the id survived", () => {
  // The whole point of degrading rather than erasing: identity survives.
  const inner = JSON.stringify({
    ok: true,
    selectedTool: "create_asset",
    result: { ok: true, id: "a_kept", bounded: true, droppedFields: 1, summary: "tool completed; result exceeded the lazy protocol output bound — identifying fields kept, bulk omitted" },
  });
  const a = artifactFromToolResult("execute_tool", { modelContent: inner });
  assert(a, "a degraded result that kept the id must still render a card");
  assertEquals(a.id, "a_kept");
});

Deno.test("envelope: a failed execute_tool renders no artifact", () => {
  const inner = JSON.stringify({ ok: false, selectedTool: "create_asset", error: "denied" });
  assertEquals(artifactFromToolResult("execute_tool", { modelContent: inner }), null);
});

// ── the agent-do {modelContent, userSummary} wrapper (CAP-FB-20260830-THREAD-
// ARTIFACT-CARD-01) ────────────────────────────────────────────────────────
// A real run wraps the tool result as {modelContent (structured), userSummary
// (prose)}. The DEFAULT unwrap prefers userSummary, so it returns "Created
// crumb.html", the selectedTool is never found, and the derivation returned
// null — which is why ARTIFACTS-IN-THREAD-01 was DONE while zero cards rendered.
// The runtime-authoritative selectedTool (passed here) recovers it, and the
// structured-unwrap fallback defeats the prose summary even without it.
const wrapper = (over = {}) => ({
  modelContent: JSON.stringify({
    ok: true,
    selectedTool: "create_asset",
    result: { ok: true, asset: { id: "a_crumb", name: "crumb.html", type: "html", origin: "master", size: 1667, ...over } },
  }),
  userSummary: "Created crumb.html",
});

Deno.test("wrapper: the {modelContent,userSummary} wrapper with prose in userSummary still yields a card", () => {
  // With the runtime's selectedTool (the authoritative path).
  const withDeclared = artifactFromToolResult("execute_tool", wrapper(), "create_asset");
  assert(withDeclared, "the wrapper + selectedTool must produce a descriptor");
  assertEquals(withDeclared.id, "a_crumb");
  assertEquals(withDeclared.name, "crumb.html");
  // AND without it — the structured-unwrap fallback reads the selectedTool
  // named inside modelContent even though userSummary shadows it.
  const withoutDeclared = artifactFromToolResult("execute_tool", wrapper());
  assert(withoutDeclared, "the structured fallback must recover the card with no declared tool");
  assertEquals(withoutDeclared.id, "a_crumb");
});

Deno.test("wrapper: an update carries its head version so the thread can title + diff it", () => {
  const updated = {
    modelContent: JSON.stringify({
      ok: true, selectedTool: "update_asset", version: 2,
      result: { ok: true, version: 2, asset: { id: "a_crumb", name: "crumb.html", type: "html", origin: "master", size: 1700 } },
    }),
    userSummary: "Updated crumb.html",
  };
  const a = artifactFromToolResult("execute_tool", updated, "update_asset");
  assert(a, "the update must produce a descriptor");
  assertEquals(a.version, 2);
  assertEquals(a.updated, true);
});

// ── the truncated real-run result (the ACTUAL root cause) ──────────────────
// The progress port AND the durable journal bound a tool result to ~300 chars,
// so a real run's execute_tool result is an unparseable JSON string cut
// mid-`asset` (ending in `…"sch…`). This is the exact string captured from a
// loaded-extension @demo-edit-artifact run. The card must still render — the
// id/name/type sit at the head — or the deliverable is invisible after reload.
const TRUNCATED_REAL_RESULT = "{\"modelContent\":\"{\\\"ok\\\":true,\\\"selectedTool\\\":\\\"create_asset\\\",\\\"result\\\":{\\\"asset\\\":{\\\"createdAt\\\":1788130601801,\\\"id\\\":\\\"a_mtgesimh_nsow6l0f\\\",\\\"name\\\":\\\"crumb.html\\\",\\\"origin\\\":\\\"master\\\",\\\"size\\\":73,\\\"type\\\":\\\"html\\\",\\\"updatedAt\\\":1788130601801},\\\"id\\\":\\\"a_mtgesimh_nsow6l0f\\\",\\\"ok\\\":true},\\\"sch...";

Deno.test("truncated: a ~300-char cut result still yields the full card via a text scan", () => {
  const a = artifactFromToolResult("execute_tool", TRUNCATED_REAL_RESULT, "create_asset");
  assert(a, "the truncated result must still produce a card");
  assertEquals(a.id, "a_mtgesimh_nsow6l0f");
  assertEquals(a.name, "crumb.html");
  assertEquals(a.type, "html");
  assertEquals(a.origin, "master");
  assertEquals(a.size, 73);
});

Deno.test("truncated REPLAY: the reopened thread derives the card from the truncated journaled result", () => {
  const rows = toolRowsFromRunLog("exec_trunc", [
    { type: "tool-call", callId: "cT", tool: "execute_tool", args: { arguments: {} }, at: 1 },
    { type: "tool-result", callId: "cT", tool: "execute_tool", selectedTool: "create_asset", result: TRUNCATED_REAL_RESULT, ok: true, at: 2 },
  ]);
  const artifact = rows.find((r) => r.role === "artifact");
  assert(artifact, "the truncated journal must still derive an artifact row");
  assertEquals(artifact.artifact.id, "a_mtgesimh_nsow6l0f");
  assertEquals(artifact.artifact.name, "crumb.html");
});

Deno.test("bounded update: the asset object is dropped, so the id comes from the args + version from the result", () => {
  // The real update_asset result: bounded so hard the whole asset object is
  // gone — only {ok, version} survive. The target id is in the args; the
  // name/type are resolved from the store at render time.
  const result = { modelContent: JSON.stringify({ ok: true, selectedTool: "update_asset", result: { ok: true, version: 2, bounded: true, droppedFields: 1 } }) };
  const args = { origin: "master", id: "a_crumb", content: "<!doctype html>…" };
  const a = artifactFromToolResult("execute_tool", result, "update_asset", args);
  assert(a, "an update with a dropped asset must still yield a card from the args id");
  assertEquals(a.id, "a_crumb");
  assertEquals(a.version, 2);
  assertEquals(a.updated, true);
  // Without the id in the args there is nothing addressable — no card.
  assertEquals(artifactFromToolResult("execute_tool", result, "update_asset", { content: "x" }), null);
});

Deno.test("wrapper REPLAY: toolRowsFromRunLog passes the row's selectedTool through to the derivation", () => {
  // The persisted result row carries the runtime selectedTool; the replay must
  // forward it so a reopened thread renders the same card the live run did.
  const rows = toolRowsFromRunLog("exec_wrap", [
    { type: "tool-call", callId: "cW", tool: "execute_tool", args: { arguments: {} }, at: 1 },
    { type: "tool-result", callId: "cW", tool: "execute_tool", selectedTool: "create_asset", result: wrapper(), ok: true, at: 2 },
  ]);
  const artifact = rows.find((r) => r.role === "artifact");
  assert(artifact, "the reopened thread must derive the artifact from the wrapper");
  assertEquals(artifact.artifact.id, "a_crumb");
  assertEquals(artifact.artifact.name, "crumb.html");
});
