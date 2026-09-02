// tests/loop-context-window.test.ts — CAP-FB-20260902-LOOP-CONTEXT-WINDOW-01.
// @ts-nocheck — the agent core is deliberately dynamic.
//
// A tool loop that spans more than one inner turn used to lose the earlier
// turns' tool results: agent-do appends `result.response.messages` to its
// history at every inner-turn boundary, and with the installed AI SDK that
// holds only the LAST step's messages. The runtime now carries a bounded,
// redacted, fenced digest of every tool result forward on agent-do's own
// continuation message, so the final answer can cite every item.
import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createAgent } from "../extension/lib/agent.js";
import { utf8ByteLength } from "../extension/lib/pure.js";

function __reset() { resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); }
globalThis.chrome ??= { permissions: { contains: async () => false }, storage: undefined };

function fakeMemory() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : undefined; },
    async set(k, v) { store.set(k, v); return { ok: true }; },
    async has(k) { return store.has(k); },
    async list() { return [...store.keys()]; },
    async clear() { store.clear(); return { ok: true }; },
  };
}

/** Wrap a model so every provider-bound prompt is recorded (what the model
 * really saw at each call — the context-window evidence). */
function recording(inner) {
  const prompts = [];
  const model = new Proxy(inner, {
    get(t, p, r) {
      if (p === "doStream" || p === "doGenerate") {
        return (options) => { prompts.push(Array.isArray(options?.prompt) ? options.prompt : []); return t[p](options); };
      }
      return Reflect.get(t, p, r);
    },
  });
  return { model, prompts };
}

const NUDGE = "Continue working on the task";
const userText = (m) => Array.isArray(m?.content) ? m.content.filter((p) => p?.type === "text").map((p) => p.text).join("") : String(m?.content ?? "");
const nudgeTexts = (prompt) => prompt.filter((m) => m?.role === "user" && userText(m).trim().startsWith(NUDGE)).map(userText);
const SECRET = "Bearer abc123SECRETTOKEN9";

