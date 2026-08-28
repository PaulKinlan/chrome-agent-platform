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
//   (7) Real named-agent object skills normalization (P1-a round 1).
//   (8) Import bounds and UTF-8 byte accounting (P1-b round 1).
//   (9) Strict integer version requirement (P1-c round 2).
//   (10) Unicode 8×128KiB multi-byte emoji asset round-trip (P1-a round 2).
//   (11) Deep descriptor validation rejecting toJSON, getters, non-enumerable props (P1-b round 2).
//   (12) Deduplicated distinct counting for omittedValidSkillsCount (P2 round 2).

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
  MAX_DROPPED_SKILLS_REPORT,
  MAX_RAW_SKILLS_INPUT,
  assertPlainDataGraph,
  exportAgentCard,
  exportAgentCardJson,
  importAgentCard,
  normalizeCardCoreAssets,
  truncateToUtf8Bytes,
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
      at: "2026-08-29T10:00:00.000Z",
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
  assertEquals(card.schedule?.at, "2026-08-29T10:00:00.000Z");
  assertEquals(card.avatar, "data:image/svg+xml,<svg></svg>");
});

Deno.test("P1-a r1: exportAgentCard normalizes REAL named-agent object-form skills {id,name} without dropping them", () => {
  const realAgentRecord = {
    id: "sorting-hat",
    name: "Sorting Hat",
    role: "Groups tabs by intent.",
    skills: [
      { id: "tab-hygiene", name: "Tab hygiene", description: "Closes dupes" },
      { id: "page-summary", name: "Summarise this page", description: "Summarises" },
      "reading-list",
    ],
    coreAssets: [],
  };

  const card = exportAgentCard(realAgentRecord);
  assertEquals(card.skills, ["tab-hygiene", "page-summary", "reading-list"]);

  const json = exportAgentCardJson(realAgentRecord);
  const imported = importAgentCard(json);
  assert(imported.ok, "real agent record re-imports cleanly");
  assertEquals(imported.agent.skills, ["tab-hygiene", "page-summary", "reading-list"]);
});

Deno.test("P1-a r2: Unicode round-trip — 8 legal multi-byte emoji assets export and re-import under 2 MiB ceiling", () => {
  // 8 assets with 4-byte emojis: 40,000 emojis = 160,000 UTF-8 bytes each (over 128 KiB)
  // normalizeCardCoreAssets must truncate each asset strictly to <= 131,072 UTF-8 bytes.
  const emojiAssets = Array.from({ length: MAX_CARD_CORE_ASSETS }, (_, i) => ({
    name: `emoji-asset-${i}.txt`,
    type: "text/plain",
    content: "🔥".repeat(40000),
  }));

  const normalized = normalizeCardCoreAssets(emojiAssets);
  assertEquals(normalized.length, MAX_CARD_CORE_ASSETS);
  for (let i = 0; i < MAX_CARD_CORE_ASSETS; i++) {
    const bytes = new TextEncoder().encode(normalized[i].content).byteLength;
    assert(bytes <= MAX_CARD_CORE_ASSET_BYTES, `asset ${i} must not exceed 128 KiB (${bytes} <= ${MAX_CARD_CORE_ASSET_BYTES})`);
    assert(normalized[i].content.endsWith("…"));
  }

  const agentWithEmojiAssets = {
    name: "Emoji Specialist",
    role: "Handles multi-byte Unicode content.",
    skills: ["tab-hygiene"],
    coreAssets: emojiAssets,
  };

  const cardJson = exportAgentCardJson(agentWithEmojiAssets);
  const totalBytes = new TextEncoder().encode(cardJson).byteLength;
  assert(totalBytes <= MAX_CARD_JSON_BYTES, `exported JSON must not exceed 2 MiB (${totalBytes} <= ${MAX_CARD_JSON_BYTES})`);

  const reimported = importAgentCard(cardJson);
  assert(reimported.ok, `maximal Unicode export must re-import cleanly: ${!reimported.ok && reimported.error}`);
  assertEquals(reimported.agent.coreAssets.length, MAX_CARD_CORE_ASSETS);
});

