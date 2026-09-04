// @ts-nocheck — agent cards test suite is dynamic.
// tests/agent-cards.test.ts — agent cards data layer unit tests (AGENT-PRODUCT-GAPS §5, G7).
//
// Falsification-gated tests covering:
//   (1) Round-trip fidelity (export → JSON → import) with 100% content equality.
//   (2) P1-a r4: Array index accessor inspection (getter counter 0) and array custom props/toJSON rejection.
//   (3) P1-b r4: Serialized JSON budget enforcement on escaped characters (\\, \0, quotes).
//   (4) P2 r4: truncateToUtf8Bytes handling of tiny budgets (0, 1, 2 bytes return "").
//   (5) P1-c r2: Strict integer version requirement (numeric safe integer === 1).
//   (6) P2 r2: Distinct counting for omittedValidSkillsCount.
//   (7) Real named-agent object skills normalization.
//   (8) Unicode 8×128KiB multi-byte emoji asset round-trip.
//   (9) Deep descriptor validation rejecting toJSON, getters, and non-enumerable props.

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

Deno.test("P2 r4: truncateToUtf8Bytes handles tiny budgets (0, 1, 2 bytes return '')", () => {
  assertEquals(truncateToUtf8Bytes("hello", 0), "");
  assertEquals(truncateToUtf8Bytes("hello", 1), "");
  assertEquals(truncateToUtf8Bytes("hello", 2), "");
  // 3 bytes can fit the 3-byte ellipsis "…"
  const r3 = truncateToUtf8Bytes("hello", 3);
  assertEquals(r3, "…");
  assertEquals(new TextEncoder().encode(r3).byteLength, 3);

  // Exact fit
  assertEquals(truncateToUtf8Bytes("abc", 3), "abc");
  assertEquals(truncateToUtf8Bytes("abcd", 4), "abcd");
});

Deno.test("P1-a r4: array index accessor is caught by descriptor check without executing the getter", () => {
  let getterRan = 0;
  const skillsWithIndexGetter = [];
  Object.defineProperty(skillsWithIndexGetter, "0", {
    get() {
      getterRan++;
      return "tab-hygiene";
    },
    enumerable: true,
    configurable: true,
  });

  const cardWithArrayGetter = {
    version: 1,
    name: "Array Getter Agent",
    skills: skillsWithIndexGetter,
  };

  const res = importAgentCard(cardWithArrayGetter);
  assertEquals(res.ok, false);
  assert(res.error.includes("accessor property (getter/setter) rejected"));
  assertEquals(getterRan, 0, "getter at array index must never execute during descriptor check");

  // Custom non-index property on array is rejected
  const skillsWithCustomProp = ["tab-hygiene"];
  skillsWithCustomProp.customMetadata = "malicious";
  const resCustom = importAgentCard({
    version: 1,
    name: "Custom Array Prop",
    skills: skillsWithCustomProp,
  });
  assertEquals(resCustom.ok, false);
  assert(resCustom.error.includes("custom non-index property rejected"));

  // toJSON on array is rejected
  const skillsWithToJSON = ["tab-hygiene"];
  skillsWithToJSON.toJSON = () => ["escaped"];
  const resToJSON = importAgentCard({
    version: 1,
    name: "Array toJSON",
    skills: skillsWithToJSON,
  });
  assertEquals(resToJSON.ok, false);
  assert(resToJSON.error.includes("toJSON property rejected on array"));
});

Deno.test("P1-b r5: pseudo-index properties (e.g. arr['01']='hidden') are rejected as non-canonical array properties", () => {
  const skillsWithPseudoIndex = ["tab-hygiene"];
  skillsWithPseudoIndex["01"] = "hidden";

  const res = importAgentCard({
    version: 1,
    name: "Pseudo Index Agent",
    skills: skillsWithPseudoIndex,
  });

  assertEquals(res.ok, false);
  assert(res.error.includes("custom non-index property rejected"));

  // Non-integer and negative indices also rejected
  const arrNegative = ["tab-hygiene"];
  arrNegative["-1"] = "negative";
  assertEquals(importAgentCard({ version: 1, name: "Neg", skills: arrNegative }).ok, false);

  const arrFloat = ["tab-hygiene"];
  arrFloat["1.5"] = "float";
  assertEquals(importAgentCard({ version: 1, name: "Float", skills: arrFloat }).ok, false);
});

Deno.test("P1-a r5 (dptw): NO export budget — past-cap assets export and re-import WHOLE", () => {
  // 8 assets of 131072 backslashes each = ~1 MiB of content; the pretty JSON
  // is > 2 MiB and must export + re-import with 100% content equality.
  for (const n of [131041, 131072]) {
    const assets = Array.from({ length: 8 }, (_, i) => ({
      name: `asset-${i}.txt`,
      type: "text/plain",
      content: "\\".repeat(n),
    }));

    const agent = {
      name: `Boundary Agent ${n}`,
      role: "Boundary testing.",
      skills: ["tab-hygiene"],
      coreAssets: assets,
    };

    const prettyJson = exportAgentCardJson(agent);
    const prettyBytes = new TextEncoder().encode(prettyJson).byteLength;
    assert(prettyBytes > 2 * 1024 * 1024, `fixture must exceed the removed 2 MiB budget (${prettyBytes})`);

    const reimported = importAgentCard(prettyJson);
    assert(reimported.ok, `past-budget export at n=${n} must re-import: ${!reimported.ok && reimported.error}`);
    assertEquals(reimported.agent.coreAssets.length, 8, "dptw: all assets kept");

    const parsed = JSON.parse(prettyJson);
    for (let i = 0; i < 8; i++) {
      assertEquals(reimported.agent.coreAssets[i].content, parsed.coreAssets[i].content);
    }
  }
});


