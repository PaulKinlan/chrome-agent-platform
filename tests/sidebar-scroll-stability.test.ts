// tests/sidebar-scroll-stability.test.ts
// Verifies left sidebar and Settings menu scroll vibration fixes on NTP and Settings surfaces.
// Bead: chrome-agent-platform-kxz9d

import { assert, assertEquals } from "jsr:@std/assert@1";

const ntpHtml = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
const optionsCss = await Deno.readTextFile(new URL("../extension/options/options.css", import.meta.url));

Deno.test("NTP sidebar: decoupled from document scroll via position: fixed and body padding", () => {
  // Extract .side rule from ntp.html
  const sideMatch = ntpHtml.match(/\.side\s*\{([^}]*)\}/);
  assert(sideMatch, "ntp.html must have a .side rule");
  const sideRule = sideMatch[1];

  assert(!sideRule.includes("position: sticky"), "ntp.html .side must NOT use position: sticky");
  assert(sideRule.includes("position: fixed"), "ntp.html .side must use position: fixed");
  assert(sideRule.includes("inset-block-start: 0"), "ntp.html .side must have inset-block-start: 0");
  assert(sideRule.includes("inset-inline-start: 0"), "ntp.html .side must have inset-inline-start: 0");
  assert(sideRule.includes("block-size: 100vh"), "ntp.html .side must have block-size: 100vh");
  assert(sideRule.includes("backface-visibility: hidden"), "ntp.html .side must have backface-visibility: hidden");
  assert(sideRule.includes("transform: translateZ(0)"), "ntp.html .side must have transform: translateZ(0)");

  // Body padding-inline-start reservations
  const bodyMatch = ntpHtml.match(/body\s*\{([^}]*)\}/);
  assert(bodyMatch, "ntp.html must have a body rule");
  const bodyRule = bodyMatch[1];
  assert(bodyRule.includes("padding-inline-start: 240px"), "ntp.html body must reserve 240px padding-inline-start");
  assert(bodyRule.includes("box-sizing: border-box"), "ntp.html body must declare box-sizing: border-box");

  // Collapsed body reservation
  assert(
    /body:has\(>\s*\.side\.collapsed\)\s*\{[^}]*padding-inline-start:\s*56px;/.test(ntpHtml),
    "ntp.html must set body padding-inline-start: 56px when .side.collapsed",
  );

  // Narrow viewport reservation under 600px
  const narrowMatch = ntpHtml.match(/@media\s*\(max-width:\s*599\.98px\)\s*\{([\s\S]*?)(?=\n\s*@media|\n\s*\.side-top|\n\s*\/[/*])/);
  assert(narrowMatch, "ntp.html must have @media (max-width: 599.98px) block");
  assert(
    narrowMatch[1].includes("padding-inline-start: 56px"),
    "ntp.html @media (max-width: 599.98px) must reserve body padding-inline-start: 56px",
  );
});

Deno.test("Settings menu: desktop standalone/iframe decoupled via position: fixed and options-shell reservation", () => {
  // Desktop options-shell padding reservation
  const shellMatch = optionsCss.match(/\.options-shell\s*\{([^}]*)\}/);
  assert(shellMatch, "options.css must have .options-shell rule");
  const shellRule = shellMatch[1];
  assert(shellRule.includes("padding-inline: var(--content-gutter);"), "options-shell must keep padding-inline: var(--content-gutter)");
  assert(
    shellRule.includes("padding-inline-start: calc(var(--content-gutter) + 240px);"),
    "options-shell must reserve padding-inline-start: calc(var(--content-gutter) + 240px)",
  );

  // Desktop .side rule
  const sideMatch = optionsCss.match(/\.side\s*\{([^}]*)\}/);
  assert(sideMatch, "options.css must have .side rule");
  const sideRule = sideMatch[1];
  assert(!sideRule.includes("position: sticky"), "options.css .side must NOT use position: sticky");
  assert(sideRule.includes("position: fixed"), "options.css .side must use position: fixed");
  assert(
    sideRule.includes("inset-inline-start: calc(max(0px, (100% - var(--content-max)) / 2) + var(--content-gutter));"),
    "options.css .side must position inset-inline-start to match centered options-shell",
  );
  assert(sideRule.includes("backface-visibility: hidden"), "options.css .side must have backface-visibility: hidden");
  assert(sideRule.includes("transform: translateZ(0)"), "options.css .side must have transform: translateZ(0)");
});

Deno.test("Hub-hosted #settings-view: desktop layout keeps .side outside .content scroll container", () => {
  // Check ntp.html has .view-client-host:has(> #settings-view:not([hidden])) overflow: hidden
  assert(
    /\.view-client-host:has\(>\s*#settings-view:not\(\[hidden\]\)\)\s*\{[^}]*overflow:\s*hidden;/.test(ntpHtml),
    "ntp.html must set overflow: hidden on view-client-host when #settings-view is visible",
  );

  // Inside @scope (#settings-view, ...), :scope#settings-view matches the root #settings-view
  assert(
    /:scope#settings-view\s+\.options-shell\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s.test(optionsCss),
    ":scope#settings-view .options-shell must set min-height: 0 and overflow: hidden",
  );
  assert(
    /:scope#settings-view\s+\.side\s*\{[^}]*position:\s*relative;/s.test(optionsCss),
    ":scope#settings-view .side must use position: relative",
  );
  assert(
    /:scope#settings-view\s+\.content\s*\{[^}]*overflow-y:\s*auto;/s.test(optionsCss),
    ":scope#settings-view .content must own overflow-y: auto",
  );
  const contentMatch = optionsCss.match(/\.content\s*\{([^}]*)\}/);
  assert(contentMatch && contentMatch[1].includes("display: block"), "options.css .content must declare display: block so ntp.html .content flex does not shrink children");
});

Deno.test("Settings responsive layout: @media (max-width: 680px) resets .side and .options-shell", () => {
  const marker = "/* Settings also renders inside the NTP's covered-view iframe.";
  const start = optionsCss.indexOf(marker);
  assert(start > -1, "narrow Settings marker exists");
  const narrow = optionsCss.slice(start);

  const narrowSide = narrow.match(/\.side\s*\{([^}]*)\}/);
  assert(narrowSide, "narrow .side rule exists");
  assert(narrowSide[1].includes("position: static"), "narrow .side must have position: static");

  const narrowShell = narrow.match(/\.options-shell\s*\{([^}]*)\}/);
  assert(narrowShell, "narrow .options-shell rule exists");
  assert(narrowShell[1].includes("padding-inline: var(--content-gutter)"), "narrow .options-shell must reset padding-inline");

  // Confirm no clipping / hiding overflow in narrow adaptation
  assertEquals(
    /overflow\s*:\s*(?:hidden|clip)/.test(narrow),
    false,
    "narrow adaptation must reflow rather than clip",
  );
});

Deno.test("Active panel nested section guard: .panel.active section has content-visibility: visible", () => {
  assert(
    optionsCss.includes(".panel.active section"),
    "options.css must include .panel.active section in content-visibility: visible override",
  );
});
