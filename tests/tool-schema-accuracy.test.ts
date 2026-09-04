// tests/tool-schema-accuracy.test.ts — gpw: every model-visible schema states
// the REAL enforced constraints, and designated content fields carry bytes
// exactly.
//
// dptw removed every size ceiling from the tool-argument contract, but three
// model-visible lies remained on main:
//   1. create_asset / update_asset / append_asset interpolated
//      ASSET_BOUNDS.maxContentBytes / maxAppendBytes — now Infinity — into the
//      schema text the model reads ("max Infinity UTF-8 bytes per call").
//   2. append_asset's description still claimed a 64 KiB per-call cap and a
//      4 MiB storage ceiling that enforcement no longer has.
//   3. append_asset.content was not a designated exact-content field, so the
//      chunked build path NFKC-normalized bytes that create_asset carries
//      whole — the same body, two paths, different bytes.
//
// RED on the pre-fix tree: the source pins find the Infinity interpolations
// and the stale ceiling copy, and the fidelity probe watches "ﬁ" (U+FB01,
// NFKC → "fi") change bytes on the append path. GREEN once the descriptions
// tell the truth and append_asset.content is designated.
// @ts-nocheck

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  executableBrowserToolRecords,
  executableBuiltinToolRecords,
  executableBundledToolRecords,
  executableManagementToolRecords,
  executableWebMcpToolRecords,
  LazyToolProtocol,
  sanitizeLazyToolArguments,
} from "../extension/lib/lazy-tool-protocol.js";
import { canonicalToolDescriptor } from "../extension/lib/tool-catalog.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import { managementToolset } from "../extension/lib/management-tools.js";
import { memoryToolset } from "../extension/lib/agent.js";
import { browserToolset } from "../extension/lib/browser-tools.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";

const HUB_SCOPE = { hub: true, agentId: "hub", origin: "", documentId: "" };

function adapterContext(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0.0",
    sourceGeneration: "extension:1",
    scope: HUB_SCOPE,
    capabilities: ["test.invoke"],
    ...overrides,
  };
}

function runContext(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    taskId: "task-1",
    runGeneration: "generation-1",
    agentId: "hub",
    origin: "",
    documentId: "hub-doc",
    ...overrides,
  };
}

function refFactory() {
  let value = 0;
  return () => `sel_${(++value).toString(16).padStart(36, "0")}`;
}

function allProductRecords() {
  return [
    ...executableBuiltinToolRecords(memoryToolset({
      get: async () => null,
      set: async () => {},
      list: async () => [],
      grep: async () => [],
    }), adapterContext()),
    ...executableBrowserToolRecords(browserToolset(false), adapterContext()),
    ...executableManagementToolRecords(managementToolset({ callRoute: () => ({ ok: true }) }), adapterContext()),
    ...executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
      scope: HUB_SCOPE,
      sourceGeneration: "bundled-conformance:1",
    }),
    ...executableWebMcpToolRecords([{
      name: "page_probe",
      source: "declared",
      description: "probe",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
    }], {
      origin: "https://example.test",
      agentId: "hub",
      documentId: "hub-doc",
      sourceGeneration: "page:1",
    }, () => ({ ok: true })),
  ];
}

Deno.test("schema accuracy: NO registered product schema renders Infinity/NaN into model-visible text", () => {
  const records = allProductRecords();
  assert(records.length > 100, "the walk covers the full registered product catalog");
  for (const record of records) {
    const descriptor = canonicalToolDescriptor(record.descriptorInput);
    for (const [label, text] of [
      ["schemaSummary", descriptor.schemaSummary],
      ["outputSchemaSummary", descriptor.outputSchemaSummary],
      ["description", String(record.descriptorInput.description ?? "")],
    ]) {
      assert(
        !/Infinity|NaN/.test(String(text)),
        `${descriptor.name}: ${label} must never render Infinity/NaN — a removed limit interpolated into model-visible text`,
      );
    }
  }
});

Deno.test("schema accuracy: append_asset states no size ceiling the store does not enforce", async () => {
  const records = executableManagementToolRecords(
    managementToolset({ callRoute: () => ({ ok: true }) }),
    adapterContext(),
  );
  const record = records.find((r) => r.descriptorInput.toolId === "append_asset");
  assert(record, "append_asset is registered");
  const descriptor = canonicalToolDescriptor(record.descriptorInput);
  const visible = `${record.descriptorInput.description}\n${descriptor.schemaSummary}`;
  assert(
    !/64\s*KiB|4\s*MiB/.test(visible),
    "append_asset must not claim a 64 KiB per-call cap or a 4 MiB storage ceiling — dptw removed both",
  );

  // The tool's own source must not interpolate a removed bound into the
  // model-visible schema text (the Infinity bug, 5ie6).
  const source = await Deno.readTextFile("extension/lib/management-tools.js");
  assert(
    !source.includes("${ASSET_BOUNDS.maxContentBytes}") &&
      !source.includes("${ASSET_BOUNDS.maxAppendBytes}"),
    "management tool schemas must not interpolate the removed ASSET_BOUNDS size ceilings",
  );
});

