// tests/ntp-sidebar-collapsible.test.ts — pins for bead chrome-agent-platform-5vk4
// Rethink NTP left sidebar: collapsible disclosure sections, Tasks primary flex height,
// human cadence, and clean collapsed rail.

import { assert, assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatCadenceMinutes } from "../extension/lib/next-run-label.js";

const ROOT = new URL("../", import.meta.url).pathname;

Deno.test("5vk4: human cadence formatting in sidebar agent subtitle", () => {
  assertEquals(formatCadenceMinutes(1440), "daily");
  assertEquals(formatCadenceMinutes(60), "hourly");
  assertEquals(formatCadenceMinutes(360), "every 6 hours");
  assertEquals(formatCadenceMinutes(10080), "weekly");
});

Deno.test("5vk4: sidebar collapsible disclosure sections and markup in ntp.html", async () => {
  const html = await Deno.readTextFile(`${ROOT}/extension/ntp/ntp.html`);

  // Verify all 6 required sections exist as <details class="...side-disclosure...">
  const requiredDisclosures = [
    "tasks-section",
    "failed-runs",
    "harness-presence",
    "board-strip",
    "agents-section",
    "activity-section",
  ];

  for (const id of requiredDisclosures) {
    const regex = new RegExp(`<details[^>]*id="${id}"[^>]*class="[^"]*side-disclosure[^"]*"|<details[^>]*class="[^"]*side-disclosure[^"]*"[^>]*id="${id}"`, "s");
    assert(regex.test(html), `element #${id} must be a <details> with side-disclosure class`);
    // Each disclosure must have a <summary> child
    const summaryMatch = new RegExp(`<details[^>]*id="${id}"[\\s\\S]*?<summary|<details[^>]*class="[^"]*"[^>]*id="${id}"[\\s\\S]*?<summary`, "s");
    assert(summaryMatch.test(html), `<details id="${id}"> must contain a <summary> element`);
  }

  // Tasks section is open by default and primary
  assert(/<details[^>]*id="tasks-section"[^>]*\bopen\b/.test(html), "#tasks-section must have 'open' attribute by default");
  assert(html.includes('id="tasks-count"'), "#tasks-count badge must exist in tasks summary");
  assert(html.includes('id="tasks-list"'), "#tasks-list container must exist");

  // Tasks primary flex height rules
  assert(
    /#tasks-section\[open\]\s*\{[^}]*flex:\s*1\s+1\s+220px/s.test(html) ||
    /#tasks-section\[open\]\s*\{[^}]*min-height:\s*160px/s.test(html),
    "#tasks-section[open] must have flex: 1 1 220px or min-height: 160px",
  );

  // Failed runs disclosure
  assert(html.includes('id="failed-runs-count"'), "#failed-runs-count must exist");
  assert(html.includes('id="failed-runs-clear"'), "#failed-runs-clear must exist");
  assert(html.includes('id="failed-runs-list"'), "#failed-runs-list must exist");

  // Harness disclosure
  assert(html.includes('id="harness-list"'), "#harness-list must exist");

  // Board disclosure
  assert(html.includes('id="board-count"'), "#board-count must exist");
  assert(html.includes('id="board-list"'), "#board-list must exist");

  // Agents disclosure
  assert(/<details[^>]*id="agents-section"[^>]*\bopen\b/.test(html), "#agents-section must have 'open' attribute by default");
  assert(html.includes('id="agents-count"'), "#agents-count must exist");
  assert(html.includes('id="agents-list"'), "#agents-list must exist");

  // Activity disclosure
  assert(html.includes('id="activity-count"'), "#activity-count must exist");
  assert(html.includes('id="activity-list"'), "#activity-list must exist");
});

