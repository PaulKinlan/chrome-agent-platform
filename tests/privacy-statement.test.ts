// tests/privacy-statement.test.ts — CAP-FB-20260830-PRIVACY-STATEMENT-01.
//
// The "What this extension sends and stores" page must be TRUE by
// construction: its lists are rendered from the same constants the code runs
// on, and these pins fail the moment the code and the page drift apart.
//
//  1. OUTBOUND_HOSTS (lib/provider.js) names every literal https:// host the
//     provider layer can send a request to. A new preset host that is not
//     exported is RED here before it is silently missing from the page.
//  2. The page's stored-data list is FACTORY_RESET_STORAGE_CLASSES, in order,
//     each class with its own reader-language copy — a new storage class the
//     reset covers is RED here until the page says what it holds.
//  3. The host-access sentence is the settled Q18 (a) posture (the README's
//     sentence), rendered from ONE constant.
//  4. The page is reachable from Settings → About, is NOT web-accessible, and
//     the sent list names the skill-import hosts and every provider host.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { FACTORY_RESET_STORAGE_CLASSES } from "../extension/lib/factory-reset.js";
import { OUTBOUND_HOSTS, PROVIDER_CHOICES } from "../extension/lib/provider.js";
import {
  buildPrivacyStatement,
  HOST_ACCESS_SENTENCE,
  SKILL_IMPORT_HOSTS,
  STORAGE_CLASS_COPY,
} from "../extension/lib/privacy-statement.js";

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, ROOT));

/** Every `https://<host>` literal in a source, comments excluded (a doc link
 *  in a comment is not a request). */
