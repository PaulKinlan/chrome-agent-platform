// tests/composer-skill-autofill.test.ts — chrome-agent-platform-etdn.
//
// Paul's directive: skills defined in CAP must (a) be listable + autofillable
// in the composer (the /skill: palette and the @ picker already list them with
// search; Tab/Enter/Click select), and (b) REACH THE HARNESS — a prompt that
// calls a skill must carry the skill's full definition to the harness turn.
//
// What is pinned here:
//   - the /skill: palette listing (skill.list rows, query filtering, the
//     collision-proof /skill:<refId> insert format),
//   - the skill-context resolution + payload builder in acp-runner,
//   - an END-TO-END ACP turn through a fake client proving the harness
//     receives the skill block, while the conversation keeps the owner's text.
// @ts-nocheck
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { loadComposerCommandItems } from "../extension/shared/composer-commands.js";
import {
  buildPromptWithSkillContext,
  extractSkillRefs,
  resolveSkillContext,
} from "../extension/lib/acp-runner.js";

const SKILL_ROWS = [
  { refId: "builtin:page-summary", id: "page-summary", name: "Page summary", description: "summarise the page", prompt: "Summarise the active page in three bullets." },
  { refId: "imported:cookie-audit", id: "cookie-audit", name: "Cookie audit", description: "audit cookies", prompt: "Audit the cookies of the site." },
  { refId: "builtin:auto-group-by-domain", id: "auto-group-by-domain", name: "Sorting Hat", description: "background skill", prompt: "GROUP TABS" },
];

function fakeRuntimeSend(type, body) {
  if (type === "skill.list") return Promise.resolve({ skills: SKILL_ROWS });
  return Promise.resolve({});
}

// ── the composer lists skills with search and the insertable reference ──────

Deno.test("etdn: the /skill palette lists CAP skills from the store with query filtering", async () => {
  const items = await loadComposerCommandItems("skill", "cookie", { runtimeSend: fakeRuntimeSend });
  assertEquals(items.length, 1);
  assertEquals(items[0].id, "skill:imported:cookie-audit", "the insert carries the source-qualified ref");
  assertEquals(items[0].label, "Cookie audit");
  const all = await loadComposerCommandItems("skill", "", { runtimeSend: fakeRuntimeSend });
  assertEquals(all.length, SKILL_ROWS.length, "an empty query lists every registered skill");
});

Deno.test("etdn: the @ picker surfaces skills as mention candidates", async () => {
  // The @ picker (components.js mentionCandidates) reads the SAME skill.list
  // route; pinned structurally so the two entry points cannot drift apart.
  const src = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  assert(/RUNTIME_SEND\("skill\.list"\)/.test(src), "the @ picker must read skill.list");
  assert(/kind: "skill", group: "Skills"/.test(src), "skills must be their own mention group");
});

// ── skill-context resolution + payload construction ─────────────────────────

Deno.test("etdn: /skill: references are extracted deduped in order", () => {
  assertEquals(
    extractSkillRefs("use /skill:builtin:page-summary then /skill:imported:cookie-audit and /skill:builtin:page-summary again"),
    ["builtin:page-summary", "imported:cookie-audit"],
  );
  assertEquals(extractSkillRefs("no references here"), []);
});

Deno.test("etdn: resolveSkillContext maps refs to the FULL skill records from the store", async () => {
  const rows = await resolveSkillContext(
    "run /skill:builtin:page-summary and /skill:builtin:missing-skill",
    { runtimeSend: fakeRuntimeSend },
  );
  assertEquals(rows.length, 1, "unknown refs are skipped");
  assertEquals(rows[0].refId, "builtin:page-summary");
  assert(rows[0].prompt.length > 0, "the record carries the skill's instructions");
});

Deno.test("etdn: the payload builder prepends a delimited skill block and keeps the owner's text", () => {
  const task = "check which cookie tools exist";
  const out = buildPromptWithSkillContext(task, [
    { refId: "builtin:page-summary", name: "Page summary", description: "summarise", prompt: "Summarise the page." },
  ]);
  assertStringIncludes(out, "<cap-skills>");
  assertStringIncludes(out, '<cap-skill ref="builtin:page-summary" name="Page summary">');
  assertStringIncludes(out, "Summarise the page.");
  assert(out.endsWith(task), "the owner's own text must remain the turn's task");
  assertEquals(buildPromptWithSkillContext(task, []), task, "no skills means an unchanged payload");
});

// ── end to end: the harness turn receives the skill block ───────────────────

Deno.test("etdn: runAcpTaskTurn forwards the skill context to the harness prompt", async () => {
  const { runAcpTaskTurn } = await import("../extension/lib/acp-runner.js");
  const prompted = [];
  const fakeClient = {
    connected: true,
    async connect() {},
    async initialize() {},
    async cancel() {},
    close() {},
    async newSession() { return { sessionId: "sess-1" }; },
    async loadSession() {},
    async prompt(_sid, text) {
      prompted.push(text);
      return { stopReason: "end_of_turn", messages: [] };
    },
    async close() {},
  };
  // The conversation container is only touched through guarded optional calls;
  // a null container keeps this a payload test, not a DOM test.
  // A minimal conversation stand-in: the runner touches guarded optional
  // methods only, and an appendError-less container keeps this a payload test.
  const container = {
    appendError: (m) => { throw new Error(m); },
  };
  const res = await runAcpTaskTurn({
    container,
    task: "run /skill:builtin:page-summary on the news site",
    harnessId: "pi",
    isStale: () => false,
    clientFactory: () => fakeClient,
    runtimeSend: fakeRuntimeSend,
    onStatus: () => {},
    onRunRegistered: () => {},
  });
  assertEquals(res.ok, true, JSON.stringify(res));
  assertEquals(prompted.length, 1);
  assertStringIncludes(prompted[0], "<cap-skills>");
  assertStringIncludes(prompted[0], "Summarise the active page in three bullets.");
  assertStringIncludes(prompted[0], "run /skill:builtin:page-summary on the news site");
});
