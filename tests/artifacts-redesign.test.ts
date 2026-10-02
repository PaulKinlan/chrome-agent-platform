// tests/artifacts-redesign.test.ts — Unit, DOM and behavioral assertions for bead chrome-agent-platform-qvve:
// Redesigned Artifacts gallery and <artifact-card> with scaled desktop previews,
// non-wrapping buttons, wide split inspector, and search/type filters.
import { assert, assertEquals } from "jsr:@std/assert@1";

// Stub browser globals for component testing if not present
if (!(globalThis as any).HTMLElement) {
  (globalThis as any).HTMLElement = class HTMLElementStub {
    attachShadow() { return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], appendChild() {} }; }
    getAttribute() { return null; }
    hasAttribute() { return false; }
    setAttribute() {}
    removeAttribute() {}
    dispatchEvent() { return true; }
    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
  };
}
if (!(globalThis as any).customElements) {
  const registry = new Map();
  (globalThis as any).customElements = {
    define(name: string, cls: any) { registry.set(name, cls); },
    get(name: string) { return registry.get(name); },
  };
}
if (!(globalThis as any).CustomEvent) {
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init: any = {}) { this.type = type; this.detail = init.detail ?? {}; }
  };
}

const { formatArtifactSize, formatArtifactType, injectFrameGuards, renderHtmlFrame } = await import("../extension/shared/components.js");

Deno.test("qvve: formatArtifactSize formats bytes truthfully into human-readable units", () => {
  assertEquals(formatArtifactSize(500), "500 B");
  assertEquals(formatArtifactSize(0), "0 B");
  assertEquals(formatArtifactSize(1023), "1023 B");
  assertEquals(formatArtifactSize(1024), "1 KB");
  assertEquals(formatArtifactSize(90732), "88.6 KB");
  assertEquals(formatArtifactSize(1048576), "1 MB");
  assertEquals(formatArtifactSize(1572864), "1.5 MB");
  assertEquals(formatArtifactSize(10485760), "10 MB");
});

Deno.test("qvve: formatArtifactType produces clean title badges for artifact kinds", () => {
  assertEquals(formatArtifactType("html"), "HTML");
  assertEquals(formatArtifactType("markdown"), "Markdown");
  assertEquals(formatArtifactType("md"), "Markdown");
  assertEquals(formatArtifactType("json"), "JSON");
  assertEquals(formatArtifactType("csv"), "CSV");
  assertEquals(formatArtifactType("text"), "Text");
  assertEquals(formatArtifactType("data"), "Data");
  assertEquals(formatArtifactType("image"), "Image");
});

Deno.test("qvve: injectFrameGuards and renderHtmlFrame suppress scrollbars for thumbnail previews", () => {
  const nonce = "test-thumb-nonce";
  const guardedThumb = injectFrameGuards("<div>content</div>", nonce, { thumbnail: true });
  assert(guardedThumb.includes('data-cap-thumb="1"'), "must include data-cap-thumb marker");
  assert(guardedThumb.includes("overflow:hidden!important"), "must inject overflow:hidden style in thumbnail");
  assert(guardedThumb.includes("scrollbar-width:none!important"), "must inject scrollbar-width:none in thumbnail");

  // Non-thumbnail must NOT have the thumbnail style
  const guardedNormal = injectFrameGuards("<div>content</div>", nonce, { thumbnail: false });
  assert(!guardedNormal.includes('data-cap-thumb="1"'), "normal preview must not have thumbnail style");

  // renderHtmlFrame with thumbnail: true includes scrolling="no"
  const thumbMarkup = renderHtmlFrame("<div>content</div>", { nonce, thumbnail: true });
  assert(thumbMarkup.includes('scrolling="no"'), "thumbnail iframe must declare scrolling='no'");

  const normalMarkup = renderHtmlFrame("<div>content</div>", { nonce, thumbnail: false });
  assert(!normalMarkup.includes('scrolling="no"'), "normal iframe must not declare scrolling='no'");
});

