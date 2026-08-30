// @ts-nocheck
// CAP-FB-20260830-AGENT-BOARD-WORKING-01 (steps 7 + 10): the demo model's
// @demo-board flow is HONEST about a denial and never claims a blocked job.
// The lazy execute_tool envelope reaches the model as {modelContent: "<json>"}
// (see tests/agent-do-logging), so the unwrap must parse it — before this fix
// a denied claim was reported as "finished without board results" and the
// model still called board_complete_job.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createDemoModel } from "../extension/lib/models/demo-model.js";

const envelope = (selectedTool, result) => ({
  type: "json",
  value: { modelContent: JSON.stringify({ ok: true, selectedTool, result, schemaSummary: "{}" }) },
});
const searchResult = (name) => ({
  type: "json",
  value: { modelContent: JSON.stringify({ ok: true, tools: [{ name, selectionRef: `sel_${"a".repeat(36)}` }] }) },
});
const toolMsg = (toolName, output) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: `c_${toolName}`, toolName, output }] });
const assistantCall = (toolName) => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c_${toolName}`, toolName, input: "{}" }] });

function boardPrompt(steps) {
  return [{ role: "user", content: [{ type: "text", text: "@demo-board" }] }, ...steps];
}

Deno.test("demo board: a denied claim ends the flow with a DENIED final text (no complete call)", async () => {
  const model = createDemoModel();
  const prompt = boardPrompt([
    assistantCall("search_tools"), toolMsg("search_tools", searchResult("board_list")),
    assistantCall("execute_tool"), toolMsg("execute_tool", envelope("board_list", { ok: true, jobs: [{ id: "job_1", status: "pending", blocked: false }] })),
    assistantCall("search_tools"), toolMsg("search_tools", searchResult("board_claim_job")),
    assistantCall("execute_tool"), toolMsg("execute_tool", envelope("board_claim_job", { ok: false, code: "board-deny-claim", error: "you are not allowed to claim jobs from hub" })),
  ]);
  const out = await model.doGenerate({ prompt });
  assertEquals(out.finishReason, "stop", JSON.stringify(out.content));
  const text = out.content.find((p) => p.type === "text")?.text ?? "";
  assertStringIncludes(text, "DENIED");
  assertStringIncludes(text, "board-deny-claim");
  assert(!out.content.some((p) => p.type === "tool-call"), "no board_complete_job after a denial");
});

Deno.test("demo board: a blocked job is skipped; the first claimable job is claimed", async () => {
  const model = createDemoModel();
  const prompt = boardPrompt([
    assistantCall("search_tools"), toolMsg("search_tools", searchResult("board_list")),
    assistantCall("execute_tool"), toolMsg("execute_tool", envelope("board_list", { ok: true, jobs: [
      { id: "job_blocked", status: "pending", blocked: true, blockedBy: ["job_open"] },
      { id: "job_open", status: "pending", blocked: false },
    ] })),
    assistantCall("search_tools"), toolMsg("search_tools", searchResult("board_claim_job")),
  ]);
  const out = await model.doGenerate({ prompt });
  const call = out.content.find((p) => p.type === "tool-call");
  assert(call, "the claim call is issued");
  assertEquals(JSON.parse(call.input).arguments.jobId, "job_open");
});

Deno.test("demo board: a completed job reads as success through the modelContent envelope", async () => {
  const model = createDemoModel();
  const prompt = boardPrompt([
    assistantCall("search_tools"), toolMsg("search_tools", searchResult("board_list")),
    assistantCall("execute_tool"), toolMsg("execute_tool", envelope("board_list", { ok: true, jobs: [{ id: "job_1", status: "pending" }] })),
    assistantCall("search_tools"), toolMsg("search_tools", searchResult("board_claim_job")),
    assistantCall("execute_tool"), toolMsg("execute_tool", envelope("board_claim_job", { ok: true, job: { id: "job_1", status: "claimed", claimantId: "worker" } })),
    assistantCall("search_tools"), toolMsg("search_tools", searchResult("board_complete_job")),
    assistantCall("execute_tool"), toolMsg("execute_tool", envelope("board_complete_job", { ok: true, settled: true, job: { id: "job_1", status: "completed" } })),
  ]);
  const out = await model.doGenerate({ prompt });
  assertEquals(out.finishReason, "stop");
  assertStringIncludes(out.content.find((p) => p.type === "text")?.text ?? "", "claimed and completed");
});

// The lazy projection fences board_list (tagged untrusted, lib/untrusted-fence.js):
// every string leaf — the job id AND its status — arrives inside the run's
// boundary. The demo model must read THROUGH the fence (the 2026-08-30
// coordinator merge of the board + fencing lanes: the claim went out with the
// fenced id and came back board-no-job).
Deno.test("demo board: a FENCED board_list result still yields the bare open job id", async () => {
  const { fenceUntrustedValue } = await import("../extension/lib/untrusted-fence.js");
  const token = "c".repeat(32);
  const fenced = fenceUntrustedValue({ ok: true, untrusted: true, jobs: [
    { id: "job_blocked", status: "pending", blocked: true, blockedBy: ["job_open"] },
    { id: "job_open", status: "pending", blocked: false, description: "critique the draft" },
  ] }, token);
  const model = createDemoModel();
  const prompt = boardPrompt([
    assistantCall("search_tools"), toolMsg("search_tools", searchResult("board_list")),
    assistantCall("execute_tool"), toolMsg("execute_tool", envelope("board_list", fenced)),
    assistantCall("search_tools"), toolMsg("search_tools", searchResult("board_claim_job")),
  ]);
  const out = await model.doGenerate({ prompt });
  const call = out.content.find((p) => p.type === "tool-call");
  assert(call, "the claim call is issued");
  assertEquals(JSON.parse(call.input).arguments.jobId, "job_open");
});
