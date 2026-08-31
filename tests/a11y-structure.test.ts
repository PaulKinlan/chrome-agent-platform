// a11y-structure.test.ts — UX-AUDIT-2026-08-28 UX-006/UX-007 regression pins.
// The axe audit found: aria-allowed-attr on the composer textarea
// (aria-expanded on a plain textarea), aria-pressed on role=switch buttons,
// duplicate "Tasks" landmark names on the NTP, non-focusable scrollable
// regions, no <main> on sidepanel/artifact, and no level-one heading on the
// NTP/sidepanel. These pins hold the structure that the axe KAT
// (scripts/axe-audit.ts, live-browser zero-violation gate) verified.

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";


const read = (p: string) =>
  Deno.readTextFile(new URL(p, new URL("../", import.meta.url)));

Deno.test("a11y: every primary surface has exactly one main landmark", async () => {
  for (const f of [
    "./extension/ntp/ntp.html",
    "./extension/options/options.html",
    "./extension/sidepanel/sidepanel.html",
    "./extension/artifact/artifact.html",
  ]) {
    const html = await read(f);
    const mains = html.match(/<main\b/g)?.length ?? 0;
    assert(mains === 1, `${f}: expected exactly 1 <main>, found ${mains}`);
  }
});

Deno.test("a11y: ntp + sidepanel have a level-one heading (UX-007)", async () => {
  for (const f of ["./extension/ntp/ntp.html", "./extension/sidepanel/sidepanel.html"]) {
    const html = await read(f);
    assert(/<h1\b/.test(html), `${f}: no <h1> found`);
  }
});

Deno.test("a11y: the composer textarea is a textbox-with-popup (CAP-FB-20260830-SLASH-PALETTE-COMBOBOX-01)", async () => {
  const js = await read("./extension/shared/components.js");
  const m = js.match(/<textarea id="task-input"[^>]*>/);
  assert(m, "task-input textarea not found");
  // The multiline textarea KEEPS textbox semantics — the ARIA 1.2 combobox
  // role is reserved for single-line inputs, so a multiline editable combo is
  // expressed as a textbox-with-popup: aria-haspopup + aria-expanded +
  // aria-controls naming the listbox, with aria-activedescendant set by JS
  // only while a palette is open and removed on hide.
  assert(!/role="combobox"/.test(m[0]), "multiline textarea must not carry role=combobox");
  assert(/aria-haspopup="listbox"/.test(m[0]), "textarea lacks aria-haspopup=listbox");
  assert(/aria-expanded="false"/.test(m[0]), "textarea lacks aria-expanded=false (closed state)");
  assert(/aria-controls="popup-\$\{this\._uid\}"/.test(m[0]), "textarea lacks aria-controls naming the popup");
  assert(!/aria-activedescendant=/.test(m[0]), "textarea must not hard-code aria-activedescendant (it is set by JS while open)");
  // and no other JS path may re-add the expanded state to the input.
  const toggles = js.match(/_input\?\.setAttribute\("aria-expanded"/g) ?? [];
  assert(toggles.length > 0, "JS never toggles aria-expanded on the input");
  // The hide path must REMOVE the active descendant (no stale name after close).
  assert(/removeAttribute\("aria-activedescendant"\)/.test(js), "hide path does not clear aria-activedescendant");
  // The slash-picker path mirrors the picker's highlight onto the textarea.
  assert(/aria-controls", "ap-list"/.test(js), "slash picker does not point controls at ap-list");
});

Deno.test("a11y: role=switch never carries aria-pressed (aria-allowed-attr)", async () => {
  const js = await read("./extension/shared/components.js");
  const switches = js.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
  assert(switches.length > 0, "no switch buttons found (template drifted?)");
  for (const s of switches) {
    assert(!/aria-pressed/.test(s), `switch carries aria-pressed: ${s.slice(0, 120)}`);
  }
});

Deno.test("a11y: scrollable side lists are keyboard-focusable", async () => {
  const html = await read("./extension/ntp/ntp.html");
  for (const id of ["thread-sidebar", "side-agents"]) {
    const m = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
    assert(m, `#${id} not found`);
    assert(/\stabindex="0"/.test(m[0]), `#${id} lacks tabindex="0"`);
  }
});

Deno.test("a11y: sidebar landmark names are unique (aside vs regions)", async () => {
  const html = await read("./extension/ntp/ntp.html");
  const aside = html.match(/<aside[^>]*aria-label="([^"]*)"/);
  assert(aside, "no labelled aside");
  assert(aside[1] !== "Tasks", "aside label collides with the Tasks region");
});

Deno.test("a11y: theme.css ships the visually-hidden utility", async () => {
  const css = await read("./extension/shared/theme.css");
  assert(/\.visually-hidden/.test(css), "no .visually-hidden utility");
});

// nested-interactive: a focusable role=button row that CONTAINS real buttons
// makes child activation ambiguous under the keyboard (Enter on Delete also
// opened the row). The row must be a non-interactive wrapper and the open
// affordance an explicit button that is a SIBLING of Retry/Delete.
Deno.test("a11y: ntp task rows are non-interactive wrappers with an explicit open button", async () => {
  const js = await read("./extension/ntp/ntp.js");
  const m = js.match(/function renderTaskRows[\s\S]*?\n}/);
  assert(m, "renderTaskRows not found");
  const fn = m[0];
  assert(!/item\.setAttribute\("role", "button"\)/.test(fn), "thread-item is still a role=button");
  assert(!/item\.tabIndex/.test(fn), "thread-item is still tabbable");
  assert(!/item\.addEventListener\("keydown"/.test(fn), "thread-item still forwards keydown");
  assert(!/item\.addEventListener\("click"/.test(fn), "thread-item still has a row-level click handler");
  assert(/className = "t-open"/.test(fn), "no explicit .t-open open button");
  assert(/open\.type = "button"/.test(fn), ".t-open is not a real button");
});

Deno.test("a11y: <task-row> row is not a focusable button; open is an explicit sibling button", async () => {
  const js = await read("./extension/shared/components.js");
  // Slice to the TaskRow region — other components share class/template names.
  const start = js.indexOf("class TaskRow");
  const end = js.indexOf("customElements.define(\"task-row\"");
  assert(start > -1 && end > start, "TaskRow region not found");
  const region = js.slice(start, end);
  const m = region.match(/`<div class="row"[^>]*>[\s\S]*?<\/div>`\);/);
  assert(m, "task-row template not found");
  const tpl = m[0];
  assert(!/role="button"/.test(tpl), "task-row .row is still role=button");
  assert(!/tabindex/.test(tpl), "task-row .row is still tabbable");
  assert(/class="row-open"/.test(tpl), "no explicit .row-open button");
  const wire = region.match(/_wire\(\) \{[\s\S]*?\n  \}/);
  assert(wire, "TaskRow._wire not found");
  assert(!/\.row"\)\?\.addEventListener\("keydown"/.test(wire[0]), "_wire still forwards row keydown");
  assert(/"\.row-open"\)\?\.addEventListener\("click"/.test(wire[0]), "_wire does not open via .row-open");
});
