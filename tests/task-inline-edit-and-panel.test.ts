// tests/task-inline-edit-and-panel.test.ts — Verification of task title inline click-to-edit
// and collapsed panel header vertical position stability
// (CAP-FB-20260823-TASK-INLINE-EDIT-01 & CAP-FB-20260823-COLLAPSED-PANEL-HEADER-01).
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("TASK-INLINE-EDIT: ntp.html has editable-task hover/focus styling and no separate edit button for tasks", async () => {
  const html = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.html", import.meta.url),
  );

  // CSS hover and focus styling for inline editable title
  assert(html.includes("#thread-title.editable-task:hover"), "must have hover styling for editable task title");
  assert(html.includes("#thread-title.editable-task:focus-visible"), "must have focus-visible styling for editable task title");
  assert(html.includes("input.title-edit"), "must style inline input editor");

  // Initial markup structure
  assert(html.includes('id="thread-title" tabindex="-1"'), "thread-title is programmatically focusable");
  assert(html.includes('id="edit-agent" type="button" aria-label="Edit agent" hidden'), "edit-agent button defaults to hidden");
});

Deno.test("TASK-INLINE-EDIT: ntp.js removes separate edit button for tasks and wires click-to-edit inline", async () => {
  const js = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  // In openThread: editAgentBtn is hidden, threadTitle is marked editable
  assert(
    /editAgentBtn\.hidden = true;[\s\S]*?threadTitle\.classList\.add\("editable-task"\);/
      .test(js),
    "openThread must hide editAgentBtn and add editable-task class to threadTitle",
  );

  // In openAgentSurface: editAgentBtn is shown for named agents, threadTitle is NOT editable-task
  assert(
    /editAgentBtn\.hidden = kind !== "named";[\s\S]*?threadTitle\.classList\.remove\("editable-task"\);/
      .test(js),
    "openAgentSurface must show editAgentBtn only for named agents and remove editable-task",
  );

  // In hideThreadViewInner: threadTitle editable state is cleaned up
  assert(
    /threadTitle\.classList\.remove\("editable-task"\);[\s\S]*?threadView\.hidden = true;/
      .test(js),
    "hideThreadViewInner must clean up editable-task class",
  );

  // Keyboard and click event listeners on threadTitle
  assert(
    js.includes('threadTitle.addEventListener("click"') &&
      js.includes('threadTitle.addEventListener("keydown"'),
    "threadTitle must have both click and keydown handlers for inline editing",
  );
});

Deno.test("COLLAPSED-PANEL-HEADER: .brand-row preserves fixed block-size in collapsed state preventing list shift", async () => {
  const html = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.html", import.meta.url),
  );

  // .brand-row maintains 40px block-size
  assert(
    html.includes(".brand-row { display: flex; align-items: center; gap: 6px; block-size: 40px; min-block-size: 40px; flex: 0 0 40px;"),
    "brand-row must maintain consistent 40px block-size",
  );

  // .side.collapsed .brand keeps display: block (with opacity: 0 and visibility: hidden) so height is preserved
  assert(
    html.includes(".side.collapsed .brand { opacity: 0; visibility: hidden; display: block; pointer-events: none; }"),
    "collapsed brand text must preserve layout block height instead of display: none",
  );

  // .side.collapsed .side-section maintains consistent top padding
  assert(
    html.includes(".side.collapsed .side-section { flex-basis: 0; padding-block-start: 6px; }"),
    "collapsed side-section maintains consistent 6px padding-block-start",
  );
});