Deno.test("P1-a r2: Unicode round-trip — 8 legal multi-byte emoji assets export and re-import with 100% content equality", () => {
  const emojiAssets = Array.from({ length: 8 }, (_, i) => ({
    name: `emoji-asset-${i}.txt`,
    type: "text/plain",
    content: "🔥".repeat(40000),
  }));

  const agentWithEmojiAssets = {
    name: "Emoji Specialist",
    role: "Handles multi-byte Unicode content.",
    skills: ["tab-hygiene"],
    coreAssets: emojiAssets,
  };

  const cardJson = exportAgentCardJson(agentWithEmojiAssets);
  const totalBytes = new TextEncoder().encode(cardJson).byteLength;
  assert(totalBytes > 0, "export produced");

  const reimported = importAgentCard(cardJson);
  assert(reimported.ok, `maximal Unicode export must re-import cleanly: ${!reimported.ok && reimported.error}`);
  assertEquals(reimported.agent.coreAssets.length, 8);

  // 100% content equality check
  const parsedExport = JSON.parse(cardJson);
  for (let i = 0; i < 8; i++) {
    assertEquals(reimported.agent.coreAssets[i].content, parsedExport.coreAssets[i].content);
  }
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
  assertEquals(importAgentCard({ name: "No Version" }).ok, false);

  const strVerRes = importAgentCard({ version: "1", name: "Str Version" });
  assertEquals(strVerRes.ok, false);
  assert(strVerRes.error.includes("version must be an integer"));

  assertEquals(importAgentCard({ version: true, name: "Bool Version" }).ok, false);
  assertEquals(importAgentCard({ version: [1], name: "Array Version" }).ok, false);
  assertEquals(importAgentCard({ version: 1.5, name: "Float Version" }).ok, false);
  assertEquals(importAgentCard({ version: 99, name: "Future Version" }).ok, false);

  const validRes = importAgentCard({ version: 1, name: "Valid Version" });
  assertEquals(validRes.ok, true);
  assertEquals(validRes.version, 1);
});

Deno.test("P2 r2: omittedValidSkillsCount counts distinct omitted skills, not repeated occurrences", () => {
  const distinctSkills = Array.from({ length: 130 }, (_, i) => `skill-id-${i}`);
  const knownSet = new Set(distinctSkills);

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
  assertEquals(res.agent.skills.length, 130, "dptw: no skill cap — all 130 distinct skills kept");
  assertEquals(res.omittedValidSkillsCount, 0, "dptw: nothing omitted");
});

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
  const noName = { version: 1, role: "No name" };
  const res1 = importAgentCard(noName);
  assertEquals(res1.ok, false);
  assert(res1.error.includes("requires a name"));

  const nullName = { version: 1, name: null, role: "Null name" };
  const res2 = importAgentCard(nullName);
  assertEquals(res2.ok, false);
  assert(res2.error.includes("requires a name"));

  const emptyName = { version: 1, name: "", role: "Empty name" };
  const res3 = importAgentCard(emptyName);
  assertEquals(res3.ok, false);
  assert(res3.error.includes("requires a non-empty name"));

  const wsName = { version: 1, name: "   \t\n  ", role: "WS name" };
  const res4 = importAgentCard(wsName);
  assertEquals(res4.ok, false);
  assert(res4.error.includes("requires a non-empty name"));

  const numName = { version: 1, name: 12345, role: "Num name" };
  const res5 = importAgentCard(numName);
  assertEquals(res5.ok, false);
  assert(res5.error.includes("name must be a string"));
});

Deno.test("agent cards (dptw): oversized fields are kept WHOLE — no maximums", () => {
  const hugeName = "A".repeat(220);
  const hugeRole = "B".repeat(37_000);
  const hugeCreatedFrom = "C".repeat(114);
  const hugeAvatar = "data:image/png;base64," + "D".repeat(33_768);
  const hugeAssetContent = "E".repeat(131_572);

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
  assert(res.ok, "oversized card imports successfully");
  assertEquals(res.agent.name, hugeName, "name whole");
  assertEquals(res.agent.role, hugeRole, "role whole");
  assertEquals(res.agent.createdFrom, hugeCreatedFrom, "createdFrom whole");
  assertEquals(res.agent.avatar, hugeAvatar, "avatar whole");
  assertEquals(res.agent.coreAssets[0].content, hugeAssetContent, "asset content whole — no ellipsis clip");
});


Deno.test("agent cards: hostile input fails closed on invalid field types", () => {
  const badRole = { version: 1, name: "Agent", role: { nested: "object" } };
  const r1 = importAgentCard(badRole);
  assertEquals(r1.ok, false);
  assert(r1.error.includes("role/persona must be a string"));

  const badSkills = { version: 1, name: "Agent", skills: "tab-hygiene" };
  const r2 = importAgentCard(badSkills);
  assertEquals(r2.ok, false);
  assert(r2.error.includes("skills must be an array"));

  const badSkillItem = { version: 1, name: "Agent", skills: ["tab-hygiene", 12345] };
  const r3 = importAgentCard(badSkillItem);
  assertEquals(r3.ok, false);
  assert(r3.error.includes("skill ids must be strings"));

  const badAssets = { version: 1, name: "Agent", coreAssets: { name: "doc.txt" } };
  const r4 = importAgentCard(badAssets);
  assertEquals(r4.ok, false);
  assert(r4.error.includes("coreAssets must be an array"));

  const badSched1 = { version: 1, name: "Agent", schedule: "every 5 min" };
  const r5 = importAgentCard(badSched1);
  assertEquals(r5.ok, false);
  assert(r5.error.includes("schedule must be an object"));

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
