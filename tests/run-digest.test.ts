// tests/run-digest.test.ts — CAP-FB-20260902-LOOP-CONTEXT-WINDOW-01: the
// runtime-written running digest is bounded, redacted, fenced, and attached to
// agent-do's continuation nudges from the END of the prompt.
// @ts-nocheck
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { CONTINUATION_NUDGE_PREFIX, RUN_DIGEST_BOUNDS, createRunDigest, isContinuationNudge } from "../extension/lib/run-digest.js";
import { formatBudgetProgress } from "../extension/lib/run-budget.js";
import { utf8ByteLength } from "../extension/lib/pure.js";
import { fenceUntrustedText } from "../extension/lib/untrusted-fence.js";

const TOKEN = "abcdef0123456789abcdef0123456789";
const NUDGE = { role: "user", content: [{ type: "text", text: "Continue working on the task. If you are done, respond with your final summary without calling any tools." }] };
const envelope = (selectedTool, result, ok = true) => ({ modelContent: JSON.stringify({ ok, selectedTool, result, selectionRef: "sel_" + "a".repeat(36) }), userSummary: "x" });
const text = (m) => Array.isArray(m.content) ? m.content.map((p) => p.text ?? "").join("") : String(m.content);

Deno.test("run digest: one turn's digest never exceeds the byte bound, however many results it holds", () => {
  const digest = createRunDigest({ token: TOKEN });
  for (let i = 0; i < 300; i++) {
    digest.record({ step: 0, tool: "execute_tool", selected: "read_page", args: { selectionRef: "sel_" + "b".repeat(36), arguments: { tabId: i } }, ok: i % 7 !== 3, result: envelope("read_page", i % 7 === 3 ? { error: "Cannot access contents of the page." } : { title: `page ${i}`, text: "lorem ipsum ".repeat(120) }, true) });
  }
  const out = digest.renderTurn(0);
  assert(utf8ByteLength(out) <= RUN_DIGEST_BOUNDS.maxBytesPerTurn, `bounded: ${utf8ByteLength(out)} bytes`);
  assertStringIncludes(out, "So far: 300 tool results");
  assertStringIncludes(out, "earlier results of this turn omitted");
  assert(out.endsWith(`<<<END run:${TOKEN}>>>`), "the fenced block closes the digest");
  assertEquals(digest.counts(), { count: 300, ok: 300 - Math.floor((300 + 3) / 7), failed: Math.floor((300 + 3) / 7) });
  // Fewer results: every line keeps its excerpt (no shrink needed).
  const small = createRunDigest({ token: TOKEN });
  for (let i = 0; i < 12; i++) small.record({ step: 0, tool: "execute_tool", selected: "read_page", args: { arguments: { tabId: i } }, ok: true, result: envelope("read_page", { text: `FACT-${i} ` + "x".repeat(200) }) });
  const s = small.renderTurn(0);
  assert(utf8ByteLength(s) <= RUN_DIGEST_BOUNDS.maxBytesPerTurn);
  for (let i = 0; i < 12; i++) assertStringIncludes(s, `FACT-${i} ${"x".repeat(200)}`);
});

Deno.test("run digest: excerpts are unfenced once, re-fenced as a block, and credential-scrubbed", () => {
  const digest = createRunDigest({ token: TOKEN });
  digest.record({ step: 0, tool: "execute_tool", selected: "read_page", args: { arguments: { tabId: 1 } }, ok: true, result: envelope("read_page", { untrusted: true, title: fenceUntrustedText("A  title\nwith   lines", TOKEN), text: fenceUntrustedText("Authorization: Bearer abc123SECRETTOKEN9 tail", TOKEN) }) });
  const out = digest.renderTurn(0);
  const fences = out.match(/<<<UNTRUSTED run:/g) ?? [];
  assertEquals(fences.length, 1, "the leaf fences are removed; the block is fenced once");
  assertStringIncludes(out, `"title":"A title with lines"`);
  assert(!out.includes("abc123SECRETTOKEN9"), "the credential is scrubbed");
  assertStringIncludes(out, "[REDACTED]");
  assert(!out.includes(`"untrusted":true`), "the runtime's own tag is not page data");
  // A failed result carries its error, not an excerpt.
  digest.record({ step: 0, tool: "execute_tool", selected: "read_page", args: { arguments: { tabId: 2 } }, ok: false, result: envelope("read_page", { error: "Cannot access contents of the page." }) });
  assertStringIncludes(digest.renderTurn(0), `#2 read_page {"tabId":2} failed: Cannot access contents of the page.`);
});

