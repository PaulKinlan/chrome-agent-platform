// @ts-nocheck — fixture-shaped test data; the runtime behavior is what's under test.
// Tests for the unified agent-registry helpers (CAP-FB-20260818-AGENT-ACCESS-01):
// the canonical ref (named:<id>/background:<id>/site:<origin>), the grouping /
// filtering the shared <agent-picker> + the /agent command BOTH use, and the
// stale-selection detection (a deleted/disabled agent must be rejectable).

import {
  AGENT_KINDS,
  canonicalRef,
  candidatesFromGroups,
  filterGroups,
  findAgentByRef,
  flattenGroups,
  isCallable,
  parseAgentRef,
  shouldApplyRegistrySnapshot,
} from "../extension/shared/agent-registry.js";
import { assertEquals } from "jsr:@std/assert@1";

const groups = [
  {
    id: "named",
    label: "Named agents",
    agents: [
      { ref: "named:reader", id: "reader", kind: "named", name: "Reader", summary: "reads articles", skills: ["reading"], status: "ready", enabled: true },
      { ref: "named:pr-reviewer", id: "pr-reviewer", kind: "named", name: "PR Reviewer", summary: "reviews pull requests", skills: ["github"], status: "ready", enabled: true },
    ],
  },
  {
    id: "background",
    label: "Background agents",
    agents: [
      { ref: "background:sorting-hat", id: "sorting-hat", kind: "background", name: "Sorting Hat", summary: "groups tabs", status: "every 15 min", enabled: true },
      { ref: "background:dedupe-tabs", id: "dedupe-tabs", kind: "background", name: "Dedupe tabs", summary: "closes duplicates", status: "disabled", enabled: false },
    ],
  },
  {
    id: "site",
    label: "Site agents",
    agents: [
      { ref: "site:https://github.com", id: "https://github.com", kind: "site", name: "@github.com", summary: "2 tools · site agent", status: "enrolled", enabled: true },
    ],
  },
];

Deno.test("canonicalRef builds the three canonical kinds", () => {
  assertEquals(canonicalRef("named", "reader"), "named:reader");
  assertEquals(canonicalRef("background", "sorting-hat"), "background:sorting-hat");
  assertEquals(canonicalRef("site", "https://github.com"), "site:https://github.com");
  assertEquals(canonicalRef("master", "x"), ""); // unknown kinds are rejected
  assertEquals(canonicalRef("named", ""), "");
});

Deno.test("parseAgentRef round-trips and rejects malformed refs", () => {
  assertEquals(parseAgentRef("named:reader"), { kind: "named", id: "reader" });
  assertEquals(parseAgentRef("site:https://github.com"), { kind: "site", id: "https://github.com" });
  assertEquals(parseAgentRef("agent:reader"), null); // the OLD ambiguous shape
  assertEquals(parseAgentRef("nope"), null);
  assertEquals(parseAgentRef(""), null);
  assertEquals(AGENT_KINDS, ["named", "background", "site"]);
});

Deno.test("flattenGroups keeps the group label on every agent", () => {
  const flat = flattenGroups(groups);
  assertEquals(flat.length, 5);
  assertEquals(flat[0].group, "Named agents");
  assertEquals(flat[4].group, "Site agents");
});

Deno.test("findAgentByRef resolves a live agent and exposes a stale one", () => {
  assertEquals(findAgentByRef(groups, "named:reader")?.name, "Reader");
  assertEquals(findAgentByRef(groups, "site:https://github.com")?.kind, "site");
  // Stale: a deleted agent is NOT found (the caller rejects the selection).
  assertEquals(findAgentByRef(groups, "named:deleted-agent"), null);
  assertEquals(findAgentByRef(groups, "background:no-such"), null);
});

Deno.test("shouldApplyRegistrySnapshot fences request-order and revision races", () => {
  // A late response from an older request can never overwrite the latest one.
  assertEquals(shouldApplyRegistrySnapshot(4, 5, 12, 11), false);
  // Even the latest request cannot regress to a lower SW revision.
  assertEquals(shouldApplyRegistrySnapshot(5, 5, 10, 11), false);
  assertEquals(shouldApplyRegistrySnapshot(5, 5, 11, 11), true);
  assertEquals(shouldApplyRegistrySnapshot(5, 5, 12, 11), true);
  // Legacy/static responses without a revision still use request ordering.
  assertEquals(shouldApplyRegistrySnapshot(5, 5, undefined, 11), true);
});

Deno.test("isCallable: only ENABLED background agents are callable", () => {
  assertEquals(isCallable(groups[1].agents[0]), true); // enabled
  assertEquals(isCallable(groups[1].agents[1]), false); // disabled
  assertEquals(isCallable(groups[0].agents[0]), true); // named always callable
  assertEquals(isCallable(groups[2].agents[0]), true); // enrolled site callable
});

Deno.test("filterGroups: query, callableOnly, and exclusions", () => {
  // No filter → all groups, all agents.
  assertEquals(filterGroups(groups).flatMap((g) => g.agents).length, 5);
  // callableOnly drops the disabled background agent (and its group survives).
  const callable = filterGroups(groups, "", { callableOnly: true });
  const callableIds = callable.flatMap((g) => g.agents.map((a) => a.ref));
  assertEquals(callableIds.includes("background:dedupe-tabs"), false);
  assertEquals(callableIds.includes("background:sorting-hat"), true);
  // The query matches name/id/summary/skills, case-insensitively.
  const q = filterGroups(groups, "github");
  assertEquals(q.flatMap((g) => g.agents.map((a) => a.ref)).sort(), [
    "named:pr-reviewer", // the github skill
    "site:https://github.com",
  ]);
  // excludeId drops the current agent from every kind.
  const ex = filterGroups(groups, "", { excludeId: "reader" });
  assertEquals(ex.flatMap((g) => g.agents.map((a) => a.id)).includes("reader"), false);
  // A query with no matches drops the group entirely.
  const none = filterGroups(groups, "zzz-no-match");
  assertEquals(none, []);
});

Deno.test("candidatesFromGroups: picker/slash items carry the canonical ref + group", () => {
  const items = candidatesFromGroups(groups, {});
  assertEquals(items.length, 4); // callableOnly defaults to true
  const reader = items.find((i) => i.ref === "named:reader");
  // The textual / command reference is the UNAMBIGUOUS canonical form
  // (`agent:<canonical-ref>`) — never a bare id that collides across kinds.
  assertEquals(reader.id, "agent:named:reader");
  assertEquals(reader.kind, "named");
  assertEquals(reader.group, "Named agents");
  assertEquals(reader.label, "Reader");
  // The current agent is excluded.
  const ex = candidatesFromGroups(groups, { excludeId: "reader" });
  assertEquals(ex.some((i) => i.agentId === "reader"), false);
  // Query filtering flows through.
  const q = candidatesFromGroups(groups, { query: "sorting" });
  assertEquals(q.map((i) => i.ref), ["background:sorting-hat"]);
});
