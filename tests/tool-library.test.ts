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
  const selectorOrder = ["csvtool", "uuid", "head", "tail", "cut", "base64", "md5sum", "sha256sum", "sha512sum", "wc", "xxd", "sort", "uniq", "tr", "grep", "toml2json", "markdown", "diff", "patch", "stat", "du", "tree", "gzip", "truncate"];
  for (const toolId of selectorOrder) {
    assertMatch(block, new RegExp(`option value="${toolId}"`), `option ${toolId} present`);
  }
  const toolSelectMarkup = block.slice(block.indexOf('class="preview-tool"'), block.indexOf("</select>", block.indexOf('class="preview-tool"')));
  const actualSelectorOrder = [...toolSelectMarkup.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assertEquals(actualSelectorOrder, selectorOrder, "selector order is exact and truncate is appended after gzip as tool 24");
  assertMatch(block, /LEGACY — NOT for security/, "the md5sum label warns legacy/not security");
  assertMatch(block, /args "\/job\/inputs\/f\.bin"/, "stat help gives the exact immutable-seed guest path");
  assertMatch(block, /leave args empty for the immutable "\/job" default/, "du help names its safe immutable default");
  assertMatch(block, /read-only deterministic inputs\/f\.bin seed/, "du help names its bounded deterministic seed");
  assertNotMatch(block, /type="file"|showOpenFilePicker|upload/i, "gzip/du/stat add no picker/upload authority");
  assertMatch(block, /gzip — compress or decompress data streams/, "gzip selector label matches the Unix-name-first naming");
  assertMatch(block, /class="preview-gzip-mode"/, "gzip-only native mode select exists");
  assertMatch(block, /option value="compress">Compress text/, "compress text mode exists");
  assertMatch(block, /option value="decompress">Decompress base64/, "decompress base64 mode exists");
  assertMatch(block, /mode === "decompress" \? \["-d"\] : \[\]/, "gzip argv is derived from the exact mode only");
  assertMatch(block, /argsLabel\.hidden = twoDocMode \|\| gzipMode \|\| truncateMode/, "free-form arguments hide for gzip, truncate and two-document tools");
  assertMatch(block, /gzipControls\.hidden = !gzipMode/, "gzip mode control is restored/hidden on tool switches");
  assertMatch(block, /truncateControls\.hidden = !truncateMode/, "truncate controls are restored/hidden on tool switches");
  assertMatch(block, /class="preview-truncate-size"/, "truncate-only bounded size control exists");
  assertMatch(block, /class="preview-truncate-no-create"/, "truncate-only no-create checkbox exists");
  assertMatch(block, /\["-s", size, "\/job\/scratch\/touched"\]/, "truncate argv is the spec-owned fixture resize only");
  assertMatch(block, /this\.previewResult = null/, "tool/mode switches clear stale output");
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
  assertMatch(block, /out\.textContent = text/, "gzip base64 is rendered inertly through textContent");
  assertNotMatch(block, /navigator\.clipboard|Blob\s*\(|URL\.createObjectURL|download\s*=|innerHTML\s*=/, "gzip adds no export, clipboard, Blob or HTML sink");
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
  assertMatch(block, /width:100%|inline-size:100%/, "mode/select/input controls remain narrow-layout bounded");
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

// Execute the real ToolLibrary._wire change callbacks. This catches lexical
// binding defects that a source-string assertion cannot (the original gzip
// handler referenced the click callback's block-scoped stdinInput).
Deno.test("tool-library: gzip tool/mode handlers update controls and restore generic mode without throwing", async () => {
  class FakeElement {
    constructor(value = "") {
      this.value = value;
      this.hidden = false;
      this.placeholder = "";
      this.textContent = "";
      this.listeners = new Map();
      this.attrs = {};
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type) { this.listeners.get(type)?.({ target: this }); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    setAttribute(name, value) { this.attrs[name] = value; }
    scrollIntoView() {}
    get classList() { return { toggle() {}, add() {}, remove() {}, contains() { return false; } }; }
  }

  const registry = new Map();
  globalThis.HTMLElement = class {
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
    createElement: (tag) => new FakeElement(tag),
    querySelector: () => null,
    head: { appendChild() {} },
    getElementById: () => null,
  };

  const mod = await import("../extension/shared/components.js?gzip-handler-regression");
  const ToolLibraryClass = mod.ToolLibrary ?? registry.get("tool-library");
  assert(ToolLibraryClass, "ToolLibrary class exported/registered");

  const tool = new FakeElement("csvtool");
  const mode = new FakeElement("compress");
  const run = new FakeElement();
  const help = new FakeElement();
  const twoDoc = new FakeElement();
  const stdinLabel = new FakeElement();
  const stdin = new FakeElement("prior input");
  const argsLabel = new FakeElement();
  const args = new FakeElement();
  const gzipControls = new FakeElement();
  const stdinLabelText = new FakeElement();
  const output = new FakeElement();
  const docA = new FakeElement();
  const docB = new FakeElement();
  const docACount = new FakeElement();
  const docBCount = new FakeElement();
  const bySelector = new Map([
    [".preview-run", run], [".preview-tool", tool], [".preview-help", help],
    [".preview-two-doc", twoDoc], [".preview-stdin-label", stdinLabel],
    [".preview-stdin", stdin], [".preview-args-label", argsLabel], [".preview-args", args],
    [".preview-gzip-controls", gzipControls], [".preview-gzip-mode", mode],
    [".preview-stdin-label-text", stdinLabelText], [".preview-output", output],
    [".preview-doc-a", docA], [".preview-doc-b", docB],
    ["#preview-doc-a-count", docACount], ["#preview-doc-b-count", docBCount],
  ]);
  const root = { querySelector(selector) { return bySelector.get(selector) ?? null; } };
  const library = Object.create(ToolLibraryClass.prototype);
  library._root = root;
  library._previewBusy = false;
  library._previewResult = null;
  library._wire();

  let threw = null;
  try {
    tool.value = "gzip";
    tool.emit("change");
  } catch (error) {
    threw = error;
  }
  assertEquals(threw, null, `gzip compress tool change must not throw: ${threw?.message ?? threw}`);
  assertEquals(gzipControls.hidden, false);
  assertEquals(argsLabel.hidden, true);
  assertEquals(stdin.hidden, false);
  assertEquals(stdinLabelText.textContent, "UTF-8 text input");
  assertEquals(stdin.placeholder, "Enter bounded UTF-8 text");
  assertMatch(help.textContent, /complete canonical-base64 gzip member/);

  stdin.value = "will be cleared";
  mode.value = "decompress";
  mode.emit("change");
  assertEquals(stdin.value, "", "mode switch clears stale cross-mode input");
  assertEquals(stdinLabelText.textContent, "Canonical base64 gzip input");
  assertEquals(stdin.placeholder, "H4sI…");
  assertMatch(help.textContent, /canonical standard base64 only/);
  assertEquals(argsLabel.hidden, true, "free-form args remain hidden in decompress mode");

  tool.value = "csvtool";
  tool.emit("change");
  assertEquals(gzipControls.hidden, true);
  assertEquals(argsLabel.hidden, false, "switch away restores generic arguments");
  assertEquals(stdin.hidden, false);
  assertEquals(stdinLabelText.textContent, "Stdin (bounded)");
  assertEquals(stdin.placeholder, "a,b\n1,2\n3,4");
});

// ──────────────────────────────────────────────────────────────────────────
// Tool-library <details> slice: the native details groups + the bounded rows
// ──────────────────────────────────────────────────────────────────────────
Deno.test("tool-library: each source category renders as a native <details> with the count on the <summary> and bounded tool rows (no action surfaces)", async () => {
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ""; this.className = ""; this.hidden = false; this.attrs = {}; }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    get classList() { return { toggle: () => {}, add: () => {}, remove: () => {} }; }
  }
  const registry = new Map();
  const catalogEl = new El("div");
  const bySelector = new Map([[".catalog", catalogEl], [".status-line", new El("p")], [".preview", new El("div")]]);
  const shadow = { _html: "", set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, querySelector: (s) => bySelector.get(s) ?? null, querySelectorAll: () => [] };
  globalThis.HTMLElement = class { attachShadow() { return shadow; } addEventListener() {} dispatchEvent() { return true; } getAttribute() { return null; } hasAttribute() { return false; } };
  globalThis.customElements = { define(n, c) { registry.set(n, c); }, get(n) { return registry.get(n); } };
  globalThis.window = globalThis;
  globalThis.CustomEvent = class { constructor(t, i = {}) { this.type = t; this.detail = i.detail ?? {}; } };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.document = { createElement: (t) => new El(t), querySelector: () => null, head: { appendChild() {} }, getElementById: () => null };

  const mod = await import("../extension/shared/components.js?details-slice");
  const ToolLibraryClass = mod.ToolLibrary ?? registry.get("tool-library");
  const library = Object.create(ToolLibraryClass.prototype);
  library._root = shadow;
  library._rendered = true;
  library._state = "ready";
  library._announcedState = "";
  library._error = "";
  library._results = null;
  library._summary = null;
  library.summary = {
    descriptorCount: 3,
    bySource: { "bundled-package": 2, "extension-builtin": 1 },
    catalogDiagnostics: {},
    selectionDiagnostics: {},
    settingsPreviewTools: ["csvtool", "gzip"],
    toolsBySource: {
      "bundled-package": [
        { toolId: "csvtool", name: "csvtool", sourceLabel: "Bundled packages", version: "1.0.0", available: true, description: "RFC 4180 CSV stream filter" },
        { toolId: "touch", name: "touch", sourceLabel: "Bundled packages", version: "1.0.0", available: false, description: "touch candidate" },
      ],
      "extension-builtin": [
        { toolId: "memory.read", name: "memory.read", sourceLabel: "Built-in", version: null, available: true, description: "Read the hub memory" },
      ],
    },
  };
  library.state = "ready";

  // each category is a native <details> with the count on the <summary>
  const allDetails = [];
  const walkDetails = (node) => {
    if (node.tag === "details") allDetails.push(node);
    for (const child of node.children ?? []) walkDetails(child);
  };
  walkDetails(catalogEl);
  const details = allDetails.filter((d) => d.className === "source-group");
  assertEquals(details.length, 6, "one native <details> per category (incl. the zero-count sources)");
  const bundled = details.find((d) => d.attrs["data-source"] === "bundled-package");
  assert(bundled, "the bundled-package category exists");
  const bundledSummary = bundled.children.find((c) => c.tag === "summary");
  assert(bundledSummary, "the category has a <summary>");
  const summaryText = bundledSummary.children.map((c) => c.textContent).join(" ");
  assert(summaryText.includes("Bundled packages"), "the summary keeps the label");
  assert(summaryText.includes("2"), "the summary keeps the count");
  // the expanded body lists the tool rows with the descriptions
  const toolList = bundled.children.find((c) => c.tag === "ul");
  assert(toolList, "the expanded body is a list");
  assertEquals(toolList.children.length, 2, "the bounded tool rows are listed");
  const first = toolList.children[0];
  const firstHead = first.children.find((c) => c.className === "source-tool-head");
  const firstDesc = first.children.find((c) => c.className === "source-tool-desc");
  assert(firstHead && firstDesc, "each row has the head + the description");
  const headText = firstHead.children.map((c) => c.textContent).join(" ");
  assert(headText.includes("csvtool") && headText.includes("v1.0.0"), "the row shows the name + the version");
  assertEquals(firstDesc.textContent, "RFC 4180 CSV stream filter", "the row shows the one-line description");
  const touchHead = toolList.children[1].children.find((c) => c.className === "source-tool-head");
  assert(touchHead.children.some((c) => c.className.includes("unavailable")), "the unavailable row is marked");
  // NO action surface: the details bodies contain no buttons/links/inputs
  const walk = (node, out = []) => {
    if (["button", "a", "input", "select", "textarea"].includes(node.tag)) out.push(node.tag);
    for (const child of node.children ?? []) walk(child, out);
    return out;
  };
  assertEquals(walk(catalogEl), [], "the <details> slice renders no action surface — the Run preview button is the ONLY action");
});

// ──────────────────────────────────────────────────────────────────────────
// N-2: a legacy/corrupt shadow summary shape renders safely (empty groups)
// ──────────────────────────────────────────────────────────────────────────
Deno.test("tool-library: a legacy or corrupt shadow summary (missing/typed-wrong perSource arrays) renders empty safely without throwing", async () => {
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ""; this.className = ""; this.hidden = false; this.attrs = {}; }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    get classList() { return { toggle: () => {}, add: () => {}, remove: () => {} }; }
  }
  const registry = new Map();
  const catalogEl = new El("div");
  const bySelector = new Map([[".catalog", catalogEl], [".status-line", new El("p")], [".preview", new El("div")]]);
  const shadow = { _html: "", set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, querySelector: (s) => bySelector.get(s) ?? null, querySelectorAll: () => [] };
  globalThis.HTMLElement = class { attachShadow() { return shadow; } addEventListener() {} dispatchEvent() { return true; } getAttribute() { return null; } hasAttribute() { return false; } };
  globalThis.customElements = { define(n, c) { registry.set(n, c); }, get(n) { return registry.get(n); } };
  globalThis.window = globalThis;
  globalThis.CustomEvent = class { constructor(t, i = {}) { this.type = t; this.detail = i.detail ?? {}; } };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.document = { createElement: (t) => new El(t), querySelector: () => null, head: { appendChild() {} }, getElementById: () => null };

  const mod = await import("../extension/shared/components.js?n2-corrupt-summary");
  const ToolLibraryClass = mod.ToolLibrary ?? registry.get("tool-library");
  for (const [label, summary] of [
    ["no toolsBySource", { descriptorCount: 3, bySource: { "bundled-package": 2 }, catalogDiagnostics: {}, selectionDiagnostics: {}, settingsPreviewTools: ["csvtool"] }],
    ["toolsBySource wrong type", { descriptorCount: 3, bySource: { "bundled-package": 2 }, catalogDiagnostics: {}, selectionDiagnostics: {}, settingsPreviewTools: ["csvtool"], toolsBySource: "corrupt" }],
    ["bySource wrong type", { descriptorCount: 3, bySource: "corrupt", catalogDiagnostics: {}, selectionDiagnostics: {}, settingsPreviewTools: ["csvtool"], toolsBySource: {} }],
    ["rows not an array", { descriptorCount: 3, bySource: { "bundled-package": 2 }, catalogDiagnostics: {}, selectionDiagnostics: {}, settingsPreviewTools: ["csvtool"], toolsBySource: { "bundled-package": "corrupt" } }],
    ["null summary", null],
  ]) {
    const library = Object.create(ToolLibraryClass.prototype);
    library._root = shadow;
    library._rendered = true;
    library._state = "ready";
    library._announcedState = "";
    library._error = "";
    library._results = null;
    library._summary = null;
    let threw = null;
    try { library.summary = summary; library.state = "ready"; } catch (error) { threw = error; }
    assertEquals(threw, null, `${label}: the corrupt summary renders without throwing`);
  }
});