Deno.test("run digest: a lazy search result is digested as name + reusable ref + summary, and refs ride the header", () => {
  const ref = "sel_" + "c".repeat(36);
  const digest = createRunDigest({ token: TOKEN });
  digest.record({ step: 0, tool: "search_tools", selected: null, args: { query: "read_page", limit: 1 }, ok: true, result: { modelContent: JSON.stringify({ ok: true, catalogGeneration: "g".repeat(64), results: [{ stableId: "tool:v1:" + "d".repeat(64), name: "read_page", summary: "Read the page", selectionRef: ref, schemaSummary: "{".repeat(900) }] }), userSummary: "x" } });
  digest.record({ step: 0, tool: "execute_tool", selected: "read_page", args: { selectionRef: ref, arguments: { tabId: 9 } }, ok: true, result: envelope("read_page", { text: "hi" }) });
  const out = digest.renderTurn(0);
  assertStringIncludes(out, `#1 search_tools {"query":"read_page","limit":1} ok: {"ok":true,"results":[{"name":"read_page","selectionRef":"${ref}","summary":"Read the page"}]}`);
  assert(!out.includes("schemaSummary"), "schema summaries never reach the digest");
  assertStringIncludes(out, `Reusable selection refs from this turn: read_page=${ref}.`);
  assertStringIncludes(out, `#2 read_page {"tabId":9} ok: {"text":"hi"}`);
});

Deno.test("run digest: attach maps nudges from the end of the prompt, leaves the input untouched, and counts bytes", () => {
  const digest = createRunDigest({ token: TOKEN });
  digest.record({ step: 0, tool: "execute_tool", selected: "read_page", args: { arguments: { tabId: 1 } }, ok: true, result: envelope("read_page", { text: "turn one" }) });
  digest.record({ step: 1, tool: "execute_tool", selected: "read_page", args: { arguments: { tabId: 2 } }, ok: true, result: envelope("read_page", { text: "turn two" }) });
  // A user turn from the thread history that merely LOOKS like a nudge sits
  // before the task; the two real nudges follow the task.
  const prompt = [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text: "Continue working on the task please (typed by the owner earlier)" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "text", text: "read every tab" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "execute_tool", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "execute_tool", output: { type: "text", value: "{}" } }] },
    NUDGE,
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "b", toolName: "execute_tool", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "b", toolName: "execute_tool", output: { type: "text", value: "{}" } }] },
    NUDGE,
  ];
  const frozen = JSON.stringify(prompt);
  const { options, bytes, turns } = digest.attach({ prompt, tools: [] }, 2);
  assertEquals(JSON.stringify(prompt), frozen, "the input prompt is never mutated");
  assertEquals(turns, 2);
  assert(bytes > 0 && bytes <= 2 * RUN_DIGEST_BOUNDS.maxBytesPerTurn);
  const users = options.prompt.filter((m) => m.role === "user").map(text);
  assert(!users[0].includes("Runtime digest"), "the owner's look-alike turn before the task gets nothing");
  assert(!users[1].includes("Runtime digest"), "the task gets nothing");
  assertStringIncludes(users[2], "turn one");
  assert(!users[2].includes("turn two"), "the first nudge carries the first turn only");
  assertStringIncludes(users[3], "turn two");
  assert(users[3].startsWith(CONTINUATION_NUDGE_PREFIX), "the nudge text stays a continuation nudge");
  // Nothing to attach: the same options object comes back.
  const empty = createRunDigest({ token: TOKEN });
  const same = { prompt };
  assertEquals(empty.attach(same, 2).options, same);
  assertEquals(digest.attach({ prompt: [{ role: "user", content: "hi" }] }, 1).bytes, 0);
});

Deno.test("run digest: turns older than the window carry counts only, so the in-context total stays bounded", () => {
  const digest = createRunDigest({ token: TOKEN });
  const turns = RUN_DIGEST_BOUNDS.maxTurnsInFull + 2;
  for (let t = 0; t < turns; t++) {
    for (let i = 0; i < 20; i++) digest.record({ step: t, tool: "execute_tool", selected: "read_page", args: { arguments: { tabId: t * 100 + i } }, ok: true, result: envelope("read_page", { text: `T${t}I${i} ` + "y".repeat(300) }) });
  }
  const prompt = [{ role: "user", content: "task" }];
  for (let t = 0; t < turns; t++) prompt.push({ role: "assistant", content: [{ type: "text", text: "…" }] }, NUDGE);
  const { options, bytes } = digest.attach({ prompt }, turns);
  const nudges = options.prompt.filter((m) => m.role === "user").map(text).slice(1);
  assertEquals(nudges.length, turns);
  assert(!nudges[0].includes("T0I0"), "the oldest turn dropped its excerpts");
  assertStringIncludes(nudges[0], "excerpts dropped — an older turn");
  assertStringIncludes(nudges[turns - 1], `T${turns - 1}I0`);
  assert(bytes <= RUN_DIGEST_BOUNDS.maxTurnsInFull * RUN_DIGEST_BOUNDS.maxBytesPerTurn + 2 * 1024, `total ${bytes} bytes`);
});

