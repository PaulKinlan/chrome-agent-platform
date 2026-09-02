// tests/recent-activity-feed.test.ts — CAP-FB-20260830-RECENT-ACTIVITY-USER-EVENTS-01 (opd2)
// @ts-nocheck

const registry = new Map();
class HTMLElementStub {
  constructor() { this._attrs = new Map(); }
  attachShadow(_init) { return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], appendChild: () => {} }; }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  hasAttribute(n) { return this._attrs.has(n); }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  removeAttribute(n) { this._attrs.delete(n); }
  dispatchEvent(_e) { return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.HTMLElement = globalThis.HTMLElement || HTMLElementStub;
globalThis.customElements = globalThis.customElements || {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis.window || globalThis;
globalThis.CustomEvent = globalThis.CustomEvent || class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail ?? null;
    this.bubbles = !!init.bubbles;
  }
};

import { assert, assertEquals } from "jsr:@std/assert@1";
import { USER_VISIBLE_KINDS, USER_VISIBLE_KINDS_SET } from "../extension/lib/activity-kinds.js";
import { createActivityRoutes, filterActivityEntries } from "../extension/background/routes/activity.js";

const { activityText, userKindLabel } = await import("../extension/shared/components.js");

Deno.test("recent-activity: activity-kinds allowlist contains only user-meaningful events", () => {
  const expected = [
    "task",
    "result",
    "artifact",
    "approval-requested",
    "approval-granted",
    "approval-denied",
    "schedule-ran",
  ];
  assertEquals([...USER_VISIBLE_KINDS], expected);
  assertEquals(USER_VISIBLE_KINDS_SET.size, expected.length);

  // Protocol / attestation / debug rows must NOT be in the allowlist
  for (const denied of ["prompt-attestation", "tool-call", "tool-result", "screenshot", "error", "auth-token"]) {
    assert(!USER_VISIBLE_KINDS_SET.has(denied), `allowlist must exclude protocol kind: ${denied}`);
  }
});

Deno.test("recent-activity: route-level createActivityRoutes enforces default-deny and intersection", async () => {
  const mixedJournal = [
    { id: "1", type: "task", task: "User task", ts: 100 },
    { id: "2", type: "prompt-attestation", ts: 101 },
    { id: "3", type: "tool-call", tool: "fs.read", args: "{}", ts: 102 },
    { id: "4", type: "tool-result", result: "file content", ts: 103 },
    { id: "5", type: "result", result: "Finished task.", ok: true, ts: 104 },
    { id: "6", type: "screenshot", ts: 105 },
    { id: "7", type: "artifact", artifact: { name: "Report" }, ts: 106 },
    { id: "8", type: "approval-requested", task: "Need access", ts: 107 },
    { id: "9", type: "error", error: "Fatal error", ts: 108 },
  ];

  const deps = {
    masterMemory: () => ({ async get() { return mixedJournal; } }),
    namedAgentMemory: () => ({ async get() { return []; } }),
    backgroundAgentMemory: () => ({ async get() { return []; } }),
    siteMemory: () => ({ async get() { return []; } }),
    listNamedAgents: async () => [],
    listNamedAgentIds: async () => [],
    listBackgroundAgentIds: async () => [],
    listOrigins: async () => [],
    slugifyAgentId: (id) => String(id),
  };

  const routes = createActivityRoutes(deps);

  // 1. Omitted kinds in route request → defaults to user-visible kinds only (task, result, artifact, approval-requested)
  const defRes = await routes["activity.list"]({});
  assertEquals(defRes.count, 4, "default route call returns exactly the 4 user-visible rows");
  const defTypes = new Set(defRes.entries.map((e) => e.type));
  assertEquals([...defTypes].sort(), ["approval-requested", "artifact", "result", "task"]);
  assert(!defTypes.has("prompt-attestation"), "prompt-attestation excluded");
  assert(!defTypes.has("tool-call"), "tool-call excluded");
  assert(!defTypes.has("tool-result"), "tool-result excluded");
  assert(!defTypes.has("screenshot"), "screenshot excluded");
  assert(!defTypes.has("error"), "error excluded");

  // 2. Requesting protocol kinds alone → default-deny drops them, yields empty
  const protocolRes = await routes["activity.list"]({ kinds: ["tool-call", "screenshot", "error"] });
  assertEquals(protocolRes.count, 0, "protocol kinds request returns 0 entries");

  // 3. Requesting mixed kinds → intersects strictly with user allowlist
  const mixedRes = await routes["activity.list"]({ kinds: ["task", "tool-call", "artifact"] });
  assertEquals(mixedRes.count, 2, "mixed request returns only task and artifact");
  assertEquals(mixedRes.entries.map((e) => e.type), ["artifact", "task"]);
});

