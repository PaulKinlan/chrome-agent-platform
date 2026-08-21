// @ts-nocheck — the DOM/ViewTransition mocks intentionally expose a minimal shape.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createViewTransitionRunner,
  shouldSuppressRootCrossfade,
  TASK_VIEW_TRANSITION_CLASS,
  VIEW_ROUTE,
} from "../extension/ntp/view-transition.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(
  {
    reduced = false,
    throws = false,
    throwsAfterUpdate = false,
    supported = true,
  } = {},
) {
  const classes = new Set();
  const classesAtStart = [];
  const finished = deferred();
  let starts = 0;
  const document = {
    documentElement: {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
    },
    startViewTransition(update) {
      starts += 1;
      classesAtStart.push(new Set(classes));
      if (throws) throw new Error("snapshot failed");
      update();
      if (throwsAfterUpdate) throw new Error("snapshot failed after update");
      return { finished: finished.promise };
    },
  };
  if (!supported) delete document.startViewTransition;
  const run = createViewTransitionRunner({
    document,
    prefersReducedMotion: () => reduced,
  });
  return {
    classes,
    classesAtStart,
    document,
    finished,
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

Deno.test("unrelated full-view routes start without the task-boundary suppression class", async () => {
  const h = harness();
  h.run(() => {}, {
    sourceRoute: VIEW_ROUTE.HUB,
    targetRoute: VIEW_ROUTE.SETTINGS,
    focusAfter: null,
  });

  assertEquals(h.starts(), 1);
  assertEquals(
    h.classesAtStart[0].has(TASK_VIEW_TRANSITION_CLASS),
    false,
    "Hub/full-view navigation retains the ordinary root and named overlay cross-fade",
  );
  assertEquals(h.classes.size, 0);

  h.finished.resolve();
  await h.finished.promise;
  await Promise.resolve();
  assertEquals(h.classes.size, 0);
});

Deno.test("leaving a task during an active incidental transition applies and cleans suppression", async () => {
  const h = harness();
  h.run(() => {}); // sidebar transition: no route boundary
  assertEquals(h.classes.size, 0);

  h.run(() => {}, {
    sourceRoute: VIEW_ROUTE.TASK,
    targetRoute: VIEW_ROUTE.SETTINGS,
    focusAfter: null,
  });
  assert(
    h.classes.has(TASK_VIEW_TRANSITION_CLASS),
    "the live top layer stops presenting old task controls",
  );

  h.finished.resolve();
  await h.finished.promise;
  await Promise.resolve();
  assertEquals(h.classes.size, 0, "overlap suppression is always cleaned");
});

Deno.test("task view transition suppresses the old root until cleanup and routes focus after finish", async () => {
  const h = harness();
  let updated = 0;
  let focused = 0;
  const focusTarget = { isConnected: true, focus: () => focused++ };

  h.run(() => updated++, {
    sourceRoute: VIEW_ROUTE.HUB,
    targetRoute: VIEW_ROUTE.TASK,
    focusAfter: focusTarget,
  });

  assertEquals(updated, 1);
  assertEquals(
    focused,
    0,
    "focus waits for the top-layer transition to finish",
  );
  assert(
    h.classesAtStart[0].has(TASK_VIEW_TRANSITION_CLASS),
    "route-scoped root policy is installed before the old snapshot is captured",
  );
  assert(
    h.classes.has(TASK_VIEW_TRANSITION_CLASS),
    "route-scoped root policy remains active during capture",
  );

  h.finished.resolve();
  await h.finished.promise;
  await Promise.resolve();

  assertEquals(
    h.classes.has(TASK_VIEW_TRANSITION_CLASS),
    false,
    "temporary snapshot policy is removed",
  );
  assertEquals(
    focused,
    1,
    "focus is routed exactly once to the active task surface",
  );
});

Deno.test("aborted task view transition still cleans the route class and routes focus", async () => {
  const h = harness();
  let focused = 0;
  h.run(() => {}, {
    sourceRoute: VIEW_ROUTE.TASK,
    targetRoute: VIEW_ROUTE.SETTINGS,
    focusAfter: { isConnected: true, focus: () => focused++ },
  });

  h.finished.reject(new Error("aborted"));
  await h.finished.promise.catch(() => {});
  await Promise.resolve();

  assertEquals(h.classes.size, 0);
  assertEquals(focused, 1);
});

Deno.test("a rapid route switch waits for the active top layer and cannot restore stale focus", async () => {
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

  assertEquals(updates, 2, "the guarded route still updates immediately");
  assertEquals(
    currentFocus,
    0,
    "focus does not move underneath an active top-layer snapshot",
  );
  h.finished.resolve();
  await h.finished.promise;
  await Promise.resolve();

  assertEquals(
    staleFocus,
    0,
    "the earlier transition cannot steal focus when it finishes",
  );
  assertEquals(
    currentFocus,
    1,
    "the latest route receives focus after the active transition",
  );
  assertEquals(h.classes.size, 0);
});

Deno.test("an incidental overlapping transition does not cancel pending task-route focus", async () => {
  const h = harness();
  let routeFocus = 0;
  h.run(() => {}, {
    sourceRoute: VIEW_ROUTE.HUB,
    targetRoute: VIEW_ROUTE.TASK,
    focusAfter: { isConnected: true, focus: () => routeFocus++ },
  });
  h.run(() => {}); // e.g. a rail state update: no focus ownership

  h.finished.resolve();
  await h.finished.promise;
  await Promise.resolve();

  assertEquals(routeFocus, 1);
});

Deno.test("reduced motion bypasses snapshots and focuses the updated task immediately", () => {
  const h = harness({ reduced: true });
  let updated = false;
  let focused = false;
  h.run(() => {
    updated = true;
  }, {
    sourceRoute: VIEW_ROUTE.HUB,
    targetRoute: VIEW_ROUTE.TASK,
    focusAfter: {
      isConnected: true,
      focus: () => {
        focused = true;
      },
    },
  });

  assertEquals(h.starts(), 0);
  assertEquals(updated, true);
  assertEquals(focused, true);
  assertEquals(h.classes.size, 0);
});

Deno.test("synchronous snapshot failure applies the route once then cleans and focuses", () => {
  for (
    const h of [harness({ throws: true }), harness({ throwsAfterUpdate: true })]
  ) {
    let updates = 0;
    let focused = 0;
    h.run(() => updates++, {
      sourceRoute: VIEW_ROUTE.TASK,
      targetRoute: VIEW_ROUTE.HUB,
      focusAfter: { isConnected: true, focus: () => focused++ },
    });

    assertEquals(
      updates,
      1,
      "the DOM update is never replayed after a synchronous failure",
    );
    assertEquals(focused, 1);
    assertEquals(h.classes.size, 0);
  }
});

Deno.test("unsupported View Transitions use the immediate focus-safe fallback", () => {
  const h = harness({ supported: false });
  let updates = 0;
  let focused = 0;
  h.run(() => updates++, {
    sourceRoute: VIEW_ROUTE.HUB,
    targetRoute: VIEW_ROUTE.TASK,
    focusAfter: { isConnected: true, focus: () => focused++ },
  });

  assertEquals(h.starts(), 0);
  assertEquals(updates, 1);
  assertEquals(focused, 1);
  assertEquals(h.classes.size, 0);
});

Deno.test("task-boundary CSS hides old root and overlay pixels without suppressing the new named overlay", async () => {
  const html = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.html", import.meta.url),
  );
  const oldSnapshotRule =
    /html\.task-view-transition::view-transition-old\(root\)\s*,\s*html\.task-view-transition::view-transition-old\(overlay-view\)\s*{([^}]*)}/s
      .exec(html);

  assert(
    oldSnapshotRule,
    "both old task-boundary snapshots share one scoped rule",
  );
  assert(
    /animation:\s*none;/.test(oldSnapshotRule[1]) &&
      /opacity:\s*0;/.test(oldSnapshotRule[1]),
    "old(root) and old(overlay-view) are non-animated and transparent",
  );
  assert(
    /\.view-overlay\s*{[^}]*view-transition-name:\s*overlay-view;/s.test(html),
    "the replacement overlay keeps its shared transition identity",
  );
  assertEquals(
    /html\.task-view-transition::view-transition-new\(overlay-view\)/.test(
      html,
    ),
    false,
    "new(overlay-view) remains active instead of being disabled by task policy",
  );
  assert(
    /html\.task-view-transition::view-transition-new\(root\)\s*{[^}]*animation:\s*none;/s
      .test(html),
    "the replacement root remains immediate",
  );
});

