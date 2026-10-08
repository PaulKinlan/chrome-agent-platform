// tests/i18n-catalogue-honesty.test.ts — the catalogue honesty check
// (chrome-agent-platform-716s.2) EXECUTED, twice over:
//
//  1. FALSIFICATION. Every rule in scripts/check-i18n.mjs is fed the exact
//     defective entries and markup that shipped in the first Settings
//     migration (verbatim from the pre-fix catalogue/options.html) and must
//     REPORT them; the fixed shape of each must report nothing, so a rule
//     cannot pass by returning true.
//  2. THE SHIPPED TREE. checkI18n() over the real catalogue and markup
//     reports zero findings, and the four leads the 2026-10-01 audit watched
//     render as full sentences through hydrateI18n with their inline markup
//     intact.
//
// RED before the fix: the pre-fix tree reported 72 findings across 28 keys
// (the audit's "12 suspicious entries" among them). GREEN after.
// @ts-nocheck — fixture shapes are asserted at runtime.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  analyseElement,
  auditMarkup,
  auditMessages,
  checkI18n,
  decodeEntities,
  formatFindings,
  keysUsedInScript,
} from "../scripts/check-i18n.mjs";

const rules = (findings) => [...new Set(findings.map((f) => f.rule))].sort();
const keysOf = (findings) => [...new Set(findings.map((f) => f.key))].sort();

// ── 1. falsification: the shipped defects are REPORTED ─────────────────────

// Verbatim pre-fix catalogue entries (extension/_locales/en/messages.json @ origin/main 4b071088).
const PRE_FIX_ENTRIES = {
  options_version: { message: "Version " },
  options_backup_amp_restore: { message: "Backup &amp; restore" },
  options_connect_a_remote: { message: "Connect a remote " },
  options_reusable_capabilities_each_documented_below_a_skil: {
    message: "\n          Reusable capabilities, each documented below. A skill is included in a\n          task — type ",
  },
  options_write_a: { message: "Write a " },
  options_chrome_grants: { message: "Chrome grants " },
  options_chrome: { message: "Chrome " },
  options_platform: { message: " Platform" },
  options_about: { message: "\n        About" },
  options_add_file: { message: "\n              Add file\n            " },
  options_import_a_backup_file: { message: "\n            Import a backup file\n            " },
  options_file_system_access_api_is_unavailable_in_this_brow: {
    message: "\n            File System Access API is unavailable in this browser environment\n          ",
  },
};

Deno.test("falsification: every pre-fix truncated/escaped entry the audit named is REPORTED by the catalogue rules", () => {
  const findings = auditMessages(PRE_FIX_ENTRIES);
  const flagged = keysOf(findings);
  for (const key of Object.keys(PRE_FIX_ENTRIES)) {
    assert(flagged.includes(key), `${key} must be reported; got ${JSON.stringify(flagged)}`);
  }
  assertEquals(flagged.length, 12, "the twelve pre-fix entries are twelve defects");
  const byKey = Object.fromEntries(findings.map((f) => [f.key + ":" + f.rule, f]));
  assert(byKey["options_version:C1"], "a trailing space is a C1 (padding whitespace) finding");
  assert(byKey["options_backup_amp_restore:C4"], "&amp; in the catalogue is a C4 (entity) finding");
  assert(byKey["options_write_a:C3"], "'Write a ' ends in an article — C3");
  assert(byKey["options_reusable_capabilities_each_documented_below_a_skil:C1"], "embedded newlines are C1");
});

Deno.test("falsification: the catalogue rules each fire on one shaped input and stay silent on its fixed twin", () => {
  const cases = [
    ["C1", "Version ", "Version $1"],
    ["C1", "\n  About", "About"],
    ["C2", "A skill is included in a task —", "A skill is included in a task — type $1 anywhere."],
    ["C3", "Write a", "Write a $1 line."],
    ["C3", "Open the", "Open the hub"],
    ["C4", "Backup &amp; restore", "Backup & restore"],
    ["C4", "Chrome grants &lt;all_urls&gt;", "Chrome grants $1"],
    ["C5", "Write a <code>[WebMCP]</code> line", "Write a $1 line"],
  ];
  for (const [rule, bad, good] of cases) {
    const red = auditMessages({ k: { message: bad } });
    assert(rules(red).includes(rule), `${rule} must fire on ${JSON.stringify(bad)}; got ${JSON.stringify(rules(red))}`);
    assertEquals(auditMessages({ k: { message: good } }), [], `${rule} must stay silent on ${JSON.stringify(good)}`);
  }
  // A raw ampersand is TEXT, not an entity: "Data & memory" is a correct message.
  assertEquals(auditMessages({ k: { message: "Data & memory" } }), []);
});