Deno.test("recent-activity: pure filterActivityEntries default-deny filtering", () => {
  const sampleEntries = [
    { id: "1", type: "task", task: "Plan vacation", ts: 100 },
    { id: "2", type: "tool-call", tool: "browse", ts: 101 },
    { id: "3", type: "prompt-attestation", ts: 102 },
    { id: "4", type: "result", result: "Trip planned.", ok: true, ts: 103 },
    { id: "5", type: "screenshot", ts: 104 },
    { id: "6", type: "artifact", task: "Itinerary", ts: 105 },
  ];

  const def = filterActivityEntries(sampleEntries, {});
  assertEquals(def.map((e) => e.type), ["artifact", "result", "task"]);

  const protocolOnly = filterActivityEntries(sampleEntries, { kinds: ["tool-call", "screenshot"] });
  assertEquals(protocolOnly.length, 0);

  const mixed = filterActivityEntries(sampleEntries, { kinds: ["task", "prompt-attestation"] });
  assertEquals(mixed.map((e) => e.type), ["task"]);
});

Deno.test("recent-activity: per-kind human summaries and labels (including approval variants)", () => {
  assertEquals(userKindLabel({ type: "task" }), "Started");
  assertEquals(userKindLabel({ type: "result", ok: true }), "Finished");
  assertEquals(userKindLabel({ type: "result", ok: false }), "Failed");
  assertEquals(userKindLabel({ type: "artifact" }), "Made");
  assertEquals(userKindLabel({ type: "approval-requested" }), "Needs approval");
  assertEquals(userKindLabel({ type: "approval-granted" }), "Approved");
  assertEquals(userKindLabel({ type: "approval-denied" }), "Denied");
  assertEquals(userKindLabel({ type: "schedule-ran" }), "Schedule ran");

  // Approval granted
  const grantedLine = activityText({ type: "approval-granted", description: "Deploy latest build to staging server." });
  assert(grantedLine.length <= 140, "approval-granted <= 140");
  assert(grantedLine.endsWith("approved"), "approval-granted ends with approved");
  assert(grantedLine.includes("Deploy latest build to staging server."), "approval-granted contains subject");

  // Approval denied
  const deniedLine = activityText({ type: "approval-denied", task: "Delete production database table." });
  assert(deniedLine.length <= 140, "approval-denied <= 140");
  assert(deniedLine.endsWith("denied"), "approval-denied ends with denied");
  assert(deniedLine.includes("Delete production database table."), "approval-denied contains subject");
});

Deno.test("recent-activity: ≤140 boundary challenged when the first sentence itself exceeds 140 chars", () => {
  // A long unbroken first sentence of 200+ characters with NO early punctuation
  const longFirstSentence = "This is an extremely long single sentence description designed to exceed the one hundred and forty character limit without any punctuation marks before the very end of the string which keeps going and going.";
  assert(longFirstSentence.length > 140, "test fixture sentence must exceed 140 chars");

  // 1. Task with oversized first sentence -> must be <= 140 and never a raw cut past boundary
  const taskSummary = activityText({ type: "task", task: longFirstSentence });
  assert(taskSummary.length <= 140, `task summary exceeds 140 (${taskSummary.length}): ${taskSummary}`);
  assert(taskSummary === "a task" || taskSummary.length <= 140, "task summary handles long sentence cleanly");

  // 2. Result with oversized first sentence -> must be <= 140 with honest fallback/truncation
  const resultSummary = activityText({ type: "result", result: longFirstSentence, ok: true });
  assert(resultSummary.length <= 140, `result summary exceeds 140 (${resultSummary.length}): ${resultSummary}`);
  assert(resultSummary.startsWith("Finished"), "result summary retains verdict");

  // 3. Artifact with oversized name -> must be <= 140
  const artifactSummary = activityText({ type: "artifact", artifact: { name: longFirstSentence } });
  assert(artifactSummary.length <= 140, `artifact summary exceeds 140 (${artifactSummary.length}): ${artifactSummary}`);
  assert(artifactSummary.startsWith("Made"), "artifact summary retains Made prefix");

  // 4. Approval with oversized subject -> must be <= 140 and include verb
  const approvalSummary = activityText({ type: "approval-requested", task: longFirstSentence });
  assert(approvalSummary.length <= 140, `approval summary exceeds 140 (${approvalSummary.length}): ${approvalSummary}`);
  assert(approvalSummary.endsWith("needs approval"), "approval retains verb");

  // 5. Schedule with oversized task -> must be <= 140
  const scheduleSummary = activityText({ type: "schedule-ran", task: longFirstSentence });
  assert(scheduleSummary.length <= 140, `schedule summary exceeds 140 (${scheduleSummary.length}): ${scheduleSummary}`);
  assert(scheduleSummary.startsWith("Ran"), "schedule retains Ran prefix");
});

