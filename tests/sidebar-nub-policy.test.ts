// Focused contract tests for side-panel nub visibility across routable views.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  applySidebarNubPolicy,
  sidebarNubPolicy,
} from "../extension/ntp/view-policy.js";

Deno.test("sidebar nub policy: hub and conversation retain access; covered full views do not", () => {
  assertEquals(sidebarNubPolicy("hub"), {
    hidden: false,
    inert: false,
    disabled: false,
  });
  assertEquals(sidebarNubPolicy("conversation"), {
    hidden: false,
    inert: false,
    disabled: false,
  });
  assertEquals(sidebarNubPolicy("full"), {
    hidden: true,
    inert: true,
    disabled: true,
  });
});

Deno.test("sidebar nub policy: a covered nub is absent, inert and restores without sidebar mutation", () => {
  const attrs = new Map<string, string>();
  const toggle = {
    hidden: false,
    inert: false,
    disabled: false,
    toggleAttribute(name: string, force: boolean) {
      if (force) attrs.set(name, "");
      else attrs.delete(name);
    },
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
  };
  const sidebar = { collapsed: true };

  applySidebarNubPolicy(toggle, "full");
  assertEquals({
    hidden: toggle.hidden,
    inert: toggle.inert,
    disabled: toggle.disabled,
  }, {
    hidden: true,
    inert: true,
    disabled: true,
  });
  assertEquals(attrs.has("hidden"), true);
  assertEquals(attrs.has("inert"), true);
  assertEquals(attrs.get("aria-hidden"), "true");
  assertEquals(
    sidebar.collapsed,
    true,
    "view policy must not alter the prior sidebar state",
  );

  applySidebarNubPolicy(toggle, "conversation");
  assertEquals({
    hidden: toggle.hidden,
    inert: toggle.inert,
    disabled: toggle.disabled,
  }, {
    hidden: false,
    inert: false,
    disabled: false,
  });
  assertEquals(attrs.has("hidden"), false);
  assertEquals(attrs.has("inert"), false);
  assertEquals(attrs.has("aria-hidden"), false);
  assertEquals(
    sidebar.collapsed,
    true,
    "restoring the nub leaves collapsed-sidebar access intact",
  );
});

Deno.test("sidebar nub policy: null/absent toggle input is defensive and still returns the policy", () => {
  assertEquals(applySidebarNubPolicy(null, "full"), {
    hidden: true,
    inert: true,
    disabled: true,
  });
  assertEquals(applySidebarNubPolicy(null, "hub"), {
    hidden: false,
    inert: false,
    disabled: false,
  });
  assertEquals(applySidebarNubPolicy(undefined, "conversation"), {
    hidden: false,
    inert: false,
    disabled: false,
  });
});

function makeToggle() {
  const attrs = new Map<string, string>();
  const toggle = {
    hidden: false,
    inert: false,
    disabled: false,
    attrs,
    toggleAttribute(name: string, force: boolean) {
      if (force) attrs.set(name, "");
      else attrs.delete(name);
    },
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
  };
  return toggle;
}

function assertCovered(toggle: ReturnType<typeof makeToggle>, label: string) {
  assertEquals(
    { hidden: toggle.hidden, inert: toggle.inert, disabled: toggle.disabled },
    { hidden: true, inert: true, disabled: true },
    `${label}: properties`,
  );
  assertEquals(toggle.attrs.has("hidden"), true, `${label}: hidden attribute`);
  assertEquals(toggle.attrs.has("inert"), true, `${label}: inert attribute`);
  assertEquals(
    toggle.attrs.get("aria-hidden"),
    "true",
    `${label}: aria-hidden`,
  );
}

function assertActionable(
  toggle: ReturnType<typeof makeToggle>,
  label: string,
) {
  assertEquals(
    { hidden: toggle.hidden, inert: toggle.inert, disabled: toggle.disabled },
    { hidden: false, inert: false, disabled: false },
    `${label}: properties`,
  );
  assertEquals(toggle.attrs.has("hidden"), false, `${label}: hidden attribute`);
  assertEquals(toggle.attrs.has("inert"), false, `${label}: inert attribute`);
  assertEquals(toggle.attrs.has("aria-hidden"), false, `${label}: aria-hidden`);
}

Deno.test("sidebar nub policy: rapid multi-hop view switches keep properties and attributes in exact sync", () => {
  const toggle = makeToggle();
  const hops = [
    "hub",
    "full",
    "conversation",
    "full",
    "hub",
    "full",
    "conversation",
    "hub",
  ] as const;
  for (const view of hops) {
    applySidebarNubPolicy(toggle, view);
    if (view === "full") assertCovered(toggle, `hop→${view}`);
    else assertActionable(toggle, `hop→${view}`);
  }
});

Deno.test("sidebar nub policy: current-main sync keeps side inert and gives toggle state one authority", async () => {
  const source = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );
  const start = source.indexOf("function syncViewOpen(");
  assert(start > -1, "syncViewOpen exists");
  const body = source.slice(
    start,
    source.indexOf("function hideThreadViewInner(", start),
  );
  assert(
    body.includes("side.inert = fullViewOpen;"),
    "covered sidebar inertness is preserved",
  );
  assert(
    body.includes('side.setAttribute("aria-hidden", "true")'),
    "covered sidebar stays AX-absent",
  );
  assert(
    body.includes("applySidebarNubPolicy("),
    "the pure policy owns sideToggle state",
  );
  assertEquals(
    body.includes("[side, sideToggle]"),
    false,
    "sideToggle is not also mutated by the inline sidebar authority",
  );
});

Deno.test("sidebar nub policy: openView synchronises covered state inside the focused transition update", async () => {
  const source = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );
  const start = source.indexOf("function openView(");
  assert(start > -1, "openView exists");
  const body = source.slice(
    start,
    source.indexOf("function closeView(", start),
  );
  const transitionOpen = body.indexOf("runRouteUpdate(() =>");
  const focusUpdate = body.indexOf("viewFocus.open(trigger, () => {");
  const reveal = body.indexOf("viewOverlay.hidden = false;");
  const sync = body.indexOf("syncViewOpen();");
  const transitionOptions = body.indexOf("}, null), {");
  assert(
    transitionOpen > -1 && focusUpdate > transitionOpen && reveal > focusUpdate,
    "the overlay reveal lives in the focused View Transition update callback",
  );
  assert(
    sync > reveal && sync < transitionOptions,
    "syncViewOpen runs after reveal but before the transition update closes",
  );
  assertEquals(
    body.indexOf("syncViewOpen();", sync + 1),
    -1,
    "no eager duplicate syncViewOpen call exists outside the update callback",
  );
});

Deno.test("sidebar nub policy: expanded and collapsed sidebars both restore exactly after a covered view", () => {
  for (const collapsed of [false, true]) {
    const toggle = makeToggle();
    const sidebar = { collapsed };
    applySidebarNubPolicy(toggle, collapsed ? "hub" : "conversation");
    assertActionable(toggle, `before cover (collapsed=${collapsed})`);
    applySidebarNubPolicy(toggle, "full");
    assertCovered(toggle, `covered (collapsed=${collapsed})`);
    assertEquals(
      sidebar.collapsed,
      collapsed,
      "covering must not mutate collapse state",
    );
    applySidebarNubPolicy(toggle, "hub");
    assertActionable(toggle, `restored (collapsed=${collapsed})`);
    assertEquals(
      sidebar.collapsed,
      collapsed,
      "restoration must not mutate collapse state",
    );
  }
});