Deno.test("5vk4: sidebar collapse toggle moved to top header bar and clean 56px rail", async () => {
  const html = await Deno.readTextFile(`${ROOT}/extension/ntp/ntp.html`);

  // #side-toggle must be inside .side (not a trailing sibling after </aside>)
  const sideIndex = html.indexOf('<aside class="side" id="side"');
  const sideEndIndex = html.indexOf("</aside>");
  const toggleIndex = html.indexOf('id="side-toggle"');

  assert(sideIndex !== -1, "#side must exist");
  assert(sideEndIndex !== -1, "</aside> must exist");
  assert(toggleIndex !== -1, "#side-toggle must exist");
  assert(
    toggleIndex > sideIndex && toggleIndex < sideEndIndex,
    "#side-toggle must be inside <aside class=\"side\" id=\"side\">, not a trailing floating nub sibling",
  );

  // .side-top must wrap .brand and #side-toggle
  assert(html.includes("side-top"), ".side-top container must exist");

  // Zero text/card bleed in .side.collapsed:
  // All section bodies/cards hidden via display: none !important
  assert(
    /\.side\.collapsed\s+[^}]*#(?:board-strip|tasks-list|harness-presence|failed-runs|agents-section)[^}]*display:\s*none\s*!important/s.test(html) ||
    /\.side\.collapsed\s+#board-strip[^{]*\{\s*display:\s*none\s*!important;/s.test(html),
    "#board-strip must have display: none !important when .side.collapsed",
  );
  assert(
    /\.side\.collapsed\s+[^}]*#tasks-list[^}]*display:\s*none\s*!important/s.test(html) ||
    /\.side\.collapsed\s+#tasks-list[^{]*\{\s*display:\s*none\s*!important;/s.test(html),
    "#tasks-list must have display: none !important when .side.collapsed",
  );
  assert(
    /\.side\.collapsed\s+[^}]*#harness-presence[^}]*display:\s*none\s*!important/s.test(html) ||
    /\.side\.collapsed\s+#harness-presence[^{]*\{\s*display:\s*none\s*!important;/s.test(html),
    "#harness-presence must have display: none !important when .side.collapsed",
  );
  assert(
    /\.side\.collapsed\s+[^}]*#failed-runs[^}]*display:\s*none\s*!important/s.test(html) ||
    /\.side\.collapsed\s+#failed-runs[^{]*\{\s*display:\s*none\s*!important;/s.test(html),
    "#failed-runs must have display: none !important when .side.collapsed",
  );

  // In .side.collapsed, width must be 56px
  assert(
    /\.side\.collapsed\s*\{[^}]*(?:inline-size\s*:\s*56px|width\s*:\s*56px)/s.test(html),
    ".side.collapsed must have inline-size: 56px or width: 56px",
  );
});

