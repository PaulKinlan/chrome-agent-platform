// tests/configure-deeplink.test.ts — Unit and contract tests for
// Settings deep-link hash navigation and background agent configure routing
// (CAP-FB-20260823-BACKGROUND-CONFIGURE-DEEPLINK-01).
// @ts-nocheck

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  isExactOptionsSender,
  OPTIONS_PRODUCT_HASHES,
  normalizeSettingsSectionId,
  SETTINGS_SECTIONS,
} from "../extension/lib/pure.js";

Deno.test("OPTIONS_PRODUCT_HASHES: contains #background-agents and #background", () => {
  assert(OPTIONS_PRODUCT_HASHES.has("#background-agents"));
  assert(OPTIONS_PRODUCT_HASHES.has("#background"));
  assert(OPTIONS_PRODUCT_HASHES.has("#providers"));
  assert(OPTIONS_PRODUCT_HASHES.has("#tool-library"));
  assert(!OPTIONS_PRODUCT_HASHES.has("#unknown-foreign"));
});

Deno.test("isExactOptionsSender: accepts registered #background-agents hash", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const url = `chrome-extension://${id}/options/options.html`;
  const exact = {
    id,
    url: `${url}#background-agents`,
    origin: `chrome-extension://${id}`,
    frameId: 0,
    documentLifecycle: "active",
    documentId: "doc-1",
  };
  assert(isExactOptionsSender(exact, id, url), "options.html#background-agents must be accepted");
  assert(isExactOptionsSender({ ...exact, url: `${url}#background` }, id, url), "options.html#background must be accepted");
  assert(!isExactOptionsSender({ ...exact, url: `${url}#foreign-hash` }, id, url), "foreign hash must fail closed");
  assert(!isExactOptionsSender({ ...exact, url: `${url}?param=1#background` }, id, url), "query params must fail closed");
});

Deno.test("isExactOptionsSender: the EMBEDDED Settings sender shape binds owner-options (P0 pek9)", () => {
  // The hub's openView boots the embedded Settings frame at its exact
  // canonical URL (options/options.html or options/options.html#providers) —
  // no query. Chrome reports that committed URL as sender.url, so these are
  // the shapes the service worker actually receives from the hub-embedded
  // Providers panel. Both MUST bind the owner-options principal.
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const url = `chrome-extension://${id}/options/options.html`;
  const base = {
    id,
    origin: `chrome-extension://${id}`,
    frameId: 5,
    documentLifecycle: "active",
    documentId: "embedded-doc-1",
  };
  assert(
    isExactOptionsSender({ ...base, url }, id, url),
    "the embedded bare options.html document must bind owner-options",
  );
  assert(
    isExactOptionsSender({ ...base, url: `${url}#providers` }, id, url),
    "the embedded options.html#providers document must bind owner-options",
  );
  // And the OLD broken embedded shape — the committed URL still carrying
  // ?embedded=1 — must keep failing closed (a regression to query markers is
  // exactly the P0 that refused the real Settings document).
  assert(
    !isExactOptionsSender({ ...base, url: `${url}?embedded=1#providers` }, id, url),
    "an embedded=1 query on the committed URL must still fail closed",
  );
});

Deno.test("normalizeSettingsSectionId: legacy background links land on unified Agents", () => {
  assertEquals(normalizeSettingsSectionId("#background-agents"), "agents");
  assertEquals(normalizeSettingsSectionId("background-agents"), "agents");
  assertEquals(normalizeSettingsSectionId("#background"), "agents");
  assertEquals(normalizeSettingsSectionId("#providers"), "providers");
  assertEquals(normalizeSettingsSectionId("#tool-library"), "tool-library");
  assertEquals(normalizeSettingsSectionId("#agents"), "agents");
  assertEquals(normalizeSettingsSectionId("#about"), "about");

  // Unknown or hostile hashes fail closed
  assertEquals(normalizeSettingsSectionId("#stale-unregistered-hash"), null);
  assertEquals(normalizeSettingsSectionId("#<script>"), null);
  assertEquals(normalizeSettingsSectionId(""), null);
  assertEquals(normalizeSettingsSectionId(null), null);
});

Deno.test("Configure call sites in ntp.js use exact deep-link hash", async () => {
  const ntpSource = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  // bg-configure button
  assert(
    ntpSource.includes('openView("options/options.html#background-agents"'),
    "bg-configure click must route to options.html#background-agents",
  );

  // data-open-bg link in empty state
  assert(
    ntpSource.includes('openView("options/options.html#background-agents"'),
    "data-open-bg click must route to options.html#background-agents",
  );

  // P0 pek9: openView must boot embedded frames at the canonical URL and strip
  // legacy ?embedded=1 markers from stored routes (never re-append them).
  assert(
    ntpSource.includes('const frameUrl = chrome.runtime.getURL(String(path ?? ""))'),
    "openView must boot the frame at the canonical path with no query appended",
  );
  assert(
    ntpSource.includes('p !== "embedded=1"'),
    "openView must strip legacy embedded=1 markers out of stored route paths",
  );
});

Deno.test("named-agent editing works from embedded and standalone Settings", async () => {
  const options = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assert(options.includes('postMessage(message, "*")'), "embedded Settings must request its parent NTP editor");
  assert(options.includes("&edit=1"), "standalone Settings must navigate to the explicit edit route");
  assert(ntp.includes('parsed.kind === "named" && parsed.edit === true'), "the NTP must open the maintained editor for that route");
});

Deno.test("options.html has one unified Agents section and keeps no background section", async () => {
  const html = await Deno.readTextFile(
    new URL("../extension/options/options.html", import.meta.url),
  );
  assert(html.includes('<section id="agents"'), "Settings must contain the Agents section");
  assert(html.includes('id="unified-agent-list"'), "Agents must own the unified management list");
  assert(!html.includes('<section id="background"'), "a separate background-agent section must not return");
  assert(!html.includes('data-section="background"'), "a separate background-agent nav item must not return");
});