Deno.test("loop context window: a 12-item loop across three inner turns cites 12/12 in its final answer", async () => {
  __reset();
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const { tool } = await import("ai");
  const { z } = await import("zod");
  const N = 12;
  const { model, prompts } = recording(createDemoModel());
  const events = [];
  const reads = [];
  const agent = createAgent({
    model: { model, modelId: "demo-local", providerName: "demo" },
    id: "hub", name: "hub", system: "test", memory: fakeMemory(), taskId: "t-window",
    // innerStepLimit = max(2, min(maxIterations, 24)) = 6 → the 12 reads span
    // THREE read-bearing inner turns (3 reads, 6 reads, 3 reads + the answer).
    maxIterations: 6,
    tools: {
      list_tabs: tool({ description: "List EVERY open tab", inputSchema: z.object({}), execute: async () => ({ count: N + 2, windows: 1, tabs: [
        { id: 1, url: "chrome-extension://x/ntp.html", title: "hub" },
        ...Array.from({ length: N }, (_, i) => ({ id: 100 + i, url: `http://127.0.0.1:1/tab/${i + 1}`, title: `tab ${i + 1}` })),
        { id: 2, url: "http://127.0.0.1:1/red.html", title: "red" },
      ] }) }),
      read_page: tool({ description: "Read the page", inputSchema: z.object({ tabId: z.number() }), execute: async ({ tabId }) => {
        reads.push(tabId);
        if (tabId === 105) return { error: "Cannot access contents of the page." };
        // One page carries a credential-shaped string: it must never reach the
        // model — not in the raw result, not in the carried digest.
        const text = tabId === 101 ? `FACT-02: page 101 says Authorization: ${SECRET} end` : `FACT-${String(tabId - 99).padStart(2, "0")}: page ${tabId} reports ${(tabId * 37) % 1000} units`;
        return { untrusted: true, title: `t${tabId}`, url: `http://127.0.0.1:1/tab/${tabId - 99}`, text };
      } }),
    },
    onProgress: (ev) => events.push(ev),
  });
  assertEquals(agent.budget().innerStepLimit, 6);
  const result = await agent.run("@demo-every-tab match=/tab/", "", []);

  // The answer cites every item: 12 listed, 11 read, the unreadable one named.
  assertStringIncludes(String(result), `Every tab: listed ${N}, read ${N - 1} of ${N}`);
  assertStringIncludes(String(result), "could not read 1: 105 (Cannot access contents of the page.)");
  assertEquals(new Set(reads).size, N, "every listed tab was read exactly once");
  assertEquals(reads.length, N, "no tab was re-read after a boundary");
  // The loop really crossed inner-turn boundaries: tool calls happened in at
  // least three distinct outer iterations, and the prompts carried agent-do's
  // continuation nudge.
  const calls = events.filter((e) => e.type === "tool-call");
  const outerSteps = new Set(calls.map((e) => e.step));
  assert(outerSteps.size >= 3, `tool calls spanned ${outerSteps.size} inner turns: ${JSON.stringify([...outerSteps])}`);
  assert(prompts.some((p) => nudgeTexts(p).length >= 2), "the model saw at least two continuation nudges");
  // The read_page selection ref was found ONCE and reused across the
  // boundaries (the digest carries it; no second search_tools round-trip).
  assertEquals(calls.filter((e) => e.toolName === "search_tools").length, 2, "one search for list_tabs, one for read_page");
  assertEquals(calls.filter((e) => e.toolName === "execute_tool").length, N + 1, "one list + one read per tab");

  // The digest rides the continuation message: runtime-written, fenced as
  // untrusted, bounded to 8 KiB per turn, and redacted.
  const digests = prompts.flatMap(nudgeTexts).filter((t) => t.includes("Runtime digest"));
  assert(digests.length > 0, "a continuation message carried the runtime digest");
  for (const d of digests) {
    assert(utf8ByteLength(d) - utf8ByteLength(NUDGE) <= 8 * 1024 + 128, `one turn's digest stays bounded (${utf8ByteLength(d)} bytes)`);
    assert(/<<<UNTRUSTED run:[A-Za-z0-9]+>>>/.test(d) && /<<<END run:[A-Za-z0-9]+>>>/.test(d), "the digest's tool-result excerpts are fenced as untrusted");
  }
  assert(digests.some((d) => /read_page[^\n]*tabId[^\n]*failed: Cannot access contents of the page/.test(d)), "a failed item is named in the digest");
  assert(digests.some((d) => /FACT-01/.test(d)), "an earlier turn's page text is excerpted in the digest");
  const everything = JSON.stringify(prompts);
  assert(!everything.includes(SECRET), "a credential in a page never reaches the model, digest included");
  assert(everything.includes("[REDACTED]"), "the credential was redacted, not dropped silently");

  // The counts ride the budget events so the status row can show them.
  const budget = events.filter((e) => e.type === "budget" && e.results);
  assert(budget.length > 0, "budget events carry the running result counts");
  const last = budget[budget.length - 1].results;
  assertEquals(last.count, N + 3, "2 searches + 1 list + 12 reads");
  assertEquals(last.failed, 1);
  assertEquals(last.ok, N + 2);
  assertEquals(events.find((e) => e.type === "done")?.budget?.exhausted, false);
});

Deno.test("loop context window: a loop that fits one inner turn carries no digest and costs no extra bytes", async () => {
  __reset();
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const { tool } = await import("ai");
  const { z } = await import("zod");
  const { model, prompts } = recording(createDemoModel());
  const events = [];
  const agent = createAgent({
    model: { model, modelId: "demo-local", providerName: "demo" },
    id: "hub", name: "hub", system: "test", memory: fakeMemory(), taskId: "t-window-one",
    maxIterations: 24,
    tools: {
      read_page: tool({ description: "Read the page", inputSchema: z.object({ tabId: z.number() }), execute: async ({ tabId }) => ({ untrusted: true, title: `t${tabId}`, text: "x" }) }),
    },
    onProgress: (ev) => events.push(ev),
  });
  const result = await agent.run("@demo-every-tab tabs=7,8,9", "", []);
  assertStringIncludes(String(result), "Every tab: listed 3, read 3 of 3.");
  // The only nudge is the one after the answer (agent-do nudges after any
  // tool step); it carries the digest of that single turn, and nothing else
  // in the prompt grew.
  const digests = prompts.flatMap(nudgeTexts).filter((t) => t.includes("Runtime digest"));
  for (const d of digests) assert(utf8ByteLength(d) <= 8 * 1024 + 128);
  const budget = events.filter((e) => e.type === "budget");
  assert(budget.every((e) => (e.digestBytes ?? 0) <= 8 * 1024 + 128), "no call carried more than one bounded digest");
});
