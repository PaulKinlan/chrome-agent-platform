// tests/navigation-state-matrix.test.ts — the navigation state-machine fix
// (CAP-FB-20260823-NAVIGATION-STATE-02): history.state is the single source of
// truth, self-initiated pushes never re-dispatch, forward restores the exact
// title/name, unknown routes fail closed to hub, and no blank "view" survives.
// Pure helpers + a small history-stack model drive the owner's exact repros.
// @ts-nocheck — the history-stack model is intentionally dynamic (house style).
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  ensureNtpHistoryRoot,
  navigateHome,
  navigateNtpRoute,
  parseNtpHash,
  resolveEntryMeta,
  shouldDispatchForNavigationType,
} from "../extension/lib/navigation-controller.js";

// A minimal rooted history model: the hub is entry zero and only the current
// deep view follows it. Deep → deep replaces, so Back always means Home.
function historyModel() {
  const stack = [{ hash: "", state: null }]; // the hub
  let index = 0;
  const push = (hash, state) => {
    stack.splice(index + 1); // a hub push truncates the forward stack
    if (parseNtpHash(stack[index].hash).route === "hub") {
      stack.push({ hash, state });
      index += 1;
    } else {
      stack[index] = { hash, state };
    }
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

Deno.test("home is the navigation root: deep views replace in nav order and Home resets the stack", () => {
  let href = "chrome-extension://cap/ntp/ntp.html#thread=one";
  let index = 0;
  const entries = [{ href, state: null }];
  const setCurrent = (url, state, replace) => {
    href = new URL(url, href).href;
    const entry = { href, state };
    if (replace) entries[index] = entry;
    else {
      entries.splice(index + 1, Infinity, entry);
      index += 1;
    }
  };
  const win = {
    location: {
      get href() { return href; },
      get hash() { return new URL(href).hash; },
      get pathname() { return new URL(href).pathname; },
      get search() { return new URL(href).search; },
    },
    history: {
      get state() { return entries[index].state; },
      replaceState(state, _title, url) { setCurrent(url, state, true); },
      pushState(state, _title, url) { setCurrent(url, state, false); },
      back() {
        if (index === 0) return false;
        index -= 1;
        href = entries[index].href;
        return true;
      },
    },
  };

  assertEquals(ensureNtpHistoryRoot(win), true, "a direct deep link gets a hub root");
  assertEquals(entries.map((entry) => new URL(entry.href).hash), ["", "#thread=one"]);
  assertEquals(
    navigateNtpRoute(win, "#view=options%2Foptions.html", { route: "view", title: "Settings" }),
    "replace",
    "deep → deep replaces rather than stacking another view",
  );
  assertEquals(entries.map((entry) => new URL(entry.href).hash), ["", "#view=options%2Foptions.html"]);

  assertEquals(navigateHome(win), true);
  assertEquals(new URL(entries[index].href).hash, "", "Home replaces the current deep route");
  assertEquals(win.history.back(), true);
  assertEquals(new URL(entries[index].href).hash, "", "Back from Home cannot resurrect the deep route");
  assertEquals(win.history.back(), false, "the rooted stack has no older in-app view");

  assertEquals(
    navigateNtpRoute(win, "#agent=named:writer", { route: "agent", kind: "named", id: "writer" }),
    "push",
    "the next deep view follows home",
  );
  assertEquals(entries.map((entry) => new URL(entry.href).hash), ["", "#agent=named:writer"], "forward history was reset in nav order");
  navigateHome(win);
  assertEquals(new URL(entries[index].href).hash, "");
});

Deno.test("NTP brand and + both use the real Home destination before focusing a new task", async () => {
  const html = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
  const js = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assertStringIncludes(html, 'id="home" type="button" aria-label="Home"');
  assertStringIncludes(js, 'document.getElementById("home")?.addEventListener("click", () => goHome());');
  assertStringIncludes(js, 'document.getElementById("new-task")?.addEventListener("click", () => {\n  goHome({ focusAfter: composer });');
  assertStringIncludes(js, "const changed = navigateHome(window);");
  assertStringIncludes(js, "hideThreadView({ fromNavigation: true, focusAfter });");
});

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

Deno.test("REPRO 1 — task → settings replaces the deep entry, then Back → Home", () => {
  const h = historyModel();
  h.push("#thread=t1", { route: "thread", id: "t1" });
  h.push("#view=options%2Foptions.html", { route: "view", path: "options/options.html", title: "Settings" });
  h.back();
  assertEquals(h.resolve().parsed, { route: "hub" }, "Back from any deep view reaches Home");
  h.forward();
  const r = h.resolve();
  assertEquals(r.parsed, { route: "view", path: "options/options.html" });
  assertEquals(r.meta.title, "Settings", "forward restores the current deep view exactly");
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

Deno.test("rapid alternation keeps only Home + the latest deep view in navigation order", () => {
  const h = historyModel();
  const entries = [
    ["#thread=t1", { route: "thread", id: "t1" }],
    ["#view=options%2Foptions.html", { route: "view", path: "options/options.html", title: "Settings" }],
    ["#view=artifacts%2Findex.html", { route: "view", path: "artifacts/index.html", title: "Artifacts" }],
    ["#agent=named:writer", { route: "agent", kind: "named", id: "writer", name: "Writer" }],
  ];
  for (const [hash, state] of entries) h.push(hash, state);

  assertEquals(h.resolve().parsed, { route: "agent", kind: "named", id: "writer" });
  assertEquals(h.resolve().meta.name, "Writer");
  h.back();
  assertEquals(h.resolve().parsed, { route: "hub" });
  h.back();
  assertEquals(h.resolve().parsed, { route: "hub" }, "there is no older in-app view behind Home");
  h.forward();
  assertEquals(h.resolve().parsed, { route: "agent", kind: "named", id: "writer" });
});