function httpsHostsIn(src: string): string[] {
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const hosts = new Set<string>();
  for (const m of noComments.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/"'`\s?)]|$)/gi)) hosts.add(m[1].toLowerCase());
  return [...hosts].sort();
}

// Hosts that appear as FIXTURE data (the demo model's fake article URLs), never
// as a request target. Listed explicitly so the scan cannot be quietly widened.
const FIXTURE_HOSTS = new Set(["example.com", "example.invalid"]);

Deno.test("OUTBOUND_HOSTS: every literal provider host in provider.js and the native model adapters is exported", async () => {
  const files = [
    "extension/lib/provider.js",
    "extension/lib/models/gemini-native-model.js",
    "extension/lib/models/anthropic-native-model.js",
    "extension/lib/model-catalog.js",
  ];
  const exported = new Set(OUTBOUND_HOSTS.map((h) => h.host));
  assert(exported.size >= 4, `at least the four preset hosts are exported, got ${[...exported]}`);
  for (const file of files) {
    const literal = httpsHostsIn(await read(file)).filter((h) => !FIXTURE_HOSTS.has(h));
    for (const host of literal) {
      assert(exported.has(host), `${file} sends to ${host} but OUTBOUND_HOSTS does not list it`);
    }
  }
  // And the export is derived from the presets, not a hand-typed copy.
  for (const choice of PROVIDER_CHOICES) {
    if (!/^https:\/\//.test(choice.baseURL ?? "")) continue;
    const host = new URL(choice.baseURL).host;
    assert(exported.has(host), `preset ${choice.id} (${host}) is missing from OUTBOUND_HOSTS`);
  }
  for (const h of OUTBOUND_HOSTS) {
    assert(typeof h.id === "string" && h.id, "each outbound host names its provider id");
    assert(typeof h.name === "string" && h.name, "each outbound host has a reader-facing name");
    assert(!/https?:/.test(h.host) && !h.host.includes("/"), `host is a bare host name: ${h.host}`);
  }
});

Deno.test("stored-data list: equals FACTORY_RESET_STORAGE_CLASSES, in order, each with its own copy", () => {
  assertEquals(Object.keys(STORAGE_CLASS_COPY), [...FACTORY_RESET_STORAGE_CLASSES], "one copy entry per storage class, same order");
  const statement = buildPrivacyStatement({ outboundHosts: OUTBOUND_HOSTS });
  assertEquals(statement.stored.map((row) => row.id), [...FACTORY_RESET_STORAGE_CLASSES]);
  for (const row of statement.stored) {
    assert(row.text.trim().length > 20, `${row.id} says what it holds`);
    assert(!/chrome\.|opfs|indexed-?db|kv\b/i.test(row.text), `${row.id} is described in the reader's words, not the system's: ${row.text}`);
  }
  // A storage class without copy is refused, never rendered blank.
  let threw = false;
  try {
    buildPrivacyStatement({ outboundHosts: OUTBOUND_HOSTS, storageClasses: [...FACTORY_RESET_STORAGE_CLASSES, "phantom-store"] });
  } catch (e) {
    threw = /phantom-store/.test(String(e?.message));
  }
  assert(threw, "an unlabelled storage class throws with its name");
});

Deno.test("the provider key line says it is stored unencrypted", () => {
  const statement = buildPrivacyStatement({ outboundHosts: OUTBOUND_HOSTS });
  const local = statement.stored.find((row) => row.id === "chrome.storage.local");
  assert(local && /not encrypted|unencrypted/i.test(local.text), `the settings row states the key is unencrypted: ${local?.text}`);
});

Deno.test("host access: the sentence is the settled posture the README states, from one constant", async () => {
  const readme = await read("README.md");
  assert(/read every page/.test(HOST_ACCESS_SENTENCE) && /acts on a site only after you allow it/.test(HOST_ACCESS_SENTENCE), HOST_ACCESS_SENTENCE);
  assert(readme.includes("read every page") && readme.includes("acts on a site only after you allow it"), "README states the same posture");
  const statement = buildPrivacyStatement({ outboundHosts: OUTBOUND_HOSTS });
  assertEquals(statement.hostAccess, HOST_ACCESS_SENTENCE);
});

Deno.test("sent list: names every outbound provider host, the local-only presets, the skill-import hosts and the approved-fetch gate", async () => {
  const statement = buildPrivacyStatement({ outboundHosts: OUTBOUND_HOSTS });
  const text = statement.sent.map((row) => row.text).join("\n");
  for (const h of OUTBOUND_HOSTS) assert(text.includes(h.host), `sent list names ${h.host}`);
  for (const h of SKILL_IMPORT_HOSTS) assert(text.includes(h), `sent list names the skill-import host ${h}`);
  const skillImport = await read("extension/lib/skill-import.js");
  for (const h of SKILL_IMPORT_HOSTS) assert(skillImport.includes(`https://${h}/`), `skill-import.js really fetches ${h}`);
  assert(/on this computer/.test(text), "the local presets (Ollama, LM Studio, Chrome's built-in model) are stated to stay local");
  assert(/approved/.test(text) && /cookies/.test(text), "the script fetch line states the approval gate and that no cookies are sent");
  assert(statement.sent.some((row) => /no analytics|nothing else leaves/i.test(row.text)), "the statement says nothing else leaves the computer");
});

Deno.test("the page: linked from Settings → About, not web-accessible, one h1, the three lists", async () => {
  const options = await read("extension/options/options.html");
  const about = options.slice(options.indexOf('<section id="about"'));
  assert(about.includes('href="../privacy/privacy.html"'), "Settings → About links the privacy page");
  const manifest = JSON.parse(await read("extension/manifest.json"));
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const res of entry.resources ?? []) assert(!/privacy/.test(res), `privacy page must not be web-accessible: ${res}`);
  }
  const page = await read("extension/privacy/privacy.html");
  assertEquals((page.match(/<h1\b/g) ?? []).length, 1, "exactly one h1");
  assert(page.includes("<privacy-statement"), "the page renders the shared <privacy-statement> component");
  assert(!/innerHTML/.test(await read("extension/privacy/privacy.js")), "the page script never uses innerHTML");
});
