// tests/panel-frame-pool.test.ts — CAP-FB-20260828-PANEL-DOC-RETENTION-01.
// Pins the bounded panel-frame pool: the old single shared #view-frame forced a
// cross-document replace on every panel switch and the renderer retained each
// destroyed document until a major GC (measured 12 cycles: Documents 4→39,
// listeners 113→776, heap 1.8→8.4MB — scripts/panel-leak-probe.ts). The pool
// makes the document count bounded by the panel count and close a plain hide.
// @ts-nocheck
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";

const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
const ntpHtml = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));

Deno.test("PANEL-POOL: panels use a single exact-document options frame (retired multi-view Map pool)", () => {
  assert(ntpJs.includes("let optionsFrame = null;"), "ntp.js must declare the single exact-document options frame");
  assert(!ntpJs.includes("const panelFrames = new Map()"), "ntp.js must retire the open-ended multi-path panelFrames Map pool");
  assert(ntpJs.includes("function panelFrameFor(path)"), "ntp.js must resolve the exact-document frame via panelFrameFor");
  assert(ntpJs.includes('optionsFrame.dataset.panelPath = "options/options.html";'), "optionsFrame must set data-panel-path for journey automation");
  assert(ntpJs.includes("PANEL_FRAME_CONTAINER.appendChild(optionsFrame);"), "optionsFrame must be appended to the panel frame container");
  assert(!ntpHtml.includes('id="view-frame"'), "the static shared #view-frame must be gone from the markup");
});