// Verbatim pre-fix markup lines (extension/options/options.html @ origin/main 4b071088).
const PRE_FIX_MARKUP = `
<a href="#about" class="nav-item" data-section="about">
<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg data-i18n="options_about">
About</a>
<p class="muted" data-i18n="options_connect_a_remote">Connect a remote <abbr title="Model Context Protocol">MCP</abbr> server so agents can call its tools. Only remote servers are supported — Streamable HTTP or SSE over an <code>https://</code> URL. An auth token stays on this device only — never in the bundle, logs, or receipts — and is never shown again after you save it.</p>
<p class="skills-sub" data-i18n="options_reusable_capabilities_each_documented_below_a_skil">
  Reusable capabilities, each documented below. A skill is included in a
  task — type <span class="muted">/skill:name</span> anywhere in the
  composer on the hub, or attach it to an agent. Use one here to start a
  task with it pre-filled.
</p>
<h3 style="margin: 0 0 6px;" data-i18n="options_backup_amp_restore">Backup &amp; restore</h3>
<label data-i18n="options_import_a_backup_file">
  Import a backup file
  <input type="file" id="import-all-file" hidden>
</label>
<div class="about-brand" id="about-brand-home" data-i18n="options_chrome_agent_platform">
  <svg class="about-brand-logo" viewBox="0 0 24 24"><path d="M11 5.5v9"/></svg>
  <span class="about-brand-text">Chrome Agent Platform</span>
</div>
<span data-i18n="options_version">Version <strong id="about-version">v0.0.0</strong></span>
<span data-i18n="options_missing_key">Orphaned</span>
`;

Deno.test("falsification: the pre-fix markup is REPORTED — dead end-tag attribute, children without slots, entity drift, missing key", () => {
  const messages = {
    ...PRE_FIX_ENTRIES,
    options_chrome_agent_platform: { message: "Chrome Agent Platform" },
  };
  const { findings, used } = auditMarkup(PRE_FIX_MARKUP, messages, { file: "fixture.html" });
  const byKey = {};
  for (const f of findings) (byKey[f.key] ??= []).push(f.rule);
  assertEquals(byKey.options_about, ["M1"], "data-i18n on </svg …> is a dead attribute");
  assertEquals(byKey.options_connect_a_remote, ["M3"], "two inline children, no $1/$2 — hydration would truncate the lead");
  assertEquals(byKey.options_reusable_capabilities_each_documented_below_a_skil, ["M3"]);
  assertEquals(byKey.options_backup_amp_restore, ["M4"], "the catalogue holds the entity, the markup renders '&' — drift");
  assertEquals(byKey.options_import_a_backup_file, ["M3"], "the file <input> would be discarded");
  assertEquals(byKey.options_chrome_agent_platform, ["M3"], "the About logo would be discarded");
  assertEquals(byKey.options_version, ["M3"], "the version <strong> would be discarded");
  assertEquals(byKey.options_missing_key, ["M2"]);
  assert(!used.has("options_about"), "a dead end-tag attribute does not count as a use");
  // Every finding names its file:line so a reader can go straight to it.
  for (const f of findings) assert(/^fixture\.html:\d+$/.test(f.where), `finding carries a location: ${JSON.stringify(f)}`);
  assert(formatFindings(findings).includes("M3 options_version (fixture.html:"), "the report is human-readable");
});

Deno.test("the fixed markup shape reports nothing: slots per child, entity in markup only, keys on text-only spans", () => {
  const markup = `
<p class="muted" data-i18n="options_mcp_lead">Connect a remote <abbr title="Model Context Protocol">MCP</abbr> server so agents can call its tools. Only remote servers are supported — Streamable HTTP or SSE over an <code>https://</code> URL.</p>
<h3 data-i18n="options_backup_restore">Backup &amp; restore</h3>
<label>
  <span data-i18n="options_import_a_backup_file">Import a backup file</span>
  <input type="file" id="import-all-file" hidden>
</label>
<span data-i18n="options_version">Version <strong id="about-version">v0.0.0</strong></span>
<div class="chip" data-i18n="options_notice">
  File System Access API is unavailable in this browser environment
</div>
<button data-i18n-attr="aria-label:options_close;title:options_close"></button>
`;
  const messages = {
    options_mcp_lead: { message: "Connect a remote $1 server so agents can call its tools. Only remote servers are supported — Streamable HTTP or SSE over an $2 URL." },
    options_backup_restore: { message: "Backup & restore" },
    options_import_a_backup_file: { message: "Import a backup file" },
    options_version: { message: "Version $1" },
    options_notice: { message: "File System Access API is unavailable in this browser environment" },
    options_close: { message: "Close" },
  };
  const { findings, used } = auditMarkup(markup, messages, { file: "fixture.html" });
  assertEquals(findings, [], formatFindings(findings));
  assertEquals([...used].sort(), Object.keys(messages).sort());
  // And the slot contract has teeth in BOTH directions.
  const tooFew = auditMarkup(markup, { ...messages, options_mcp_lead: { message: "Connect a remote $1 server." } }, {}).findings;
  assertEquals(rules(tooFew), ["M3"], "a message that places only one of two children is reported");
  const tooMany = auditMarkup(markup, { ...messages, options_version: { message: "Version $1 $2" } }, {}).findings;
  assertEquals(rules(tooMany), ["M3"], "a message naming a slot that is not there is reported");
  const reworded = auditMarkup(markup, { ...messages, options_version: { message: "Build $1" } }, {}).findings;
  assertEquals(rules(reworded), ["M4"], "a message that says something else than the markup fallback is reported");
});

