// tests/tool-call-clarity.test.ts — the tool-call clarity + agent-creation
// honesty KATs (owner-reported: "it said it created an agent but nothing
// appears"; "the tool bubbles are opaque and the JSON is an unformatted mess").
// Every test here is FALSIFICATION-GATED: it FAILS against the pre-fix code
// (no describeToolCall export, no nested decode, mid-string journal
// truncation, no named-agent tools in the hub prompt, no demo marker).

import { describeToolCall } from "../extension/lib/tool-summary.js";
import { buildTree, journalJson, safeJsonStringify, safeParse } from "../extension/shared/tool-tree.js";
import { redactDeep } from "../extension/lib/pure.js";
import { MASTER_SKILL } from "../extension/lib/master-skill.js";
import { createDemoModel } from "../extension/lib/models/demo-model.js";

Deno.test("describeToolCall: search_tools carries the actual query", () => {
  const s = describeToolCall("search_tools", { query: "daily notes" });
  if (s !== "Searching tools for “daily notes”") throw new Error(`got: ${s}`);
});

Deno.test("describeToolCall: navigate/open/read/memory/agent mappings are human", () => {
  const cases = [
    ["open_tab", { url: "https://example.com/x" }, "Opening https://example.com/x"],
    ["read_page", {}, "Reading the page"],
    ["memory_set", { key: "prefs" }, "Saving “prefs” to memory"],
    ["create_named_agent", { name: "Scout" }, "Creating agent “Scout”"],
    ["list_named_agents", {}, "Listing your agents"],
    ["schedule_task", { name: "digest" }, "Scheduling “digest”"],
    ["delegate_task", { agentId: "critic" }, "Delegating to critic"],
  ];
  for (const [name, args, want] of cases) {
    const got = describeToolCall(name, args);
    if (got !== want) throw new Error(`${name}: got "${got}", want "${want}"`);
  }
});

Deno.test("describeToolCall: fallback verb-izes unknown tools with the primary arg, bounded", () => {
  const got = describeToolCall("get_tab_info", { tabId: 42 });
  if (!/^Running get tab info/.test(got)) throw new Error(`fallback: ${got}`);
  const long = describeToolCall("search_history", { query: "x".repeat(500) });
  if (long.length > 80) throw new Error(`unbounded interpolation: ${long.length}`);
});

Deno.test("buildTree: a leaf string holding a JSON payload DECODES into a subtree (no raw blob)", () => {
  // The owner's exact complaint: { origin: "master", payload: "<big json string>" }
  // rendered the payload as one unreadable line.
  const nested = JSON.stringify({ items: [{ name: "a", qty: 1 }, { name: "b", qty: 2 }], total: 2 });
  const tree = buildTree({ origin: "master", payload: nested });
  const keys = tree.rows.map((r) => r.key);
  if (!keys.includes("payload")) throw new Error("payload row missing");
  // The nested decode: the payload's OWN keys appear as real rows.
  if (!keys.includes("items") || !keys.includes("total")) {
    throw new Error(`nested JSON string was NOT decoded — rows: ${keys.join(",")}`);
  }
});

Deno.test("buildTree: nested decode is bounded (hostile deep string nesting stops)", () => {
  // 12 stringify levels ≈ 50KB (under PARSE_LIMIT so decoding DOES start) but
  // well past the 8-decode budget — rows must stay bounded.
  let v: any = { leaf: true };
  for (let i = 0; i < 12; i++) v = JSON.stringify(v);
  const tree = buildTree({ payload: v });
  if (tree.rows.length > 40) throw new Error(`unbounded nested decode: ${tree.rows.length} rows`);
});

Deno.test("buildTree: a plain (non-JSON) string leaf stays a plain string", () => {
  const tree = buildTree({ note: "just some words, not json" });
  const row = tree.rows.find((r) => r.key === "note");
  if (!row || row.kind !== "string" || row.text !== "just some words, not json") {
    throw new Error(`plain string was mangled: ${JSON.stringify(row)}`);
  }
});

Deno.test("journalJson: a >2000-byte payload stays VALID bounded JSON (the slice-truncation bug)", () => {
  const big = { rows: Array.from({ length: 50 }, (_, i) => ({ i, text: "x".repeat(80) })) };
  const out = journalJson(big);
  // The old code produced `JSON.stringify(...).slice(0,2000)+"…"` — invalid JSON.
  // The fix must keep the journal parseable so the tree renderer never falls
  // back to the raw blob on replay.
  const parsed = safeParse(out);
  if (parsed.kind !== "json") throw new Error(`journaled payload is not parseable JSON: ${out.slice(0, 80)}…`);
  if (out.length > 2100) throw new Error(`unbounded journal payload: ${out.length}`);
});

