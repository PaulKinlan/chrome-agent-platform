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
  assert(openView.includes("const isClientSide = targetRoute === VIEW_ROUTE.DIRECTORY || targetRoute === VIEW_ROUTE.ARTIFACTS;"),
    "openView must identify client-side views");
  assert(openView.includes("else if (targetRoute === VIEW_ROUTE.ARTIFACTS) {"),
    "openView must branch for VIEW_ROUTE.ARTIFACTS");
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
  assert(applyRoute.includes("const isClient = targetRoute === VIEW_ROUTE.DIRECTORY || targetRoute === VIEW_ROUTE.ARTIFACTS;"),
    "applyCurrentHashRoute must identify client-side Artifacts route");
  assert(applyRoute.includes("openView(parsed.path, title, null, { pushHistory: false });"),
    "unmounted view traverse/reload must fall through to openView");
});

Deno.test("artifacts client view: a11y focus movement on mount and restoration on unmount (C10)", () => {
  const openView = ntpJs.slice(ntpJs.indexOf("function openView("), ntpJs.indexOf("function closeView("));
  assert(openView.includes('focusAfter: activePanelFrame ?? (isClientSide ? (document.getElementById("view-back") ?? (targetRoute === VIEW_ROUTE.DIRECTORY ? directoryViewEl : artifactsViewEl)) : null)'),
    "openView must route focus into client view upon mount");
  const closeView = ntpJs.slice(ntpJs.indexOf("function closeView("), ntpJs.indexOf("// ── Multi-Page App"));
  assert(closeView.includes("viewFocus.close(() => {})"),
    "closeView must restore focus to the initiating trigger upon unmount");
});

Deno.test("artifacts client view: F2 & F3 dynamic origin resolution and filter reset", () => {
  // F2: parseArtifactParams extracts origin
  const parsedWithOrigin = (artifactsJs.includes("origin = sp.get(\"origin\")") || artifactsJs.includes("origin = sp.get('origin')"));
  assert(parsedWithOrigin, "parseArtifactParams must parse origin parameter");

  // F2: targetOrigin resolution uses asset's origin or param, not master hardcode
  assert(artifactsJs.includes("const targetOrigin = initialParams.origin || targetAsset?.origin || \"master\";"),
    "targetOrigin must resolve from asset metadata or deep-link param, not hardcoded 'master'");

  // F3: filter state resets when params are absent
  assert(artifactsJs.includes("filterKind = initialParams.kind || \"\";"),
    "filterKind must reset to empty string when param is absent");
  assert(artifactsJs.includes("searchQuery = initialParams.search || \"\";"),
    "searchQuery must reset to empty string when param is absent");
  assert(artifactsJs.includes("selectedAssetId = initialParams.id || null;"),
    "selectedAssetId must reset to null when param is absent");
});

Deno.test("artifacts search: final query debounced, filters immediate, pending work cancelled on navigation", () => {
  const inputHandler = artifactsJs.split('searchInput?.addEventListener("input", (e) => {')[1]?.split("kindFilter?.addEventListener")[0];
  assert(inputHandler?.includes("searchQuery = e.target.value.trim();"), "typing must update the query synchronously");
  assert(inputHandler?.includes("pendingSearch?.();"), "typing must schedule only a trailing rebuild");
  assert(!inputHandler?.includes("updateFilteredView()"), "typing must not rebuild the grid on each input");
  assert(artifactsJs.includes("pendingSearch?.cancel(); // A discrete filter choice renders now"),
    "kind selection must cancel a pending typing timer and render immediately");
  assert(artifactsJs.includes("export function teardownArtifactsView()"), "the hub must have a teardown seam");
  assert(ntpJs.includes("function hideViewInner() {\n  teardownArtifactsView();"),
    "closing the hub view must cancel pending search work");
  assert(ntpJs.includes("if (targetRoute !== VIEW_ROUTE.ARTIFACTS) teardownArtifactsView();"),
    "switching directly from Artifacts to another view must cancel pending search work");
});

// 0iln: the live-preview reads used to be awaited one card at a time — up to
// MAX_PREVIEWS = 24 sequential chrome.runtime -> SW -> OPFS round-trips, which is
// the waterfall the perf-review station flagged. This pins the bounded-pool shape
// so the fix cannot rot back into a per-card loop, and it pins it statically
// because a timed browser measurement cannot run wherever Chrome is absent.
Deno.test("artifacts previews: the reads are a bounded pool, not a per-card waterfall (0iln)", () => {
  const cap = Number(artifactsJs.match(/const MAX_PREVIEWS = (\d+);/)?.[1] ?? "0");
  const pool = Number(artifactsJs.match(/const PREVIEW_CONCURRENCY = (\d+);/)?.[1] ?? "0");
  assert(cap > 0, "MAX_PREVIEWS must be declared");
  assert(pool > 0 && pool <= cap,
    `preview concurrency must be declared and bounded by the preview cap (got pool=${pool}, cap=${cap})`);
  assert(artifactsJs.includes("const pending = cards.slice(0, MAX_PREVIEWS);"),
    "the preview jobs must be collected into a pending list");
  assert(artifactsJs.includes("for (let job = pending.shift(); job; job = pending.shift())"),
    "bounded workers must drain the pending list");
  assert(artifactsJs.includes("await Promise.all(workers)"),
    "the pool must be awaited as a whole, not one read at a time");
  assert(!artifactsJs.includes("for (const { card, a } of cards.slice(0, MAX_PREVIEWS))"),
    "the per-card sequential waterfall must not come back (0iln)");
  assert(!artifactsJs.includes('full.asset.type === "image" ?'),
    "the no-op image ternary must not come back (0iln)");
});
