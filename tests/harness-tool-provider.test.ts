// tests/harness-tool-provider.test.ts — the gate between a harness and a CAP
// tool.
//
// THE CLAIM BEING TESTED IS A NEGATIVE: there is no path from a harness request
// to a side effect that skips the owner's approval. So the load-bearing
// assertions below are not "the result was right" but "the tool's execute was
// NEVER CALLED" — a spy that must stay at zero. A test that only checked the
// returned error would pass just as happily with the tool having run first.
//
// This matters because `browserToolset()`'s gates default to null, and with no
// gate wired its Destructive actions execute without approval. A harness
// toolset is a new call site, so an approval function is REQUIRED at
// construction rather than defaulted.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { z } from "zod";
import { createHarnessToolProvider } from "../extension/lib/harness-tool-provider.js";

type Any = any;

const call = (p: Any, name: string, args: Any = {}): Promise<Any> => p.callTool(name, args);

/** A toolset whose execute records every call, so "did it run" is observable
 * rather than inferred from a return value. */
function spyToolset() {
  const calls: Any[] = [];
  const toolset = {
    list_tabs: {
      description: "List open tabs",
      inputSchema: z.object({ verbose: z.boolean().optional() }).strict(),
      execute: async (args: Any) => { calls.push({ tool: "list_tabs", args }); return { ok: true, tabs: ["a"] }; },
    },
    close_tab: {
      description: "Close a tab (Destructive class)",
      inputSchema: z.object({ tabId: z.number().int() }).strict(),
      execute: async (args: Any) => { calls.push({ tool: "close_tab", args }); return { ok: true, closed: args.tabId }; },
    },
    no_validator: {
      description: "a tool with no schema",
      execute: async (args: Any) => { calls.push({ tool: "no_validator", args }); return { ok: true }; },
    },
  };
  return { toolset, calls };
}

Deno.test("an ungated harness toolset is not constructible", () => {
  const { toolset } = spyToolset();
  for (const bad of [undefined, null, "yes", 1, {}]) {
    let message = "";
    try { createHarnessToolProvider({ toolset, approve: bad as Any }); } catch (e) { message = String((e as Error)?.message ?? e); }
    assert(message.includes("approve"), `approve=${String(bad)} must be refused: ${message}`);
  }
  // And a missing toolset is refused too, rather than silently serving nothing.
  let noToolset = "";
  try { createHarnessToolProvider({ approve: async () => true } as Any); } catch (e) { noToolset = String((e as Error)?.message ?? e); }
  assert(noToolset.includes("toolset"), noToolset);
});

Deno.test("APPROVAL IS REQUIRED: a denial means the tool never runs", async () => {
  const { toolset, calls } = spyToolset();
  const asked: Any[] = [];
  const provider = createHarnessToolProvider({
    toolset,
    approve: async (request: Any) => { asked.push(request); return false; },
  });

  const result = await call(provider, "close_tab", { tabId: 7 });
  assertEquals(result.ok, false);
  // THE ASSERTION THAT MATTERS. A denial that still ran the tool would satisfy
  // `ok === false` if the refusal were written after the call.
  assertEquals(calls.length, 0, "a denied tool must not have executed");
  assertEquals(asked.length, 1, "the owner must have been asked exactly once");
  assertEquals(asked[0].tool, "close_tab");
  assertEquals(asked[0].args, { tabId: 7 }, "the owner is asked about the VALIDATED arguments, not the raw ones");
  assert(result.error.includes("not performed"), result.error);
});

Deno.test("APPROVAL IS REQUIRED: an approval is what lets it run, and the result comes back intact", async () => {
  const { toolset, calls } = spyToolset();
  const provider = createHarnessToolProvider({ toolset, approve: async () => true });
  const result = await call(provider, "close_tab", { tabId: 7 });
  assertEquals(result.ok, true);
  assertEquals(calls, [{ tool: "close_tab", args: { tabId: 7 } }]);
  assertEquals(result.result, { ok: true, closed: 7 });
});

Deno.test("an APPROVAL THAT THROWS is a denial, never a default grant", async () => {
  const { toolset, calls } = spyToolset();
  const provider = createHarnessToolProvider({ toolset, approve: async () => { throw new Error("card exploded"); } });
  const result = await call(provider, "close_tab", { tabId: 1 });
  assertEquals(result.ok, false);
  assertEquals(calls.length, 0, "a broken approval card must fail closed");
});

Deno.test("a tool with NO validator still needs approval", async () => {
  const { toolset, calls } = spyToolset();
  const denied = createHarnessToolProvider({ toolset, approve: async () => false });
  assertEquals((await call(denied, "no_validator", {})).ok, false);
  assertEquals(calls.length, 0, "no schema is not a grant");

  const allowed = createHarnessToolProvider({ toolset, approve: async () => true });
  assertEquals((await call(allowed, "no_validator", {})).ok, true);
  assertEquals(calls.length, 1);
});

