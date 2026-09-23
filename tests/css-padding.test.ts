// tests/css-padding.test.ts — chrome-agent-platform-rshb
//
// The LEFT inset from a CSS `padding` shorthand. Pinned here because the rule
// previously lived only inside scripts/constrained-width-layout.ts, a NAMED
// harness that no gate runs — so the same short-hand assumption survived two
// wrong answers (a false red on `padding: 14px`, and a false GREEN on a real
// 14px-vs-20px left-inset mismatch written as a four-value shorthand).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { leftInsetFromPaddingShorthand } from "../scripts/lib/css-padding.ts";

Deno.test("rshb: one value is all four sides — the uniform shorthand is the LEFT inset", () => {
  // The driven false red: `padding: 14px` on both elements made the check fail
  // with bodyLeft=null, headLeft=null, i.e. a legitimate layout reported red.
  assertEquals(leftInsetFromPaddingShorthand("14px"), 14);
  assertEquals(leftInsetFromPaddingShorthand("0"), 0);
  assertEquals(leftInsetFromPaddingShorthand("12.5px"), 12.5);
});

Deno.test("rshb: two and three values put the horizontal inset second", () => {
  assertEquals(leftInsetFromPaddingShorthand("12px 14px"), 14);
  assertEquals(leftInsetFromPaddingShorthand("1px 2px 3px"), 2);
});

Deno.test("rshb: four values put the LEFT inset last — the same assumption's second wrong answer", () => {
  // Pre-fix this read the SECOND token (the right inset), so a real 14 vs 20
  // mismatch compared 2px to 2px and the check PASSED. Driven on the real tree.
  assertEquals(leftInsetFromPaddingShorthand("1px 2px 3px 20px"), 20);
  assertEquals(leftInsetFromPaddingShorthand("0 0 0 0"), 0);
});

Deno.test("rshb: absence and unusable values are null, so the caller still FAILS (cgei's intent)", () => {
  for (const absent of [undefined, null, "", "   ", "\t\n"]) {
    assertEquals(leftInsetFromPaddingShorthand(absent), null, `absent input: ${JSON.stringify(absent)}`);
  }
  // A computed style that carries no length must not become 0 and compare equal
  // to another one: that is exactly the cgei defect (0 vs 0 passing).
  for (const unusable of ["auto", "inherit", "unset", "px", "", "calc(1px + 1px)"]) {
    assertEquals(leftInsetFromPaddingShorthand(unusable), null, `unusable input: ${JSON.stringify(unusable)}`);
  }
});

Deno.test("rshb: whitespace and case do not change the reading", () => {
  assertEquals(leftInsetFromPaddingShorthand("   12px    14px  "), 14);
  assertEquals(leftInsetFromPaddingShorthand("14PX"), 14);
  assertEquals(leftInsetFromPaddingShorthand("1px 2px 3px 20PX"), 20);
});

Deno.test("rshb: the two driven cases, as constants, match what the driver measured", () => {
  // Documents the acceptance pairs: the control must agree, and the genuine
  // mismatch must DIFFER — a check that cannot tell these apart cannot fail.
  const control = [leftInsetFromPaddingShorthand("14px"), leftInsetFromPaddingShorthand("14px")];
  assertEquals(Math.abs(control[0]! - control[1]!), 0, "the uniform control agrees with itself");
  const mismatch = [leftInsetFromPaddingShorthand("1px 2px 3px 14px"), leftInsetFromPaddingShorthand("1px 2px 3px 20px")];
  assert(Math.abs(mismatch[0]! - mismatch[1]!) > 1, `a real mismatch must be visible: ${JSON.stringify(mismatch)}`);
});
