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
      'id="artifact-quick-drawer"',
      'id="open-directory"',
      'id="durable-run-registry"',
      'id="side-toggle"',
      'id="thread-composer"',
    ]
  ) assert(html.includes(marker), `missing composed NTP marker: ${marker}`);

  for (
    const marker of [
      'from "../lib/first-run-onboarding.js"',
      'from "./route-focus.js"',
      "createRouteUpdateRunner",
      "focusExplicitRouteTarget",
      "loadFirstRunGuideState",
      'const artifactQuickDrawer = document.getElementById("artifact-quick-drawer")',
      "attachArtifactToComposer",
      "artifactId: artifact.id ?? id",
      'artifactOrigin: artifact.origin ?? origin ?? "master"',
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

  // An example chip only PREFILLS the real composer (CAP-FB-20260827-HUB-
  // FIRST-RUN-01 replaced the starter-task button with example chips).
  const seedStart = ntp.indexOf('exampleChips?.addEventListener("pick"');
  const seedEnd = ntp.indexOf(
    'firstRunGuide?.addEventListener("dismiss-guide"',
    seedStart,
  );
  assert(seedStart >= 0 && seedEnd > seedStart);
  const seedHandler = ntp.slice(seedStart, seedEnd);
  assert(seedHandler.includes("composer.value = text"));
  assert(seedHandler.includes("composer.focus()"));
  assert(!seedHandler.includes("dispatchEvent"));
  assert(!seedHandler.includes("run-task"));
  assert(!seedHandler.includes("submit"));
});

Deno.test("first-run composition preserves transaction and provider boundaries", async () => {
  const [worker, memory, options, memoryRoutes] = await Promise.all([
    text("../extension/background/service-worker.js"),
    text("../extension/lib/memory.js"),
    text("../extension/options/options.js"),
    // The memory.get/set/list/clear routes (incl. the __tombs reserved-key
    // boundary) live in the extracted module since the teardown r5 review —
    // the boundary is pinned at its real home, not the SW text.
    text("../extension/background/routes/memory.js"),
  ]);
  assert(worker.includes("durableRuns"));
  assert(memoryRoutes.includes("__tombs"));
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
      'customElements.define("artifact-quick-drawer", ArtifactQuickDrawer)',
    ),
  );
  assert(
    components.includes(
      'for (const [action, visible] of [["artifact-open", "Open"], ["artifact-reuse", "Reuse"]])',
    ),
  );
  assert(manifest.sandbox?.pages?.includes("sandbox/artifact-preview.html"));
});

// ── CAP-FB-20260827-HUB-FIRST-RUN-01 — the composer is the first thing ─────
// FALSIFICATION: both tests below were observed RED on the pre-change tree
// (the sidebar preceded <main>; the guide rendered six buttons) and GREEN after.

Deno.test("hub first run: the hub main content precedes the sidebar in DOM order", async () => {
  const html = await text("../extension/ntp/ntp.html");
  const mainAt = html.indexOf("<main");
  const asideAt = html.indexOf("<aside");
  assert(mainAt >= 0 && asideAt >= 0, "both landmarks exist");
  assert(
    mainAt < asideAt,
    `<main> (${mainAt}) must come before <aside> (${asideAt}) so Tab #1 lands in the composer`,
  );
  // The composer is the first focusable thing inside <main>: it precedes the
  // header's status controls and the first-run banner in DOM order.
  const composerAt = html.indexOf('<agent-composer id="composer"');
  const headerAt = html.indexOf('<header class="top"');
  const guideAt = html.indexOf('<first-run-guide id="first-run-guide"');
  assert(composerAt > mainAt, "the composer is inside <main>");
  assert(composerAt < headerAt, "the composer precedes the header's status controls");
  assert(composerAt < guideAt, "the composer precedes the first-run banner");
});

Deno.test("hub first run: the first-run guide renders at most one action button and no stepper", async () => {
  // A recording DOM double (the components.test.ts pattern) — the shadow root
  // keeps what mountTemplate writes so the rendered markup can be inspected.
  const registry = new Map();
  class ShadowRootStub {
    constructor() { this.innerHTML = ""; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    appendChild() {}
  }
  class HTMLElementStub {
    attachShadow(_init) { return new ShadowRootStub(); }
    getAttribute(_n) { return null; }
    hasAttribute(_n) { return false; }
    setAttribute(_n, _v) {}
    removeAttribute(_n) {}
    dispatchEvent(_e) { return true; }
    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  globalThis.HTMLElement = HTMLElementStub;
  globalThis.customElements = {
    define(name, cls) { registry.set(name, cls); },
    get(name) { return registry.get(name); },
  };
  globalThis.window = globalThis;
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
  };
  globalThis.matchMedia = () => ({ matches: false });
  await import("../extension/shared/components.js");
  const FirstRunGuide = registry.get("first-run-guide");
  assert(FirstRunGuide, "first-run-guide is registered");

  const render = (attrs) => {
    const el = new FirstRunGuide();
    el.hasAttribute = (n) => Object.hasOwn(attrs, n);
    el.getAttribute = (n) => attrs[n] ?? null;
    el._render();
    return String(el._root.innerHTML);
  };
  const noProvider = render({ "storage-ready": "" });
  const buttons = noProvider.match(/<button\b[^>]*>/g) ?? [];
  const dismiss = buttons.filter((b) => /aria-label="Dismiss first-run setup"/.test(b));
  const actions = buttons.filter((b) => !/aria-label="Dismiss first-run setup"/.test(b));
  assertEquals(actions.length, 1, `exactly ONE action button (got ${buttons.length} buttons)`);
  assertEquals(dismiss.length, 1, "the dismiss control is still offered");
  assert(
    buttons.indexOf(dismiss[0]) > buttons.indexOf(actions[0]),
    "the dismiss control comes AFTER the action in tab order",
  );
  assert(!/<ol\b/.test(noProvider), "no 3-step stepper");
  for (const banned of ["starter task", "Storage", "Wasm", "enrollment", "Weekly browsing review", "Allow browser control"]) {
    assert(!noProvider.includes(banned), `the banner never says "${banned}"`);
  }
  // With a provider connected the banner has nothing to ask for.
  const ready = render({ "storage-ready": "", "provider-ready": "" });
  assertEquals((ready.match(/<button\b/g) ?? []).length, 0, "a connected profile renders no banner actions");
});
