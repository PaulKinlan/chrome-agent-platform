// tests/site-playbooks.test.ts — origin-bound skills + per-origin site notes
// (CAP-FB-20260830-SITE-PLAYBOOKS-01).
//
// The security invariant: an origin-bound skill or site note for origin A is
// structurally incapable of composing into a run whose active tab is origin B.
// The falsification gate: revert the origin filter (match everything), expect
// RED on "nothing for another origin", restore, expect GREEN.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  isValidMatchPattern,
  matchPattern,
  MAX_SKILL_ORIGINS,
  skillMatchesUrl,
  validateSkillOrigins,
} from "../extension/shared/match-patterns.js";
import { appendSkillsLayer, PROMPT_REGISTRY } from "../extension/lib/system-prompts.js";
import { loadComposerCommandItems } from "../extension/shared/composer-commands.js";

Deno.test("origins on a skill are valid match patterns and bounded to 8", () => {
  assert(validateSkillOrigins(undefined).ok);
  assert(validateSkillOrigins(null).ok);
  assertEquals(validateSkillOrigins([]).origins, []);
  assert(validateSkillOrigins(["https://github.com/*"]).ok);
  assert(validateSkillOrigins(["*://*.example.com/path/*"]).ok);
  // Over the bound.
  const tooMany = Array.from({ length: MAX_SKILL_ORIGINS + 1 }, () => "https://a.com/*");
  assert(!validateSkillOrigins(tooMany).ok);
  // Invalid entries.
  assert(!validateSkillOrigins(["github.com"]).ok); // no scheme
  assert(!validateSkillOrigins(["ftp://x.com/*"]).ok); // unsupported scheme
  assert(!validateSkillOrigins(["https://te*pot.com/*"]).ok); // wildcard mid-host
  assert(!validateSkillOrigins(["https://github.com"]).ok); // no path part
  assert(!validateSkillOrigins("https://github.com/*").ok); // not an array
});

Deno.test("matchPattern: scheme, host, and path semantics", () => {
  assert(matchPattern("https://github.com/*", "https://github.com/paul"));
  assert(matchPattern("https://github.com/*", "https://github.com/"));
  assert(!matchPattern("https://github.com/*", "http://github.com/paul")); // scheme
  assert(!matchPattern("https://github.com/*", "https://evil-github.com/")); // host suffix
  assert(matchPattern("*://*.example.com/*", "https://sub.example.com/x"));
  assert(matchPattern("*://*.example.com/*", "http://example.com/x")); // *. covers bare host
  assert(matchPattern("https://github.com/paul/*", "https://github.com/paul/repo"));
  assert(!matchPattern("https://github.com/paul/*", "https://github.com/other"));
  assert(!matchPattern("not a pattern", "https://github.com/"));
  assert(!matchPattern("https://github.com/*", "not a url"));
  assert(isValidMatchPattern("https://github.com/*"));
});

Deno.test("skillMatchesUrl: global skills match everywhere; origin-bound only on their origin", () => {
  const global = { id: "g", name: "Global" };
  const bound = { id: "b", name: "Bound", origins: ["https://fixture.local/*"] };
  assert(skillMatchesUrl(global, "https://example.com/"));
  assert(skillMatchesUrl(global, "https://fixture.local/"));
  assert(skillMatchesUrl(bound, "https://fixture.local/page"));
  assert(!skillMatchesUrl(bound, "https://example.com/"));
  // An invalid origins declaration fails CLOSED (never composes).
  assert(!skillMatchesUrl({ id: "x", origins: ["bogus"] }, "https://bogus/"));
});

Deno.test("the composed skills layer carries the site note for the matching origin only", () => {
  const base = "BASE SYSTEM";
  const withNote = appendSkillsLayer(base, [], undefined, null, null, {
    origin: "https://fixture.local",
    note: "On this site, always close duplicate tabs first.",
  });
  assert(withNote.includes("## On https://fixture.local"), "the note heading renders");
  assert(withNote.includes("close duplicate tabs first"), "the note text renders");
  assert(withNote.startsWith("BASE SYSTEM"), "the note stays inside the boundary (base first)");
  // No siteNote: the section is absent entirely.
  const without = appendSkillsLayer(base, [], undefined, null, null, null);
  assert(!without.includes("## On"), "no note section without a note");
  // An empty note text renders nothing.
  const empty = appendSkillsLayer(base, [], undefined, null, null, {
    origin: "https://fixture.local",
    note: "   ",
  });
  assert(!empty.includes("## On"), "an empty note renders no section");
});

Deno.test("the /skill: palette offers origin-bound skills only on the matching tab", async () => {
  const skills = [
    { id: "fixture-triage", refId: "builtin:fixture-triage", name: "Fixture triage", description: "d", origins: ["http://127.0.0.1/*"] },
    { id: "tab-hygiene", refId: "builtin:tab-hygiene", name: "Tab hygiene", description: "d" },
  ];
  const runtimeSend = async () => ({ skills });
  const chromeOnFixture = { tabs: { query: async () => [{ url: "http://127.0.0.1:8934/shop" }] } };
  const chromeElsewhere = { tabs: { query: async () => [{ url: "https://example.com/" }] } };
  const onFixture = await loadComposerCommandItems("skill", "", { runtimeSend, chromeApi: chromeOnFixture });
  assert(onFixture.some((i) => i.id === "skill:builtin:fixture-triage"), "offered on the fixture tab");
  const elsewhere = await loadComposerCommandItems("skill", "", { runtimeSend, chromeApi: chromeElsewhere });
  assert(!elsewhere.some((i) => i.id === "skill:builtin:fixture-triage"), "absent on example.com");
  assert(elsewhere.some((i) => i.id === "skill:builtin:tab-hygiene"), "globals still offered");
});

Deno.test("the protected policy stays LAST when a site note composes", () => {
  const registry = PROMPT_REGISTRY;
  const constraints = registry.find((l) => l.id === "cap.constraints.core");
  const protectedText = String(constraints?.content ?? "");
  const composed = appendSkillsLayer(
    `HEAD\n\n${protectedText}`,
    [{ id: "s", name: "S", description: "d" }],
    registry,
    null,
    null,
    { origin: "https://fixture.local", note: "owner note" },
  );
  assert(protectedText.length > 0, "the registry carries the protected block");
  assert(composed.endsWith(protectedText), "the protected policy is still the final layer");
  assert(composed.indexOf("## On https://fixture.local") < composed.length - protectedText.length,
    "the note composes BEFORE the protected policy");
});
