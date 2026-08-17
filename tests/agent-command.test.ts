// Tests for the /agent command + @ mention filtering (buildAgentCandidates).
// Paul 2026-08-17: /agent should list only the AGENTS THAT ARE ACTUALLY
// AVAILABLE — the ENABLED background agents (not the available-but-not-enabled
// recipes) + the created named agents + the enrolled site agents — and it must
// EXCLUDE the agent the user is currently inside (you can't call the agent
// you're talking to).

import { buildAgentCandidates } from "../extension/shared/components.js";
import { assertEquals } from "jsr:@std/assert@1";

const named = [
  { id: "paul", name: "Paul", role: "summarises paul.kinlan.me" },
  { id: "reader", name: "Reader", role: "reads articles" },
];
const bg = [
  { id: "dedupe-tabs", name: "Dedupe tabs", enabled: true },
  { id: "sorting-hat", name: "Sorting Hat", enabled: false }, // available-but-not-enabled
  { id: "auto-pin", name: "Auto-pin", enabled: true },
];
const site = [
  { origin: "https://github.com", name: "github", enrolled: true, toolCount: 3 },
  { origin: "https://not-enrolled.com", name: "not", enrolled: false, toolCount: 5 },
];

Deno.test("/agent lists only the callable agents (enabled background only)", () => {
  const out = buildAgentCandidates(named, bg, site, {});
  const ids = out.map((i) => i.id);
  // named agents: both present.
  assertEquals(ids.includes("agent:paul"), true);
  assertEquals(ids.includes("agent:reader"), true);
  // background: enabled present, disabled (sorting-hat) absent.
  assertEquals(ids.includes("agent:dedupe-tabs"), true);
  assertEquals(ids.includes("agent:auto-pin"), true);
  assertEquals(ids.includes("agent:sorting-hat"), false, "the not-enabled recipe must NOT be listed");
  // site: only enrolled.
  assertEquals(ids.includes("agent:https://github.com"), true);
  assertEquals(ids.includes("agent:https://not-enrolled.com"), false);
});

Deno.test("/agent excludes the current agent", () => {
  const out = buildAgentCandidates(named, bg, site, { currentAgentId: "paul" });
  const ids = out.map((i) => i.id);
  assertEquals(ids.includes("agent:paul"), false, "the current named agent must be excluded");
  assertEquals(ids.includes("agent:reader"), true);
  // A background current agent is also excluded.
  const outBg = buildAgentCandidates(named, bg, site, { currentAgentId: "dedupe-tabs" });
  assertEquals(outBg.map((i) => i.id).includes("agent:dedupe-tabs"), false);
});

Deno.test("/agent filters by query", () => {
  const out = buildAgentCandidates(named, bg, site, { query: "paul" });
  const ids = out.map((i) => i.id);
  assertEquals(ids.includes("agent:paul"), true);
  assertEquals(ids.includes("agent:reader"), false);
});