Deno.test("NTP task routing preserves reduced-motion and focus contracts", async () => {
  const html = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.html", import.meta.url),
  );
  const js = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  assert(
    html.includes("::view-transition-group(*)"),
    "reduced-motion policy covers transition snapshots",
  );
  assert(
    js.includes("sourceRoute") && js.includes("targetRoute"),
    "NTP supplies source and target routes instead of globally disabling transitions",
  );
  assert(
    js.includes("focusAfter = threadTitle"),
    "task arrival has an explicit focus destination",
  );
  assert(
    html.includes('id="thread-title" tabindex="-1"'),
    "task heading is programmatically focusable",
  );
});

Deno.test("current-main task routing composes with Directory covered-state and focus authority", async () => {
  const js = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );

  assert(
    /for \(const covered of \[side, sideToggle\]\)/.test(js) &&
      /covered\.inert = fullViewOpen/.test(js) &&
      /covered\.setAttribute\("aria-hidden", "true"\)/.test(js),
    "full Directory views retain inert and aria-hidden authority for both covered controls",
  );
  assert(
    /function openView\(path, title, trigger\)/.test(js) &&
      /viewFocus\.open\(trigger,[\s\S]*?}, null\), \{[\s\S]*?focusAfter: viewFrame/
        .test(js),
    "the initiating trigger remains owned while frame focus waits for transition settlement",
  );
  assert(
    /focusAfter:\s*\{ focus: \(\) => viewFocus\.close\(\(\) => \{\}\) \}/.test(
      js,
    ),
    "closing a full view restores the initiating trigger after the top layer settles",
  );
});