Deno.test("recent-activity: JSON objects with no readable scalar take honest refusal path and contain no raw JSON", () => {
  const nestedComplexObj = {
    nested: {
      items: [1, 2, 3],
      flags: { valid: true, code: 0x42 },
      data: "D".repeat(400),
    },
  };

  const rawJson = JSON.stringify(nestedComplexObj);
  const jsonOk = activityText({ type: "result", result: rawJson, ok: true });
  assert(jsonOk.includes("see the run log"), `must include refusal path, got: ${jsonOk}`);
  assert(jsonOk.startsWith("Finished"), "starts with Finished verdict");
  assert(!jsonOk.includes('"nested"'), "no raw JSON key 'nested'");
  assert(!jsonOk.includes('"items"'), "no raw JSON key 'items'");
  assert(!jsonOk.includes('"flags"'), "no raw JSON key 'flags'");
  assert(!jsonOk.includes("DDDD"), "no raw JSON data value");
  assert(jsonOk.length <= 140, "refusal path output <= 140");

  const jsonFail = activityText({ type: "result", result: rawJson, ok: false });
  assert(jsonFail.includes("see the run log"), `must include refusal path, got: ${jsonFail}`);
  assert(jsonFail.startsWith("Failed"), "starts with Failed verdict");
  assert(!jsonFail.includes('"nested"'), "no raw JSON leaked in failure refusal");
});

Deno.test("recent-activity: CSS rules for .tl-row and .aex-entry summary specifically enforce minmax(0,1fr)", async () => {
  const components = await Deno.readTextFile("extension/shared/components.js");

  function extractRule(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"));
    assert(match, `missing CSS rule for selector: ${selector}`);
    return match[1].replace(/\s+/g, " ").trim();
  }

  // 1. Extract .tl-row rule in AgentTimeline
  const tlRule = extractRule(components, ".tl-row");
  assert(
    tlRule.includes("grid-template-columns:10px minmax(0,1fr) auto 20px") ||
    tlRule.includes("grid-template-columns: 10px minmax(0, 1fr) auto 20px") ||
    tlRule.includes("grid-template-columns: 10px minmax(0,1fr) auto 20px"),
    `AgentTimeline .tl-row must declare minmax(0,1fr) in grid-template-columns, got: ${tlRule}`,
  );

  // 2. Extract .aex-entry summary rule in ActivityExplorer
  const aexRule = extractRule(components, ".aex-entry summary");
  assert(
    aexRule.includes("grid-template-columns:auto minmax(0,1fr) auto") ||
    aexRule.includes("grid-template-columns: auto minmax(0, 1fr) auto") ||
    aexRule.includes("grid-template-columns: auto minmax(0,1fr) auto"),
    `ActivityExplorer .aex-entry summary must declare minmax(0,1fr) in grid-template-columns, got: ${aexRule}`,
  );
});

Deno.test("recent-activity: runs-today count is refreshed inside refreshHubActivity, scheduleRunLogRefresh, and flushRunLogDirty", async () => {
  const ntp = await Deno.readTextFile("extension/ntp/ntp.js");

  // 1. Check refreshHubActivity function body
  const refreshMatch = ntp.match(/function refreshHubActivity\(\)\s*\{([\s\S]*?)\n\}/);
  assert(refreshMatch, "refreshHubActivity function must exist in ntp.js");
  const refreshBody = refreshMatch[1];
  assert(refreshBody.includes("renderHubUsage()"), "refreshHubActivity must invoke renderHubUsage()");
  assert(refreshBody.includes("refreshTimeline()"), "refreshHubActivity must invoke refreshTimeline()");

  // 2. Check scheduleRunLogRefresh function body
  const scheduleMatch = ntp.match(/function scheduleRunLogRefresh\(\)\s*\{([\s\S]*?)\n\}/);
  assert(scheduleMatch, "scheduleRunLogRefresh function must exist in ntp.js");
  const scheduleBody = scheduleMatch[1];
  assert(
    scheduleBody.includes("refreshHubActivity") || scheduleBody.includes("renderHubUsage"),
    "scheduleRunLogRefresh must trigger refreshHubActivity / renderHubUsage",
  );

  // 3. Check flushRunLogDirty function body
  const flushMatch = ntp.match(/function flushRunLogDirty\(\)\s*\{([\s\S]*?)\n\}/);
  assert(flushMatch, "flushRunLogDirty function must exist in ntp.js");
  const flushBody = flushMatch[1];
  assert(
    flushBody.includes("refreshHubActivity") || flushBody.includes("renderHubUsage"),
    "flushRunLogDirty must trigger refreshHubActivity / renderHubUsage",
  );
});
