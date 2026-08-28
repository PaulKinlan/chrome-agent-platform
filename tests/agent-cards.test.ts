// @ts-nocheck — agent cards test suite is dynamic.
// tests/agent-cards.test.ts — agent cards data layer unit tests (AGENT-PRODUCT-GAPS §5, G7).
//
// Falsification-gated tests covering:
//   (1) Round-trip fidelity (export → JSON → import).
//   (2) Schema validation and hostile-input fail-closed behavior.
//   (3) Skill ID validation against RECIPES with explicit droppedSkills reporting.
//   (4) Strict bounding of oversized fields (name, role, skills, assets, avatar, JSON).
//   (5) Missing or invalid name rejection.
//   (6) Credential and private state isolation.

import { assert, assertEquals, assertExists, assertThrows } from "jsr:@std/assert@1";
import {
  AGENT_CARD_VERSION,
  MAX_AVATAR_LEN,
  MAX_CARD_CORE_ASSET_BYTES,
  MAX_CARD_CORE_ASSETS,
  MAX_CARD_JSON_BYTES,
  MAX_CARD_NAME_LEN,
  MAX_CARD_ROLE_LEN,
  MAX_CARD_SKILLS,
  MAX_CREATED_FROM_LEN,
  exportAgentCard,
  exportAgentCardJson,
  importAgentCard,
  normalizeCardCoreAssets,
  validateAgentCard,
} from "../extension/lib/agent-cards.js";
import { RECIPES } from "../extension/lib/recipes.js";

Deno.test("agent cards: exportAgentCard produces a well-formed card object with expected fields", () => {
  const agent = {
    name: "PR Reviewer",
    role: "Reviews pull requests critically and provides actionable feedback.",
    skills: ["tab-hygiene", "page-summary"],
    coreAssets: [
      { name: "style-guide.md", type: "text/markdown", content: "# Style Guide\nBe clear." },
    ],
    createdFrom: "code-reviewer",
    schedule: {
      periodInMinutes: 60,
      task: "Check open PR tabs and summarize status.",
    },
    avatar: "data:image/svg+xml,<svg></svg>",
  };

  const card = exportAgentCard(agent);

  assertEquals(card.version, AGENT_CARD_VERSION);
  assertEquals(typeof card.exportedAt, "string");
  assertEquals(card.name, "PR Reviewer");
  assertEquals(card.role, agent.role);
  assertEquals(card.persona, agent.role);
  assertEquals(card.skills, ["tab-hygiene", "page-summary"]);
  assertEquals(card.coreAssets.length, 1);
  assertEquals(card.coreAssets[0].name, "style-guide.md");
  assertEquals(card.coreAssets[0].content, "# Style Guide\nBe clear.");
  assertEquals(card.createdFrom, "code-reviewer");
  assertEquals(card.schedule?.periodInMinutes, 60);
  assertEquals(card.schedule?.task, "Check open PR tabs and summarize status.");
  assertEquals(card.avatar, "data:image/svg+xml,<svg></svg>");
});

Deno.test("agent cards: round-trip fidelity export → JSON string → import", () => {
  const sourceAgent = {
    name: "Research Specialist",
    role: "# Research Specialist\n\nGather cross-tab evidence and cite sources.",
    skills: ["multi-tab-researcher", "link-collector", "page-summary"],
    coreAssets: [
      { name: "sources.json", type: "application/json", content: '{"trusted": ["arxiv.org"]}' },
    ],
    createdFrom: "research-analyst",
    schedule: {
      periodInMinutes: 120,
      task: "Review open research tabs and produce a digest.",
      at: 1724000000000,
    },
    avatar: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
  };

  const json = exportAgentCardJson(sourceAgent);
  assert(typeof json === "string", "exportAgentCardJson produces a string");

  const imported = importAgentCard(json);
  assert(imported.ok, `import should succeed, got error: ${!imported.ok && imported.error}`);
  assertEquals(imported.version, AGENT_CARD_VERSION);
  assertEquals(imported.droppedSkills, []);

  const agent = imported.agent;
  assertEquals(agent.name, sourceAgent.name);
  assertEquals(agent.role, sourceAgent.role);
  assertEquals(agent.skills, sourceAgent.skills);
  assertEquals(agent.coreAssets, sourceAgent.coreAssets);
  assertEquals(agent.createdFrom, sourceAgent.createdFrom);
  assertEquals(agent.schedule?.periodInMinutes, 120);
  assertEquals(agent.schedule?.task, sourceAgent.schedule.task);
  assertEquals(agent.schedule?.at, sourceAgent.schedule.at);
  assertEquals(agent.avatar, sourceAgent.avatar);
});