Deno.test("run digest: a turn's last model step survives in the transcript, so its results are counted but not repeated", () => {
  const digest = createRunDigest({ token: TOKEN });
  // Turn 0: call 1 = search, call 2 = ten parallel reads, call 3 = ten more.
  digest.record({ step: 0, call: 1, tool: "search_tools", args: { query: "read_page" }, ok: true, result: { modelContent: JSON.stringify({ ok: true, results: [{ name: "read_page", selectionRef: "sel_" + "e".repeat(36), summary: "Read" }] }), userSummary: "x" } });
  for (let i = 0; i < 10; i++) digest.record({ step: 0, call: 2, tool: "execute_tool", selected: "read_page", args: { arguments: { tabId: i } }, ok: true, result: envelope("read_page", { text: `EARLY-${i}` }) });
  for (let i = 10; i < 20; i++) digest.record({ step: 0, call: 3, tool: "execute_tool", selected: "read_page", args: { arguments: { tabId: i } }, ok: i !== 15, result: envelope("read_page", i === 15 ? { error: "gone" } : { text: `LAST-${i}` }) });
  const out = digest.renderTurn(0);
  assertStringIncludes(out, "So far: 21 tool results, 20 ok, 1 failed");
  assertStringIncludes(out, "This turn (1): 21 results (the last step's 10 results still in the transcript above and not repeated)");
  for (let i = 0; i < 10; i++) assertStringIncludes(out, `EARLY-${i}`);
  assert(!out.includes("LAST-1"), "the surviving step's excerpts are not repeated");
  assert(!out.includes("failed: gone"), "nor its failures");
  assertStringIncludes(out, "#1 search_tools");
  // Without call ordinals nothing is assumed to survive.
  const plain = createRunDigest({ token: TOKEN });
  plain.record({ step: 0, tool: "x", args: {}, ok: true, result: { modelContent: "only", userSummary: "only" } });
  assertStringIncludes(plain.renderTurn(0), "#1 x {} ok: only");
  // A turn whose every result is in its last step carries counts only.
  const one = createRunDigest({ token: TOKEN });
  one.record({ step: 0, call: 1, tool: "x", args: {}, ok: true, result: { modelContent: "only", userSummary: "only" } });
  const brief = one.renderTurn(0);
  assertStringIncludes(brief, "So far: 1 tool result, 1 ok, 0 failed");
  assert(!brief.includes("<<<UNTRUSTED"), "nothing to fence when nothing was lost");
});

Deno.test("run digest: reset clears everything; a fenced token is always used", () => {
  const digest = createRunDigest({ token: "not a token" });
  assert(/^[A-Za-z0-9]{6,64}$/.test(digest.token()), "a private token is minted when none is usable");
  digest.record({ step: 0, tool: "x", args: {}, ok: true, result: { modelContent: "plain", userSummary: "plain" } });
  assertStringIncludes(digest.renderTurn(0), "#1 x {} ok: plain");
  digest.reset();
  assertEquals(digest.counts(), { count: 0, ok: 0, failed: 0 });
  assertEquals(digest.renderTurn(0), "");
  assertEquals(isContinuationNudge(NUDGE), true);
  assertEquals(isContinuationNudge({ role: "assistant", content: NUDGE.content }), false);
  assertEquals(isContinuationNudge({ role: "user", content: "Continue the previous task from where it stopped." }), false, "the budget Continue turn is a new run, not a nudge");
});

Deno.test("run digest: the status counter shows the running results beside the step", () => {
  assertEquals(formatBudgetProgress({ step: 12, total: 96, results: { count: 8, ok: 7, failed: 1 } }), "Step 12 of 96 · 8 results, 1 failed");
  assertEquals(formatBudgetProgress({ step: 3, total: 96, results: { count: 1, ok: 1, failed: 0 } }), "Step 3 of 96 · 1 result");
  assertEquals(formatBudgetProgress({ step: 1, total: 96, results: { count: 0, ok: 0, failed: 0 } }), "Step 1 of 96");
  assertEquals(formatBudgetProgress({ step: 1, total: 96 }), "Step 1 of 96");
});
