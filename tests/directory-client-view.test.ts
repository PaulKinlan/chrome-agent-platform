// tests/directory-client-view.test.ts — contract tests for Stage 1 of the view-frame collapse.
// Asserts that Directory renders as a client-side view inside the Hub DOM without an iframe.
import { assert, assertEquals } from "jsr:@std/assert@1";

const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
const ntpHtml = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
const directoryJs = await Deno.readTextFile(new URL("../extension/directory/directory.js", import.meta.url));

Deno.test("directory client view: ntp.html contains client-side view host and directory container", () => {
  assert(ntpHtml.includes('id="view-client-host"'), "ntp.html must have #view-client-host");
  assert(ntpHtml.includes('id="directory-view"'), "ntp.html must have #directory-view container");
  assert(ntpHtml.includes('id="directory-rows"'), "ntp.html must have #directory-rows for rendering");
  assert(ntpHtml.includes('id="directory-view" class="directory-view" tabindex="-1"'),
    "#directory-view must be programmatically focusable for a11y focus routing");
});

Deno.test("directory client view: ntp.js mounts Directory natively without iframe", () => {
  const openView = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  assert(openView.includes("const isClientSide = targetRoute === VIEW_ROUTE.DIRECTORY || targetRoute === VIEW_ROUTE.ARTIFACTS;"),
    "openView must identify client-side views");
  assert(openView.includes("if (targetRoute === VIEW_ROUTE.DIRECTORY) {"),
    "openView must branch for VIEW_ROUTE.DIRECTORY");
  assert(openView.includes("renderDirectoryContent(directoryRowsEl"),
    "openView must render Directory into directoryRowsEl directly");
});

Deno.test("directory client view: directory.js exports rendering authority and supports standalone boot", () => {
  assert(directoryJs.includes("export async function renderDirectoryContent("),
    "directory.js must export renderDirectoryContent for client view consumption");
  assert(directoryJs.includes("export async function renderDiscovered("),
    "directory.js must export renderDiscovered");
  assert(directoryJs.includes('document.getElementById("rows")'),
    "directory.js must retain standalone document rows mounting");
});

Deno.test("directory client view: URL addressability and single history entry preserved (C1)", () => {
  assert(ntpJs.includes('if (routePath === "directory/directory.html" || routePath === "directory") return VIEW_ROUTE.DIRECTORY;'),
    "embeddedViewRoute must map directory paths to VIEW_ROUTE.DIRECTORY");
  const openView = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  assert(openView.includes('navigateNtpRoute(window, hash, { route: "view", path, title }, title)'),
    "openView must preserve rooted navigation for client-side views via navigateNtpRoute");
  assert(!openView.includes("history.pushState("),
    "openView must not call raw history.pushState directly");
});

Deno.test("directory client view: hash-restore on reload and traverse-to-unmounted fallthrough (C9)", () => {
  const applyRoute = ntpJs.slice(ntpJs.indexOf("async function applyCurrentHashRoute"), ntpJs.indexOf("// Support browser back/forward navigation"));
  assert(applyRoute.includes("const isClient = targetRoute === VIEW_ROUTE.DIRECTORY || targetRoute === VIEW_ROUTE.ARTIFACTS;"),
    "applyCurrentHashRoute must identify client-side Directory route");
  assert(applyRoute.includes("openView(parsed.path, title, null, { pushHistory: false });"),
    "unmounted view traverse/reload must fall through to openView");
});

Deno.test("directory client view: a11y focus movement on mount and restoration on unmount (C10)", () => {
  const openView = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  assert(openView.includes('focusAfter: activePanelFrame ?? (isClientSide ? (document.getElementById("view-back") ?? (targetRoute === VIEW_ROUTE.DIRECTORY ? directoryViewEl : artifactsViewEl)) : null)'),
    "openView must route focus into client view upon mount");
  const closeView = ntpJs.slice(ntpJs.indexOf("function closeView("), ntpJs.indexOf("// ── Multi-Page App"));
  assert(closeView.includes("viewFocus.close(() => {})"),
    "closeView must restore focus to the initiating trigger upon unmount");
});