Deno.test("agent cards: import supports persona field as alias for role", () => {
  const cardWithPersona = {
    version: 1,
    name: "Persona Agent",
    persona: "Instructions given via persona field.",
    skills: ["tab-hygiene"],
  };

  const res = importAgentCard(cardWithPersona);
  assert(res.ok, "import with persona alias succeeds");
  assertEquals(res.agent.name, "Persona Agent");
  assertEquals(res.agent.role, "Instructions given via persona field.");
});

Deno.test("agent cards: skill ID validation drops unknown skills and reports them explicitly", () => {
  const knownSkill1 = RECIPES[0].id;
  const knownSkill2 = RECIPES[1].id;
  assertExists(knownSkill1);
  assertExists(knownSkill2);

  const card = {
    version: 1,
    name: "Skill Probe Agent",
    role: "Testing skill filter",
    skills: [
      knownSkill1,
      "unrecognized-external-skill-99",
      knownSkill2,
      "another-bogus-skill",
      knownSkill1, // duplicate should be deduplicated
    ],
  };

  const res = importAgentCard(card);
  assert(res.ok, "import with unknown skills should still succeed");
  assertEquals(res.agent.skills, [knownSkill1, knownSkill2]);
  assertEquals(res.droppedSkills, [
    "unrecognized-external-skill-99",
    "another-bogus-skill",
  ]);
});

Deno.test("agent cards: custom knownSkillIds option allows scoped skill validation", () => {
  const card = {
    version: 1,
    name: "Custom Skill Agent",
    skills: ["allowed-one", "forbidden-two", "allowed-three"],
  };

  const res = importAgentCard(card, {
    knownSkillIds: new Set(["allowed-one", "allowed-three"]),
  });
  assert(res.ok);
  assertEquals(res.agent.skills, ["allowed-one", "allowed-three"]);
  assertEquals(res.droppedSkills, ["forbidden-two"]);
});

Deno.test("agent cards: missing or empty name is rejected honestly (fails closed)", () => {
  // Missing name property
  const noName = { version: 1, role: "No name" };
  const res1 = importAgentCard(noName);
  assertEquals(res1.ok, false);
  assert(res1.error.includes("requires a name"));

  // null name
  const nullName = { version: 1, name: null, role: "Null name" };
  const res2 = importAgentCard(nullName);
  assertEquals(res2.ok, false);
  assert(res2.error.includes("requires a name"));

  // Empty string name
  const emptyName = { version: 1, name: "", role: "Empty name" };
  const res3 = importAgentCard(emptyName);
  assertEquals(res3.ok, false);
  assert(res3.error.includes("requires a non-empty name"));

  // Whitespace-only name
  const wsName = { version: 1, name: "   \t\n  ", role: "WS name" };
  const res4 = importAgentCard(wsName);
  assertEquals(res4.ok, false);
  assert(res4.error.includes("requires a non-empty name"));

  // Non-string name
  const numName = { version: 1, name: 12345, role: "Num name" };
  const res5 = importAgentCard(numName);
  assertEquals(res5.ok, false);
  assert(res5.error.includes("name must be a string"));

  // Object name
  const objName = { version: 1, name: { first: "Agent" }, role: "Obj name" };
  const res6 = importAgentCard(objName);
  assertEquals(res6.ok, false);
  assert(res6.error.includes("name must be a string"));
});