Deno.test("journalJson: credential-shaped values are redacted (key-based AND pattern-based)", () => {
  const out = journalJson({ apiKey: "sk-live-abcdef123456", note: "key: ghp_secretvalue999" });
  if (out.includes("sk-live-abcdef123456")) throw new Error("apiKey value leaked into the journal");
  if (out.includes("ghp_secretvalue999")) throw new Error("credential-shaped string leaked into the journal");
  if (!/REDACTED|redacted/.test(out)) throw new Error("no redaction marker present");
});

Deno.test("redactDeep: redacts keys AND credential-shaped strings at depth, bounded on hostile input", () => {
  const r = redactDeep({ outer: { token: "abc123456", text: "authorization: Bearer abcdefghijklmnop" } });
  if (r.outer.token !== "[REDACTED]") throw new Error("key redaction missing");
  if (String(r.outer.text).includes("abcdefghijklmnop")) throw new Error("Bearer value leaked");
  let deep: any = {}; let cur: any = deep;
  for (let i = 0; i < 40; i++) { cur.next = {}; cur = cur.next; }
  const d = redactDeep(deep); // must not throw or recurse forever
  if (typeof d !== "object") throw new Error("hostile depth broke redactDeep");
});

Deno.test("hub prompt: the named-agent lifecycle is documented (the agent-creation lie fix)", () => {
  // Falsification: the pre-fix MASTER_SKILL documented create_agent (site
  // enrollment) but NEVER create_named_agent — the model had no idea the
  // teammate-creation tool existed and hallucinated success.
  if (!MASTER_SKILL.includes("create_named_agent")) throw new Error("create_named_agent undocumented");
  if (!MASTER_SKILL.includes("list_named_agents")) throw new Error("list_named_agents undocumented");
  if (!/never create_agent|never `create_agent`/i.test(MASTER_SKILL)) {
    throw new Error("the create_agent vs create_named_agent distinction is not taught");
  }
});

Deno.test("hub prompt: the action-honesty clause exists (never claim without a real tool call)", () => {
  if (!/NEVER claim you created/i.test(MASTER_SKILL)) throw new Error("honesty clause missing");
});

Deno.test("demo model: @demo-create-agent drives search→execute through the REAL lazy protocol", async () => {
  const model = createDemoModel() as any;
  const prompt = [{ role: "user", content: [{ type: "text", text: '@demo-create-agent name="KAT Bot" role="checks things"' }] }];
  const first = await model.doGenerate({ prompt });
  const call = first.content?.[0] as any;
  if (call?.type !== "tool-call" || call.toolName !== "search_tools") {
    throw new Error(`expected search_tools first, got ${call?.toolName}`);
  }
  const input = JSON.parse(call.input);
  if (input.query !== "create_named_agent") throw new Error(`search query: ${input.query}`);
});

Deno.test("demo model: the execute step carries the parsed name/role + the redaction probe", async () => {
  const model = createDemoModel() as any;
  const user = { role: "user", content: [{ type: "text", text: '@demo-create-agent name="KAT Bot" role="checks things"' }] };
  // simulate step 1: one tool result (the search) is in the slice
  const withSearch = [user, { role: "tool", content: [{ type: "tool-result", result: { results: [{ selectionRef: "sel_" + "a".repeat(36) }] } }] }];
  const second = await model.doGenerate({ prompt: withSearch });
  const call = second.content?.[0] as any;
  if (call?.type !== "tool-call" || call.toolName !== "execute_tool") {
    throw new Error(`expected execute_tool second, got ${call?.toolName}`);
  }
  const input = JSON.parse(call.input);
  if (input.arguments?.name !== "KAT Bot") throw new Error(`name not parsed: ${JSON.stringify(input.arguments)}`);
  if (input.arguments?.role !== "checks things") throw new Error(`role not parsed`);
  if (!String(input.arguments?.note ?? "").includes("sk-kat-redaction-check")) throw new Error("redaction probe missing");
});

