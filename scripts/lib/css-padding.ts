// css-padding.ts — the LEFT inset from a CSS `padding` shorthand.
// chrome-agent-platform-rshb
//
// Why this is its own module: the rule existed inline in
// scripts/constrained-width-layout.ts, which is registered as a NAMED harness —
// no gate runs it, so the rule had no regression guard at all. It was wrong in
// two ways at once, and BOTH were driven:
//
//   • `padding: 14px` → the old code read `split()[1]`, which is `undefined` for
//     a single-value shorthand, returned null, and RED-ed a legitimate layout.
//     The failing detail contradicted its own verdict —
//     {"bodyPadding":"14px","headPadding":"14px","bodyLeft":null,"headLeft":null}
//     — because only the TOKEN COUNT differed.
//   • `padding: 1px 2px 3px 20px` → `[1]` is the RIGHT inset, so the check
//     compared right insets while its subject is the left one. Driven: a real
//     14px-vs-20px left-inset mismatch PASSED pre-fix (both sides read 2px),
//     i.e. the same false-red fix had also produced a check that could not fail.
//
// The shorthand rule (CSS 2.1 §8.4, all four sides in one declaration):
//   1 value  → all four sides         · LEFT is t[0]
//   2 values → vertical horizontal    · LEFT is t[1]
//   3 values → top horizontal bottom  · LEFT is t[1]
//   4 values → top right bottom left  · LEFT is t[3]
//
// Absence and unparseable input both return null, and the caller FAILS on null:
// that is the intent of chrome-agent-platform-cgei (an absent element must not
// compare equal to another absent element).

/** The left inset in px from a computed `padding` shorthand, or null when the
 *  value is absent or carries no usable length (both FAIL the caller's check). */
export function leftInsetFromPaddingShorthand(value: unknown): number | null {
  const tokens = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const part = tokens.length >= 4 ? tokens[3] : tokens.length === 1 ? tokens[0] : tokens[1];
  const n = parseFloat(part);
  return Number.isFinite(n) ? n : null;
}
