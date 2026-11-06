// tests/impeccable-design-system-static-cache.test.ts — chrome-agent-platform-c3vpz
//
// The static design-system sweep used to: (1) re-walk EVERY element's full
// ancestor chain through getComputedStyle in the skip check — O(n·depth) style
// reads per run — then read computed style AGAIN in the main loop; (2) call
// hasDirectText twice per element (once per branch); (3) rerun sampleText — a
// full-subtree textContent read plus whitespace collapse — for EVERY finding.
// The fix memoises per run (shared style cache, memoised chain-hidden
// verdicts, one direct-text check, a LAZY sample). These pins hold both sides:
// the findings must be byte-identical to the documented semantics, and the
// work counts must be the cached ones (each pin fails on the pre-fix shape).
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { collectStaticDesignSystemFindings } from "../.agents/skills/impeccable/scripts/detector/design-system.mjs";

function makeEl(tag: string, opts: { text?: string; kids?: any[]; attrs?: Record<string, string>; style?: Record<string, string> } = {}) {
  const { text = "", kids = [], attrs = {}, style = {} } = opts;
  const node: any = {
    tagName: tag.toUpperCase(),
    childNodes: [] as any[],
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    parentElement: null,
    _style: {
      display: "block",
      visibility: "visible",
      fontFamily: "",
      color: "rgb(0, 0, 0)",
      backgroundColor: "transparent",
      borderTopWidth: "0px",
      borderRightWidth: "0px",
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
      outlineWidth: "0px",
      borderRadius: "",
      ...style,
    },
    _textReads: 0,
  };
  if (text) node.childNodes.push({ nodeType: 3, textContent: text });
  for (const k of kids) {
    node.childNodes.push(k);
    k.parentElement = node;
  }
  Object.defineProperty(node, "textContent", {
    get() {
      node._textReads++;
      return node.childNodes.map((c: any) => String(c.textContent ?? "")).join(" ");
    },
  });
  return node;
}

function fixture() {
  const child1 = makeEl("div", {
    text: "hi",
    style: { color: "rgb(255, 0, 0)", fontFamily: "WeirdFont, sans-serif", borderRadius: "7px" },
  });
  const child2 = makeEl("div", { text: "yo", style: { color: "transparent" } });
  const child3 = makeEl("span", { text: "buried", style: { color: "rgb(9, 9, 9)" } });
  const hiddenChild = makeEl("div", { text: "hidden text", kids: [child3], attrs: { hidden: "" } });
  const parent = makeEl("div", { kids: [child1, child2, hiddenChild] });
  const all = [parent, child1, child2, hiddenChild, child3];
  const styleCalls: any[] = [];
  const win = {
    getComputedStyle(el: any) {
      styleCalls.push(el);
      return el._style;
    },
  };
  const doc = { querySelectorAll: (_sel: string) => all };
  const ds = {
    present: true,
    hasFonts: true,
    hasColors: true,
    hasRadii: true,
    allowedFonts: new Set<string>(),
    allowedColorKeys: new Set<any>(),
    allowedRadii: [] as any[],
    hasPillRadius: false,
  };
  return { parent, child1, child2, child3, hiddenChild, all, styleCalls, win, doc, ds };
}

Deno.test("c3vpz semantics: the findings are exactly the documented ones, unchanged by the memoisation", () => {
  const f = fixture();
  const findings = collectStaticDesignSystemFindings(f.doc, f.win, "page.html", f.ds);
  assertEquals(findings.length, 3, "child1 emits font + color + radius; nothing else does");
  assertEquals(findings[0].antipattern, "design-system-font");
  assertEquals(findings[0].snippet, 'div "hi" uses weirdfont; not declared in DESIGN.md typography');
  assertEquals(findings[0].ignoreValue, "weirdfont");
  assertEquals(findings[1].antipattern, "design-system-color");
  assertEquals(findings[1].snippet, 'text color rgb(255, 0, 0) on div "hi" is outside DESIGN.md colors');
  assertEquals(findings[1].ignoreValue, "rgb(255, 0, 0)");
  assertEquals(findings[2].antipattern, "design-system-radius");
  assertEquals(findings[2].snippet, 'border-radius 7px on div "hi" is outside the DESIGN.md rounded scale');
  assertEquals(findings[2].ignoreValue, "7px");
  for (const item of findings) assertEquals(item.file, "page.html");
});

Deno.test("c3vpz perf: ONE computed-style read per element (skip walk and main loop share the cache); the attribute-hidden element needs none", () => {
  const f = fixture();
  collectStaticDesignSystemFindings(f.doc, f.win, "page.html", f.ds);
  // pre-fix this fixture cost 11 getComputedStyle calls (per-element ancestor
  // re-walks + a fresh read in the loop body); the cached run costs 4:
  // parent, child1, child2, child3 — once each. hiddenChild is skipped on its
  // `hidden` attribute BEFORE any style read, exactly as before.
  assertEquals(f.styleCalls.length, 4, `expected 4 style reads, saw ${f.styleCalls.length}`);
  for (const el of [f.parent, f.child1, f.child2, f.child3]) {
    assertEquals(f.styleCalls.filter((e) => e === el).length, 1, "each element's style is read exactly once");
  }
  assertEquals(f.styleCalls.filter((e) => e === f.hiddenChild).length, 0, "the attribute-hidden element is skipped without a style read");
});

Deno.test("c3vpz perf: sampleText is lazy and memoised — one subtree text read for three findings, zero for elements that emit none", () => {
  const f = fixture();
  collectStaticDesignSystemFindings(f.doc, f.win, "page.html", f.ds);
  // pre-fix, child1's subtree text was read THREE times (once per finding);
  // the lazy memo reads it once. Elements without findings never read it at
  // all — sampleText used to run per finding, and now runs per emitting
  // element at most.
  assertEquals(f.child1._textReads, 1, "three findings share ONE memoised sample");
  assertEquals(f.parent._textReads, 0);
  assertEquals(f.child2._textReads, 0);
  assertEquals(f.hiddenChild._textReads, 0);
  assertEquals(f.child3._textReads, 0);
});

Deno.test("c3vpz: the cache is per-run — a second sweep over the same DOM gives identical findings and pays its own (same) costs", () => {
  const f = fixture();
  const first = collectStaticDesignSystemFindings(f.doc, f.win, "page.html", f.ds);
  const callsAfterFirst = f.styleCalls.length;
  const second = collectStaticDesignSystemFindings(f.doc, f.win, "page.html", f.ds);
  assertEquals(second.map((x: any) => x.snippet), first.map((x: any) => x.snippet), "identical output on a repeat run");
  assertEquals(f.styleCalls.length, callsAfterFirst + 4, "the second run pays its own 4 reads — no cross-run staleness");
});
