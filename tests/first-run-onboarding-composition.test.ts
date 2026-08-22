// @ts-nocheck — source composition checks intentionally read shipped source bytes.
import { assert, assertEquals } from "jsr:@std/assert@1";

async function text(path: string) {
  return await Deno.readTextFile(new URL(path, import.meta.url));
}

Deno.test("first-run composition leaves the current release identity unchanged", async () => {
  const [pkg, lock, manifest] = await Promise.all([
    text("../package.json").then(JSON.parse),
    text("../package-lock.json").then(JSON.parse),
    text("../extension/manifest.json").then(JSON.parse),
  ]);
  // Release-agnostic identity: every release surface carries ONE semver-valid
  // version (the post-commit hook allocates it; no test may hardcode it).
  assert(
    typeof pkg.version === "string" && /^\d+\.\d+\.\d+$/.test(pkg.version),
    `package.json version must be semantic, got ${pkg.version}`,
  );
  assertEquals(lock.version, pkg.version);
  assertEquals(lock.packages[""].version, pkg.version);
  assertEquals(manifest.version, pkg.version);
  assertEquals(manifest.version_name, pkg.version);
});

Deno.test("first-run composition preserves current run, transition, Directory and Durable surfaces", async () => {
  const [html, js] = await Promise.all([
    text("../extension/ntp/ntp.html"),
    text("../extension/ntp/ntp.js"),
  ]);
  for (
    const marker of [
      'id="first-run-guide"',
      'id="asset-quick-drawer"',
      'id="open-directory"',
      'id="durable-run-registry"',
      'id="side-toggle"',
      'id="thread-composer"',
      "::view-transition-old(overlay-view)",
    ]
  ) assert(html.includes(marker), `missing composed NTP marker: ${marker}`);

  for (
    const marker of [
      'from "../lib/first-run-onboarding.js"',
      'from "./view-transition.js"',
      "createViewTransitionRunner",
      "focusExplicitRouteTarget",
      "loadFirstRunGuideState",
      'const assetQuickDrawer = document.getElementById("asset-quick-drawer")',
      "attachAssetToComposer",
      "artifactId: asset.id ?? id",
      'artifactOrigin: asset.origin ?? origin ?? "master"',
      "recordAuthoritativeThreadProjection",
      "clearAuthoritativeThreadProjection",
      "side.inert = fullViewOpen",
      'side.setAttribute("aria-hidden", "true")',
      "applySidebarNubPolicy(",
      'openView("directory/directory.html", "Directory", event.currentTarget)',
    ]
  ) assert(js.includes(marker), `missing composed NTP behavior: ${marker}`);
});

Deno.test("first-run fragment navigation retains Settings route and explicit focus ownership", async () => {
  const ntp = await text("../extension/ntp/ntp.js");
  assert(
    ntp.includes('const routePath = String(path ?? "").split(/[?#]/, 1)[0]'),
  );
  assert(
    ntp.includes(
      'openView("options/options.html#providers", "Provider settings"',
    ),
  );
  assert(ntp.includes("viewFocus.open(trigger"));
  assert(ntp.includes("firstRunGuide.focusNextAction?.()"));
});

Deno.test("first-run composition redacts setup state and only prefills the real composer", async () => {
  const [worker, providerRoutes, ntp] = await Promise.all([
    text("../extension/background/service-worker.js"),
    text("../extension/background/routes/provider.js").catch(() => ""),
    text("../extension/ntp/ntp.js"),
  ]);
  const providerSrc = providerRoutes || worker;
  const summaryStart = providerSrc.indexOf('async "provider.summary"()');
  const summaryEnd = providerSrc.indexOf(
    'async "provider.permission-summary"()',
    summaryStart,
  );
  assert(summaryStart >= 0 && summaryEnd > summaryStart);
  const summaryRoute = providerSrc.slice(summaryStart, summaryEnd);
  assert(summaryRoute.includes("configured: keyedProviderConfigured(cfg)"));
  assert(!/return\s*\{[^}]*apiKey/s.test(summaryRoute));
  assert(!/return\s*\{[^}]*model/s.test(summaryRoute));

  const seedStart = ntp.indexOf('firstRunGuide?.addEventListener("seed-task"');
  const seedEnd = ntp.indexOf(
    'firstRunGuide?.addEventListener("dismiss-guide"',
    seedStart,
  );
  assert(seedStart >= 0 && seedEnd > seedStart);
  const seedHandler = ntp.slice(seedStart, seedEnd);
  assert(seedHandler.includes("composer.value = FIRST_RUN_TASK_PROMPT"));
  assert(seedHandler.includes("composer.focus()"));
  assert(!seedHandler.includes("dispatchEvent"));
  assert(!seedHandler.includes("run-task"));
  assert(!seedHandler.includes("submit"));
});

Deno.test("first-run composition preserves transaction and provider boundaries", async () => {
  const [worker, memory, options] = await Promise.all([
    text("../extension/background/service-worker.js"),
    text("../extension/lib/memory.js"),
    text("../extension/options/options.js"),
  ]);
  assert(worker.includes("durableRuns"));
  assert(worker.includes("__tombs"));
  assert(worker.includes("attachmentContext(attachments)"));
  assert(memory.includes("run-registry"));
  assert(options.includes("runOwnerApprovedMutation"));
  assert(options.includes("blockSessionOnlyCredentialSave"));

  const [components, manifest] = await Promise.all([
    text("../extension/shared/components.js"),
    text("../extension/manifest.json").then(JSON.parse),
  ]);
  assert(
    components.includes(
      'chrome.runtime.getURL("sandbox/artifact-preview.html")',
    ),
  );
  assert(components.includes('sandbox="allow-scripts"'));
  assert(
    components.includes(
      'customElements.define("artifact-inspector", ArtifactInspector)',
    ),
  );
  assert(
    components.includes(
      'customElements.define("asset-quick-drawer", AssetQuickDrawer)',
    ),
  );
  assert(
    components.includes(
      'for (const [action, visible] of [["asset-open", "Open"], ["asset-reuse", "Reuse"]])',
    ),
  );
  assert(manifest.sandbox?.pages?.includes("sandbox/artifact-preview.html"));
});