Deno.test("agent cards: oversized fields are bounded to their respective maximums", () => {
  const hugeName = "A".repeat(MAX_CARD_NAME_LEN + 100);
  const hugeRole = "B".repeat(MAX_CARD_ROLE_LEN + 5000);
  const hugeCreatedFrom = "C".repeat(MAX_CREATED_FROM_LEN + 50);
  const hugeAvatar = "data:image/png;base64," + "D".repeat(MAX_AVATAR_LEN + 1000);
  const hugeAssetContent = "E".repeat(MAX_CARD_CORE_ASSET_BYTES + 500);

  const card = {
    version: 1,
    name: hugeName,
    role: hugeRole,
    createdFrom: hugeCreatedFrom,
    avatar: hugeAvatar,
    skills: ["tab-hygiene"],
    coreAssets: [
      { name: "huge.txt", type: "text/plain", content: hugeAssetContent },
    ],
  };

  const res = importAgentCard(card);
  assert(res.ok, "oversized card imports successfully with bounded fields");
  assertEquals(res.agent.name.length, MAX_CARD_NAME_LEN);
  assertEquals(res.agent.name, "A".repeat(MAX_CARD_NAME_LEN));
  assertEquals(res.agent.role.length, MAX_CARD_ROLE_LEN);
  assertEquals(res.agent.role, "B".repeat(MAX_CARD_ROLE_LEN));
  assertEquals(res.agent.createdFrom?.length, MAX_CREATED_FROM_LEN);
  assertEquals(res.agent.createdFrom, "C".repeat(MAX_CREATED_FROM_LEN));
  assertEquals(res.agent.avatar?.length, MAX_AVATAR_LEN);

  // Asset content bounded with ellipsis
  const asset = res.agent.coreAssets[0];
  assert(asset.content.endsWith("…"));
  assertEquals(asset.content.length, MAX_CARD_CORE_ASSET_BYTES + 1);
});

Deno.test("agent cards: core asset count and skill count caps are enforced", () => {
  // 10 assets (cap is 8)
  const assets = Array.from({ length: 12 }, (_, i) => ({
    name: `doc-${i}.txt`,
    type: "text/plain",
    content: `Content ${i}`,
  }));

  const normalized = normalizeCardCoreAssets(assets);
  assertEquals(normalized.length, MAX_CARD_CORE_ASSETS);
  assertEquals(normalized[0].name, "doc-0.txt");
  assertEquals(normalized[MAX_CARD_CORE_ASSETS - 1].name, `doc-${MAX_CARD_CORE_ASSETS - 1}.txt`);

  // Max skills cap on import
  const known = RECIPES.map((r) => r.id);
  const manySkills = Array.from({ length: 200 }, (_, i) => known[i % known.length]);
  const card = {
    version: 1,
    name: "Many Skills Agent",
    skills: manySkills,
  };

  const res = importAgentCard(card);
  assert(res.ok);
  assert(res.agent.skills.length <= MAX_CARD_SKILLS);
});

Deno.test("agent cards: hostile input fails closed on invalid JSON or non-object roots", () => {
  // Malformed JSON string
  const badJson = '{"version": 1, "name": "Broken", "skills": [';
  const r1 = importAgentCard(badJson);
  assertEquals(r1.ok, false);
  assert(r1.error.includes("malformed card JSON"));

  // Non-object roots
  assertEquals(importAgentCard(null).ok, false);
  assertEquals(importAgentCard(undefined).ok, false);
  assertEquals(importAgentCard(12345).ok, false);
  assertEquals(importAgentCard(true).ok, false);
  assertEquals(importAgentCard("not a json string").ok, false);
  assertEquals(importAgentCard(["array", "root"]).ok, false);
  assertEquals(importAgentCard(JSON.stringify(["array", "root"])).ok, false);
});