Deno.test("PANEL-POOL: directory, artifacts, and hub-ok Settings routes create zero panel frames in PANEL_FRAME_CONTAINER", () => {
  // 1. Static markup verification: zero static panel iframes in #view overlay, and all client views nested under #view-client-host
  const viewSection = ntpHtml.slice(ntpHtml.indexOf('id="view"'), ntpHtml.indexOf('id="thread-view"'));
  const staticIframes = (viewSection.match(/<iframe/gi) || []).length;
  assertEquals(staticIframes, 0, "#view overlay markup must have zero static panel <iframe> elements");

  const vchIndex = ntpHtml.indexOf('id="view-client-host"');
  const dirIndex = ntpHtml.indexOf('id="directory-view"');
  const artIndex = ntpHtml.indexOf('id="artifacts-view"');
  const setIndex = ntpHtml.indexOf('id="settings-view"');
  const viewEnd = ntpHtml.indexOf("<!-- CAP-FB-20260828-PANEL-DOC-RETENTION-01");
  assert(vchIndex > 0, "#view-client-host must exist in ntp.html");
  assert(dirIndex > vchIndex && artIndex > vchIndex && setIndex > vchIndex && setIndex < viewEnd,
    "directory-view, artifacts-view, and settings-view must all mount inside #view-client-host in ntp.html");

  // 2. In ntp.js openView, client-side views mount directly in #view-client-host with zero panel frame instantiation
  const openViewBody = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  const startClient = openViewBody.indexOf("if (isClientSide) {");
  assert(startClient >= 0, "openView must contain an explicit isClientSide branch");
  const elseBranch = openViewBody.indexOf("} else {", startClient);
  assert(elseBranch > startClient, "openView must separate client-side mounting from exact-document frame mounting");

  const clientBranch = openViewBody.slice(startClient, elseBranch);
  assert(!clientBranch.includes("panelFrameFor("), "client-side views must never invoke panelFrameFor or create a panel frame");
  assert(!/iframe/i.test(clientBranch), "client-side branch in openView must never reference, create, or append an iframe element");
  assert(!/createElement\s*\(\s*["'`]iframe["'`]\s*\)/i.test(clientBranch), "client-side views must never create an iframe element");
  assert(!/appendChild\s*\([^)]*iframe/i.test(clientBranch), "client-side views must never append an iframe element");
  assert(clientBranch.includes("activePanelFrame = null;"), "client-side views must clear activePanelFrame");
  assert(clientBranch.includes("if (optionsFrame) optionsFrame.hidden = true;"), "optionsFrame is hidden when client views mount");

  // Verify per-route mounting and unhiding under #view-client-host
  assert(clientBranch.includes("viewClientHost.hidden = false;"), "openView must unhide viewClientHost for client-side views");
  assert(clientBranch.includes("directoryViewEl.hidden = false;"), "openView must unhide directoryViewEl for directory route");
  assert(clientBranch.includes("artifactsViewEl.hidden = false;"), "openView must unhide artifactsViewEl for artifacts route");
  assert(clientBranch.includes("settingsViewEl.hidden = false;"), "openView must unhide settingsViewEl for hub-ok settings route");

  // Verify route classification includes Directory, Artifacts, and hub-ok Settings sections
  assert(
    ntpJs.includes("const isClientSide = targetRoute === VIEW_ROUTE.DIRECTORY || targetRoute === VIEW_ROUTE.ARTIFACTS || (targetRoute === VIEW_ROUTE.SETTINGS && isHubOk);"),
    "directory, artifacts, and hub-ok settings routes must be classified client-side",
  );
  assert(
    ntpJs.includes('const HUB_OK_SETTINGS_SECTIONS = new Set(["skills", "usage", "about"]);'),
    "HUB_OK_SETTINGS_SECTIONS must define client-side settings sections",
  );
});

function getFunctionFrom(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Function ${name} not found in source`);
  let depth = 0;
  let started = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") {
      depth++;
      started = true;
    } else if (src[i] === "}") {
      depth--;
      if (started && depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unterminated function ${name}`);
}

function createNtpViewHarness(src = ntpJs) {
  const fnOpenView = getFunctionFrom(src, "openView");
  const fnPanelFrameFor = getFunctionFrom(src, "panelFrameFor");
  const fnEmbeddedViewRoute = getFunctionFrom(src, "embeddedViewRoute");
  const fnResolveSettingsSectionFromPath = getFunctionFrom(src, "resolveSettingsSectionFromPath");
  const fnNormalizeHubSettingsSection = getFunctionFrom(src, "normalizeHubSettingsSection");

  const makeElement = (id: string, tagName = "div") => ({
    id,
    tagName: tagName.toUpperCase(),
    hidden: true,
    children: [] as any[],
    dataset: {} as Record<string, string>,
    title: "",
    src: "",
    contentWindow: { location: { hash: "" } },
    appendChild(child: any) { this.children.push(child); return child; },
    querySelectorAll(selector: string) {
      const results: any[] = [];
      function walk(node: any) {
        for (const c of node.children) {
          if (c.tagName.toLowerCase() === selector.toLowerCase() || (selector.startsWith("#") && c.id === selector.slice(1))) {
            results.push(c);
          }
          walk(c);
        }
      }
      walk(this);
      return results;
    },
  });

  const PANEL_FRAME_CONTAINER = makeElement("view");
  const viewClientHost = makeElement("view-client-host");
  const directoryViewEl = makeElement("directory-view");
  const directoryRowsEl = makeElement("directory-rows");
  const artifactsViewEl = makeElement("artifacts-view");
  const settingsViewEl = makeElement("settings-view", "section");
  const viewTitle = makeElement("view-title");
  const viewOverlay = makeElement("view-overlay");
  const threadView = makeElement("thread-view");

  PANEL_FRAME_CONTAINER.appendChild(viewClientHost);
  viewClientHost.appendChild(directoryViewEl);
  viewClientHost.appendChild(artifactsViewEl);
  viewClientHost.appendChild(settingsViewEl);

  const documentMock = {
    getElementById(id: string) {
      if (id === "view") return PANEL_FRAME_CONTAINER;
      if (id === "view-client-host") return viewClientHost;
      if (id === "directory-view") return directoryViewEl;
      if (id === "directory-rows") return directoryRowsEl;
      if (id === "artifacts-view") return artifactsViewEl;
      if (id === "settings-view") return settingsViewEl;
      if (id === "view-title") return viewTitle;
      return null;
    },
    createElement(tag: string) {
      return makeElement("", tag);
    },
  };

  const chromeMock = {
    runtime: {
      getURL: (p: string) => "chrome-extension://mock/" + p,
    },
  };

  const VIEW_ROUTE = {
    SETTINGS: "settings",
    DIRECTORY: "directory",
    ARTIFACTS: "artifacts",
  };
  const HUB_OK_SETTINGS_SECTIONS = new Set(["skills", "usage", "about"]);

  const runner = new Function("document", "chrome", "PANEL_FRAME_CONTAINER", "viewClientHost", "directoryViewEl", "directoryRowsEl", "artifactsViewEl", "settingsViewEl", "viewTitle", "viewOverlay", "threadView", "VIEW_ROUTE", "HUB_OK_SETTINGS_SECTIONS", `
    let optionsFrame = null;
    let activePanelFrame = null;
    let activeViewRoute = null;
    function flushDeferredComponents() {}
    function teardownArtifactsView() {}
    function teardownHubSettingsView() {}
    function renderDirectoryContent() {}
    function renderArtifactsView() {}
    function renderHubSettingsView() {}
    function attachArtifactToComposer() {}
    function goHome() {}
    function navigateNtpRoute() {}
    function runRouteUpdate(fn) { fn(); }
    function hideThreadViewInner() {}
    function syncViewOpen() {}
    const composer = {};
    const viewFocus = { open: (t, fn) => fn(), close: (fn) => fn() };
    const window = {};
    const location = { href: "chrome-extension://mock/ntp.html" };

    ${fnNormalizeHubSettingsSection}
    ${fnEmbeddedViewRoute}
    ${fnResolveSettingsSectionFromPath}
    ${fnPanelFrameFor}
    ${fnOpenView}

    return {
      openView,
      panelFrameFor,
      getOptionsFrame: () => optionsFrame,
      getActivePanelFrame: () => activePanelFrame,
      countAllIframes: () => PANEL_FRAME_CONTAINER.querySelectorAll("iframe").length,
      container: PANEL_FRAME_CONTAINER,
      viewClientHost,
      directoryViewEl,
      artifactsViewEl,
      settingsViewEl,
    };
  `);

  return runner(documentMock, chromeMock, PANEL_FRAME_CONTAINER, viewClientHost, directoryViewEl, directoryRowsEl, artifactsViewEl, settingsViewEl, viewTitle, viewOverlay, threadView, VIEW_ROUTE, HUB_OK_SETTINGS_SECTIONS);
}

Deno.test("PANEL-POOL: source-bound panel frame lifecycle verifies zero panel frames for client views and one retained optionsFrame for exact-document panels", () => {
  const harness = createNtpViewHarness(ntpJs);

  // 1. Initial state: zero panel frames in PANEL_FRAME_CONTAINER
  assertEquals(harness.countAllIframes(), 0, "initial PANEL_FRAME_CONTAINER must contain 0 panel frames");

  // 2. Open Directory view
  harness.openView("directory/directory.html");
  assertEquals(harness.viewClientHost.hidden, false, "viewClientHost must be unhidden for directory");
  assertEquals(harness.directoryViewEl.hidden, false, "directoryView must be unhidden");
  assertEquals(harness.artifactsViewEl.hidden, true, "artifactsView must remain hidden");
  assertEquals(harness.settingsViewEl.hidden, true, "settingsView must remain hidden");
  assertEquals(harness.countAllIframes(), 0, "directory view must create 0 iframes anywhere in PANEL_FRAME_CONTAINER");

  // 3. Open Artifacts view
  harness.openView("artifacts/index.html");
  assertEquals(harness.viewClientHost.hidden, false, "viewClientHost must be unhidden for artifacts");
  assertEquals(harness.directoryViewEl.hidden, true, "directoryView must remain hidden");
  assertEquals(harness.artifactsViewEl.hidden, false, "artifactsView must be unhidden");
  assertEquals(harness.settingsViewEl.hidden, true, "settingsView must remain hidden");
  assertEquals(harness.countAllIframes(), 0, "artifacts view must create 0 iframes anywhere in PANEL_FRAME_CONTAINER");

  // 4. Open Hub-ok Settings views (skills, usage, about)
  for (const section of ["skills", "usage", "about"]) {
    harness.openView(`settings#${section}`);
    assertEquals(harness.viewClientHost.hidden, false, `viewClientHost must be unhidden for settings#${section}`);
    assertEquals(harness.directoryViewEl.hidden, true, "directoryView must remain hidden");
    assertEquals(harness.artifactsViewEl.hidden, true, "artifactsView must remain hidden");
    assertEquals(harness.settingsViewEl.hidden, false, `settingsView must be unhidden for settings#${section}`);
    assertEquals(harness.countAllIframes(), 0, `settings#${section} must create 0 iframes anywhere in PANEL_FRAME_CONTAINER`);
  }

  // 5. Open exact-document panel (e.g. providers)
  harness.openView("options/options.html#providers");
  assertEquals(harness.viewClientHost.hidden, true, "viewClientHost must be hidden for exact-document panels");
  const optionsFrame = harness.getOptionsFrame();
  assert(optionsFrame, "optionsFrame must exist after opening exact-document panel");
  assertEquals(optionsFrame.hidden, false, "optionsFrame must be unhidden for exact-document panels");
  assertEquals(optionsFrame.dataset.panelPath, "options/options.html", "optionsFrame must carry exact data-panel-path");
  assertEquals(harness.countAllIframes(), 1, "exact-document panel creates exactly 1 optionsFrame in PANEL_FRAME_CONTAINER");

  // 6. Navigate between exact-document panels (never creates a 2nd panel frame)
  harness.openView("options/options.html#data");
  assertEquals(harness.countAllIframes(), 1, "exact-document panel switch must retain exactly 1 optionsFrame");

  // 7. Navigate back to client view (optionsFrame hidden, viewClientHost unhidden, still 1 retained frame)
  harness.openView("directory/directory.html");
  assertEquals(harness.viewClientHost.hidden, false, "viewClientHost unhidden when returning to directory");
  assertEquals(harness.directoryViewEl.hidden, false, "directoryView unhidden");
  assertEquals(optionsFrame.hidden, true, "optionsFrame hidden when returning to directory");
  assertEquals(harness.countAllIframes(), 1, "no new panel frames created when switching back to client views");
});

Deno.test("PANEL-POOL: FALSIFICATION — injected iframe in openView client-side branch turns zero-iframe check RED", () => {
  // Reviewer reproduction finding (chrome-agent-platform-wmvsz):
  // Injecting PANEL_FRAME_CONTAINER.appendChild(document.createElement('iframe')) into openView's isClientSide branch
  const mutatedNtpJs = ntpJs.replace(
    "viewClientHost.hidden = false;",
    "viewClientHost.hidden = false;\n    PANEL_FRAME_CONTAINER.appendChild(document.createElement('iframe'));",
  );
  assertNotEquals(mutatedNtpJs, ntpJs, "mutation must successfully apply to ntp.js source");

  // 1. Static check must detect the injected iframe in clientBranch
  const openViewBody = mutatedNtpJs.slice(mutatedNtpJs.indexOf("function openView("), mutatedNtpJs.indexOf("function closeView("));
  const startClient = openViewBody.indexOf("if (isClientSide) {");
  const elseBranch = openViewBody.indexOf("} else {", startClient);
  const clientBranch = openViewBody.slice(startClient, elseBranch);
  assert(/iframe/i.test(clientBranch), "falsification: clientBranch regex must detect injected single-quoted iframe");

  // 2. Behavioral source-bound execution must detect the runtime iframe append and fail the zero-iframe assertion
  const mutatedHarness = createNtpViewHarness(mutatedNtpJs);
  mutatedHarness.openView("directory/directory.html");
  const iframesCreated = mutatedHarness.countAllIframes();
  assertEquals(iframesCreated, 1, "falsification: injected client-side append must register as a created iframe (proving sensitivity)");
});

Deno.test("PANEL-POOL: a panel document is booted exactly once (no per-open navigation)", () => {
  // The only frame.src assignment in openView is the boot-once branch.
  const openView = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  assert(/if \(!frame\.src \|\| frame\.src === "about:blank"[^)]*\) \{\s*\n\s*frame\.src = frameUrl;/.test(openView),
    "openView must navigate a pooled frame only on first boot");
  assert(!/location\.replace\(/.test(openView), "openView must never replace-navigate an already-booted panel");
});

Deno.test("PANEL-POOL: close is a plain hide (no document churn on the close path)", () => {
  const hide = ntpJs.slice(ntpJs.indexOf("function hideViewInner()"), ntpJs.indexOf("function showThreadView("));
  assert(!/location\.replace\(|\.src = /.test(hide), "hideViewInner must not navigate or blank the panel frame");
});

Deno.test("PANEL-POOL: message-origin checks accept any pooled panel frame", () => {
  assert(ntpJs.includes("function isPanelFrameSource(win)"), "the pooled-frame origin check must exist");
  assert(!/e\.source !== viewFrame\.contentWindow/.test(ntpJs), "no check may address the removed shared frame");
});

Deno.test("PANEL-POOL: the rooted-history contract is preserved (one routed entry, Back only for Back)", () => {
  // Opening a panel routes through the controller so hub → view pushes once
  // while deep → view replaces. The explicit Back control still traverses.
  const openView = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  assert(/navigateNtpRoute\(window, hash, \{ route: "view"/.test(openView), "openView must use the rooted navigation controller");
  assert(!/history\.pushState\(/.test(openView), "openView must not bypass rooted navigation with a direct push");
  const closeView = ntpJs.slice(ntpJs.indexOf("function closeView("), ntpJs.indexOf("// ── Multi-Page App"));
  assert(/history\.back\(\)/.test(closeView), "the explicit Back path must retain browser traversal");
});
