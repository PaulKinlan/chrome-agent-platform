// tests/i18n-foundation.test.ts — the internationalisation FOUNDATION pins
// (chrome-agent-platform-54q): catalogue shape, drift guard between
// _locales/en/messages.json and the embedded gallery fallback, lookup
// semantics, and the hydrate contract for static HTML.
//
// FALSIFICATION: drift the embedded catalogue (or a message value) and the
// drift pin goes RED; break the lookup fallback and the gallery rendering
// tests go RED; remove default_locale and the manifest pin goes RED.
// @ts-nocheck — JSON catalogue shapes are asserted at runtime above.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { t, hydrateI18n, I18N_DEFAULT_CATALOGUE } from "../extension/shared/i18n.js";

const CATALOGUE_PATH = new URL("../extension/_locales/en/messages.json", import.meta.url);
const MANIFEST_PATH = new URL("../extension/manifest.json", import.meta.url);
const messages = JSON.parse(await Deno.readTextFile(CATALOGUE_PATH));
const manifest = JSON.parse(await Deno.readTextFile(MANIFEST_PATH));

Deno.test("i18n: the manifest declares default_locale=en and the en catalogue exists", () => {
  assertEquals(manifest.default_locale, "en", "default_locale must exist so Chrome resolves _locales/en");
  assert(messages && typeof messages === "object", "_locales/en/messages.json must parse as an object");
});

Deno.test("i18n: every catalogue entry is a well-formed chrome.i18n message", () => {
  // chrome.i18n message names: alphanumerics, underscore, @ only.
  const nameOk = /^[a-zA-Z0-9_@]+$/;
  for (const [key, entry] of Object.entries(messages)) {
    assert(nameOk.test(key), `catalogue key ${JSON.stringify(key)} is not a valid chrome.i18n message name`);
    assert(entry && typeof entry === "object" && !Array.isArray(entry), `${key}: entry must be an object`);
    assert(typeof entry.message === "string" && entry.message.length > 0, `${key}: message must be a non-empty string`);
  }
});

Deno.test("i18n: the embedded default catalogue is byte-identical to _locales/en/messages.json (drift guard)", () => {
  const expected = {};
  for (const [key, entry] of Object.entries(messages)) expected[key] = entry.message;
  assertEquals(
    { ...I18N_DEFAULT_CATALOGUE },
    expected,
    "extension/shared/i18n.js drifted from _locales/en/messages.json — run `node scripts/sync-i18n.mjs`",
  );
});

Deno.test("i18n: t() resolves through the catalogue in a chrome-less context (the gallery path)", () => {
  // No chrome global here: the fallback catalogue must answer.
  const keys = Object.keys(messages);
  for (const key of keys.slice(0, 25)) {
    assertEquals(t(key), messages[key].message, `t(${key}) must return the catalogue message`);
  }
});

Deno.test("i18n: a missing key is loud (returns the key), never a silent blank", () => {
  assertEquals(t("this_key_does_not_exist_xyz"), "this_key_does_not_exist_xyz");
});

Deno.test("i18n: positional substitutions match chrome.i18n $1..$9 semantics", () => {
  // Synthetic probe via the fallback: build a message shape the catalogue uses.
  const probe = Object.entries(messages).find(([, v]) => /\$1/.test(v.message));
  if (!probe) return; // no substitution strings migrated yet — nothing to pin
  const [key, entry] = probe;
  const out = t(key, "EXAMPLE");
  assert(!out.includes("$1"), `t(${key}, "EXAMPLE") left $1 unsubstituted: ${out}`);
  assertStringIncludes(out, "EXAMPLE");
});

Deno.test("i18n: hydrateI18n fills data-i18n text and data-i18n-attr attributes from the catalogue", () => {
  const keys = Object.keys(messages);
  if (keys.length === 0) return; // nothing migrated yet
  const first = keys[0];
  const textEl = {
    _text: "stale",
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    getAttribute: (n) => (n === "data-i18n" ? first : null),
    setAttribute() {},
  };
  const attrEl = {
    attrs: { "data-i18n-attr": `aria-label:${first}` },
    getAttribute(n) { return this.attrs[n] ?? null; },
    setAttribute(n, v) { this.attrs[n] = v; },
  };
  const root = {
    querySelectorAll(sel) {
      if (sel === "[data-i18n]") return [textEl];
      if (sel === "[data-i18n-attr]") return [attrEl];
      return [];
    },
  };
  hydrateI18n(root);
  assertEquals(textEl._text, messages[first].message, "data-i18n text must come from the catalogue");
  assertEquals(attrEl.attrs["aria-label"], messages[first].message, "data-i18n-attr must come from the catalogue");
});