Deno.test("agent cards: hostile input fails closed on invalid field types", () => {
  // Non-string role
  const badRole = { version: 1, name: "Agent", role: { nested: "object" } };
  const r1 = importAgentCard(badRole);
  assertEquals(r1.ok, false);
  assert(r1.error.includes("role/persona must be a string"));

  // Non-array skills
  const badSkills = { version: 1, name: "Agent", skills: "tab-hygiene" };
  const r2 = importAgentCard(badSkills);
  assertEquals(r2.ok, false);
  assert(r2.error.includes("skills must be an array"));

  // Non-string skill item
  const badSkillItem = { version: 1, name: "Agent", skills: ["tab-hygiene", 12345] };
  const r3 = importAgentCard(badSkillItem);
  assertEquals(r3.ok, false);
  assert(r3.error.includes("skill ids must be strings"));

  // Non-array coreAssets
  const badAssets = { version: 1, name: "Agent", coreAssets: { name: "doc.txt" } };
  const r4 = importAgentCard(badAssets);
  assertEquals(r4.ok, false);
  assert(r4.error.includes("coreAssets must be an array"));

  // Non-object schedule
  const badSched1 = { version: 1, name: "Agent", schedule: "every 5 min" };
  const r5 = importAgentCard(badSched1);
  assertEquals(r5.ok, false);
  assert(r5.error.includes("schedule must be an object"));

  // Negative / invalid schedule period
  const badSched2 = { version: 1, name: "Agent", schedule: { periodInMinutes: -10 } };
  const r6 = importAgentCard(badSched2);
  assertEquals(r6.ok, false);
  assert(r6.error.includes("periodInMinutes must be a positive number"));

  // Non-string schedule task
  const badSched3 = { version: 1, name: "Agent", schedule: { periodInMinutes: 60, task: 999 } };
  const r7 = importAgentCard(badSched3);
  assertEquals(r7.ok, false);
  assert(r7.error.includes("schedule task must be a string"));

  // Unsupported version
  const badVersion = { version: 99, name: "Agent" };
  const r8 = importAgentCard(badVersion);
  assertEquals(r8.ok, false);
  assert(r8.error.includes("unsupported agent card version"));
});

Deno.test("agent cards: oversized JSON string payload is rejected before parsing", () => {
  const hugeJson = JSON.stringify({
    version: 1,
    name: "Huge Agent",
    role: "x".repeat(MAX_CARD_JSON_BYTES + 100),
  });

  const res = importAgentCard(hugeJson, { maxBytes: MAX_CARD_JSON_BYTES });
  assertEquals(res.ok, false);
  assert(res.error.includes("exceeds maximum allowed size"));
});

Deno.test("agent cards: exportAgentCard refuses invalid agent arguments with typed errors", () => {
  assertThrows(() => exportAgentCard(null), TypeError);
  assertThrows(() => exportAgentCard(undefined), TypeError);
  assertThrows(() => exportAgentCard("not-an-agent"), TypeError);
  assertThrows(() => exportAgentCard({ name: "" }), Error, "requires a non-empty agent name");
  assertThrows(() => exportAgentCard({ name: "   " }), Error, "requires a non-empty agent name");
});

Deno.test("agent cards: credentials and private state are never exported into card JSON", () => {
  const agentWithSecrets = {
    name: "Secure Agent",
    role: "Performs secret tasks",
    skills: ["tab-hygiene"],
    provider: {
      provider: "openai",
      apiKey: "sk-secret-key-12345",
      baseURL: "https://api.openai.com",
    },
    apiKey: "sk-another-secret",
    instanceId: "123e4567-e89b-12d3-a456-426614174000",
    revision: 5,
    createdAt: 1724000000000,
    updatedAt: 1724000050000,
  };

  const card = exportAgentCard(agentWithSecrets);
  const cardJson = JSON.stringify(card);

  assert(!cardJson.includes("sk-secret-key-12345"), "apiKey must not be exported");
  assert(!cardJson.includes("sk-another-secret"), "apiKey must not be exported");
  assert(!cardJson.includes("123e4567-e89b-12d3-a456-426614174000"), "instanceId must not be exported");
  assert(!("provider" in card), "provider configuration must not be exported");
  assert(!("revision" in card), "internal revision must not be exported");
});
