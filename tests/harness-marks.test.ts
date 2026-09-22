// harness-marks.test.ts — the harness identity marks and the constrained-width
// layout rules that carry them.
//
// Two owner-reported defects live here, and both are pinned by MEASURED
// OBSERVABLES rather than by prose:
//
//  1. The harness chips had no mark, so a collapsed panel had nothing to carry
//     the identity, and a long registered name was compressed into a
//     two-line chip (measured live at a 260px panel: 222x51, two line boxes).
//  2. The hub's Jobs board held its grid column open with one long unbreakable
//     token, squeezing the Agents box to 116px and overflowing .main-wrap by
//     4px at a 1100px window.
//
// The CSS pins below EXTRACT the rule and assert the declaration inside it.
// A whole-file substring would be satisfied by a comment or by a declaration on
// some other selector — the substring-pin failure this repo has already paid
// for twice (see "Test honesty" in AGENTS.md).
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { HARNESS_MARK, HARNESS_MARK_LABEL, harnessMarkEl, harnessMarkKey } from "../extension/shared/harness-marks.js";

const root = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFile(new URL(p, root));

/** The body of the FIRST rule whose selector matches `selector` exactly. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  assert(at >= 0, `no \`${selector} {\` rule found`);
  const close = css.indexOf("}", at);
  assert(close > at, `the \`${selector}\` rule is not closed`);
  return css.slice(at + selector.length + 2, close);
}
/** The body of an at-rule block (`@media … {` / `@container … {`). */
function atBlock(css: string, header: string): string {
  const at = css.indexOf(header);
  assert(at >= 0, `no \`${header}\` block found`);
  let depth = 0, i = css.indexOf("{", at);
  const start = i;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) break; }
  }
  return css.slice(start, i + 1);
}

// ---------------------------------------------------------------------------
// 1. The marks themselves (pure — no DOM needed).
// ---------------------------------------------------------------------------
Deno.test("harness marks: every harness the picker offers has its own mark", () => {
  for (const id of ["pi", "claude-code", "codex"]) {
    assertEquals(harnessMarkKey(id), id, `${id} has no mark of its own`);
  }
});

Deno.test("harness marks: an unknown harness gets the generic badge, not another harness's mark", () => {
  assertEquals(harnessMarkKey("some-future-harness"), null);
  assertEquals(harnessMarkKey("__proto__"), null, "a prototype key must not resolve to a mark");
  assertEquals(harnessMarkKey("constructor"), null);
});

Deno.test("harness marks: every mark is a real <svg> wrapper with a viewBox", () => {
  // The shipped bug this pins: the badge was emitted as a bare <rect> + <text>
  // with no <svg> wrapper, so the fragment parser made them unknown HTML
  // elements (namespaceURI …/xhtml) that render nothing — the badge silently
  // degraded to loose text. The live check caught it as markW 9px / ns xhtml.
  for (const [key, svg] of Object.entries(HARNESS_MARK)) {
    assertMatch(svg, /^<svg viewBox="[^"]+"[^>]*>/, `${key} is not wrapped in <svg viewBox=…>`);
    assertMatch(svg, /<\/svg>$/, `${key} is not closed with </svg>`);
  }
});

Deno.test("harness marks: each mark is currentColor and aria-hidden, and uses no emoji", () => {
  for (const [key, svg] of Object.entries(HARNESS_MARK)) {
    assert(svg.includes("currentColor"), `${key} does not use currentColor`);
    assert(svg.includes('aria-hidden="true"'), `${key} is not aria-hidden`);
    assert(!svg.includes('fill="#') && !svg.includes("stroke=\"#"), `${key} hard-codes a colour`);
    // eslint-disable-next-line no-misleading-character-class
    assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(svg), `${key} uses an emoji`);
  }
});

Deno.test("harness marks: marks differ from each other", () => {
  const pi = HARNESS_MARK["pi"], cc = HARNESS_MARK["claude-code"], cx = HARNESS_MARK["codex"];
  assert(pi !== cc && cc !== cx && pi !== cx, "two harnesses share one mark");
});

Deno.test("harness marks: the module states that no vendor logo is redistributed", () => {
  assertMatch(HARNESS_MARK_LABEL, /no vendor logo is redistributed/i);
});

// ---------------------------------------------------------------------------
// 2. The mark element — built with DOM, never innerHTML for untrusted data.
// ---------------------------------------------------------------------------
function fakeDoc() {
  const made: any[] = [];
  const doc = {
    createElement(tag: string) {
      const el: any = {
        tagName: tag.toUpperCase(), className: "", attrs: {}, innerHTML: "", textContent: "",
        setAttribute(n: string, v: string) { el.attrs[n] = v; },
        getAttribute(n: string) { return el.attrs[n] ?? null; },
        querySelector(sel: string) {
          // The badge's letter element, as the real DOM would find it.
          return sel === "text" && el.innerHTML.includes("<text") ? { textContent: "" } : null;
        },
      };
      made.push(el);
      return el;
    },
  };
  return { doc, made };
}

Deno.test("harness mark element: it is a .hq-mark wrapper holding the harness's own svg", () => {
  const { doc } = fakeDoc();
  const el = harnessMarkEl(doc, "claude-code", "Claude Code");
  assertEquals(el.className, "hq-mark");
  assertEquals(el.getAttribute("aria-hidden"), "true");
  assertEquals(el.innerHTML, HARNESS_MARK["claude-code"]);
});