Deno.test("P1-b r2: deep descriptor validation rejects accessors, toJSON, and non-enumerable properties", () => {
  // 1. toJSON method rejected
  const toJSONCard = {
    version: 1,
    name: "toJSON Card",
    toJSON() {
      return { version: 1, name: "Escaped" };
    },
  };
  const r1 = importAgentCard(toJSONCard);
  assertEquals(r1.ok, false);
  assert(r1.error.includes("toJSON property rejected"));

  // 2. Non-enumerable property rejected
  const nonEnumCard = { version: 1, name: "NonEnum" };
  Object.defineProperty(nonEnumCard, "hiddenSecret", {
    value: "hidden",
    enumerable: false,
    configurable: true,
  });
  const r2 = importAgentCard(nonEnumCard);
  assertEquals(r2.ok, false);
  assert(r2.error.includes("non-enumerable property rejected"));

  // 3. Property getter rejected by descriptor check before executing
  let getterRan = 0;
  const getterCard = {
    version: 1,
    get name() {
      getterRan++;
      return "Getter Name";
    },
  };
  const r3 = importAgentCard(getterCard);
  assertEquals(r3.ok, false);
  assert(r3.error.includes("accessor property (getter/setter) rejected"));
  assertEquals(getterRan, 0, "getter must not be executed during descriptor check");

  // 4. Nested accessor in coreAssets rejected
  const nestedGetterCard = {
    version: 1,
    name: "Nested Getter",
    coreAssets: [
      {
        get name() {
          return "doc.txt";
        },
      },
    ],
  };
  const r4 = importAgentCard(nestedGetterCard);
  assertEquals(r4.ok, false);
  assert(r4.error.includes("accessor property (getter/setter) rejected"));
});

Deno.test("P1-c r2: strict integer version requirement (own property, numeric safe integer)", () => {
  // Missing version rejected
  assertEquals(importAgentCard({ name: "No Version" }).ok, false);

  // String version "1" rejected (strictly integer number required)
  const strVerRes = importAgentCard({ version: "1", name: "Str Version" });
  assertEquals(strVerRes.ok, false);
  assert(strVerRes.error.includes("version must be an integer"));

  // Boolean/array/float version rejected
  assertEquals(importAgentCard({ version: true, name: "Bool Version" }).ok, false);
  assertEquals(importAgentCard({ version: [1], name: "Array Version" }).ok, false);
  assertEquals(importAgentCard({ version: 1.5, name: "Float Version" }).ok, false);
  assertEquals(importAgentCard({ version: 99, name: "Future Version" }).ok, false);

  // Safe integer 1 accepted
  const validRes = importAgentCard({ version: 1, name: "Valid Version" });
  assertEquals(validRes.ok, true);
  assertEquals(validRes.version, 1);
});

Deno.test("P2 r2: omittedValidSkillsCount counts distinct omitted skills, not repeated occurrences", () => {
  const distinctSkills = Array.from({ length: 130 }, (_, i) => `skill-id-${i}`);
  const knownSet = new Set(distinctSkills);

  // 130 distinct skills + 50 repeats of the 130th skill
  const skillListWithRepeats = [
    ...distinctSkills,
    ...Array(50).fill("skill-id-129"),
  ];

  const card = {
    version: 1,
    name: "Omitted Count Agent",
    skills: skillListWithRepeats,
  };

  const res = importAgentCard(card, { knownSkillIds: knownSet });
  assert(res.ok);
  assertEquals(res.agent.skills.length, MAX_CARD_SKILLS); // 128
  // Exactly 2 distinct valid skills exceeded the 128 cap (skill-id-128 and skill-id-129), not 52!
  assertEquals(res.omittedValidSkillsCount, 2);
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
      knownSkill1,
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

  const asset = res.agent.coreAssets[0];
  assert(asset.content.endsWith("…"));
  assertEquals(new TextEncoder().encode(asset.content).byteLength, MAX_CARD_CORE_ASSET_BYTES);
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