Deno.test("schema accuracy: the vestigial append Infinity guard is gone from both enforcement seams", async () => {
  // A `> APPEND_MAX_BYTES` check against Infinity can never fire — it is dead
  // code whose error message would read "at most Infinity UTF-8 bytes". Both
  // seams (the library and the service-worker route) drop it together.
  for (const file of ["extension/lib/artifacts.js", "extension/background/service-worker.js"]) {
    const source = await Deno.readTextFile(file);
    assert(!source.includes("APPEND_MAX_BYTES"), `${file}: no vestigial APPEND_MAX_BYTES append bound`);
    assert(
      !/at most \$\{[^}]*\} UTF-8 bytes \(append in pieces\)/.test(source),
      `${file}: no dead 'append in pieces' refusal that would interpolate Infinity`,
    );
  }
});

Deno.test("content fidelity: append_asset.content is a designated exact-content field (no NFKC rewrite)", () => {
  const records = executableManagementToolRecords(
    managementToolset({ callRoute: () => ({ ok: true }) }),
    adapterContext(),
  );
  const record = records.find((r) => r.descriptorInput.toolId === "append_asset");
  const descriptor = canonicalToolDescriptor(record.descriptorInput);

  // U+FB01 LATIN SMALL LIGATURE FI rewrites to "fi" under NFKC. A designated
  // field carries it byte-exact; an ordinary field is normalized.
  const ligature = "ﬁ";
  assertEquals(ligature.normalize("NFKC"), "fi", "the probe vector really changes under NFKC");

  const appended = sanitizeLazyToolArguments({ id: "a1", content: ligature }, descriptor);
  assertEquals(
    appended.content,
    ligature,
    "append_asset.content carries the exact bytes — the chunked build path must not diverge from create_asset",
  );

  // The create path stays the reference: same field, same fidelity.
  const createRecord = records.find((r) => r.descriptorInput.toolId === "create_asset");
  const createDescriptor = canonicalToolDescriptor(createRecord.descriptorInput);
  const created = sanitizeLazyToolArguments({ name: "n", content: ligature }, createDescriptor);
  assertEquals(created.content, ligature, "create_asset.content stays exact");

  // And a NON-designated field still normalizes — the designation is precise,
  // not a blanket pass.
  const echoDescriptor = canonicalToolDescriptor({
    sourceKind: "extension-builtin",
    packageId: "cap.test",
    toolId: "echo",
    version: "1",
    name: "echo",
    description: "probe",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    capabilities: ["test.invoke"],
    scope: HUB_SCOPE,
    sourceGeneration: "extension:1",
    availability: "ready",
    dispatcherKind: "builtin",
  });
  const plain = sanitizeLazyToolArguments({ value: ligature }, echoDescriptor);
  assertEquals(plain.value, "fi", "non-designated fields still normalize (NFKC)");
});

Deno.test("content fidelity: a >64 KiB non-normalizable append arrives at the dispatcher byte-exact", async () => {
  let saved: Record<string, unknown> | undefined;
  const records = executableManagementToolRecords(
    managementToolset({ callRoute: (_t: string, args: Record<string, unknown>) => { saved = args; return { ok: true }; } }),
    adapterContext(),
  ).filter((record: { descriptorInput: { toolId: string } }) => record.descriptorInput.toolId === "append_asset");
  const protocol = new LazyToolProtocol({
    readSources: () => records,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = runContext();
  const searched = await protocol.search({ query: "append_asset", limit: 1 }, context);
  assertEquals(searched.ok, true);

  // Past the STALE documented 64 KiB per-call cap, and non-NFKC content.
  const chunk = "ﬁ".repeat(40 * 1024); // 40 Ki ligatures = 120 KiB UTF-16
  const result = await protocol.execute({
    selectionRef: searched.results[0].selectionRef,
    arguments: { id: "a1", content: chunk },
  }, context);
  assertEquals(result.ok, true, `a past-cap append dispatches: ${JSON.stringify(result).slice(0, 200)}`);
  assertEquals(saved?.content, chunk, "every byte arrives exactly as sent — no cap, no rewrite");
});
