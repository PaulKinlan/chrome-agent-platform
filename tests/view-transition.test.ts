// @ts-nocheck — minimal harness for synchronous view transition and focus routing.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createViewTransitionRunner,
  focusExplicitRouteTarget,
  shouldSuppressRootCrossfade,
  TASK_VIEW_TRANSITION_CLASS,
  VIEW_ROUTE,
} from "../extension/ntp/view-transition.js";

function harness() {
  let starts = 0;
  const classes = new Set();
  const document = {
    documentElement: {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
    },
    startViewTransition(update) {
      starts += 1;
      update();
      return { finished: Promise.resolve() };
    },
  };
  const run = createViewTransitionRunner({
    document,
    prefersReducedMotion: () => false,
  });
  return {
    classes,
    document,
    run,
    starts: () => starts,
  };
}

Deno.test("route direction suppresses snapshots only across either side of a task boundary", () => {
  const fullViewRoutes = [
    VIEW_ROUTE.HUB,
    VIEW_ROUTE.SETTINGS,
    VIEW_ROUTE.DIRECTORY,
    VIEW_ROUTE.SKILLS,
    VIEW_ROUTE.ARTIFACTS,
  ];
  for (const fullViewRoute of fullViewRoutes) {
    for (
      const [source, target] of [
        [fullViewRoute, VIEW_ROUTE.TASK],
        [VIEW_ROUTE.TASK, fullViewRoute],
      ]
    ) {
      assertEquals(
        shouldSuppressRootCrossfade(source, target),
        true,
        `${source} → ${target} suppresses obsolete root and overlay pixels`,
      );
    }
  }

  for (const source of fullViewRoutes) {
    for (const target of fullViewRoutes) {
      if (source === target) continue;
      assertEquals(
        shouldSuppressRootCrossfade(source, target),
        false,
        `${source} → ${target} retains its normal named cross-fade`,
      );
    }
  }
  assertEquals(
    shouldSuppressRootCrossfade(VIEW_ROUTE.TASK, VIEW_ROUTE.TASK),
    false,
  );
  assertEquals(shouldSuppressRootCrossfade(null, VIEW_ROUTE.TASK), false);
});

Deno.test("view transition runner: applies navigation update immediately without starting view transitions", () => {
  const h = harness();
  let updated = 0;
  let focused = 0;
  const focusTarget = { isConnected: true, focus: () => focused++ };

  const res = h.run(() => updated++, {
    sourceRoute: VIEW_ROUTE.HUB,
    targetRoute: VIEW_ROUTE.TASK,
    focusAfter: focusTarget,
  });

  assertEquals(res, null, "runner returns null for immediate synchronous execution");
  assertEquals(updated, 1, "update runs immediately and synchronously");
  assertEquals(h.starts(), 0, "document.startViewTransition is NOT invoked (no janky transition)");
  assertEquals(focused, 1, "focus is routed synchronously to the destination surface");
});

Deno.test("view transition runner: rapid route switches apply updates synchronously and focus latest target", () => {
  const h = harness();
  let updates = 0;
  let staleFocus = 0;
  let currentFocus = 0;

  h.run(() => updates++, {
    sourceRoute: VIEW_ROUTE.HUB,
    targetRoute: VIEW_ROUTE.TASK,
    focusAfter: { isConnected: true, focus: () => staleFocus++ },
  });

  h.run(() => updates++, {
    sourceRoute: VIEW_ROUTE.TASK,
    targetRoute: VIEW_ROUTE.SETTINGS,
    focusAfter: { isConnected: true, focus: () => currentFocus++ },
  });

  assertEquals(updates, 2, "both route updates run synchronously in order");
  assertEquals(staleFocus, 1, "first route focused on execution");
  assertEquals(currentFocus, 1, "second route focused on execution");
  assertEquals(h.starts(), 0, "no view transitions started");
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

Deno.test("NTP showThreadView keeps follow-ups focus-neutral and explicit agent switches composer-focused", async () => {
  const js = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  assert(
    /function showThreadView\(options = \{\}\)\s*\{[\s\S]*?const focusAfter = Object\.hasOwn\(options, "focusAfter"\)[\s\S]*?: threadTitle;[\s\S]*?if \(!threadView\.hidden\) \{\s*focusExplicitRouteTarget\(options\);\s*return;\s*\}[\s\S]*?withViewTransition\(/
      .test(js),
    "already-open routes return before transitions and focus only an explicit target",
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
