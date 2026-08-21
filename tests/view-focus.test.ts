// Focus-order and focus-return contract for full in-context views.
import { assertEquals } from "jsr:@std/assert@1";
import { createViewFocusController } from "../extension/lib/view-focus.js";

function target(name: string, events: string[]) {
  return {
    name,
    isConnected: true,
    hidden: false,
    inert: false,
    disabled: false,
    parentElement: null,
    style: { display: "block", visibility: "visible" },
    focus() { events.push(`focus:${name}`); },
  };
}

const getStyle = (value: { style: { display: string; visibility: string } }) => value.style;

Deno.test("full view focuses its frame only after the reveal makes it visible", () => {
  const events: string[] = [];
  const trigger = target("directory-trigger", events);
  const frame = target("directory-frame", events);
  const overlay = { hidden: true };
  frame.focus = () => events.push(`focus:directory-frame:visible=${!overlay.hidden}`);
  const focus = createViewFocusController({ getStyle });

  focus.open(trigger, () => {
    events.push("reveal");
    overlay.hidden = false;
  }, frame);

  assertEquals(events, ["reveal", "focus:directory-frame:visible=true"]);
});

Deno.test("closing a full view restores only its still-visible initiating trigger", () => {
  const events: string[] = [];
  const trigger = target("directory-trigger", events);
  const frame = target("directory-frame", events);
  const overlay = { hidden: true };
  const focus = createViewFocusController({ getStyle });

  focus.open(trigger, () => { overlay.hidden = false; }, frame);
  events.length = 0;
  focus.close(() => {
    overlay.hidden = true;
    events.push("hide");
  });
  assertEquals(events, ["hide", "focus:directory-trigger"]);

  focus.open(trigger, () => { overlay.hidden = false; }, frame);
  events.length = 0;
  trigger.isConnected = false;
  focus.close(() => {
    overlay.hidden = true;
    events.push("hide-removed-trigger");
  });
  assertEquals(events, ["hide-removed-trigger"]);
});
