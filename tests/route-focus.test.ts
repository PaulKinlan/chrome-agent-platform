// @ts-nocheck — minimal harness for the synchronous route-update runner and focus routing.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createRouteUpdateRunner,
  focusExplicitRouteTarget,
  VIEW_ROUTE,
} from "../extension/ntp/route-focus.js";

function harness() {
  let focused = 0;
  const run = createRouteUpdateRunner();
  return {
    run,
    focused: () => focused,
    makeTarget: () => ({ isConnected: true, focus: () => (focused += 1) }),
  };
}

Deno.test("route update runner: applies navigation update immediately and synchronously", () => {
  const h = harness();
  let updated = 0;
  let focused = 0;
  const focusTarget = { isConnected: true, focus: () => focused++ };

  const res = h.run(() => updated++, {
    focusAfter: focusTarget,
  });

  assertEquals(res, null, "runner returns null for immediate synchronous execution");
  assertEquals(updated, 1, "update runs immediately and synchronously");
  assertEquals(focused, 1, "focus is routed synchronously to the destination surface");
});

Deno.test("route update runner: rapid route switches apply updates synchronously and focus latest target", () => {
  const h = harness();
  let updates = 0;
  let staleFocus = 0;
  let currentFocus = 0;

  h.run(() => updates++, {
    focusAfter: { isConnected: true, focus: () => staleFocus++ },
  });

  h.run(() => updates++, {
    focusAfter: { isConnected: true, focus: () => currentFocus++ },
  });

  assertEquals(updates, 2, "both route updates run synchronously in order");
  assertEquals(staleFocus, 1, "first route focused on execution");
  assertEquals(currentFocus, 1, "second route focused on execution");
});

Deno.test("explicit route focus distinguishes no-owner, connected, disconnected, and throwing targets", () => {
  let focusedCount = 0;
  const focusTarget = {
    isConnected: true,
    focus: () => {
      focusedCount += 1;
    },
  };

  assertEquals(
    focusExplicitRouteTarget(),
    false,
    "a no-argument route does not acquire focus ownership",
  );
  assertEquals(focusedCount, 0, "a no-argument route focuses nothing");

  assertEquals(
    focusExplicitRouteTarget({ focusAfter: focusTarget }),
    true,
    "an explicit focus disposition owns routing",
  );
  assertEquals(
    focusedCount,
    1,
    "a connected explicit target is focused synchronously",
  );

  let disconnectedFocusCount = 0;
  assertEquals(
    focusExplicitRouteTarget({
      focusAfter: {
        isConnected: false,
        focus: () => {
          disconnectedFocusCount += 1;
        },
      },
    }),
    true,
    "a disconnected target still represents an explicit disposition",
  );
  assertEquals(
    disconnectedFocusCount,
    0,
    "a disconnected target is not focused",
  );

  assertEquals(
    focusExplicitRouteTarget({
      focusAfter: {
        isConnected: true,
        focus: () => {
          throw new Error("focus failed");
        },
      },
    }),
    true,
    "a focus exception is contained without losing explicit ownership",
  );
});

Deno.test("view transitions are fully removed: no transition API or naming remains in the runner or the NTP", async () => {
  const runnerSource = await Deno.readTextFile(
    new URL("../extension/ntp/route-focus.js", import.meta.url),
  );
  const ntpSource = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );
  const ntpHtml = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.html", import.meta.url),
  );

  for (const [name, source] of [["route-focus.js", runnerSource], ["ntp.js", ntpSource], ["ntp.html", ntpHtml]]) {
    assert(
      !/view.?transition/i.test(source),
      `${name} must not mention view transitions at all`,
    );
  }
});

Deno.test("NTP showThreadView keeps follow-ups focus-neutral and explicit agent switches composer-focused", async () => {
  const js = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  assert(
    /function showThreadView\(options = \{\}\)\s*\{[\s\S]*?const focusAfter = Object\.hasOwn\(options, "focusAfter"\)[\s\S]*?: threadTitle;[\s\S]*?if \(!threadView\.hidden\) \{\s*focusExplicitRouteTarget\(options\);\s*return;\s*\}[\s\S]*?runRouteUpdate\(/
      .test(js),
    "already-open routes return before the route update and focus only an explicit target",
  );
  assert(
    /async function runThreadTurn\(text, attachments = \[\], mention = null\)\s*\{[\s\S]*?showThreadView\(\);/
      .test(js),
    "follow-up turns retain the focus-neutral no-argument route",
  );
  assert(
    /async function openThread\(id\)\s*\{[\s\S]*?showThreadView\(\);/
      .test(js),
    "same-thread row opens retain the focus-neutral no-argument route",
  );
  assert(
    /async function openAgentSurface\(\{ kind, id, name \}\)\s*\{[\s\S]*?showThreadView\(\{ focusAfter: threadComposer \}\);/
      .test(js),
    "openAgentSurface explicitly routes focus to threadComposer",
  );
  assert(
    /async function openBackgroundAgentChat\(id, name\)\s*\{[\s\S]*?showThreadView\(\{ focusAfter: threadComposer \}\);/
      .test(js),
    "openBackgroundAgentChat explicitly routes focus to threadComposer",
  );
});
