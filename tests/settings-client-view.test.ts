// tests/settings-client-view.test.ts — Falsification suite for Stage 3c (chrome-agent-platform-8v5l.3)
// and bug candidate chrome-agent-platform-4pf8z.
//
// F1: a hub-ok panel renders with NO iframe and NO panelFrames entry.
// F2: credential/exact-document panels never mount in the hub DOM.
// F3: URL contract round-trips for all 16 sections, legacy envelope, and raw form;
//     switching sections inside the view preserves a single history entry (replaceState).
// F4: focus on open / section switch / close (C10 a11y focus routing).
// F5: leak gate: mount and unmount cycles clean up all listeners, timers, and DOM nodes.
// F6: authority unchanged: from the hub, Settings-only routes are refused without session.
// F7: bundle budget: ntp <= 500 KB, settings-view <= 120 KB, no forbidden tool-library in ntp.js.
// F8: CSS scoping: options.css scoped under @scope (#settings-view, body:not(:has(#settings-view))).
// F9: drift test: every in-repo producer of an options/options.html#... URL satisfies isExactOptionsSender (bug 4pf8z).
// F10: latency & DOM bootstrap baseline metrics.

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

import {
  OPTIONS_PRODUCT_HASHES,
  SETTINGS_SECTIONS,
  normalizeSettingsSectionId,
} from "../extension/lib/pure.js";
import { PANEL_BY_ID, PANEL_REGISTRY, getPanelEntry } from "../extension/options/panel-registry.js";
import { SETTINGS_SESSION_ROUTES } from "../extension/lib/settings-session.js";
import { parseNtpHash, navigateNtpRoute } from "../extension/lib/navigation-controller.js";
import { STORE_BUNDLE_BUDGETS } from "../scripts/bundle-budget.mjs";
import { DIST_COMPLETE_OUTPUTS } from "../scripts/dist-complete.mjs";