Deno.test("harness mark element: an unknown harness's name never reaches innerHTML", () => {
  // The name is agent-supplied text. It may only ever be assigned as text.
  const { doc, made } = fakeDoc();
  const el = harnessMarkEl(doc, "brand-new-harness", "<img src=x onerror=alert(1)>");
  assertEquals(el.innerHTML, HARNESS_MARK.generic, "the generic badge must be the trusted constant");
  assert(!el.innerHTML.includes("img"), "the agent's name was interpolated into markup");
  const letter = made.find((m) => m.innerHTML === HARNESS_MARK.generic);
  assert(letter, "no element carried the generic badge");
});

// ---------------------------------------------------------------------------
// 3. The side panel CSS: the chip cannot wrap or overflow, and the collapsed
//    panel is where the mark takes over.
// ---------------------------------------------------------------------------
const panelHtml = await read("./extension/sidepanel/sidepanel.html");

Deno.test("side panel: a harness chip never wraps its label and never exceeds its container", () => {
  const hq = ruleBody(panelHtml, ".harness-quick .hq");
  assertMatch(hq, /white-space:\s*nowrap/, "the chip may wrap its label inside the pill");
  assertMatch(hq, /max-width:\s*100%/, "a long name can push the chip out of its container");
  assertMatch(hq, /overflow:\s*hidden/);
});

Deno.test("side panel: the label is the part that gives way, with an ellipsis", () => {
  const label = ruleBody(panelHtml, ".harness-quick .hq .hq-label");
  assertMatch(label, /overflow:\s*hidden/);
  assertMatch(label, /text-overflow:\s*ellipsis/);
  assertMatch(label, /min-width:\s*0/, "without min-width:0 the label cannot shrink and the chip overflows");
});

Deno.test("side panel: the mark is fixed-size and cannot be squeezed away", () => {
  const mark = ruleBody(panelHtml, ".harness-quick .hq .hq-mark");
  assertMatch(mark, /flex:\s*0 0 auto/, "the mark must not shrink with the chip");
});

Deno.test("side panel: collapsing the panel hides the label and keeps the mark", () => {
  const block = atBlock(panelHtml, "@container (max-width: 320px)");
  assertMatch(block, /\.harness-quick \.hq-label \{/, "the collapsed rule does not target the label");
  assertMatch(block, /clip:\s*rect\(/, "the label is not hidden at the collapsed width");
});

Deno.test("side panel: the Agents tab is a container context, so the collapsed rule can fire there", () => {
  // Without this the @container rule never matches in the Agents view — the tab
  // the harness chips actually live in.
  const view = ruleBody(panelHtml, "#agents-view");
  assertMatch(view, /container-type:\s*inline-size/);
});

// ---------------------------------------------------------------------------
// 4. The hub layout: one long token must not win a column.
// ---------------------------------------------------------------------------
const ntpHtml = await read("./extension/ntp/ntp.html");
const componentsJs = await read("./extension/shared/components.js");

/** The first `len` characters of a rule whose selector starts with `selector`. */
function ruleSlice(css: string, selector: string, len = 400): string {
  const at = css.indexOf(selector);
  assert(at >= 0, `no \`${selector}\` rule found`);
  return css.slice(at, at + len);
}

Deno.test("hub: the two-column grid uses minmax(0, …), so a long token cannot force a track", () => {
  const wide = atBlock(ntpHtml, "@media (min-width: 1100px)");
  assertMatch(wide, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/,
    "plain 1fr lets the Jobs content hold the track open and squeeze the Agents box");
});

Deno.test("hub: the base (single-column) grid uses the same minmax(0, …) form", () => {
  const wrap = ruleBody(ntpHtml, ".main-wrap");
  assertMatch(wrap, /grid-template-columns:\s*minmax\(0, 1fr\)/);
});

Deno.test("hub: the Jobs board's content is inset like its own panel header", () => {
  const board = ruleBody(ntpHtml, ".jobs-board-body");
  const body = board.match(/padding:\s*([^;]+);/);
  assert(body, ".jobs-board-body has no padding");
  const head = ruleBody(ntpHtml, ".panel-head").match(/padding:\s*([^;]+);/);
  assert(head, ".panel-head has no padding");
  assertEquals(body![1].trim(), head![1].trim(),
    `the board's content inset (${body![1].trim()}) must match the panel header's (${head![1].trim()})`);
});

Deno.test("hub: a long unbreakable token in a board row can break", () => {
  // The companion to the grid fix: once the column is allowed to be narrow, the
  // text inside it must be breakable or it overflows the row instead.
  for (const sel of [".jb-desc {", ".jb-msg {"]) {
    assertMatch(ruleSlice(componentsJs, sel), /overflow-wrap:\s*anywhere/, `${sel} cannot break a long run id`);
  }
});

Deno.test("hub: a nowrap party label is bounded so it cannot hold the row open", () => {
  const party = ruleSlice(componentsJs, ".jb-party {", 200);
  assertMatch(party, /white-space:\s*nowrap/, ".jb-party lost its single-line intent");
  assertMatch(party, /min-width:\s*0/, ".jb-party cannot shrink");
  assertMatch(party, /text-overflow:\s*ellipsis/);
});

Deno.test("hub: the settled row's one-line excerpt cannot force the column wide", () => {
  const excerpt = ruleSlice(componentsJs, ".jb-excerpt {", 200);
  assertMatch(excerpt, /min-width:\s*0/, ".jb-excerpt cannot shrink");
  assertMatch(excerpt, /max-width:\s*100%/);
  assertMatch(excerpt, /text-overflow:\s*ellipsis/, "a clipped excerpt must still read as truncated");
});
