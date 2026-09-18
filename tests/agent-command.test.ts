// Tests for the /agent command + @ mention filtering via agent-registry.js (candidatesFromGroups).
// Paul 2026-08-17: /agent should list only the AGENTS THAT ARE ACTUALLY
// AVAILABLE — the ENABLED background agents (not the available-but-not-enabled
// recipes) + the created named agents + the enrolled site agents — and it must
// EXCLUDE the agent the user is currently inside (you can't call the agent
// you're talking to).

import { candidatesFromGroups } from "../extension/shared/agent-registry.js";
import { assertEquals } from "jsr:@std/assert@1";

const groups = [
  {
    id: "named",
    label: "Named agents",
    agents: [
      { ref: "named:paul", id: "paul", kind: "named", name: "Paul", summary: "summarises paul.kinlan.me", enabled: true },
      { ref: "named:reader", id: "reader", kind: "named", name: "Reader", summary: "reads articles", enabled: true },
    ],
  },
  {
    id: "background",
    label: "Background agents",
    agents: [
      { ref: "background:dedupe-tabs", id: "dedupe-tabs", kind: "background", name: "Dedupe tabs", enabled: true },
      { ref: "background:sorting-hat", id: "sorting-hat", kind: "background", name: "Sorting Hat", enabled: false }, // available-but-not-enabled
      { ref: "background:auto-pin", id: "auto-pin", kind: "background", name: "Auto-pin", enabled: true },
    ],
  },
  {
    id: "site",
    label: "Site agents",
    agents: [
      { ref: "site:https://github.com", id: "https://github.com", kind: "site", name: "github", enrolled: true, toolCount: 3, enabled: true },
    ],
  },
];

Deno.test("/agent lists only the callable agents (enabled background only)", () => {
  const out = candidatesFromGroups(groups, { callableOnly: true });
  const refs = out.map((i) => i.ref);
  // named agents: both present.
  assertEquals(refs.includes("named:paul"), true);
  assertEquals(refs.includes("named:reader"), true);
  // background: enabled present, disabled (sorting-hat) absent.
  assertEquals(refs.includes("background:dedupe-tabs"), true);
  assertEquals(refs.includes("background:auto-pin"), true);
  assertEquals(refs.includes("background:sorting-hat"), false, "the not-enabled recipe must NOT be listed");
  // site: enrolled present.
  assertEquals(refs.includes("site:https://github.com"), true);
});

Deno.test("/agent excludes the current agent", () => {
  const out = candidatesFromGroups(groups, { excludeId: "paul" });
  const refs = out.map((i) => i.ref);
  assertEquals(refs.includes("named:paul"), false, "the current named agent must be excluded");
  assertEquals(refs.includes("named:reader"), true);
  // A background current agent is also excluded.
  const outBg = candidatesFromGroups(groups, { excludeId: "dedupe-tabs" });
  assertEquals(outBg.map((i) => i.ref).includes("background:dedupe-tabs"), false);
});

Deno.test("/agent filters by query", () => {
  const out = candidatesFromGroups(groups, { query: "paul" });
  const refs = out.map((i) => i.ref);
  assertEquals(refs.includes("named:paul"), true);
  assertEquals(refs.includes("named:reader"), false);
});
