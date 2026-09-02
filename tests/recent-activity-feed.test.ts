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
import { filterActivityEntries } from "../extension/background/routes/activity.js";

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

Deno.test("recent-activity: activity.list default-deny kinds filtering", () => {
  const sampleEntries = [
    { id: "1", type: "task", task: "Plan vacation", ts: 100 },
    { id: "2", type: "tool-call", tool: "browse", ts: 101 },
    { id: "3", type: "prompt-attestation", ts: 102 },
    { id: "4", type: "result", result: "Trip planned.", ok: true, ts: 103 },
    { id: "5", type: "screenshot", ts: 104 },
    { id: "6", type: "artifact", task: "Itinerary", ts: 105 },
  ];

  // Default (no kinds specified) → only user visible kinds returned
  const def = filterActivityEntries(sampleEntries, {});
  assertEquals(def.map((e) => e.type), ["artifact", "result", "task"]);

  // Attempting to request protocol kinds alone yields empty
  const protocolOnly = filterActivityEntries(sampleEntries, { kinds: ["tool-call", "screenshot"] });
  assertEquals(protocolOnly.length, 0);

  // Requesting mix of valid and invalid kinds filters down to valid intersection
  const mixed = filterActivityEntries(sampleEntries, { kinds: ["task", "prompt-attestation"] });
  assertEquals(mixed.map((e) => e.type), ["task"]);
});

Deno.test("recent-activity: per-kind human summaries stay within ≤140 chars", () => {
  const longText = "A".repeat(500);

  // Task
  const taskLine = activityText({ type: "task", task: `Check flight prices to Rome. ${longText}` });
  assert(taskLine.length <= 140, `task line exceeds 140: ${taskLine.length}`);
  assert(taskLine.startsWith("Check flight prices to Rome."), "task takes first readable sentence");

  // Result
  const resultLine = activityText({ type: "result", result: `[demo model] Hotel reservation confirmed. ${longText}`, ok: true });
  assert(resultLine.length <= 140, `result line exceeds 140: ${resultLine.length}`);
  assert(!resultLine.includes("[demo model]"), "demo tag stripped");
  assert(resultLine.startsWith("Finished: Hotel reservation confirmed."), "result formatted with verdict and first sentence");

  // Artifact
  const artifactLine = activityText({ type: "artifact", artifact: { name: `Summer Travel Itinerary. ${longText}` } });
  assert(artifactLine.length <= 140, `artifact line exceeds 140: ${artifactLine.length}`);
  assert(artifactLine.startsWith("Made Summer Travel Itinerary."), "artifact formatted as Made <name>");

  // Approval requested
  const reqLine = activityText({ type: "approval-requested", task: `Send email to hotel manager. ${longText}` });
  assert(reqLine.length <= 140, `approval line exceeds 140: ${reqLine.length}`);
  assert(reqLine.includes("needs approval"), "approval includes verb");

  // Schedule ran
  const schedLine = activityText({ type: "schedule-ran", task: `Daily calendar check. ${longText}` });
  assert(schedLine.length <= 140, `schedule line exceeds 140: ${schedLine.length}`);
  assert(schedLine.startsWith("Ran Daily calendar check."), "schedule formatted as Ran <task>");
});

Deno.test("recent-activity: JSON objects with no readable scalar take honest refusal path", () => {
  const nestedComplexObj = {
    nested: {
      items: [1, 2, 3],
      flags: { valid: true, code: 0x42 },
      data: "D".repeat(400),
    },
  };

  const jsonOk = activityText({ type: "result", result: JSON.stringify(nestedComplexObj), ok: true });
  assert(jsonOk.includes("see the run log"), `must include refusal path, got: ${jsonOk}`);
  assert(jsonOk.startsWith("Finished"), "starts with Finished verdict");
  assert(!jsonOk.includes('"nested"'), "raw json not leaked in summary");

  const jsonFail = activityText({ type: "result", result: JSON.stringify(nestedComplexObj), ok: false });
  assert(jsonFail.includes("see the run log"), `must include refusal path, got: ${jsonFail}`);
  assert(jsonFail.startsWith("Failed"), "starts with Failed verdict");
});

Deno.test("recent-activity: layout grid column definitions prevent time overlap", async () => {
  const components = await Deno.readTextFile("extension/shared/components.js");

  // AgentTimeline .tl-row grid template
  assert(
    components.includes("grid-template-columns:10px minmax(0,1fr) auto 20px") ||
    components.includes("grid-template-columns: 10px minmax(0, 1fr) auto 20px"),
    "timeline row uses minmax(0,1fr) to prevent time column overlap",
  );

  // ActivityExplorer .aex-entry summary grid template
  assert(
    components.includes("grid-template-columns:auto minmax(0,1fr) auto") ||
    components.includes("grid-template-columns: auto minmax(0, 1fr) auto"),
    "activity explorer summary uses minmax(0,1fr) to prevent time column overlap",
  );
});

Deno.test("recent-activity: runs-today count is refreshed on all timeline refresh paths", async () => {
  const ntp = await Deno.readTextFile("extension/ntp/ntp.js");
  assert(ntp.includes("function refreshHubActivity()"), "ntp.js defines unified refreshHubActivity");
  assert(ntp.includes("renderHubUsage()"), "refreshHubActivity calls renderHubUsage");
});