/** What the markup fallback RENDERS: entities decoded, whitespace collapsed.
 * The catalogue holds text, never markup — comparing raw bytes is exactly how
 * "Backup &amp; restore" got into the catalogue and onto the screen (716s.2). */
function renderedText(markup: string): string {
  return markup
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body) => {
      if (body[0] === "#") return String.fromCodePoint(body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" } as Record<string, string>)[body] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

Deno.test("i18n: every data-i18n leaf in Settings markup resolves to a catalogue message that renders identically to its no-JS fallback text", async () => {
  // The Settings migration contract: the markup keeps the English text as the
  // no-JS fallback, the catalogue value renders the SAME text, so rendering
  // is unchanged whether or not chrome.i18n/hydration runs. A drift in either
  // direction (key without catalogue entry, or catalogue value ≠ markup text)
  // is the silent-copy-change this pin exists to stop. Since 716s.2 the
  // comparison is on RENDERED text: the markup may write `&amp;`, the
  // catalogue must hold `&` — a catalogue entity renders literally.
  const html = new URL("../extension/options/options.html", import.meta.url);
  const src = await Deno.readTextFile(html);
  const code = src
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "");
  const leaf = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^<>]*\bdata-i18n="([^"]+)"[^<>]*>([^<>]*)<\//g;
  let checked = 0;
  for (const m of code.matchAll(leaf)) {
    const [, tag, key, staticText] = m;
    const entry = messages[key];
    assert(entry, `data-i18n key ${key} on <${tag}> has no catalogue entry`);
    assertEquals(
      entry.message,
      renderedText(staticText),
      `catalogue message for ${key} drifted from the static markup fallback text`,
    );
    assert(!/&[a-zA-Z#][a-zA-Z0-9]*;/.test(entry.message), `${key}: the catalogue holds text, never an HTML entity — hydration renders it literally`);
    assertEquals(entry.message, entry.message.trim(), `${key}: no padding whitespace in the catalogue`);
    checked++;
  }
  assert(checked >= 100, `expected the Settings migration to have wired ~120 leaves, found ${checked}`);
});

Deno.test("i18n: hydrating the migrated Settings leaves renders the catalogue value, and mutating the catalogue changes the render (falsification)", async () => {
  const html = new URL("../extension/options/options.html", import.meta.url);
  const src = await Deno.readTextFile(html);
  const m = src.match(/<h2[^<>]*\bdata-i18n="([^"]+)"[^<>]*>([^<>]*)<\/h2>/);
  assert(m, "expected at least one migrated <h2> heading in Settings");
  const [, key, staticText] = m;
  // Simulate hydration with the REAL catalogue value.
  const el = {
    _text: staticText,
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    getAttribute: (n) => (n === "data-i18n" ? key : null),
    setAttribute() {},
  };
  const root = { querySelectorAll: (sel) => (sel === "[data-i18n]" ? [el] : []) };
  hydrateI18n(root);
  assertEquals(el._text, messages[key].message, "hydration must render the catalogue message");
  // FALSIFICATION: the catalogue value must be byte-identical to the static
  // markup text — if a migration ever reworded a string, this is the tripwire.
  assertEquals(messages[key].message, staticText, "catalogue value drifted from the original rendered text — migrations must be byte-identical");
});

// ── Mixed content (chrome-agent-platform-716s.2) ─────────────────────────────
// A minimal DOM double: enough of Element for hydrateI18n's mixed path —
// `children`, `ownerDocument.createTextNode`, `replaceChildren`, textContent.
function fakeDom() {
  const doc = { createTextNode: (s: string) => ({ nodeType: 3, textContent: String(s) }) };
  const el = (tag: string, attrs: Record<string, string>, kids: any[] = []) => {
    const node: any = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      attrs: { ...attrs },
      childNodes: kids,
      ownerDocument: doc,
      get children() { return node.childNodes.filter((n: any) => n.nodeType === 1); },
      get textContent() { return node.childNodes.map((n: any) => n.textContent).join(""); },
      set textContent(v: string) { node.childNodes = [doc.createTextNode(v)]; },
      getAttribute(n: string) { return node.attrs[n] ?? null; },
      setAttribute(n: string, v: string) { node.attrs[n] = v; },
      replaceChildren(...nodes: any[]) { node.childNodes = nodes; },
    };
    return node;
  };
  const text = (s: string) => doc.createTextNode(s);
  const root = (...els: any[]) => ({ querySelectorAll: (sel: string) => (sel === "[data-i18n]" ? els : []) });
  return { el, text, root };
}