Deno.test("5vk4: action button stopPropagation in ntp.js", async () => {
  const ntpJs = await Deno.readTextFile(`${ROOT}/extension/ntp/ntp.js`);

  // #new-task click listener must call e.stopPropagation()
  assert(
    /document\.getElementById\("new-task"\)\??\.addEventListener\("click",\s*\((?:e|event)\)\s*=>\s*\{\s*(?:e|event)\.stopPropagation\(\)/s.test(ntpJs) ||
    /new-task[\s\S]{0,100}stopPropagation/.test(ntpJs),
    "#new-task click listener must call stopPropagation() so the details disclosure doesn't toggle",
  );

  // #new-agent click listener must call e.stopPropagation()
  assert(
    /document\.getElementById\("new-agent"\)\??\.addEventListener\("click",\s*\((?:e|event)\)\s*=>\s*\{\s*(?:e|event)\.stopPropagation\(\)/s.test(ntpJs) ||
    /new-agent[\s\S]{0,100}stopPropagation/.test(ntpJs),
    "#new-agent click listener must call stopPropagation()",
  );

  // ntp.js must import and use formatCadenceMinutes
  assert(
    ntpJs.includes("formatCadenceMinutes"),
    "ntp.js must import formatCadenceMinutes to format agent cadence",
  );

  // ntp.js must persist side disclosures in localStorage under cap:ntp:side-disclosures
  assert(
    ntpJs.includes("cap:ntp:side-disclosures"),
    "ntp.js must persist disclosure states under 'cap:ntp:side-disclosures'",
  );
});

Deno.test("5vk4: sidebar disclosure state resolution and defaults", () => {
  // Pure logic test for sidebar disclosure state:
  // - tasks-section: default open
  // - agents-section: default open
  // - board-strip: default closed
  // - harness-presence: default closed
  // - activity-section: default closed
  // - failed-runs: default closed
  function resolveDisclosureState(
    sectionId: string,
    persistedState: Record<string, boolean> | null = null,
  ): boolean {
    if (persistedState && typeof persistedState[sectionId] === "boolean") {
      return persistedState[sectionId];
    }

    switch (sectionId) {
      case "tasks-section":
      case "agents-section":
        return true;
      case "board-strip":
      case "harness-presence":
      case "activity-section":
      case "failed-runs":
        return false;
      default:
        return false;
    }
  }

  // Defaults without persisted state
  assertEquals(resolveDisclosureState("tasks-section"), true);
  assertEquals(resolveDisclosureState("agents-section"), true);
  assertEquals(resolveDisclosureState("harness-presence"), false);
  assertEquals(resolveDisclosureState("activity-section"), false);
  assertEquals(resolveDisclosureState("board-strip"), false);
  assertEquals(resolveDisclosureState("failed-runs"), false);

  // Persisted state overrides defaults
  const persisted = {
    "tasks-section": false,
    "board-strip": true,
    "harness-presence": true,
  };
  assertEquals(resolveDisclosureState("tasks-section", persisted), false);
  assertEquals(resolveDisclosureState("board-strip", persisted), true);
  assertEquals(resolveDisclosureState("harness-presence", persisted), true);
  assertEquals(resolveDisclosureState("agents-section", persisted), true); // not in persisted, falls back to default
});

Deno.test("5vk4: brand text and toggle dimensions in .side-top avoid text clipping", async () => {
  const html = await Deno.readTextFile(`${ROOT}/extension/ntp/ntp.html`);

  // .side-top gap must be 4px
  assert(/\.side-top\s*\{[^}]*gap:\s*4px/s.test(html), ".side-top must declare gap: 4px");

  // .side-top .brand must be 13px font-size with -0.01em letter-spacing and white-space nowrap
  assert(
    /\.side-top\s+\.brand\s*\{[^}]*font-size:\s*13px/s.test(html) &&
    /\.side-top\s+\.brand\s*\{[^}]*letter-spacing:\s*-0\.01em/s.test(html),
    ".side-top .brand must specify font-size: 13px and letter-spacing: -0.01em to prevent clipping",
  );

  // .side:not(.collapsed) #side-toggle must be 28px x 28px
  assert(
    /\.side:not\(\.collapsed\)\s+(?:#side-toggle|\.side-toggle)\s*\{[^}]*width:\s*28px/s.test(html) &&
    /\.side:not\(\.collapsed\)\s+(?:#side-toggle|\.side-toggle)\s*\{[^}]*height:\s*28px/s.test(html),
    ".side:not(.collapsed) #side-toggle must be 28x28px",
  );

  // .side.collapsed #side-toggle remains 36px x 36px
  assert(
    /\.side\.collapsed\s+(?:#side-toggle|\.side-toggle)\s*\{[^}]*width:\s*36px/s.test(html),
    ".side.collapsed #side-toggle must remain 36x36px",
  );
});

Deno.test("5vk4: side disclosure summary min-height, inner list bounds, and centered collapsed rail", async () => {
  const html = await Deno.readTextFile(`${ROOT}/extension/ntp/ntp.html`);

  // Closed disclosures cannot shrink and summary headers have min-height: 34px
  assert(
    /details\.side-disclosure:not\(\[open\]\)\s*\{[^}]*flex:\s*0\s+0\s+auto\s*!important/s.test(html),
    "details.side-disclosure:not([open]) must have flex: 0 0 auto !important",
  );
  assert(
    /\.side-disclosure\s*>\s*summary\s*\{[^}]*min-height:\s*34px/s.test(html) ||
    /\.side-head\s*\{[^}]*min-height:\s*34px/s.test(html),
    "Summary and side-head must have min-height: 34px",
  );

  // Secondary disclosure inner list max-heights
  assert(/\.fr-list\s*\{[^}]*max-height:\s*120px/s.test(html), ".fr-list must have max-height: 120px");
  assert(/\.bs-list\s*\{[^}]*max-height:\s*120px/s.test(html), ".bs-list must have max-height: 120px");
  assert(/\.agents-list[^{]*\{[^}]*max-height:\s*150px/s.test(html), ".agents-list must have max-height: 150px");
  assert(/\.activity-list\s*\{[^}]*max-height:\s*160px/s.test(html), ".activity-list must have max-height: 160px");

  // .side.collapsed centering
  assert(
    /\.side\.collapsed\s*\{[^}]*padding:\s*12px\s+9px/s.test(html),
    ".side.collapsed must have padding: 12px 9px",
  );
  assert(
    /\.side\.collapsed\s*\{[^}]*align-items:\s*center/s.test(html),
    ".side.collapsed must have align-items: center",
  );
  assert(
    /\.side\.collapsed\s+\.side-foot\s*\{[^}]*align-items:\s*center/s.test(html),
    ".side.collapsed .side-foot must have align-items: center",
  );
});


