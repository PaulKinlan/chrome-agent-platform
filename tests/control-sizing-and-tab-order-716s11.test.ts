// tests/control-sizing-and-tab-order-716s11.test.ts
// Unit tests for bead chrome-agent-platform-716s.11:
// 1. Touch/hit target floor (>= 36px for primary controls, >= 32px for secondary chips/buttons,
//    switches 40x24 with >= 24x24 hit area, links >= 24px hit area).
// 2. #side-toggle focus-visible outline ring and uninterrupted Tab keyboard advancement.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

Deno.test("716s.11: SwitchToggle in components.js and .switch in theme.css are 40x24 with 18x18 knob", async () => {
  const compSrc = await Deno.readTextFile(`${ROOT}/extension/shared/components.js`);
  const themeSrc = await Deno.readTextFile(`${ROOT}/extension/shared/theme.css`);

  // SwitchToggle component in components.js
  assert(
    /\.sw\s*\{[^}]*width\s*:\s*40px;[^}]*height\s*:\s*24px/s.test(compSrc),
    "SwitchToggle .sw must be width:40px and height:24px (was 36x20)",
  );
  assert(
    /\.sw::after\s*\{[^}]*width\s*:\s*18px;[^}]*height\s*:\s*18px/s.test(compSrc),
    "SwitchToggle .sw::after knob must be 18x18px (was 14x14)",
  );
  assert(
    /\.sw\[aria-checked="true"\]::after\s*\{[^}]*transform\s*:\s*translateX\(16px\)/s.test(compSrc),
    "SwitchToggle checked knob must translateX 16px to balance 2px margin",
  );

  // .switch in theme.css
  assert(
    /\.switch\s*\{[^}]*width\s*:\s*40px;[^}]*height\s*:\s*24px/s.test(themeSrc),
    ".switch in theme.css must be width:40px and height:24px (was 36x20)",
  );
  assert(
    /\.switch::after\s*\{[^}]*width\s*:\s*18px;[^}]*height\s*:\s*18px/s.test(themeSrc),
    ".switch::after in theme.css must be 18x18px (was 14x14)",
  );
});

Deno.test("716s.11: Hub sidebar controls meet hit target floor (new-task, delete, harnesses, provider status)", async () => {
  const ntpSrc = await Deno.readTextFile(`${ROOT}/extension/ntp/ntp.html`);

  // .harness-list button: 36px tall
  assert(
    /\.harness-list\s+button\s*\{[^}]*min-height\s*:\s*36px/s.test(ntpSrc),
    ".harness-list button must have min-height: 36px (was 29px tall)",
  );

  // .new-task (for #new-task and #new-agent): >= 32px
  assert(
    /\.new-task\s*\{[^}]*(?:inline-size\s*:\s*32px|min-width\s*:\s*32px)[^}]*(?:block-size\s*:\s*32px|min-height\s*:\s*32px)/s.test(ntpSrc),
    ".new-task must be at least 32x32px (was 28x28)",
  );

  // .thread-item .t-delete: >= 32px
  assert(
    /\.thread-item\s+\.t-delete\s*\{[^}]*(?:inline-size\s*:\s*32px|min-width\s*:\s*32px)[^}]*(?:block-size\s*:\s*32px|min-height\s*:\s*32px)/s.test(ntpSrc),
    ".thread-item .t-delete must be at least 32x32px (was 28x28)",
  );

  // .provider-status: >= 32px
  assert(
    /\.provider-status\s*\{[^}]*min-height\s*:\s*32px/s.test(ntpSrc),
    ".provider-status must have min-height: 32px (was 25px)",
  );

  // .failed-runs .fr-retry and .fr-dismiss: >= 32px
  assert(
    /\.failed-runs\s+\.fr-retry\s*\{[^}]*min-height\s*:\s*32px/s.test(ntpSrc),
    ".failed-runs .fr-retry must have min-height: 32px",
  );
  assert(
    /\.failed-runs\s+\.fr-dismiss\s*\{[^}]*(?:height\s*:\s*32px|min-height\s*:\s*32px)/s.test(ntpSrc),
    ".failed-runs .fr-dismiss must be at least 32px tall (was 20px)",
  );

  // .chip-action: >= 32px
  assert(
    /\.chip-action\s*\{[^}]*(?:height\s*:\s*32px|min-height\s*:\s*32px)/s.test(ntpSrc),
    ".chip-action must be at least 32px tall (was 22px)",
  );
});