Deno.test("i18n: hydrating <p>text <code>x</code> tail</p> keeps the tail AND the inline element (the truncation defect)", () => {
  const { el, text, root } = fakeDom();
  // options_diagnostics_logs_help is the owner-only service-worker diagnostics copy.
  const code = el("code", {}, [text("webmcp-sw")]);
  const p = el("span", { "data-i18n": "options_diagnostics_logs_help" }, [text("Write "), code, text(" injection diagnostics to the extension's service-worker DevTools console. Page-console diagnostics remain off.")]);
  hydrateI18n(root(p));
  assertEquals(p.textContent, "Write webmcp-sw injection diagnostics to the extension's service-worker DevTools console. Page-console diagnostics remain off.");
  assert(p.childNodes.includes(code), "the SAME <code> node is placed back — moved, not cloned or re-parsed");
  assertEquals(p.children.length, 1);
  assert(p.childNodes.every((n: any) => n.nodeType === 3 || n === code), "only text nodes and the original child — no markup is created from the catalogue string");
});

Deno.test("i18n: the About version keeps its <strong id=about-version> and the MCP lead keeps both inline children in message order", () => {
  const { el, text, root } = fakeDom();
  const strong = el("strong", { id: "about-version" }, [text("v0.3.560")]);
  const version = el("span", { "data-i18n": "options_version" }, [text("Version "), strong]);
  const abbr = el("abbr", { title: "Model Context Protocol" }, [text("MCP")]);
  const codeEl = el("code", {}, [text("https://")]);
  const lead = el("p", { "data-i18n": "options_mcp_lead" }, [text("Connect a remote "), abbr, text(" server … over an "), codeEl, text(" URL.")]);
  hydrateI18n(root(version, lead));
  assertEquals(version.textContent, "Version v0.3.560", "About renders Version <manifest version> — not a bare 'Version'");
  assertEquals(version.childNodes[1], strong, "the version node survives hydration so options.js's manifest write is what renders");
  assertEquals(lead.textContent, messages.options_mcp_lead.message.replace("$1", "MCP").replace("$2", "https://"));
  assertEquals(lead.children, [abbr, codeEl], "both inline children survive, in order");
  assert(lead.textContent.endsWith("never shown again after you save it."), "the whole sentence renders, not the prefix before the first child");
});

Deno.test("i18n: a mixed element whose message does not place every child is left UNTOUCHED (never destroys the logo or a file input)", () => {
  const { el, text, root } = fakeDom();
  const svg = el("svg", { class: "about-brand-logo" });
  const span = el("span", { class: "about-brand-text" }, [text("Chrome Agent Platform")]);
  // The pre-fix shape: the key on the container, the message a plain string.
  const brand = el("div", { "data-i18n": "options_chrome_agent_platform" }, [svg, text(" "), span]);
  const before = [...brand.childNodes];
  hydrateI18n(root(brand));
  assertEquals(brand.childNodes, before, "no slot for the children → the markup fallback stays exactly as authored");
  // A missing key on a mixed element likewise keeps the markup (the check
  // script is the loud guard for that; a leaf still renders the key).
  const input = el("input", { type: "file" });
  const label = el("label", { "data-i18n": "options_key_that_does_not_exist" }, [text("Import a backup file"), input]);
  hydrateI18n(root(label));
  assertEquals(label.childNodes, [label.childNodes[0], input]);
  assert(label.childNodes.includes(input), "the file <input> survives");
});

Deno.test("i18n: mixed-content hydration contains no innerHTML/outerHTML/insertAdjacentHTML path", async () => {
  const src = await Deno.readTextFile(new URL("../extension/shared/i18n.js", import.meta.url));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert(!/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|DOMParser/.test(code), "catalogue strings are never parsed as markup");
  assert(/replaceChildren\(/.test(code) && /createTextNode\(/.test(code), "the mixed path writes text nodes and re-places existing children");
});
