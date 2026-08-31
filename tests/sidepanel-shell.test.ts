// sidepanel-shell.test.ts — CAP-FB-20260830-SIDE-PANEL-COMPANION-01.
//
// The side panel Page view is a companion pinned to the current tab, not a
// WebMCP status surface with an "Open site" URL bar and two H1s. These pins
// hold the layout + wiring the companion depends on:
//   - exactly one <h1> (the two-H1 bug is gone; a11y: one level-one heading),
//   - the numbered instruction card (<ol>) is removed,
//   - the URL field is demoted into a secondary <details> ("Open another site…"),
//   - the header shows the active tab (favicon + host set with textContent),
//   - a page composer + conversation are bound to the tab, with "Continue in hub",
//   - the Agents picker uses the active-only projection (callable-only over the
//     FRESH-PROFILE-filtered registry, so disabled templates never appear).
import { assert, assertEquals } from "jsr:@std/assert@1";

const read = (p: string) => Deno.readTextFile(new URL(p, new URL("../", import.meta.url)));
const html = await read("./extension/sidepanel/sidepanel.html");
const js = await read("./extension/sidepanel/sidepanel.js");

/** The substring of the FIRST <details …> … </details> block. */
function detailsBlock(src: string): string {
  const open = src.indexOf("<details");
  assert(open >= 0, "no <details> block found in the side panel");
  const close = src.indexOf("</details>", open);
  assert(close >= 0, "the <details> block is not closed");
  return src.slice(open, close + "</details>".length);
}

Deno.test("side panel: exactly one <h1> (the two-H1 bug is gone)", () => {
  const count = (html.match(/<h1\b/g) ?? []).length;
  assertEquals(count, 1, `expected exactly one <h1>, found ${count}`);
});

Deno.test("side panel: the numbered instruction card is removed (no <ol>)", () => {
  assert(!/<ol\b/.test(html), "the side panel still renders an <ol> instruction card");
  assert(!html.includes('id="first-run"'), "the first-run instruction card is still present");
});

Deno.test("side panel: the URL field is demoted into a secondary <details>", () => {
  const block = detailsBlock(html);
  assert(block.includes('id="url"'), "the #url input is not inside a <details> disclosure");
  assert(/<summary[^>]*>[\s\S]*Open another site/.test(block), "the disclosure is not labelled 'Open another site…'");
  // The URL field is no longer prefilled with a default site (it was value="https://example.com").
  assert(!/id="url"[^>]*value=/.test(html), "the #url input must not carry a default value attribute");
});

Deno.test("side panel: the header is pinned to the active tab (favicon + host)", () => {
  assert(html.includes('id="tab-favicon"'), "no favicon slot for the active tab");
  assert(html.includes('id="tab-host"'), "no host slot for the active tab");
  assert(html.includes('id="tab-toolstate"'), "no tool-state line for the active tab");
  // The active tab is queried and kept live on switch/navigation/focus.
  assert(js.includes("chrome.tabs.query({ active: true, lastFocusedWindow: true })"), "the panel never queries the active tab");
  assert(js.includes("chrome.tabs?.onActivated"), "the panel does not update on tab switch");
  assert(js.includes("chrome.tabs?.onUpdated"), "the panel does not update on tab navigation");
  // Host + favicon are untrusted web values: host via textContent, favicon via src (never innerHTML).
  assert(js.includes("hostEl.textContent ="), "the host must be set with textContent");
  assert(js.includes("faviconEl.src = url"), "the favicon must be set via the img src attribute");
});

Deno.test("side panel: a page composer + conversation are bound to the tab, with Continue in hub", () => {
  assert(html.includes('id="page-composer"'), "no page composer");
  assert(html.includes('id="page-history"'), "no page conversation");
  assert(html.includes('id="continue-hub"'), "no Continue-in-hub control");
  // The composer runs a turn keyed to the tab's thread; Continue reopens it in the hub.
  assert(js.includes("runConversationTurn(pageHistory"), "the page composer does not run a conversation turn");
  assert(/ntp\/ntp\.html#thread=/.test(js), "Continue in hub does not reopen the tab's thread");
});

Deno.test("side panel: the Agents picker uses the active-only projection (callable-only over the filtered registry)", () => {
  // The active-only projection for every agent surface (FRESH-PROFILE-TEMPLATE-
  // AGENTS-01): the picker reads the registry, which already excludes disabled
  // templates, and `callable-only` hides any disabled background agent — so the
  // 22 template agents never appear in the side panel's Agents tab.
  const picker = html.match(/<agent-picker\b[^>]*id="agents-picker"[^>]*>/);
  assert(picker, "the Agents picker is missing");
  assert(picker[0].includes("callable-only"), "the Agents picker is not callable-only (templates would appear)");
});
