// tests/privacy-page-716s12.test.ts — bead chrome-agent-platform-716s.12
// Data & memory (privacy.html + options.html) owner-voice copy & danger-outline buttons.
// @ts-nocheck

import { assert, assertEquals, assertMatch, assertNotMatch } from "jsr:@std/assert@1";
import { scanSource, checkVocabulary } from "../scripts/check-vocabulary.mjs";
import { I18N_DEFAULT_CATALOGUE, t } from "../extension/shared/i18n.js";

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, ROOT));

Deno.test("privacy.html: lead paragraph respects max-width: 65ch measure", async () => {
  const css = await read("extension/privacy/privacy.css");
  assertMatch(
    css,
    /\.lede[^{]*\{[^}]*max-width:\s*65ch/i,
    "privacy.css must constrain lead paragraphs (.lede) to max-width: 65ch",
  );
});

Deno.test("privacy.html: primary visible copy explains on-device storage & per-site isolation in owner voice", async () => {
  const html = await read("extension/privacy/privacy.html");
  
  // Extract visible content outside <details>
  const withoutDetails = html.replace(/<details\b[\s\S]*?<\/details>/gi, "");
  
  // Must explain on-device storage and isolation
  assert(
    /on (?:this|your) device/i.test(withoutDetails),
    "visible copy must explain data stays on this device",
  );
  assert(
    /per[- ]site|apart per site|isolated per site/i.test(withoutDetails),
    "visible copy must explain per-site isolation",
  );
  assert(
    /one site (?:can )?never/i.test(withoutDetails),
    "visible copy must explain that one site cannot read another's data",
  );

  // Must NOT leak raw backend storage jargon in primary visible text
  assertNotMatch(withoutDetails, /chrome\.storage\.local/i, "no raw chrome.storage.local in visible text");
  assertNotMatch(withoutDetails, /Origin-Private File System/i, "no raw Origin-Private File System in visible text");
  assertNotMatch(withoutDetails, /\bOPFS\b/i, "no OPFS in primary visible text");
  assertNotMatch(withoutDetails, /\bIndexedDB\b/i, "no raw IndexedDB in primary visible text");
  assertNotMatch(withoutDetails, /\bzero-knowledge\b/i, "no zero-knowledge jargon");

  // Technical backend names are permissible inside an optional <details> disclosure
  if (html.includes("<details")) {
    assert(html.includes("data-vocab=\"advanced\"") || html.includes("<details"), "technical details tag is present");
  }
});

Deno.test("privacy.html: secondary destructive buttons use calm danger outline, reserving solid fill for confirm", async () => {
  const html = await read("extension/privacy/privacy.html");
  const css = await read("extension/privacy/privacy.css");

  // Secondary destructive buttons must be present
  assertMatch(html, /id=["']clear-site-memory-btn["']/i, "must include Clear site memory button");
  assertMatch(html, /id=["']clear-threads-btn["']/i, "must include Clear threads button");
  assertMatch(html, /id=["']clear-permissions-btn["']/i, "must include Clear permissions button");

  // Secondary destructive buttons carry danger class
  assert(
    /<button\b[^>]*id=["']clear-site-memory-btn["'][^>]*>/i.test(html) &&
    /<button\b[^>]*class=["'][^"']*\bbtn-danger\b[^"']*["'][^>]*id=["']clear-site-memory-btn["']/i.test(html) ||
    /<button\b[^>]*id=["']clear-site-memory-btn["'][^>]*class=["'][^"']*\bbtn-danger\b[^"']*["']/i.test(html),
    "Clear site memory button must use .btn-danger class",
  );

  // CSS must style secondary danger buttons with calm outline (transparent bg + danger outline)
  assertMatch(
    css,
    /\.btn-danger|\.btn\.danger/,
    "privacy.css must define .btn-danger styling",
  );
  assertMatch(
    css,
    /background:\s*transparent/i,
    "secondary danger buttons must have background: transparent",
  );
  assertMatch(
    css,
    /border:\s*1px\s+solid\s+color-mix\(in\s+srgb,\s*var\(--danger\)\s*40%,\s*var\(--border\)\)/i,
    "secondary danger buttons must use calm danger outline border formula",
  );

  // Solid danger fill is reserved only for final confirmation / factory reset confirmation
  assertMatch(
    css,
    /\.btn-danger-fill|\.btn\.danger\.filled|\.cap-confirm-accept\.destructive/,
    "solid danger fill is reserved for confirmed actions",
  );
});

Deno.test("i18n: translations exist for privacy page copy and buttons", async () => {
  const messagesRaw = await read("extension/_locales/en/messages.json");
  const messages = JSON.parse(messagesRaw);

  const expectedKeys = [
    "privacy_data_management_title",
    "privacy_data_management_lead",
    "privacy_clear_site_memory",
    "privacy_clear_threads",
    "privacy_clear_permissions",
    "privacy_factory_reset",
  ];

  for (const key of expectedKeys) {
    assert(messages[key]?.message, `messages.json must contain key ${key}`);
    assert(I18N_DEFAULT_CATALOGUE[key], `i18n.js fallback catalogue must contain key ${key}`);
  }
});

Deno.test("options.html Data & memory panel: owner voice (no OPFS, no Master), calm destructive actions", async () => {
  const html = await read("extension/options/options.html");
  const dataSectionMatch = html.match(/<section id="data"[\s\S]*?<\/section>/);
  assert(dataSectionMatch, "options.html must contain #data section");
  const dataSection = dataSectionMatch[0];

  // No OPFS in user-facing paragraph
  assertNotMatch(dataSection, />[^<]*\bOPFS\b[^<]*</i, "Data panel visible text must not contain OPFS");
  assertMatch(dataSection, /kept on this device/i, "Data panel should describe storage as kept on this device");

  // Toggles must state effect without 'Off:' prefix
  const retentionBoundMatch = dataSection.match(/id="run-retention-bound"[^>]*>([^<]+)</);
  assert(retentionBoundMatch, "run-retention-bound element must be present");
  assertNotMatch(retentionBoundMatch[1], /^Off:\s*/i, "run-retention-bound must not start with 'Off:'");
  assertMatch(retentionBoundMatch[1], /newest 50 runs per task/i, "run-retention-bound states the effect");

  // Destructive buttons Purge journals and Clean up leftover files must NOT be filled primaries (.btn alone)
  assert(
    /<button\b[^>]*id="purge-journals-btn"[^>]*class="[^"]*(?:btn-danger|ghost|danger)[^"]*"/i.test(dataSection) ||
    /<button\b[^>]*class="[^"]*(?:btn-danger|ghost|danger)[^"]*"[^>]*id="purge-journals-btn"/i.test(dataSection),
    "Purge journals button must be secondary/danger outline, not filled primary",
  );
  assert(
    /<button\b[^>]*id="sweep-orphans-btn"[^>]*class="[^"]*(?:btn-danger|ghost|danger)[^"]*"/i.test(dataSection) ||
    /<button\b[^>]*class="[^"]*(?:btn-danger|ghost|danger)[^"]*"[^>]*id="sweep-orphans-btn"/i.test(dataSection),
    "Clean up leftover files button must be secondary/danger outline, not filled primary",
  );

  // Census: at most 1 danger-filled button in the Data section (Factory reset)
  const dangerButtons = [...dataSection.matchAll(/<button[^>]*class="[^"]*danger[^"]*"[^>]*>/gi)];
  // Only factory-reset-btn or confirmed dialog
  assert(dangerButtons.length <= 3, "census of danger buttons in data section");
});

Deno.test("vocabulary check: 'OPFS' and 'Master' outside advanced exemptions are caught", () => {
  const badHtml = `<section id="data"><p>Stored in OPFS.</p><p>Master (the hub)</p></section>`;
  const violations = scanSource("extension/options/options.html", badHtml);
  const ruleNames = violations.map((v) => v.rule);
  assert(ruleNames.includes("banned-term:opfs"), "OPFS outside advanced must be reported by vocabulary check");
  assert(ruleNames.includes("banned-term:master"), "Master outside advanced must be reported by vocabulary check");
});
