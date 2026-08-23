// tests/navigation-state-matrix.test.ts — the navigation state-machine fix
// (CAP-FB-20260823-NAVIGATION-STATE-02): history.state is the single source of
// truth, self-initiated pushes never re-dispatch, forward restores the exact
// title/name, unknown routes fail closed to hub, and no blank "view" survives.
// Pure helpers + a small history-stack model drive the owner's exact repros.
// @ts-nocheck — the history-stack model is intentionally dynamic (house style).
import { assertEquals } from "jsr:@std/assert@1";
import {
  parseNtpHash,
  resolveEntryMeta,
  shouldDispatchForNavigationType,
} from "../extension/lib/navigation-controller.js";

// A minimal history-stack model of the NTP navigation: each entry carries its
// hash + the state pushed by openView/openThread/openAgentSurface.
function historyModel() {
  const stack = [{ hash: "", state: null }]; // the hub
  let index = 0;
  const push = (hash, state) => {
    stack.splice(index + 1); // a push truncates the forward stack
    stack.push({ hash, state });
    index += 1;
  };
  return {
    get current() { return stack[index]; },
    get canForward() { return index < stack.length - 1; },
    push,
    back() { if (index > 0) index -= 1; },
    forward() { if (index < stack.length - 1) index += 1; },
    resolve() {
      const parsed = parseNtpHash(this.current.hash);
      return { parsed, meta: resolveEntryMeta(parsed, this.current.state) };
    },
  };
}

Deno.test("parseNtpHash maps every route class (the owner's view classes)", () => {
  assertEquals(parseNtpHash(""), { route: "hub" });
  assertEquals(parseNtpHash("#"), { route: "hub" });
  assertEquals(parseNtpHash("#thread=t1"), { route: "thread", id: "t1" });
  assertEquals(parseNtpHash("#agent=named:writer"), { route: "agent", kind: "named", id: "writer" });
  assertEquals(parseNtpHash("#agent=background:cron"), { route: "agent", kind: "background", id: "cron" });
  assertEquals(parseNtpHash("#view=artifacts%2Findex.html"), { route: "view", path: "artifacts/index.html" });
  assertEquals(parseNtpHash("#view=recipes%2Findex.html"), { route: "view", path: "recipes/index.html" });
  assertEquals(parseNtpHash("#view=options%2Foptions.html"), { route: "view", path: "options/options.html" });
  assertEquals(parseNtpHash("#garbage"), { route: "hub" }, "unknown → hub (fail closed)");
});

Deno.test("shouldDispatchForNavigationType skips ONLY self-initiated push/replace", () => {
  assertEquals(shouldDispatchForNavigationType("push"), false);
  assertEquals(shouldDispatchForNavigationType("replace"), false);
  assertEquals(shouldDispatchForNavigationType("traverse"), true);
  assertEquals(shouldDispatchForNavigationType("reload"), true);
});

Deno.test("resolveEntryMeta restores the EXACT title/name from the history state (never a hardcoded 'View')", () => {
  const view = { route: "view", path: "artifacts/index.html" };
  assertEquals(resolveEntryMeta(view, { route: "view", path: "artifacts/index.html", title: "Assets" }).title, "Assets");
  assertEquals(resolveEntryMeta(view, { route: "view", path: "recipes/index.html", title: "Skills" }).title, "Skills");
  assertEquals(resolveEntryMeta(view, { title: "Settings" }).title, "Settings");
  assertEquals(resolveEntryMeta(view, null).title, "View", "no state → the 'View' fallback (never a blank)");
  const agent = { route: "agent", kind: "named", id: "writer" };
  assertEquals(resolveEntryMeta(agent, { name: "Writer" }).name, "Writer");
  assertEquals(resolveEntryMeta(agent, null).name, null);
});

Deno.test("REPRO 1 — forward after back restores the task + settings with the exact state", () => {
  const h = historyModel();
  h.push("#thread=t1", { route: "thread", id: "t1" });          // click task
  h.push("#view=options%2Foptions.html", { route: "view", path: "options/options.html", title: "Settings" }); // Settings
  h.back();                                                    // back → the task
  assertEquals(h.resolve().parsed, { route: "thread", id: "t1" });
  h.forward();                                                 // FORWARD → Settings
  const r = h.resolve();
  assertEquals(r.parsed, { route: "view", path: "options/options.html" });
  assertEquals(r.meta.title, "Settings", "forward restores the exact title, not a blank 'View'");
});

Deno.test("REPRO 2 — Assets in-app back lands on hub, and forward re-opens 'Assets' (no blank 'view')", () => {
  const h = historyModel();
  h.push("#view=artifacts%2Findex.html", { route: "view", path: "artifacts/index.html", title: "Assets" });
  h.back();                                                    // in-app back
  assertEquals(h.resolve().parsed, { route: "hub" }, "back → hub (no blank titled screen)");
  h.forward();                                                 // forward
  const r = h.resolve();
  assertEquals(r.parsed.route, "view");
  assertEquals(r.meta.title, "Assets", "forward restores 'Assets' exactly");
});

Deno.test("REPRO 3 — Skills → back → forward → back never produces a blank or orphan state", () => {
  const h = historyModel();
  h.push("#view=recipes%2Findex.html", { route: "view", path: "recipes/index.html", title: "Skills" });
  h.back();                                                    // back → hub
  assertEquals(h.resolve().parsed, { route: "hub" });
  h.forward();                                                 // forward → Skills
  assertEquals(h.resolve().meta.title, "Skills");
  h.back();                                                    // back → hub again
  assertEquals(h.resolve().parsed, { route: "hub" });
  assertEquals(h.canForward, true, "the forward stack is intact, never truncated");
});

Deno.test("rapid alternation — the stack stays consistent across task/settings/assets/skills/agents", () => {
  const h = historyModel();
  const entries = [
    ["#thread=t1", { route: "thread", id: "t1" }],
    ["#view=options%2Foptions.html", { route: "view", path: "options/options.html", title: "Settings" }],
    ["#view=artifacts%2Findex.html", { route: "view", path: "artifacts/index.html", title: "Assets" }],
    ["#view=recipes%2Findex.html", { route: "view", path: "recipes/index.html", title: "Skills" }],
    ["#agent=named:writer", { route: "agent", kind: "named", id: "writer", name: "Writer" }],
  ];
  for (const [hash, state] of entries) h.push(hash, state);
  for (let i = entries.length - 1; i >= 0; i--) {
    const r = h.resolve();
    const expected = parseNtpHash(entries[i][0]);
    assertEquals(r.parsed, expected, `back #${i} restores the exact route`);
    if (expected.route === "view") {
      assertEquals(r.meta.title, entries[i][1].title, `view #${i} restores its title`);
    }
    if (expected.route === "agent") {
      assertEquals(r.meta.name, entries[i][1].name, `agent #${i} restores its name`);
    }
    h.back();
  }
  assertEquals(h.resolve().parsed, { route: "hub" });
  for (let i = 0; i < entries.length; i++) {
    h.forward();
    const r = h.resolve();
    assertEquals(r.parsed, parseNtpHash(entries[i][0]), `forward #${i} restores the exact route`);
  }
});
