// @ts-nocheck — record harnesses are intentionally dynamic.
// tests/webmcp-argsvalidation.test.ts — CAP-FB-20260824-WEBMCP-ARGSVALIDATION-01:
// the bistro booking failed `lazy-arguments-invalid` with NO detail — the model
// invented "ensure the tab is open and has permissions" because it could not
// see WHICH field failed. These KATs pin: (1) the REAL bistro-shaped schema
// compiles and accepts a valid booking; (2) a rejection carries a NAMED reason
// + per-field detail the model can repair from; (3) fail-open compile for
// common JSON-Schema keywords ($schema/format/pattern/oneOf/unknown) with the
// present fields still strict; (4) named diagnostics fire.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { z } from "npm:zod@3";
import { compileSchemaToZod, schemaToZod } from "../extension/lib/pure.js";
import { executableBuiltinToolRecords, executableWebMcpToolRecords, LazyToolProtocol } from "../extension/lib/lazy-tool-protocol.js";
import { tool } from "ai";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";

// The EXACT schema the bistro's declarative WebMCP form generates (polyfill):
// SELECTs become string enums — "2 people" is the STRING "2", and "outside"
// seating is "Terrace". This shape is why the booking kept failing.
const BISTRO_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Customer's full name (min 2 chars)" },
    phone: { type: "string", description: "Customer's phone number (min 10 digits)" },
    date: { type: "string", description: "Reservation date. Must be today or future." },
    time: { type: "string", description: "Reservation time" },
    guests: { type: "string", enum: ["1", "2", "3", "4", "5", "6"], description: "Number of people dining" },
    seating: { type: "string", enum: ["Main Dining", "Terrace", "Private Booth", "Bar"], description: "Preferred seating area" },
    requests: { type: "string", description: "Special requests" },
  },
  required: ["name", "phone", "date", "time", "guests"],
};

const ORIGIN = "https://googlechromelabs.github.io";
const VALID_BOOKING = {
  name: "Paul Kinlan", phone: "555-010-1234", date: "2026-08-28",
  time: "19:00", guests: "2", seating: "Terrace", requests: "no allergies",
};

function refFactory() {
  let value = 0;
  return () => `sel_${(++value).toString(16).padStart(36, "0")}`;
}
function runContext() {
  return { runId: "run-1", taskId: "task-1", runGeneration: "g1", agentId: ORIGIN, origin: ORIGIN, documentId: "", catalogGeneration: "1" };
}

// Drive the REAL protocol over REAL WebMCP records (no validator stubs).
async function drive(schema, args, denials) {
  const dispatched = [];
  const records = executableWebMcpToolRecords(
    [{ name: "book_table_le_petit_bistro", source: "declared", description: "Book a table", inputSchema: schema }],
    {
      origin: ORIGIN, agentId: ORIGIN, documentId: "",
      sourceGeneration: "enrollment:1:document::epoch:0:seq:0",
      closureGeneration: "enrollment:1:document::epoch:0:seq:0",
      onValidationDenied: (info) => denials.push(info),
    },
    ({ name, args: a }) => { dispatched.push({ name, args: a }); return { ok: true, result: "booked" }; },
  );
  const protocol = new LazyToolProtocol({
    readSources: () => records,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const ctx = runContext();
  const search = await protocol.search({ query: "book table" }, ctx);
  if (!search.ok || !search.results?.length) return { search, exec: null, dispatched };
  const exec = await protocol.execute({ selectionRef: search.results[0].selectionRef, arguments: args }, ctx);
  return { search, exec, dispatched };
}

Deno.test("argsvalidation: the REAL bistro-shaped schema accepts a valid booking end-to-end (the booking unblocks)", async () => {
  const denials = [];
  const { exec, dispatched } = await drive(BISTRO_SCHEMA, VALID_BOOKING, denials);
  assertEquals(exec?.ok, true, `a valid booking must dispatch (got ${JSON.stringify(exec)})`);
  assertEquals(dispatched.length, 1);
  assertEquals(denials, []);
});

Deno.test("argsvalidation: a wrong booking is rejected with a NAMED reason + per-field detail the model can repair from — and the repaired retry dispatches", async () => {
  const denials = [];
  // The owner's prompt ("2 people", "outside") naturally yields guests:2
  // (number) and seating:"outside" — both genuinely violate the schema.
  const bad = { ...VALID_BOOKING, guests: 2, seating: "outside" };
  const first = await drive(BISTRO_SCHEMA, bad, denials);
  assertEquals(first.exec?.ok, false);
  assertEquals(first.exec?.error, "lazy-arguments-invalid");
  assertEquals(first.exec?.reason, "parse-rejected", "the failure is NAMED, not opaque");
  assertStringIncludes(first.exec?.detail ?? "", "guests", "the detail names the failing field");
  assertStringIncludes(first.exec?.detail ?? "", "seating");
  assertEquals(first.dispatched.length, 0);
  // The diagnostics hook fired with the same named reason.
  assert(denials.some((d) => d.reason === "parse-rejected" && d.name === "book_table_le_petit_bistro" && d.origin === ORIGIN));
  // The repair loop: with the detail, the model corrects to schema-true values.
  const second = await drive(BISTRO_SCHEMA, { ...bad, guests: "2", seating: "Terrace" }, []);
  assertEquals(second.exec?.ok, true, "the repaired booking dispatches");
  assertEquals(second.dispatched.length, 1);
});

Deno.test("argsvalidation: missing required fields are named in the detail (the owner's prompt carried no name/phone)", async () => {
  const denials = [];
  const sparse = { date: "2026-08-28", time: "19:00", guests: "2" };
  const { exec, dispatched } = await drive(BISTRO_SCHEMA, sparse, denials);
  assertEquals(exec?.ok, false);
  assertEquals(exec?.reason, "parse-rejected");
  assertStringIncludes(exec?.detail ?? "", "name");
  assertStringIncludes(exec?.detail ?? "", "phone");
  assertEquals(dispatched.length, 0);
});

Deno.test("argsvalidation: fail-open compile — $schema/format/pattern/unknown keywords never brick the tool; present fields stay strict", async () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      date: { type: "string", format: "date" },
      code: { type: "string", pattern: "^[a-z]+$" },
      note: { type: "string", "x-custom-vendor-keyword": true },
    },
    required: ["date"],
  };
  const denials = [];
  const ok = await drive(schema, { date: "2026-08-28", code: "abc", note: "x" }, denials);
  assertEquals(ok.exec?.ok, true, `compiles + dispatches (got ${JSON.stringify(ok.exec)})`);
  // pattern is DROPPED (never a regex-DoS vector), not enforced:
  const patternFree = await drive(schema, { date: "2026-08-28", code: "ABC1" }, []);
  assertEquals(patternFree.exec?.ok, true);
  // ...but the declared TYPE stays strict:
  const wrong = await drive(schema, { date: 20260828 }, []);
  assertEquals(wrong.exec?.ok, false);
  assertEquals(wrong.exec?.reason, "parse-rejected");
  // And the compile REPORTED the drops:
  const compiled = compileSchemaToZod(z, schema);
  assertEquals(compiled.fatal, null);
  assert(compiled.dropped.includes("$schema") && compiled.dropped.includes("format") && compiled.dropped.includes("pattern") && compiled.dropped.includes("x-custom-vendor-keyword"));
});