Deno.test("analyseElement: direct children only, void and self-closing elements, decoded and collapsed fallback", () => {
  const html = `<p data-i18n="k">Write a <code>[WebMCP]</code> line to the <b>page's <i>DevTools</i></b> console &amp; log.<br>Done</p>`;
  const info = analyseElement(html, 0);
  assertEquals(info.tag, "p");
  assertEquals(info.children, 3, "<code>, <b> (with nested <i>) and <br> are the direct children");
  assertEquals(info.fallback, "Write a $1 line to the $2 console & log. $3 Done");
  assertEquals(analyseElement(`<input data-i18n="k" type="text">`, 0).voidElement, true);
  assertEquals(analyseElement(`<svg data-i18n="k"><path d="M0 0"/></svg>`, 0).children, 1);
  assertEquals(analyseElement(`<p data-i18n="k">never closed`, 0), null);
  assertEquals(decodeEntities("&lt;all_urls&gt; &amp; &#39;x&#x27; &nbsp;"), "<all_urls> & 'x' \u00a0");
});

Deno.test("keysUsedInScript sees t(\"key\") literals and data-i18n attributes built in JS", () => {
  const used = keysUsedInScript(`
    const a = t("components_copy_exact_content");
    const b = t('components_copied_exact', 1);
    el.setAttribute("data-i18n", "x"); // not a literal attribute form — not counted
    const html = '<span data-i18n="options_import">Import</span>';
    const attr = '<button data-i18n-attr="aria-label:options_close;title:options_close">';
  `);
  assertEquals([...used].sort(), ["components_copied_exact", "components_copy_exact_content", "options_close", "options_import"]);
});

// ── 2. the shipped tree ────────────────────────────────────────────────────

Deno.test("the shipped catalogue and markup report zero findings (the audit's 28 defective keys are gone)", async () => {
  const { findings, locales, htmlFiles } = await checkI18n();
  assert(locales.includes("en"), "the en catalogue is scanned");
  assert(htmlFiles.includes("extension/options/options.html"), "Settings markup is scanned");
  assertEquals(findings, [], `\n${formatFindings(findings)}`);
});

Deno.test("the shipped catalogue carries the full sentences the audit saw cut short, and none of the truncated keys", async () => {
  const messages = JSON.parse(await Deno.readTextFile(new URL("../extension/_locales/en/messages.json", import.meta.url)));
  assertEquals(messages.options_version.message, "Version $1");
  assertEquals(messages.options_backup_restore.message, "Backup & restore");
  assert(messages.options_mcp_lead.message.startsWith("Connect a remote $1 server so agents can call its tools."));
  assert(messages.options_mcp_lead.message.endsWith("never shown again after you save it."));
  assert(messages.options_skills_lead.message.includes("task — type $1 anywhere in the composer on the hub"));
  assert(messages.options_skills_lead.message.endsWith("Use one here to start a task with it pre-filled."));
  assert(messages.options_site_agents_host_access.message.startsWith("Chrome grants $1 host access"));
  assert(messages.options_diagnostics_logs_help.message.startsWith("Write $1 injection diagnostics to the extension's service-worker DevTools console"));
  assert(messages.options_diagnostics_logs_help.message.includes("Page-console diagnostics remain off"),
    "do not promise page logging of an owner-global diagnostic setting");
  for (const gone of [
    "options_backup_amp_restore", "options_connect_a_remote", "options_chrome_grants", "options_write_a",
    "options_reusable_capabilities_each_documented_below_a_skil", "options_chrome", "options_platform",
  ]) assert(!(gone in messages), `${gone} must not survive — it was a truncated prefix`);
});
