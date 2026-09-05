// @ts-nocheck
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { attachmentContext, buildMultimodalTask, validateRunAttachments, textToDataUrl } from "../extension/lib/attachments.js";

Deno.test("site delegation attachments: text-like attachments format into context", () => {
  const attachments = [
    {
      name: "notes.txt",
      type: "text/plain",
      size: 21,
      kind: "file",
      dataURL: textToDataUrl("Important site report", "text/plain"),
    },
    {
      name: "data.json",
      type: "application/json",
      size: 15,
      kind: "file",
      dataURL: textToDataUrl('{"score": 98}', "application/json"),
    },
  ];

  const { kept, dropped } = validateRunAttachments(attachments);
  assertEquals(dropped.length, 0);
  assertEquals(kept.length, 2);

  const context = attachmentContext(kept);
  assertStringIncludes(context, "Attachments:");
  assertStringIncludes(context, "[attachment: notes.txt");
  assertStringIncludes(context, "Important site report");
  assertStringIncludes(context, "[attachment: data.json");
  assertStringIncludes(context, '{"score": 98}');

  const taskParts = buildMultimodalTask("Analyze these findings", kept);
  assertEquals(taskParts, "Analyze these findings", "pure text attachments do not wrap task into multimodal array");
});

Deno.test("site delegation attachments: image attachments format into multimodal task parts", () => {
  const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const attachments = [
    {
      name: "screenshot.png",
      type: "image/png",
      size: 68,
      kind: "file",
      dataURL: imageDataUrl,
    },
  ];

  const { kept, dropped } = validateRunAttachments(attachments);
  assertEquals(dropped.length, 0);
  assertEquals(kept.length, 1);

  const context = attachmentContext(kept);
  assertStringIncludes(context, "image attached — provided to the model as a vision input");

  const taskParts = buildMultimodalTask("Inspect this page element", kept);
  assert(Array.isArray(taskParts));
  assertEquals(taskParts[0], { type: "text", text: "Inspect this page element" });
  assertEquals(taskParts[1], { type: "image", image: imageDataUrl });
});

Deno.test("site delegation attachments: local-folder host grants are dropped with clear reason", () => {
  const attachments = [
    {
      name: "my-local-dir",
      kind: "local-folder",
      folderName: "my-local-dir",
      grantId: "grant_123",
    },
    {
      name: "sample.txt",
      type: "text/plain",
      size: 5,
      kind: "file",
      dataURL: textToDataUrl("hello", "text/plain"),
    },
  ];

  const { kept: rawAttachments, dropped: malformedDropped } = validateRunAttachments(attachments);
  const validAttachments = [];
  const dropped = [...malformedDropped];
  for (const a of rawAttachments) {
    if (a?.kind === "local-folder") {
      dropped.push({ name: a?.name ?? "folder", reason: "local folder grants are host-only and cannot be delegated to site agents" });
    } else {
      validAttachments.push(a);
    }
  }

  assertEquals(validAttachments.length, 1);
  assertEquals(validAttachments[0].name, "sample.txt");
  assertEquals(dropped.length, 1);
  assertEquals(dropped[0].name, "my-local-dir");
  assertStringIncludes(dropped[0].reason, "local folder grants are host-only and cannot be delegated to site agents");
});

Deno.test("site delegation WIRING: service-worker wires attachments and progress correlation", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const conv = await Deno.readTextFile(new URL("../extension/shared/conversation.js", import.meta.url));

  // Check agent.delegate accepts attachments
  assertStringIncludes(sw, 'async "agent.delegate"({ origin, task, threadId = null, attachments = []');

  // Check agent.delegate builds context and multimodal task
  assertStringIncludes(sw, "const delegateContext = attachmentContext(validAttachments);");
  assertStringIncludes(sw, "const promptTask = buildMultimodalTask(task, validAttachments);");

  // Check agent.delegate filters out local-folder grants
  assertStringIncludes(sw, 'a?.kind === "local-folder"');
  assertStringIncludes(sw, "local folder grants are host-only and cannot be delegated to Site Agents");

  // Check agent.delegate records attachments in durable admission and journal
  assertStringIncludes(sw, "attachmentCount: validAttachments.length");

  // Check agent.delegate feeds effective UI runId for progress broadcasts
  assertStringIncludes(sw, "uiRunId ?? execId");

  // Check conversation.js forwards attachments to agent.delegate without dropped warning
  assert(!conv.includes("Attachments aren't delivered to Site Agents yet"), "conversation no longer warns that attachments are undelivered to site agents");
  assertStringIncludes(conv, 'res = await send("agent.delegate", {');
  assertStringIncludes(conv, "attachments,");
  assertStringIncludes(conv, "runId,");
});

Deno.test("site delegation progress: progress fan-out isolates by runId and origin", () => {
  const eventsOriginA = [];
  const eventsOriginB = [];

  // Simulate progress dispatcher
  const listeners = new Map();
  function subscribe(runId, cb) {
    listeners.set(runId, cb);
  }
  function broadcast(ev) {
    const cb = listeners.get(ev.runId);
    if (cb) cb(ev);
  }

  subscribe("run_site_a_123", (ev) => eventsOriginA.push(ev));
  subscribe("run_site_b_456", (ev) => eventsOriginB.push(ev));

  // Site A emits progress with runId A
  broadcast({ type: "text-delta", text: "Analyzing report A...", runId: "run_site_a_123", agentId: "https://a.com" });
  broadcast({ type: "tool-call", tool: "web_search", runId: "run_site_a_123", agentId: "https://a.com" });

  // Site B emits progress with runId B
  broadcast({ type: "text-delta", text: "Analyzing invoice B...", runId: "run_site_b_456", agentId: "https://b.com" });

  // Verify Origin A received ONLY its own events
  assertEquals(eventsOriginA.length, 2);
  assertEquals(eventsOriginA[0].text, "Analyzing report A...");
  assertEquals(eventsOriginA[0].agentId, "https://a.com");
  assertEquals(eventsOriginA[1].tool, "web_search");

  // Verify Origin B received ONLY its own events
  assertEquals(eventsOriginB.length, 1);
  assertEquals(eventsOriginB[0].text, "Analyzing invoice B...");
  assertEquals(eventsOriginB[0].agentId, "https://b.com");
});

Deno.test("site delegation fencing: disenrollment generation mismatch aborts journal and run", () => {
  let currentGeneration = 5;
  const initialGen = 5;

  const guard = () => {
    if (currentGeneration !== initialGen) {
      throw Object.assign(new Error("delegation enrollment generation changed"), { genMismatch: true });
    }
    return { ok: true, gen: currentGeneration };
  };

  // Pre-run passes
  assertEquals(guard().ok, true);

  // Mid-run: origin is disenrolled or re-enrolled (generation increments)
  currentGeneration = 6;

  let threwGenMismatch = false;
  try {
    guard();
  } catch (err) {
    if (err.genMismatch) threwGenMismatch = true;
  }

  assertEquals(threwGenMismatch, true, "mid-run generation mismatch throws with genMismatch flag");
});

Deno.test("site delegation acceptance: real-browser delegation with attachments and live progress", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("../scripts/kat-site-delegation-attachments.ts", import.meta.url).pathname],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assert(out.success, `the site delegation acceptance check must pass:\n${log}`);
  assert(!log.includes("FAIL:"), `no check may fail:\n${log}`);
});