Deno.test("pairToolJournal: a journaled execute_tool pair replays as the REAL tool (selectedTool)", async () => {
  const { pairToolJournal } = await import("../extension/shared/conversation.js");
  const rows = [
    { type: "tool-call", id: "t1", callId: "c1", run: "r1", tool: "execute_tool",
      args: JSON.stringify({ selectionRef: "sel_abc", arguments: { name: "KAT Bot", role: "checks" } }) },
    { type: "tool-result", id: "t1", callId: "c1", run: "r1", tool: "execute_tool",
      result: JSON.stringify({ modelContent: JSON.stringify({ ok: true, selectedTool: "create_named_agent" }) }),
      ok: true, selectedTool: "create_named_agent" },
  ];
  const paired = pairToolJournal(rows);
  if (paired.length !== 1) throw new Error(`expected 1 card, got ${paired.length}`);
  if (paired[0].tool !== "create_named_agent") throw new Error(`replayed as ${paired[0].tool} — the envelope leaked`);
  const args = JSON.parse(paired[0].args);
  if (args.selectionRef) throw new Error("the selectionRef plumbing leaked into the replayed card");
  if (args.name !== "KAT Bot") throw new Error("inner arguments not unwrapped");
});

Deno.test("toolRowsFromRunLog: the durable-log replay keeps the persisted selectedTool (the mapping dropped it)", async () => {
  const { toolRowsFromRunLog } = await import("../extension/shared/conversation.js");
  const logs = [
    { type: "tool-call", id: "t1", callId: "c1", run: "r1", at: 1, tool: "execute_tool",
      args: JSON.stringify({ selectionRef: "sel_x", arguments: { path: "/tmp/a.csv" } }) },
    // The SW persists selectedTool on the result row; the RESULT payload is the
    // summarized string (no envelope left to unwrap) — without the mapping the
    // replay can only show `execute_tool`.
    { type: "tool-result", id: "t1", callId: "c1", run: "r1", at: 2, tool: "execute_tool",
      result: "Read 42 rows", ok: true, selectedTool: "read_file" },
  ];
  const rows = toolRowsFromRunLog("exec-1", logs);
  const toolRow = rows.find((r) => r.role === "tool") as any;
  if (!toolRow) throw new Error("no derived tool row");
  if (toolRow.toolName !== "read_file") {
    throw new Error(`replay shows ${toolRow.toolName} — the persisted selectedTool was dropped by toolRowsFromRunLog`);
  }
});

Deno.test("journalJson: multibyte text is BYTE-bounded and never splits a surrogate pair", () => {
  const enc = new TextEncoder();
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  // 1200 four-byte emoji = 4800 bytes; the old UTF-16 length check (1200 <= headroom) passed it through whole.
  const s = journalJson("🔥".repeat(1200), { maxBytes: 2000 });
  const bytes = enc.encode(s).length;
  if (bytes > 2000) throw new Error(`journalJson emitted ${bytes} bytes > 2000 (UTF-16 length compared against a byte budget)`);
  if (LONE.test(s)) throw new Error("a surrogate pair was split mid-character");
});

Deno.test("safeJsonStringify: a huge multibyte ROOT string stays byte-bounded, pair-safe, valid JSON", () => {
  const enc = new TextEncoder();
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  // Odd-aligned pairs ("a🌊" = 3 code units) + a maxString whose cut lands on
  // a HIGH surrogate (slice(0,8) of a 3-unit pattern) — the old code-unit cut
  // leaks a lone surrogate into the parsed value; RED pre-fix.
  const out = safeJsonStringify("a🌊".repeat(50), { maxBytes: 512, maxString: 9 });
  const bytes = enc.encode(out).length;
  if (bytes > 512) throw new Error(`safeJsonStringify emitted ${bytes} bytes > 512`);
  // JSON.stringify ESCAPES a split pair ("\ud83c") — the evidence only shows
  // in the PARSED value (a real lone surrogate leaks to every consumer).
  const parsed = JSON.parse(out);
  if (LONE.test(parsed)) throw new Error("a surrogate pair was split mid-character");
});

Deno.test("buildTree: leaf truncation never splits a surrogate pair", () => {
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const tree = buildTree({ note: "📡".repeat(500) });
  // Check the RAW row strings (JSON.stringify would escape the evidence).
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(tree);
  if (strings.some((t) => LONE.test(t))) throw new Error("a leaf truncation split a surrogate pair");
});
