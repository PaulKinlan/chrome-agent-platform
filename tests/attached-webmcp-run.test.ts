import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { bindAttachedWebmcpRun } from "../extension/lib/attached-webmcp-run.js";
import { createEphemeralSiteToolConsentStore } from "../extension/lib/ephemeral-site-tool-consent.js";

const candidate = { origin: "https://example.test", tabId: 9, documentId: "doc-one", toolCount: 2 };
const tab = { kind: "tab", tabId: 9, documentId: "doc-one", url: "https://forged.test/never-authority" };
const args = (overrides: Record<string, unknown> = {}) => ({
  attachments: [tab], runId: "sw-generated-execution", threadId: "thread-one",
  consentStore: createEphemeralSiteToolConsentStore(),
  attest: async () => candidate,
  allowOrigin: () => true,
  ...overrides,
});

Deno.test("3p3e.3: run binds exact Chrome document and closes opaque consent token at settle", async () => {
  const options = args();
  const run = await bindAttachedWebmcpRun(options);
  assertEquals(run.bindings.length, 1);
  assertEquals(options.consentStore.binding(run.bindings[0].token), {
    origin: "https://example.test", tabId: 9, documentId: "doc-one",
    runId: "sw-generated-execution", threadId: "thread-one",
  });
  assert(!("url" in run.bindings[0]), "untrusted attachment URL never becomes authority");
  run.end();
  assertThrows(() => options.consentStore.binding(run.bindings[0].token), Error, "ephemeral_site_tool_run_not_live");
  run.end(); // idempotent on repeat/finally
});

Deno.test("3p3e.3: navigation, missing picked document, denied allowlist, and malformed tab never begin authority", async () => {
  for (const overrides of [
    { attest: async () => ({ ...candidate, documentId: "new-doc" }) },
    { attachments: [{ ...tab, documentId: undefined }] },
    { allowOrigin: () => false },
    { attachments: [{ ...tab, tabId: 0 }] },
  ]) {
    const run = await bindAttachedWebmcpRun(args(overrides));
    assertEquals(run.bindings.length, 0);
    run.end();
  }
});

Deno.test("3p3e.3: a run cancelled during Chrome attestation cannot mint a consent token", async () => {
  let active = true;
  const run = await bindAttachedWebmcpRun(args({
    runActive: () => active,
    attest: async () => { active = false; return candidate; },
  }));
  assertEquals(run.bindings.length, 0);
  run.end();
});

Deno.test("3p3e.3: only eight owner-picked tabs are probed; extras remain ordinary context", async () => {
  let probes = 0;
  const attachments = Array.from({ length: 40 }, (_, i) => ({ ...tab, tabId: i + 1, documentId: `doc-${i + 1}` }));
  const run = await bindAttachedWebmcpRun(args({ attachments,
    attest: async (id: number) => { probes++; return { ...candidate, tabId: id, documentId: `doc-${id}`, origin: `https://${id}.example.test` }; },
  }));
  assertEquals(probes, 8);
  assertEquals(run.bindings.length, 8);
  run.end();
});

Deno.test("3p3e.3: SW binds only a live hub run after beginExecution and ends tokens in finally", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const begin = sw.indexOf("    beginExecution(executionId, taskId);");
  const binding = sw.indexOf("ephemeralAttachedRun = await bindAttachedWebmcpRun(", begin);
  const runOrch = sw.indexOf("      orch = await ensureOrchestrator(", begin);
  const end = sw.indexOf("ephemeralAttachedRun?.end();", runOrch);
  assert(begin > 0 && binding > begin && runOrch > binding && end > runOrch, "SW run lifecycle must bind after its live execution exists, before orchestrator, then tear down");
  assert(sw.slice(binding, runOrch).includes("attestCurrentAttachedWebmcpTab"));
});

Deno.test("3p3e.3: count-only run candidates dedupe an origin and do not enroll a Site Agent", async () => {
  const options = args({ attachments: [tab, { ...tab, tabId: 11, documentId: "doc-two" }],
    attest: async (tabId: number) => tabId === 9 ? candidate : { ...candidate, tabId: 11, documentId: "doc-two" } });
  const run = await bindAttachedWebmcpRun(options);
  assertEquals(run.bindings.length, 1);
  assertEquals(Object.keys(run.bindings[0]).sort(), ["candidate", "token"]);
  assertEquals(run.bindings[0].candidate, candidate);
  run.end();
});
