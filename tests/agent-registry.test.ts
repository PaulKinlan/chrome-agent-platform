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
import { projectUnifiedAgents } from "../extension/lib/agent-projection.js";

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

Deno.test("canonicalRef builds canonical kinds", () => {
  assertEquals(canonicalRef("named", "reader"), "named:reader");
  assertEquals(canonicalRef("background", "sorting-hat"), "background:sorting-hat");
  assertEquals(canonicalRef("site", "https://github.com"), "site:https://github.com");
  assertEquals(canonicalRef("acp", "pi"), "acp:pi");
  assertEquals(canonicalRef("master", "x"), ""); // unknown kinds are rejected
  assertEquals(canonicalRef("named", ""), "");
});

Deno.test("parseAgentRef round-trips and rejects malformed refs", () => {
  assertEquals(parseAgentRef("named:reader"), { kind: "named", id: "reader" });
  assertEquals(parseAgentRef("site:https://github.com"), { kind: "site", id: "https://github.com" });
  assertEquals(parseAgentRef("acp:pi"), { kind: "acp", id: "pi" });
  assertEquals(parseAgentRef("agent:reader"), null); // the OLD ambiguous shape
  assertEquals(parseAgentRef("nope"), null);
  assertEquals(parseAgentRef(""), null);
  assertEquals(AGENT_KINDS, ["named", "background", "site", "acp"]);
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

// ── h97m: the side panel's agents list projects the ONE created-agents set ──

const H97M_REGISTRY = [
  { id: "named", label: "Named agents", agents: [] },
  {
    id: "background",
    label: "Background agents",
    agents: [
      { ref: "background:sorting-hat", id: "sorting-hat", kind: "background", name: "Sorting Hat", summary: "groups tabs", status: "every 30 min", enabled: true },
    ],
  },
  { id: "site", label: "Site Agents", agents: [] },
  {
    id: "acp",
    label: "Harnesses (ACP)",
    // The registry admits these with NO enabled field (service-worker.js's
    // literal), so isCallable's acp arm keeps them on every profile — the +3.
    agents: [
      { id: "pi", kind: "acp", name: "pi" },
      { id: "claude-code", kind: "acp", name: "Claude Code" },
      { id: "codex", kind: "acp", name: "Codex" },
    ],
  },
];

Deno.test("h97m: callableOnly alone keeps the acp harness rows (the pre-fix divergence, pinned)", () => {
  // This is WHY the side panel picker counted +3 on a fresh profile: the
  // filter has no kind rule unless the caller passes one.
  const rows = filterGroups(H97M_REGISTRY, "", { callableOnly: true }).flatMap((g) => g.agents);
  assertEquals(rows.length, 4); // 1 enabled background + 3 acp
  assertEquals(rows.filter((a) => a.kind === "acp").length, 3);
});

Deno.test("h97m: excludeKinds [acp] makes the picker agree with the other three surfaces", () => {
  const filtered = filterGroups(H97M_REGISTRY, "", { callableOnly: true, excludeKinds: ["acp"] });
  const rows = filtered.flatMap((g) => g.agents);
  assertEquals(rows.map((a) => a.id), ["sorting-hat"]);
  // The acp GROUP is dropped entirely (empty groups never render).
  assertEquals(filtered.some((g) => g.id === "acp"), false);
  // The empty named/site groups are gone too — the list is the created-agents set.
  assertEquals(filtered.map((g) => g.id), ["background"]);
});

Deno.test("h97m: a fresh profile (no created agents) projects ZERO rows with the acp group excluded", () => {
  const fresh = [
    { id: "named", label: "Named agents", agents: [] },
    { id: "background", label: "Background agents", agents: [
      { ref: "background:sorting-hat", id: "sorting-hat", kind: "background", name: "Sorting Hat", summary: "", status: "disabled", enabled: false },
    ] },
    { id: "acp", label: "Harnesses (ACP)", agents: H97M_REGISTRY[3].agents },
  ];
  const rows = filterGroups(fresh, "", { callableOnly: true, excludeKinds: ["acp"] });
  assertEquals(rows, [], "the four surfaces agree at 0 on a fresh profile");
});

Deno.test("h97m: excludeKinds composes with query + callableOnly, and an empty/unknown list is a no-op", () => {
  const q = filterGroups(H97M_REGISTRY, "sorting", { callableOnly: true, excludeKinds: ["acp"] });
  assertEquals(q.flatMap((g) => g.agents).map((a) => a.id), ["sorting-hat"]);
  const noop = filterGroups(H97M_REGISTRY, "", { callableOnly: true, excludeKinds: [] });
  assertEquals(noop.flatMap((g) => g.agents).length, 4);
  const unknown = filterGroups(H97M_REGISTRY, "", { callableOnly: true, excludeKinds: ["master"] });
  assertEquals(unknown.flatMap((g) => g.agents).length, 4);
});

Deno.test("four-surfaces invariant: the picker projects the same created-agents set as options/ntp/hub — an enrolled site agent does not leak in (voicebox-beads-v15y)", () => {
  // THE MEASUREMENT the bead asked for, in ONE run over ONE fixture:
  //   · options/ntp/hub project the created-agents set through
  //     projectUnifiedAgents(named, background) — site agents are projected away;
  //   · the side panel's <agent-picker callable-only exclude-kinds="acp site">
  //     projects the registry through filterGroups — and callable-only ALONE
  //     would carry the enrolled site agent, because isCallable passes site
  //     unconditionally. That was v15y's measured divergence (the picker +1
  //     row the other three surfaces never count); the site exclusion is why
  //     it stays closed, asserted here so the reason survives the fixture.
  const namedStore = groups.find((g) => g.id === "named").agents
    .map(({ skills, status, ...a }) => ({ ...a }));
  const backgroundStore = groups.find((g) => g.id === "background").agents
    .map(({ skills, status, ...a }) => ({ ...a }));

  // Surfaces 1-3 (options, ntp, hub): the created-agents projection.
  const projected = projectUnifiedAgents(namedStore, backgroundStore).map((a) => `${a.kind}:${a.id}`).sort();

  // Surface 4 pre-exclusion (the measured divergence): callable-only + acp
  // excluded still admits the enrolled site agent.
  const withoutSiteFilter = filterGroups(groups, "", { callableOnly: true, excludeKinds: ["acp"] })
    .flatMap((g) => g.agents.map((a) => `${a.kind}:${a.id}`));
  assertEquals(
    withoutSiteFilter.includes("site:https://github.com"),
    true,
    "pre-condition: callable-only alone admits the enrolled site agent — the divergence v15y measured",
  );

  // Surface 4 as shipped: the picker excludes acp AND site, and the four
  // surfaces agree ON KINDS — the projection also carries disabled background
  // agents (isVisibleAgentRow keeps them visible for browse/management), which
  // the picker's own callable-only correctly drops: you cannot talk to a
  // disabled agent. The invariant v15y pins is the KIND SET — no site, no acp
  // — plus every picker row being a created agent.
  const picker = filterGroups(groups, "", { callableOnly: true, excludeKinds: ["acp", "site"] })
    .flatMap((g) => g.agents.map((a) => `${a.kind}:${a.id}`)).sort();
  assertEquals(picker, ["background:sorting-hat", "named:pr-reviewer", "named:reader"]);
  for (const row of picker) {
    assertEquals(
      projected.includes(row),
      true,
      `the four-surfaces invariant: picker row '${row}' must be a created agent (named/background), never a site or harness row`,
    );
  }
  assertEquals(
    picker.some((r) => r.startsWith("site:") || r.startsWith("acp:")),
    false,
    "no site or acp row may reach the picker — that is the divergence v15y measured",
  );
});
