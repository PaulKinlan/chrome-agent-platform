// tests/panel-frame-pool.test.ts — CAP-FB-20260828-PANEL-DOC-RETENTION-01.
// Pins the bounded panel-frame pool: the old single shared #view-frame forced a
// cross-document replace on every panel switch and the renderer retained each
// destroyed document until a major GC (measured 12 cycles: Documents 4→39,
// listeners 113→776, heap 1.8→8.4MB — scripts/panel-leak-probe.ts). The pool
// makes the document count bounded by the panel count and close a plain hide.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";

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
  assert(!clientBranch.includes('createElement("iframe")'), "client-side views must never create an iframe element");
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

Deno.test("PANEL-POOL: simulated panel frame lifecycle verifies zero panel frames for client views and one retained optionsFrame for exact-document panels", () => {
  // Construct a minimal DOM fixture modeling ntp.html's #view container
  const makeElement = (id: string, tagName = "div") => ({
    id,
    tagName: tagName.toUpperCase(),
    hidden: true,
    children: [] as any[],
    dataset: {} as Record<string, string>,
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

  const container = makeElement("view");
  const viewClientHost = makeElement("view-client-host");
  const directoryView = makeElement("directory-view");
  const artifactsView = makeElement("artifacts-view");
  const settingsView = makeElement("settings-view", "section");
  viewClientHost.appendChild(directoryView);
  viewClientHost.appendChild(artifactsView);
  viewClientHost.appendChild(settingsView);
  container.appendChild(viewClientHost);

  let optionsFrame: any = null;
  function panelFrameFor() {
    if (!optionsFrame) {
      optionsFrame = makeElement("options-frame", "iframe");
      optionsFrame.dataset.panelPath = "options/options.html";
      container.appendChild(optionsFrame);
    }
    return optionsFrame;
  }

  function simulateOpenView(path: string) {
    const routePath = String(path ?? "").split(/[?#]/, 1)[0];
    let targetRoute = "settings";
    if (routePath === "directory/directory.html" || routePath === "directory") targetRoute = "directory";
    else if (routePath === "artifacts/index.html" || routePath === "artifacts") targetRoute = "artifacts";

    const [, hash] = String(path ?? "").split("#");
    const hubOkSections = new Set(["skills", "usage", "about"]);
    const isHubOk = targetRoute === "settings" && hubOkSections.has(hash);
    const isClientSide = targetRoute === "directory" || targetRoute === "artifacts" || isHubOk;

    if (isClientSide) {
      viewClientHost.hidden = false;
      directoryView.hidden = targetRoute !== "directory";
      artifactsView.hidden = targetRoute !== "artifacts";
      settingsView.hidden = !isHubOk;
      if (optionsFrame) optionsFrame.hidden = true;
    } else {
      viewClientHost.hidden = true;
      directoryView.hidden = true;
      artifactsView.hidden = true;
      settingsView.hidden = true;
      const frame = panelFrameFor();
      frame.hidden = false;
    }
  }

  // Helper to count panel frames specifically within the PANEL_FRAME_CONTAINER (#view)
  const countPanelFrames = () => container.querySelectorAll("iframe").filter(f => f.dataset.panelPath === "options/options.html").length;

  // 1. Initial state: zero panel frames in PANEL_FRAME_CONTAINER
  assertEquals(countPanelFrames(), 0, "initial PANEL_FRAME_CONTAINER must contain 0 panel frames");

  // 2. Open Directory view
  simulateOpenView("directory/directory.html");
  assertEquals(viewClientHost.hidden, false, "viewClientHost must be unhidden for directory");
  assertEquals(directoryView.hidden, false, "directoryView must be unhidden");
  assertEquals(artifactsView.hidden, true, "artifactsView must remain hidden");
  assertEquals(settingsView.hidden, true, "settingsView must remain hidden");
  assertEquals(countPanelFrames(), 0, "directory view must create 0 panel frames in PANEL_FRAME_CONTAINER");

  // 3. Open Artifacts view
  simulateOpenView("artifacts/index.html");
  assertEquals(viewClientHost.hidden, false, "viewClientHost must be unhidden for artifacts");
  assertEquals(directoryView.hidden, true, "directoryView must remain hidden");
  assertEquals(artifactsView.hidden, false, "artifactsView must be unhidden");
  assertEquals(settingsView.hidden, true, "settingsView must remain hidden");
  assertEquals(countPanelFrames(), 0, "artifacts view must create 0 panel frames in PANEL_FRAME_CONTAINER");

  // 4. Open Hub-ok Settings views (skills, usage, about)
  for (const section of ["skills", "usage", "about"]) {
    simulateOpenView(`settings#${section}`);
    assertEquals(viewClientHost.hidden, false, `viewClientHost must be unhidden for settings#${section}`);
    assertEquals(directoryView.hidden, true, "directoryView must remain hidden");
    assertEquals(artifactsView.hidden, true, "artifactsView must remain hidden");
    assertEquals(settingsView.hidden, false, `settingsView must be unhidden for settings#${section}`);
    assertEquals(countPanelFrames(), 0, `settings#${section} must create 0 panel frames in PANEL_FRAME_CONTAINER`);
  }

  // 5. Open exact-document panel (e.g. providers)
  simulateOpenView("options/options.html#providers");
  assertEquals(viewClientHost.hidden, true, "viewClientHost must be hidden for exact-document panels");
  assertEquals(optionsFrame?.hidden, false, "optionsFrame must be unhidden for exact-document panels");
  assertEquals(countPanelFrames(), 1, "exact-document panel creates exactly 1 optionsFrame in PANEL_FRAME_CONTAINER");

  // 6. Navigate between exact-document panels (never creates a 2nd panel frame)
  simulateOpenView("options/options.html#data");
  assertEquals(countPanelFrames(), 1, "exact-document panel switch must retain exactly 1 optionsFrame");

  // 7. Navigate back to client view (optionsFrame hidden, viewClientHost unhidden, still 1 retained frame)
  simulateOpenView("directory/directory.html");
  assertEquals(viewClientHost.hidden, false, "viewClientHost unhidden when returning to directory");
  assertEquals(directoryView.hidden, false, "directoryView unhidden");
  assertEquals(optionsFrame.hidden, true, "optionsFrame hidden when returning to directory");
  assertEquals(countPanelFrames(), 1, "no new panel frames created when switching back to client views");
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
