// tests/sidepanel-sections-collapse.test.ts — verifies that all sections in the
// side panel are collapsible disclosures (<details> with <summary>) matching the
// Activity section pattern, with smooth chevron rotation, and that harness agents
// share the full-width row vocabulary of the Agents section.

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const root = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFile(new URL(p, root));

const html = await read("./extension/sidepanel/sidepanel.html");
const js = await read("./extension/sidepanel/sidepanel.js");

Deno.test("side panel sections: every section in both views is a collapsible <details>", () => {
  const pageView = html.slice(html.indexOf('id="page-view"'), html.indexOf('id="agents-view"'));
  const agentsView = html.slice(html.indexOf('id="agents-view"'));

  // Page view sections:
  assert(pageView.includes('id="tools-sect"'), "missing tools-sect in page view");
  assert(pageView.includes('id="harness-page-sect"'), "missing harness-page-sect in page view");
  assert(pageView.includes('id="activity-ledger-section"'), "missing activity-ledger-section in page view");
  assert(pageView.includes('id="open-another"'), "missing open-another in page view");

  for (const id of ["tools-sect", "harness-page-sect", "activity-ledger-section", "open-another"]) {
    const at = pageView.indexOf(`id="${id}"`);
    assert(at >= 0, `section #${id} missing`);
    const tagOpen = pageView.lastIndexOf("<", at);
    assertMatch(pageView.slice(tagOpen, at), /^<details\b/, `#${id} is not a <details> element`);
  }

  // Agents view sections:
  for (const id of ["harness-sect", "picker-sect", "tasks-sect"]) {
    const at = agentsView.indexOf(`id="${id}"`);
    assert(at >= 0, `section #${id} missing in agents view`);
    const tagOpen = agentsView.lastIndexOf("<", at);
    assertMatch(agentsView.slice(tagOpen, at), /^<details\b/, `#${id} is not a <details> element`);
  }
});

Deno.test("side panel sections: summaries provide standard chevron and header text", () => {
  // Each details section provides a summary with a rotating chevron
  assertMatch(html, /\.sect-summary\s*\{[^}]*cursor:\s*pointer/, ".sect-summary must be pointer cursor");
  assertMatch(html, /\.sect-summary\s*\{[^}]*user-select:\s*none/, ".sect-summary must be user-select: none");
  assertMatch(html, /\.sect-summary\s*\.chev\s*\{[^}]*transition:\s*transform/, "chevron must rotate with transition");
  assertMatch(html, /details\[open\]\s*>\s*summary\s*\.chev\s*\{[^}]*transform:\s*rotate\(90deg\)/, "open details must rotate chevron 90deg");
});

Deno.test("side panel sections: folded sections collapse content height", () => {
  assertMatch(html, /\.panel-sect:not\(\[open\]\)\s*\{[^}]*padding-bottom:\s*4px/, "folded panel section must reduce padding");
  assertMatch(html, /\.panel-sect\[hidden\]\s*\{\s*display:\s*none;\s*\}/, "hidden panel section must use display:none");
});

Deno.test("side panel: activity ledger section is wired to action-ledger events in sidepanel.js", () => {
  assert(js.includes('document.getElementById("action-ledger")'), "action-ledger element lookup missing in sidepanel.js");
  assert(js.includes('document.getElementById("activity-ledger-section")'), "activity-ledger-section lookup missing in sidepanel.js");
  assert(js.includes('actionLedgerEl.addEventListener("entries-change"'), "entries-change listener missing for activity ledger");
});

Deno.test("side panel: harness agents share row vocabulary with the Agents section", () => {
  // Full-width flex row with min-height >= 40px and border-radius 8px
  assertMatch(html, /\.harness-quick\s*\.hq\s*\{[^}]*width:\s*100%/, ".hq must be a full-width row");
  assertMatch(html, /\.harness-quick\s*\.hq\s*\{[^}]*border-radius:\s*8px/, ".hq must have 8px border-radius like .opt");
  assertMatch(html, /\.harness-quick\s*\.hq\s*\{[^}]*min-height:\s*40px/, ".hq must have accessible min-height");
  // 28px circular avatar container with accent border
  assertMatch(html, /\.harness-quick\s*\.hq\s*\.hq-mark\s*\{[^}]*border-radius:\s*50%/, ".hq-mark must be a circular avatar");
});