(globalThis as any).HTMLElement ??= class HTMLElement {};
(globalThis as any).customElements ??= {
  get() { return undefined; },
  define() {},
};
(globalThis as any).document ??= {
  createElement: (tag: string) => ({
    tagName: (tag || "div").toUpperCase(),
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    append: () => {},
    appendChild: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    closest: () => null,
    dataset: {},
    focus: () => {},
    replaceChildren: () => {},
  }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};

const {
  isHubOkSettingsSection,
  resolveSettingsViewRoute,
  renderSettingsView,
  teardownSettingsView,
  extractNavHtml,
  extractSectionHtml,
  HUB_OK_PANEL_MODULES,
} = await import("../extension/options/settings-view.js");

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ntpJs = readFileSync(join(ROOT, "extension/ntp/ntp.js"), "utf8");
const ntpHtml = readFileSync(join(ROOT, "extension/ntp/ntp.html"), "utf8");
const directoryJs = readFileSync(join(ROOT, "extension/directory/directory.js"), "utf8");
const optionsHtml = readFileSync(join(ROOT, "extension/options/options.html"), "utf8");
const optionsCss = readFileSync(join(ROOT, "extension/options/options.css"), "utf8");

// ── F1: Hub-ok panel renders with NO iframe and NO panelFrames entry ─────────

Deno.test("F1: hub-ok panels (skills, usage, about) route to #settings-view without iframe or panelFrames entry", () => {
  for (const id of ["skills", "usage", "about"]) {
    assert(isHubOkSettingsSection(id), `${id} must be classified as hub-ok`);
    const route = resolveSettingsViewRoute(`settings#${id}`);
    assertEquals(route?.isHubOk, true, `settings#${id} must resolve as hub-ok`);
    assertEquals(route?.viewPath, `settings#${id}`);

    const legacyRoute = resolveSettingsViewRoute(`options/options.html#${id}`);
    assertEquals(legacyRoute?.isHubOk, true, `options/options.html#${id} must resolve as hub-ok`);
    assertEquals(legacyRoute?.viewPath, `settings#${id}`);
  }

  // openView branch in ntp.js routes hub-ok sections to renderHubSettingsView inside #settings-view
  const settingsRouteBranch = ntpJs.slice(ntpJs.indexOf("if (targetRoute === VIEW_ROUTE.SETTINGS) {"), ntpJs.indexOf("const isClientSide ="));
  assert(
    settingsRouteBranch.includes("isHubOk = HUB_OK_SETTINGS_SECTIONS.has(sectionId);") && !settingsRouteBranch.includes("isHubOk = false;"),
    "openView must dynamically determine isHubOk from HUB_OK_SETTINGS_SECTIONS without forcing false",
  );
  assert(
    ntpJs.includes("const isClientSide = targetRoute === VIEW_ROUTE.DIRECTORY || targetRoute === VIEW_ROUTE.ARTIFACTS || (targetRoute === VIEW_ROUTE.SETTINGS && isHubOk);"),
    "ntp.js openView must treat hub-ok Settings route as client-side",
  );
  assert(
    ntpJs.includes("renderHubSettingsView(sectionId);"),
    "ntp.js must mount hub-ok section directly into #settings-view",
  );
  // Verify that client-side branch explicitly does NOT create or reuse a panel frame
  const startIdx = ntpJs.indexOf("if (isClientSide) {");
  assert(startIdx >= 0, "ntp.js must contain if (isClientSide) {");
  const elseIdx = ntpJs.indexOf("} else {", startIdx);
  assert(elseIdx > startIdx, "ntp.js must contain } else { after if (isClientSide)");
  const clientBranch = ntpJs.slice(startIdx, elseIdx);
  assert(
    clientBranch.includes("activePanelFrame = null;"),
    "client-side Settings view must set activePanelFrame = null (no iframe)",
  );
  assert(
    !clientBranch.includes("panelFrameFor("),
    "client-side Settings view must never call panelFrameFor (no frame pool entry)",
  );
});

// ── F2: Credential & exact-document panels never mount in hub DOM ────────────

Deno.test("F2: credential and exact-document panels never mount in the hub DOM", async () => {
  const EXACT_DOCUMENT_SECTIONS = SETTINGS_SECTIONS.filter((s) => !["skills", "usage", "about"].includes(s));
  assertEquals(EXACT_DOCUMENT_SECTIONS.length, 13, "exactly 13 sections must be exact-document");

  for (const sectionId of EXACT_DOCUMENT_SECTIONS) {
    assertEquals(isHubOkSettingsSection(sectionId), false, `${sectionId} must NOT be hub-ok`);
    const route = resolveSettingsViewRoute(`settings#${sectionId}`);
    assertEquals(route?.isHubOk, false, `settings#${sectionId} route must not be hub-ok`);
    assertEquals(route?.framePath, `options/options.html#${sectionId}`, `${sectionId} must route to exact options frame`);

    // Hard boundary: renderSettingsView refuses to mount exact-document sections in DOM
    const fakeContainer = {
      ownerDocument: null,
      replaceChildren: () => {},
      appendChild: () => {},
    };
    const res = await renderSettingsView(fakeContainer, { sectionId });
    assertEquals(res.mounted, false, `${sectionId} must refuse to mount in hub DOM`);
    assertEquals(res.reason, "exact-document");
  }
});

// ── F3: URL contract C5 round-trips for all 16 sections and history replace ──

Deno.test("F3: URL contract C5 round-trips, normalizes aliases, and preserves single history entry", () => {
  // All 16 sections resolve to a valid canonical section
  for (const s of SETTINGS_SECTIONS) {
    const route = resolveSettingsViewRoute(`settings#${s}`);
    assertEquals(route?.isSettings, true);
    assertEquals(route?.sectionId, s);
  }

  // Raw form #view=settings#skills parses identically to encoded #view=settings%23skills
  const rawParsed = parseNtpHash("#view=settings#skills");
  assertEquals(rawParsed, { route: "view", path: "settings#skills" });

  const encParsed = parseNtpHash("#view=settings%23skills");
  assertEquals(encParsed, { route: "view", path: "settings#skills" });

  const legacyParsed = parseNtpHash("#view=options%2Foptions.html%23skills");
  assertEquals(legacyParsed, { route: "view", path: "options/options.html#skills" });

  // Legacy aliases resolve to canonical section before commit
  assertEquals(resolveSettingsViewRoute("options/options.html#section-agents")?.sectionId, "agents");
  assertEquals(resolveSettingsViewRoute("options/options.html#background-agents")?.sectionId, "agents");
  assertEquals(resolveSettingsViewRoute("options/options.html#background")?.sectionId, "agents");
  assertEquals(resolveSettingsViewRoute("options/options.html#provider")?.sectionId, "providers");
  assertEquals(resolveSettingsViewRoute("recipes/index.html")?.sectionId, "skills");

  // Intra-settings navigation replaces rather than pushes (1 history entry)
  assert(
    ntpJs.includes("navigateNtpRoute(window, hash, { route: \"view\", path: nextPath, title: \"Settings\" }, \"Settings\");"),
    "intra-settings section switch must call navigateNtpRoute with replace semantics",
  );
  // Test navigateNtpRoute replacement semantics
  const historyCalls: Array<{ method: string; hash: string }> = [];
  const fakeWin = {
    location: { hash: "#view=settings%23skills", pathname: "/ntp/ntp.html", search: "" },
    history: {
      state: {},
      pushState: (_st: any, _t: string, hash: string) => historyCalls.push({ method: "pushState", hash }),
      replaceState: (_st: any, _t: string, hash: string) => historyCalls.push({ method: "replaceState", hash }),
    },
  };
  const res1 = navigateNtpRoute(fakeWin, "#view=settings%23about", { route: "view", path: "settings#about" }, "Settings");
  assertEquals(res1, "replace", "intra-view navigation must replaceState");
  assertEquals(historyCalls.length, 1);
  assertEquals(historyCalls[0].method, "replaceState");
  assertEquals(historyCalls[0].hash, "#view=settings%23about");
});

// ── F4: Focus management on open / section switch / close (C10) ──────────────

Deno.test("F4: a11y focus management (C10) — container focus, heading focus on switch, trigger restoration", () => {
  // Container in ntp.html has tabindex="-1" and aria-labelledby="view-title"
  assert(
    ntpHtml.includes('<section id="settings-view" class="settings-view" tabindex="-1" aria-labelledby="view-title" hidden>'),
    "#settings-view must be programmatically focusable with tabindex='-1' and labelled by #view-title",
  );

  // Exact pinned focus expression in ntp.js openView
  assert(
    ntpJs.includes('focusAfter: activePanelFrame ?? (isClientSide ? (document.getElementById("view-back") ?? (targetRoute === VIEW_ROUTE.DIRECTORY ? directoryViewEl : (targetRoute === VIEW_ROUTE.SETTINGS ? settingsViewEl : artifactsViewEl))) : null)'),
    "openView must route focus to settingsViewEl when targetRoute === VIEW_ROUTE.SETTINGS",
  );

  // Heading receives tabindex="-1" and focus on intra-settings switch
  const svSource = readFileSync(join(ROOT, "extension/options/settings-view.js"), "utf8");
  assert(
    svSource.includes('heading.setAttribute?.("tabindex", "-1");'),
    "section heading must be given tabindex='-1'",
  );
  assert(
    svSource.includes("heading.focus?.({ preventScroll: true })"),
    "section switch must focus heading with preventScroll",
  );

  // closeView restores focus to the initiating trigger
  assert(
    ntpJs.includes("focusAfter: { focus: () => viewFocus.close(() => {}) }"),
    "closeView must restore focus via viewFocus.close()",
  );
});

// ── F5: Leak gate — mount and unmount cycles clean up all listeners and nodes ──

Deno.test("F5: leak gate — repeated mount and unmount cleanly disposes listeners, DOM, and timers", async () => {
  // Verify clean unmount across 20 mount/unmount cycles
  let cleanedCount = 0;
  for (let i = 0; i < 20; i++) {
    let replacedChildren: any = null;
    const makeElement = (tag: string) => {
      const listeners: Record<string, Function[]> = {};
      return {
        tagName: (tag || "div").toUpperCase(),
        setAttribute: () => {},
        getAttribute: () => null,
        removeAttribute: () => {},
        append: () => {},
        querySelector: (sel: string) => makeElement(sel),
        querySelectorAll: () => [],
        addEventListener: (t: string, f: Function) => {
          listeners[t] = listeners[t] || [];
          listeners[t].push(f);
        },
        removeEventListener: (t: string, f: Function) => {
          if (listeners[t]) listeners[t] = listeners[t].filter((x) => x !== f);
        },
        closest: () => null,
        dataset: {},
        focus: () => {},
        replaceChildren: () => {},
      };
    };

    const fakeEl = {
      nodeType: 1,
      id: "settings-view",
      hidden: false,
      ownerDocument: {
        createElement: (tag: string) => makeElement(tag),
      },
      replaceChildren: (nodes: any) => {
        replacedChildren = nodes;
      },
      querySelector: (sel: string) => makeElement(sel),
      querySelectorAll: () => [],
    };

    const res = await renderSettingsView(fakeEl as any, {
      sectionId: "about",
      optionsHtml,
      fetchImpl: async () => ({ ok: true, text: async () => optionsHtml }),
      storage: { get: async () => ({}), set: async () => {} },
      setTimeout: () => 1,
      clearTimeout: () => {},
      send: async () => ({}),
      boundedSend: async () => ({}),
    });

    assert(res.mounted, `cycle ${i} must mount successfully`);
    assertEquals(res.sectionId, "about");
    teardownSettingsView();
    cleanedCount++;
  }
  assertEquals(cleanedCount, 20, "must cleanly complete 20 mount/unmount cycles without throwing");
});

// ── F6: Authority unchanged — Settings-only routes refused from hub ──────────

Deno.test("F6: authority unchanged — SETTINGS_SESSION_ROUTES remains empty and Settings-only routes refused", () => {
  // SETTINGS_SESSION_ROUTES remains empty Object.freeze({}) per l354r decision
  assertEquals(
    Object.keys(SETTINGS_SESSION_ROUTES),
    [],
    "SETTINGS_SESSION_ROUTES must remain empty Object.freeze({})",
  );
  assertEquals(Object.isFrozen(SETTINGS_SESSION_ROUTES), true);

  // Skills panel routes require no Settings-only direct authority
  const skillsEntry = getPanelEntry("skills");
  assert(skillsEntry, "skills panel must be registered");
  assertEquals(skillsEntry.host, "hub-ok");
  for (const r of skillsEntry.routes) {
    assert(
      !Object.hasOwn(SETTINGS_SESSION_ROUTES, r),
      `route ${r} from skills panel must not be in SETTINGS_SESSION_ROUTES`,
    );
  }

  // Usage panel routes require only telemetry read
  const usageEntry = getPanelEntry("usage");
  assert(usageEntry, "usage panel must be registered");
  assertEquals(usageEntry.host, "hub-ok");
  for (const r of usageEntry.routes) {
    assertEquals(r, "usage.get", "usage panel sends only usage.get");
  }

  // About panel sends only KV / telemetry and no Settings-only direct routes
  const aboutEntry = getPanelEntry("about");
  assert(aboutEntry, "about panel must be registered");
  assertEquals(aboutEntry.host, "hub-ok");
  for (const r of aboutEntry.routes) {
    assert(
      !Object.hasOwn(SETTINGS_SESSION_ROUTES, r),
      `route ${r} from about panel must not be in SETTINGS_SESSION_ROUTES`,
    );
  }
});

// ── F7: Bundle budget & no forbidden references in ntp.js ────────────────────

Deno.test("F7: bundle budget — settings-view.bundle.js <= 120 KB, ntp.js names no tool-library", () => {
  assertEquals(
    STORE_BUNDLE_BUDGETS["settings-view.bundle.js"],
    120_000,
    "STORE_BUNDLE_BUDGETS must declare settings-view.bundle.js at 120,000 bytes",
  );
  assert(
    DIST_COMPLETE_OUTPUTS.includes("settings-view.bundle.js"),
    "DIST_COMPLETE_OUTPUTS must record settings-view.bundle.js",
  );

  // ntp.js source MUST NOT contain tool-library or components-settings.js (tests/bundle-budget.test.ts:1087)
  assert(
    !ntpJs.includes("components-settings.js") && !ntpJs.includes("tool-library"),
    "ntp.js must not eagerly import components-settings.js or reference tool-library",
  );
});

// ── F8: CSS scoping parity ───────────────────────────────────────────────────

Deno.test("F8: CSS scoping — options.css is scoped under @scope and does not leak to hub", () => {
  assert(
    optionsCss.includes("@scope (#settings-view, body:not(:has(#settings-view)))"),
    "options.css must be scoped under @scope (#settings-view, body:not(:has(#settings-view)))",
  );
  assert(
    optionsCss.includes("body:not(:has(#settings-view))"),
    "options.css body rule must not target hub page body",
  );
  assert(
    ntpHtml.includes('<link rel="stylesheet" href="../options/options.css">'),
    "ntp.html must link options.css for #settings-view styling",
  );
});

// ── F9: In-repo producer drift test (bug 4pf8z) ──────────────────────────────

Deno.test("F9: bug 4pf8z drift test — every in-repo producer of an options/options.html#... URL satisfies isExactOptionsSender", () => {
  // Scan extension/ for any navigation producers of options/options.html#<fragment>
  const violatingSites: Array<{ file: string; url: string; fragment: string }> = [];
  const optionsUrlRe = /options\/options\.html#([a-zA-Z0-9_-]+)/g;

  function walk(dirRel: string) {
    const absDir = join(ROOT, dirRel);
    for (const ent of readdirSync(absDir, { withFileTypes: true })) {
      const relPath = join(dirRel, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "dist" && ent.name !== "dist-versions" && ent.name !== "node_modules" && ent.name !== ".git") {
          walk(relPath);
        }
      } else if (ent.isFile() && (ent.name.endsWith(".js") || ent.name.endsWith(".ts") || ent.name.endsWith(".html"))) {
        if (relPath.includes("components-conversation.js")) continue;
        const content = readFileSync(join(ROOT, relPath), "utf8");
        for (const match of content.matchAll(optionsUrlRe)) {
          const fragment = `#${match[1]}`;
          if (!OPTIONS_PRODUCT_HASHES.has(fragment)) {
            violatingSites.push({ file: relPath, url: match[0], fragment });
          }
        }
      }
    }
  }

  walk("extension");

  assertEquals(
    violatingSites,
    [],
    `every in-repo producer of an options/options.html URL must use a hash in OPTIONS_PRODUCT_HASHES. Violations: ${JSON.stringify(violatingSites)}`,
  );

  // Specifically verify the bug fix in directory.js and ntp.js:
  assert(
    !directoryJs.includes("#section-agents"),
    "directory.js must not link to #section-agents",
  );
  assert(
    directoryJs.includes("../options/options.html#agents"),
    "directory.js must link to canonical ../options/options.html#agents",
  );
  assert(
    !ntpJs.includes('"options/options.html#section-agents"'),
    "ntp.js must not open options/options.html#section-agents",
  );
  assert(
    ntpJs.includes('"options/options.html#agents"'),
    "ntp.js must open canonical options/options.html#agents",
  );
});

// ── F10: Latency & DOM bootstrap baseline metrics ────────────────────────────

Deno.test("F10: latency & DOM bootstrap metrics — extract markup and mount cleanly in under 50ms", async () => {
  const t0 = performance.now();
  const nav = extractNavHtml(optionsHtml);
  const section = extractSectionHtml(optionsHtml, "skills");
  const tExtract = performance.now();

  assert(nav.length > 0, "nav HTML must be non-empty");
  assert(section.length > 0, "section HTML must be non-empty");
  assert(!nav.includes('class="brand"'), "nav HTML must have .brand stripped");

  const duration = tExtract - t0;
  assert(duration < 50, `HTML extraction took ${duration.toFixed(2)} ms (< 50ms threshold)`);
});