Deno.test("arguments are checked with the tool's OWN validator, and a bad call never reaches the owner", async () => {
  const { toolset, calls } = spyToolset();
  let asked = 0;
  const provider = createHarnessToolProvider({
    toolset,
    approve: async () => { asked++; return true; },
  });

  // A strict schema rejects an unknown key, a wrong type, and a missing field.
  const extra = await call(provider, "list_tabs", { verbose: "yes" });
  assertEquals(extra.ok, false);
  assert(extra.error.includes("invalid arguments"), extra.error);
  assert(extra.error.includes("verbose"), `the refusal must name the offending field: ${extra.error}`);

  const missing = await call(provider, "close_tab", {});
  assertEquals(missing.ok, false);
  assert(missing.error.includes("close_tab"), missing.error);

  const wrongType = await call(provider, "close_tab", { tabId: "seven" });
  assertEquals(wrongType.ok, false);

  assertEquals(calls.length, 0, "no malformed call may execute");
  assertEquals(asked, 0, "the owner must not be asked to approve a malformed call");
});

Deno.test("validation runs BEFORE approval, so a valid call is the only one that reaches the owner", async () => {
  const { toolset } = spyToolset();
  const order: string[] = [];
  const provider = createHarnessToolProvider({
    toolset,
    approve: async () => { order.push("approve"); return true; },
  });
  await call(provider, "list_tabs", { verbose: true });
  assertEquals(order, ["approve"], "approval is reached for a valid call");

  const orderInvalid: string[] = [];
  const second = createHarnessToolProvider({
    toolset,
    approve: async () => { orderInvalid.push("approve"); return true; },
  });
  await call(second, "list_tabs", { nope: 1 });
  assertEquals(orderInvalid, [], "approval is NOT reached for an invalid call");
});

Deno.test("an unknown tool is refused by name, and is not a crash", async () => {
  const { toolset } = spyToolset();
  const provider = createHarnessToolProvider({ toolset, approve: async () => true });
  const res = await call(provider, "rm_rf", {});
  assertEquals(res.ok, false);
  assert(res.error.includes("unknown tool"), res.error);
  assert(res.error.includes("rm_rf"), res.error);

  // Prototype keys are not tools, even though they are object properties.
  for (const name of ["constructor", "__proto__", "toString", ""]) {
    const proto = await call(provider, name, {});
    assertEquals(proto.ok, false, `${name} must not be callable`);
  }
});

Deno.test("a tool that throws is reported as a failure, not as a refusal", async () => {
  const toolset = { boom: { description: "x", execute: async () => { throw new Error("tab closed"); } } };
  const provider = createHarnessToolProvider({ toolset, approve: async () => true });
  const res = await call(provider, "boom", {});
  assertEquals(res.ok, false);
  assert(res.error.includes("tab closed"), res.error);
  // A refusal and a crash must stay distinguishable in the transcript.
  assert(!res.error.includes("Owner denied"), "a crash must not read as a denial");
});

Deno.test("a tool answering {ok:false} keeps its own refusal wording", async () => {
  const toolset = { picky: { description: "x", execute: async () => ({ ok: false, error: "capability not granted" }) } };
  const provider = createHarnessToolProvider({ toolset, approve: async () => true });
  const res = await call(provider, "picky", {});
  assertEquals(res.ok, true, "the provider ran it; the tool is the one refusing");
  assertEquals(res.result, { ok: false, error: "capability not granted" });
});

Deno.test("listTools exposes every tool with a usable schema, permissive unless the caller knows better", async () => {
  const { toolset } = spyToolset();
  const permissive = createHarnessToolProvider({ toolset, approve: async () => true });
  const listed = await permissive.listTools();
  assertEquals(listed.map((t: Any) => t.name).sort(), ["close_tab", "list_tabs", "no_validator"]);
  for (const t of listed as Any[]) {
    // A zod schema is NOT a JSON Schema, and publishing it as one would lie to
    // the MCP client. The fallback is a permissive object schema; the real check
    // is the tool's own safeParse, applied on the way in.
    assertEquals(t.inputSchema.type, "object");
    assertEquals(typeof t.inputSchema.properties, "object");
  }
  assertEquals((listed as Any[]).find((t: Any) => t.name === "list_tabs").description, "List open tabs");

  // A caller that HAS a JSON Schema gets it published instead.
  const described = createHarnessToolProvider({
    toolset,
    approve: async () => true,
    describeSchema: (name: string) => name === "close_tab" ? { type: "object", properties: { tabId: { type: "integer" } }, required: ["tabId"] } : null,
  });
  const withSchema = await described.listTools();
  assertEquals((withSchema as Any[]).find((t: Any) => t.name === "close_tab").inputSchema.required, ["tabId"]);

  // A describeSchema that throws must not take the listing down.
  const broken = createHarnessToolProvider({ toolset, approve: async () => true, describeSchema: () => { throw new Error("no"); } });
  assertEquals((await broken.listTools()).length, 3);
});