Deno.test("argsvalidation: a tool with NO inputSchema ({}) accepts any arguments object (no longer bricked)", async () => {
  const { exec, dispatched } = await drive(undefined, { anything: "goes" }, []);
  assertEquals(exec?.ok, true);
  assertEquals(dispatched.length, 1);
  // and standalone: {} compiles to an unconstrained schema.
  assertEquals(schemaToZod(z, {}).safeParse({ any: 1 }).success, true);
});

Deno.test("argsvalidation: a DoS-bounds-violating schema fails CLOSED with a named schema-compile-failed", async () => {
  let deep = { type: "object", properties: {} };
  for (let i = 0; i < 10; i++) deep = { type: "object", properties: { n: deep } };
  const denials = [];
  const { exec, dispatched } = await drive(deep, { n: {} }, denials);
  assertEquals(exec?.ok, false);
  assertEquals(exec?.reason, "schema-compile-failed");
  assertStringIncludes(exec?.detail ?? "", "depth");
  assertEquals(dispatched.length, 0);
  assert(denials.some((d) => d.reason === "schema-compile-failed"));
});

Deno.test("argsvalidation: validator-threw and bad-data are named (unit, through the REAL protocol)", async () => {
  const baseRecord = executableBuiltinToolRecords({
    echo: tool({
      description: "Echo a bounded value",
      inputSchema: z.object({ value: z.string().max(64) }),
      execute: () => ({ ok: true }),
    }),
  }, {
    version: "1.0.0", sourceGeneration: "extension:1",
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
    capabilities: ["test.invoke"],
  })[0];
  const throwing = {
    descriptorInput: baseRecord.descriptorInput,
    authorize: baseRecord.authorize,
    validateArguments: async () => { throw new Error("boom"); },
    dispatch: () => ({ ok: true }),
  };
  const badData = {
    ...throwing,
    validateArguments: async () => ({ ok: true, data: "not-an-object" }),
  };
  for (const [record, reason] of [[throwing, "validator-threw"], [badData, "bad-data"]]) {
    const protocol = new LazyToolProtocol({
      readSources: () => [record],
      selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
    });
    const ctx = { runId: "r", taskId: "t", runGeneration: "g", agentId: "hub", origin: "", documentId: "hub-doc", catalogGeneration: "1" };
    const search = await protocol.search({ query: "echo" }, ctx);
    assertEquals(search.ok, true);
    assertEquals(search.results.length, 1, "search must find the record");
    const exec = await protocol.execute({ selectionRef: search.results[0].selectionRef, arguments: { value: "x" } }, ctx);
    assertEquals(exec?.error, "lazy-arguments-invalid");
    assertEquals(exec?.reason, reason);
  }
});

Deno.test("argsvalidation WIRING (source pins): the SW pushes validation denials to the diagnostics ring; the protocol carries reason/detail", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const proto = await Deno.readTextFile(new URL("../extension/lib/lazy-tool-protocol.js", import.meta.url));
  assert(sw.includes("onValidationDenied: (info) =>") && sw.includes("WebMCP tool arguments rejected:"), "readSiteLazySources wires onValidationDenied → pushDiagnostic");
  assert(proto.includes("compileSchemaToZod(z, schema)"), "the WebMCP validator compiles with a diagnostics report");
  assert(proto.includes('reason: "parse-rejected", detail'), "parse rejections carry the zod issues");
  assert(proto.includes("function validationError(reason, detail)"), "validateRecordArguments enriches the error");
});
