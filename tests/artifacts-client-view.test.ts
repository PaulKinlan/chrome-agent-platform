// tests/artifacts-client-view.test.ts — contract tests for Stage 2 of the view-frame collapse.
// Asserts that Artifacts renders as a native client-side view inside the Hub DOM without an iframe.
import { assert, assertEquals } from "jsr:@std/assert@1";

const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
const ntpHtml = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
const artifactsJs = await Deno.readTextFile(new URL("../extension/artifacts/index.js", import.meta.url));

Deno.test("artifacts client view: ntp.html contains client-side view host and artifacts container", () => {
  assert(ntpHtml.includes('id="view-client-host"'), "ntp.html must have #view-client-host");
  assert(ntpHtml.includes('id="artifacts-view"'), "ntp.html must have #artifacts-view container");
  assert(ntpHtml.includes('id="artifacts-grid"'), "ntp.html must have #artifacts-grid for rendering");
  assert(ntpHtml.includes('id="artifacts-capacity"'), "ntp.html must have #artifacts-capacity");
  assert(ntpHtml.includes('id="artifacts-toolbar"'), "ntp.html must have #artifacts-toolbar");
  assert(ntpHtml.includes('id="artifacts-q"'), "ntp.html must have #artifacts-q");
  assert(ntpHtml.includes('id="artifacts-kind"'), "ntp.html must have #artifacts-kind");
  assert(ntpHtml.includes('id="artifacts-workspace"'), "ntp.html must have #artifacts-workspace");
  assert(ntpHtml.includes('id="artifact-inspector"'), "ntp.html must have #artifact-inspector aside");
  assert(ntpHtml.includes('id="artifacts-view" class="artifacts-view" tabindex="-1"'),
    "#artifacts-view must be programmatically focusable for a11y focus routing");
});

Deno.test("artifacts client view: ntp.js mounts Artifacts natively without iframe", () => {
  const openView = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  assert(openView.includes("targetRoute === VIEW_ROUTE.ARTIFACTS"),
    "openView must identify VIEW_ROUTE.ARTIFACTS as a client-side view");
  assert(openView.includes("renderArtifactsView(artifactsViewEl"),
    "openView must render Artifacts into artifactsViewEl directly");
});

Deno.test("artifacts client view: artifacts/index.js exports rendering authority and supports standalone boot", () => {
  assert(artifactsJs.includes("export async function renderArtifactsView("),
    "artifacts/index.js must export renderArtifactsView for client view consumption");
  assert(artifactsJs.includes("export function matchesFilter("),
    "artifacts/index.js must export matchesFilter");
  assert(artifactsJs.includes("export async function renderCapacity("),
    "artifacts/index.js must export renderCapacity");
  assert(artifactsJs.includes("export function parseArtifactParams("),
    "artifacts/index.js must export parseArtifactParams");
  assert(artifactsJs.includes("export async function openArtifactInspector("),
    "artifacts/index.js must export openArtifactInspector");
  assert(artifactsJs.includes("export function closeArtifactInspector("),
    "artifacts/index.js must export closeArtifactInspector");
  assert(artifactsJs.includes("export async function openArtifactDialog("),
    "artifacts/index.js must export openArtifactDialog");
  assert(artifactsJs.includes('document.getElementById("grid")'),
    "artifacts/index.js must retain standalone document grid mounting");
});

Deno.test("artifacts client view: URL addressability and deep linking support (C1)", () => {
  assert(ntpJs.includes('if (routePath === "artifacts/index.html" || routePath === "artifacts" || routePath.startsWith("artifacts&")) return VIEW_ROUTE.ARTIFACTS;'),
    "embeddedViewRoute must map artifacts paths to VIEW_ROUTE.ARTIFACTS");
  const openView = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  assert(openView.includes('navigateNtpRoute(window, hash, { route: "view", path, title }, title)'),
    "openView must preserve rooted navigation for client-side views via navigateNtpRoute");
  assert(!openView.includes("history.pushState("),
    "openView must not call raw history.pushState directly");
});

Deno.test("artifacts client view: hash-restore on reload and traverse-to-unmounted fallthrough (C9)", () => {
  const applyRoute = ntpJs.slice(ntpJs.indexOf("async function applyCurrentHashRoute"), ntpJs.indexOf("// Support browser back/forward navigation"));
  assert(applyRoute.includes("VIEW_ROUTE.ARTIFACTS"),
    "applyCurrentHashRoute must identify client-side Artifacts route");
  assert(applyRoute.includes("openView(parsed.path, title, null, { pushHistory: false });"),
    "unmounted view traverse/reload must fall through to openView");
});

Deno.test("artifacts client view: a11y focus movement on mount and restoration on unmount (C10)", () => {
  const openView = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  assert(openView.includes("artifactsViewEl"),
    "openView must route focus into client view upon mount");
  const closeView = ntpJs.slice(ntpJs.indexOf("function closeView("), ntpJs.indexOf("// ── Multi-Page App"));
  assert(closeView.includes("viewFocus.close(() => {})"),
    "closeView must restore focus to the initiating trigger upon unmount");
});