Deno.test("qvve: <artifact-card> CSS scales desktop viewports, suppresses wrapping, and formats size", async () => {
  const ArtifactCardClass = (globalThis as any).customElements.get("artifact-card");
  assert(ArtifactCardClass, "artifact-card must be defined in customElements");

  let renderedMarkup = "";
  const shadow = {
    _html: "",
    set innerHTML(v: string) {
      this._html = v;
      renderedMarkup = v;
    },
    get innerHTML() { return this._html; },
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const host: any = {
    constructor: ArtifactCardClass,
    _root: shadow,
    _rendered: false,
    _preview: "<!doctype html><html><body>Report</body></html>",
    getAttribute(name: string) {
      if (name === "id") return "asset-test-1";
      if (name === "name") return "Social Media Radar";
      if (name === "type") return "html";
      if (name === "size") return "90732";
      if (name === "origin") return "master";
      if (name === "actions") return "";
      return null;
    },
    _emit() {},
  };

  ArtifactCardClass.prototype._render.call(host);

  // Scaled desktop iframe rules
  assert(renderedMarkup.includes("width:250%") || renderedMarkup.includes("width: 250%"), "iframe width must be 250%");
  assert(renderedMarkup.includes("height:250%") || renderedMarkup.includes("height: 250%"), "iframe height must be 250%");
  assert(renderedMarkup.includes("transform:scale(0.4)") || renderedMarkup.includes("transform: scale(0.4)"), "iframe transform must scale down 0.4");
  assert(renderedMarkup.includes("height:188px") || renderedMarkup.includes("height: 188px"), "preview container height must be 188px");

  // Non-wrapping action buttons
  assert(renderedMarkup.includes("white-space:nowrap") || renderedMarkup.includes("white-space: nowrap"), "actions button must specify white-space: nowrap");
  assert(renderedMarkup.includes("flex-wrap:nowrap") || renderedMarkup.includes("flex-wrap: nowrap"), "actions container must specify flex-wrap: nowrap");

  // Single-word Save label with full title and aria-label
  assert(renderedMarkup.includes('data-act="save"'), "must have save action button");
  assert(renderedMarkup.includes("<span>Save</span>"), "visible save button text must be 'Save'");
  assert(renderedMarkup.includes('title="Save to disk"'), "save button title must be 'Save to disk'");

  // Formatted byte size in metadata
  assert(renderedMarkup.includes("88.6 KB"), "metadata must display formatted size 88.6 KB instead of 90732 B");

  // Floating type badge
  assert(renderedMarkup.includes('class="type-badge"'), "must include type-badge element");
  assert(renderedMarkup.includes(">HTML<"), "type-badge must display HTML");
});

Deno.test("qvve: extension/artifacts/index.html adopts wide 1680px layout, search, kind filter, and split inspector", async () => {
  const html = await Deno.readTextFile("extension/artifacts/index.html");

  assert(html.includes("max-inline-size: 1680px"), "index.html must set max-inline-size: 1680px");
  assert(html.includes('id="q"'), "index.html must include search input #q");
  assert(html.includes('id="kind"'), "index.html must include kind pills #kind");
  assert(html.includes('id="artifact-inspector"'), "index.html must include #artifact-inspector aside");
  assert(html.includes('id="artifacts-workspace"'), "index.html must include #artifacts-workspace container");
});

Deno.test("qvve: index.js implements search and kind filtering + responsive inspector wiring", async () => {
  const js = await Deno.readTextFile("extension/artifacts/index.js");

  assert(js.includes("matchesFilter") || js.includes("filter"), "must implement artifact filtering");
  assert(js.includes("artifact-inspector") || js.includes("openArtifactInspector"), "must support inspector side-pane");
  assert(js.includes("formatArtifactSize"), "must use formatArtifactSize for consistent size rendering");
  assert(js.includes("openArtifactDialog"), "must retain openArtifactDialog fallback");
  assert(js.includes("frameCleanups.forEach") && js.includes("wireHtmlFrameContent"), "must retain frame cleanup invariants");
});