Deno.test("716s.11: #side-toggle focus-visible outline ring and Tab navigation keydown handler", async () => {
  const ntpHtml = await Deno.readTextFile(`${ROOT}/extension/ntp/ntp.html`);
  const ntpJs = await Deno.readTextFile(`${ROOT}/extension/ntp/ntp.js`);

  // Focus ring: no outline:none on .side-toggle:focus-visible
  assert(
    !/\.side-toggle:focus-visible\s*\{\s*outline\s*:\s*none;\s*\}/.test(ntpHtml),
    ".side-toggle:focus-visible must not suppress outline with outline:none",
  );
  assert(
    /\.side-toggle:focus-visible\s*\{[^}]*outline\s*:\s*2px\s+solid/s.test(ntpHtml),
    ".side-toggle:focus-visible must provide a standard outline ring",
  );

  // Tab keydown handler in ntp.js: advances from sideToggle without body stop
  assert(
    /sideToggle\??\.addEventListener\(\s*["']keydown["']/s.test(ntpJs) &&
      ntpJs.includes('event.key === "Tab"') &&
      ntpJs.includes("event.preventDefault()"),
    "sideToggle must have a keydown listener for Tab that prevents default to cycle cleanly to composer",
  );
});

Deno.test("716s.11: Options page controls meet hit target floor (get-key, small buttons, links)", async () => {
  const optsCss = await Deno.readTextFile(`${ROOT}/extension/options/options.css`);

  // .get-key link: min-height: 24px
  assert(
    /\.get-key\s*\{[^}]*min-height\s*:\s*24px/s.test(optsCss),
    ".get-key link must have min-height: 24px (was 19px tall)",
  );

  // .btn.small: min-height: 32px (was 30px)
  assert(
    /\.btn\.small\s*\{[^}]*(?:height\s*:\s*32px|min-height\s*:\s*32px)/s.test(optsCss),
    ".btn.small must be at least 32px tall (was 30px)",
  );

  // Privacy and changelog links in options
  assert(
    /\.privacy-link\s+a[^}]*min-height\s*:\s*24px/s.test(optsCss) &&
      /\.changelog-full-link\s+a[^}]*min-height\s*:\s*24px/s.test(optsCss),
    ".privacy-link a and .changelog-full-link a must have min-height: 24px (were ~16-17px)",
  );
});

Deno.test("716s.11: Sidepanel interactive controls meet hit target floor", async () => {
  const spHtml = await Deno.readTextFile(`${ROOT}/extension/sidepanel/sidepanel.html`);

  // .harness-quick .hq: min-height: 32px
  assert(
    /\.harness-quick\s+\.hq\s*\{[^}]*min-height\s*:\s*32px/s.test(spHtml),
    ".harness-quick .hq chips must have min-height: 32px",
  );

  // .enable-site-tools-btn: min-height: 32px
  assert(
    /\.enable-site-tools-btn\s*\{[^}]*min-height\s*:\s*32px/s.test(spHtml),
    ".enable-site-tools-btn must have min-height: 32px",
  );

  // .tool-chip: min-height: 32px
  assert(
    /\.tool-chip\s*\{[^}]*min-height\s*:\s*32px/s.test(spHtml),
    ".tool-chip must have min-height: 32px",
  );

  // .agent-permissions-action: min-height: 32px
  assert(
    /\.agent-permissions-action\s*\{[^}]*min-height\s*:\s*32px/s.test(spHtml),
    ".agent-permissions-action must have min-height: 32px",
  );
});

Deno.test("716s.11: Shared components meet hit target floor", async () => {
  const compSrc = await Deno.readTextFile(`${ROOT}/extension/shared/components.js`);

  // agent-composer chips: min-height: 32px
  assert(
    /agent-composer\s+\.composer\s+\.chips\s+\.chip\s*\{[^}]*min-height\s*:\s*32px/s.test(compSrc),
    "composer chips must have min-height: 32px",
  );

  // CapabilityRow .run, .open, .delete: min-height: 32px
  assert(
    /\.row\s*\{[^}]*\}\s*\.row:last-child[^}]*\}\s*\.row\.clickable/s.test(compSrc) ||
      /\.open\s*\{[^}]*min-height\s*:\s*32px/s.test(compSrc),
    "CapabilityRow actions must have min-height: 32px",
  );

  // ArtifactCard .actions button: min-height: 32px
  assert(
    /\.actions\s+button\s*\{[^}]*min-height\s*:\s*32px/s.test(compSrc),
    "ArtifactCard .actions button must have min-height: 32px",
  );

  // ActionLedger .al-undo and .al-retry: min-height: 32px
  assert(
    /\.al-undo\s*\{[^}]*min-height\s*:\s*32px/s.test(compSrc) &&
      /\.al-retry\s*\{[^}]*min-height\s*:\s*32px/s.test(compSrc),
    "ActionLedger .al-undo and .al-retry must have min-height: 32px",
  );
});
