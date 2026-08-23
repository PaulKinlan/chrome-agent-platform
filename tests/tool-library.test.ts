// @ts-nocheck — source-contract tests intentionally read shipped source bytes.
// CAP-FB-20260822-TOOL-LIBRARY-UI-01 (panel-1 slice): the <tool-library>
// component is a READ-ONLY owner diagnostics surface. These tests pin the HARD
// boundary — no events, no buttons, no action verbs, no network, no
// permissions, no signer-verification claims — plus the Settings wiring
// contract, the gallery specimens, and the layout/a11y rules. No Chrome.
import { assert, assertEquals, assertMatch, assertNotMatch } from "jsr:@std/assert@1";

async function text(path: string) {
  return await Deno.readTextFile(new URL(path, import.meta.url));
}

// The exact component block (from its banner comment to its define call).
async function componentSource() {
  const source = await text("../extension/shared/components.js");
  const start = source.indexOf("<tool-library> — READ-ONLY owner diagnostics");
  const end = source.indexOf('customElements.define("tool-library"');
  assert(start > 0 && end > start, "the tool-library component block must exist");
  return source.slice(start, end);
}

Deno.test("tool-library: registered component with the tool selector + ONE explicit-owner-click control", async () => {
  const block = await componentSource();
  // The ONLY interactive paths: the tool selector (help refresh) + the Run
  // button (explicit owner click).
  assertMatch(block, /class="preview-run"/, "the single preview Run button exists");
  assertMatch(block, /class="preview-tool"/, "the tool selector exists");
  const selectorOrder = ["csvtool", "uuid", "head", "tail", "cut", "base64", "md5sum", "sha256sum", "sha512sum", "wc", "xxd", "sort", "uniq", "tr", "grep", "toml2json", "markdown", "diff", "patch", "stat", "du", "tree"];
  for (const toolId of selectorOrder) {
    assertMatch(block, new RegExp(`option value="${toolId}"`), `option ${toolId} present`);
  }
  const actualSelectorOrder = [...block.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assertEquals(actualSelectorOrder, selectorOrder, "selector order is exact and du is appended after all 20 predecessors");
  assertMatch(block, /LEGACY — NOT for security/, "the md5sum label warns legacy/not security");
  assertMatch(block, /args "\/job\/inputs\/f\.bin"/, "stat help gives the exact immutable-seed guest path");
  assertMatch(block, /leave args empty for the immutable "\/job" default/, "du help names its safe immutable default");
  assertMatch(block, /read-only deterministic inputs\/f\.bin seed/, "du help names its bounded deterministic seed");
  assertNotMatch(block, /type="file"|showOpenFilePicker|upload/i, "du/stat add no picker/upload authority");
  // the two-document mode hides BOTH the normal Arguments and Stdin controls
  assertMatch(block, /const argsLabel = this\._root\.querySelector\("\.preview-args-label"\)/, "the args label is queried for the toggle");
  assertMatch(block, /if \(argsLabel\) argsLabel\.hidden = twoDocMode/, "the args control hides in two-document mode");
  assertMatch(block, /if \(stdinLabel\) stdinLabel\.hidden = twoDocMode/, "the stdin control hides in two-document mode");
  // the preview section uses DURABLE truthful copy — it must never enumerate a
  // stale hardcoded tool list (it would rot as the allowlist grows)
  assertMatch(block, /The selector below lists the technically admitted Settings previews/, "durable selector copy");
  assertNotMatch(block, /\(csvtool, uuid, head, tail, cut\)/, "no stale five-tool enumeration in the preview copy");
  assertMatch(block, /_emit\("tool-preview-request"/, "the component emits exactly the preview-request event");
  assertMatch(block, /toolId, args, stdin, sourceEvent/, "the preview request carries the toolId");
  assertEquals((block.match(/<button/g) ?? []).length, 1, "exactly one button (the preview-run)");
  assertNotMatch(block, /createElement\("button"/, "no programmatic buttons");
  assertNotMatch(block, /\bfetch\s*\(|XMLHttpRequest|new WebSocket|sendMessage/, "the component performs no network/message calls itself");
  assertNotMatch(block, /chrome\.permissions/, "the component touches no permissions");
  // No OTHER action verbs as affordances in the component's markup/copy (Run is
  // the single permitted explicit-owner-click affordance).
  const otherActions = block.match(/>\s*(?:Install|Update|Revoke|Grant|Execute|Verify|Copy|Download|Remove|Enable|Disable)\s*</g) ?? [];
  assertEquals(otherActions.length, 0, "no other action controls in markup");
});

Deno.test("tool-library: truthful framing + no verification claim can exist", async () => {
  const block = await componentSource();
  assertMatch(block, /read-only diagnostic view/i, "the anti-overclaim framing line is present");
  assertMatch(block, /cannot run, install, grant, update, or remove/i, "the framing names the absent actions");
  // The preview console itself re-states the bounded scope truthfully.
  assertMatch(block, /Runs\s+ONLY on your\s+explicit click/, "the preview console states the explicit-owner-click contract");
  assertMatch(block, /no catalog or provider selection authority/, "no selection authority is claimed");
  // There is no signature-verification path in this build, so no USER-VISIBLE
  // copy may carry a verification claim. (The authority's field NAME
  // `trustedReplaySafety` is API vocabulary in code, not a rendered claim —
  // scope the check to rendered copy: the template + textContent literals.)
  const renderedCopy = [
    ...block.matchAll(/textContent = `([^`]*)`/g),
    ...block.matchAll(/textContent = "([^"]*)"/g),
    ...block.matchAll(/>([^<>{}]{6,})</g),
  ].map((m) => m[1]).join("\n");
  assertNotMatch(renderedCopy, /\bverified\b|\btrusted\b/i, "no 'verified'/'trusted' claim in rendered copy");
  assertMatch(block, /No bundled Wasm packages are admitted in this build\./, "panel 2 is the static truthful no-package line");
  assertNotMatch(block, /wasm-package-authority|registry\.read/, "panel 2 imports/uses NO registry route or authority lib");
});

Deno.test("tool-library: state machine + live-region-once + diagnostics vocabulary", async () => {
  const block = await componentSource();
  for (const state of ["loading", "ready", "error", "unavailable"]) {
    assert(block.includes(`"${state}"`), `state ${state} handled`);
  }
  assertMatch(block, /role=\\?"status\\?"[^>]*aria-live=\\?"polite\\?"[^>]*aria-atomic=\\?"true\\?"/, "one polite atomic status region");
  assert(block.includes("_announcedState"), "live-region-once guard present (announce per transition, not per render)");
  assertMatch(block, /Mount ONCE/, "mount-once: the live region must be a stable node (re-render rebuilds only .catalog)");
  assertMatch(block, /host\.replaceChildren\(\)/, "re-renders clear only the catalog container, never the status line");
  // The authority's diagnostics vocabulary made legible.
  assertMatch(block, /claimed by more than one source — all excluded/, "collision exclusion line");
  assertMatch(block, /rejected by validation \(fail-closed\)/, "fail-closed rejection line");
  assertMatch(block, /Grants created: /, "selection diagnostics rendered verbatim (grants stay 0)");
  assertMatch(block, /groups\.className = "groups"/, "source groups receive the class consumed by layout and browser census");
  // Availability chips cover the authority's full vocabulary.
  for (const avail of ["ready", "owner-action-required", "stale", "disabled"]) {
    assert(block.includes(avail), `availability ${avail} covered`);
  }
  // Digests truncate with the full value only in title (no copy control).
  assertMatch(block, /slice\(0, 12\)/, "digest truncation present");
  assertMatch(block, /digest\.title = full/, "full digest only via title");
});

Deno.test("tool-library: responsive/RTL/theme rules are logical-property only", async () => {
  const block = await componentSource();
  assertNotMatch(block, /(?:^|[\s{;])(?:margin-left|margin-right|padding-left|padding-right|border-left|border-right)\s*:/, "no physical inline properties (RTL-safe by construction)");
  assertMatch(block, /@media \(max-width:560px\)/, "narrow reflow breakpoint present");
  assertMatch(block, /min-inline-size:0|min-inline-size: 0/, "shrink-safe rows");
  assertMatch(block, /overflow-wrap:anywhere/, "unbreakable digest/meta strings wrap");
  assertMatch(block, /var\(--accent|var\(--border/, "design tokens consumed");
});

Deno.test("tool-library: Settings section + wiring use ONLY the existing shadow summary", async () => {
  const html = await text("../extension/options/options.html");
  const nav = html.indexOf('data-section="tool-library"');
  const localModels = html.indexOf('data-section="local-models"');
  assert(localModels > 0 && nav > localModels && nav < html.indexOf('data-section="agents"'), "nav item sits between Local models and Agents");
  const section = html.slice(html.indexOf('id="tool-library"'), html.indexOf('id="tool-library"') + 700);
  assertNotMatch(section, /<button/, "the section markup contains no buttons");
  assertMatch(section, /Read-only diagnostics/, "the section carries the truthful intro");
  assertMatch(section, /id="tool-library-view"/, "the component has its own distinct id (no duplicate-id ambiguity)");
  assertEquals([...html.matchAll(/id="tool-library"/g)].length, 1, "exactly one #tool-library id (the section)");

  const js = await text("../extension/options/options.js");
  assertMatch(js, /renderToolLibrary/, "the wiring exists");
  assertMatch(js, /type:\s*"tool-catalog\.shadow"[\s\S]{0,80}action:\s*"summary"/, "the wiring requests ONLY the summary action");
  assertNotMatch(js, /action:\s*"search"|action:\s*"capture"|action:\s*"resolve"/, "no search/capture/resolve in this slice");
  const fnStart = js.indexOf("async function renderToolLibrary");
  const fnEnd = js.indexOf("async function renderLocalModels");
  const fn = js.slice(fnStart, fnEnd);
  // The ONLY listener in the Tool Library wiring: the preview-request handler.
  assertMatch(fn, /tool-preview-request/, "the wiring handles the explicit preview click");
  assertMatch(fn, /tool\.preview\.run/, "the wiring calls ONLY the csvtool preview route");
  assertMatch(fn, /unavailable/, "older-worker unavailable state handled");
});

Deno.test("tool-library: gallery specimens exercise every state without a backend", async () => {
  const gallery = await text("../docs/components.html");
  for (const id of ["tl-ready", "tl-rows", "tl-loading", "tl-error", "tl-unavailable", "tl-empty"]) {
    assert(gallery.includes(`id="${id}"`), `specimen ${id} present`);
  }
  const specimen = gallery.slice(gallery.indexOf('id="tool-library-specimen"'), gallery.indexOf('id="tool-library-specimen"') + 900);
  assertNotMatch(specimen, /<button/, "the specimen markup contains no buttons");
  // The fixture data covers the diagnostics vocabulary.
  assert(gallery.includes("collisions: 2"), "collision-exclusion fixture");
  assert(gallery.includes("grantsCreated: 0"), "zero-grants truth fixture");
  assert(gallery.includes('"owner-action-required"') && gallery.includes('"stale"'), "availability fixtures");
});

Deno.test("tool-library: the component registers with the design system", async () => {
  const source = await text("../extension/shared/components.js");
  assertMatch(source, /customElements\.define\("tool-library", ToolLibrary\)/, "registered");
});

// ── TDZ regression (browser gate): render with settingsPreviewCsvtool:true ──
// The preview reveal must not touch `s` before `const s = this._summary`
// (a Temporal-Dead-Zone ReferenceError). This test INVOKES the real _render
// with a stub shadow DOM — not just a string scan.

Deno.test("tool-library: _render with settingsPreviewTools revealing csvtool does not throw (TDZ regression)", async () => {
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ""; this.className = ""; this.hidden = false; this.attrs = {}; this.classes = new Set(); }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    get classList() { return { toggle: (_c, _v) => {}, add: (_c) => {}, remove: (_c) => {} }; }
  }
  const registry = new Map();
  const previewEl = new El("div");
  const statusEl = new El("p");
  const catalogEl = new El("div");
  const bySelector = new Map([
    [".status-line", statusEl],
    [".catalog", catalogEl],
    [".preview", previewEl],
  ]);
  const shadow = {
    _html: "",
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    querySelector(sel) { return bySelector.get(sel) ?? null; },
    querySelectorAll() { return []; },
  };
  globalThis.HTMLElement = class {
    attachShadow() { return shadow; }
    addEventListener() {}
    dispatchEvent() { return true; }
    getAttribute() { return null; }
    hasAttribute() { return false; }
  };
  globalThis.customElements = {
    define(name, cls) { registry.set(name, cls); },
    get(name) { return registry.get(name); },
  };
  globalThis.window = globalThis;
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; } };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.document = {
    createElement: (tag) => new El(tag),
    querySelector: () => null,
    head: { appendChild() {} },
    getElementById: () => null,
  };

  const mod = await import("../extension/shared/components.js?tdz-regression");
  const ToolLibraryClass = mod.ToolLibrary ?? registry.get("tool-library");
  assert(ToolLibraryClass, "ToolLibrary class exported/registered");
  const library = Object.create(ToolLibraryClass.prototype);
  library._root = shadow;
  library._rendered = false;
  library._state = "ready";
  library._announcedState = "";
  library._error = "";
  library._results = null;
  library._summary = null;
  // The TDZ path: setting the summary with settingsPreviewCsvtool:true MUST
  // render without throwing and MUST reveal the preview panel.
  let threw = null;
  try {
    library.summary = { settingsPreviewTools: ["csvtool", "cut", "head", "tail", "uuid"], descriptorCount: 25, bySource: {}, catalogDiagnostics: {}, selectionDiagnostics: {} };
    library.state = "ready";
  } catch (error) {
    threw = error;
  }
  assertEquals(threw, null, `render must not throw (TDZ regression): ${threw?.message ?? threw}`);
  assertEquals(previewEl.hidden, false, "the preview panel must be revealed when csvtool is in settingsPreviewTools");

  // The negative path: without the list the panel stays hidden.
  previewEl.hidden = true;
  library.summary = { descriptorCount: 25, bySource: {}, catalogDiagnostics: {}, selectionDiagnostics: {} };
  assertEquals(previewEl.hidden, true, "the preview panel stays hidden without the list");
});
