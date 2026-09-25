// shared/harness-marks.js — the identity mark for each external harness agent
// (pi / Claude Code / Codex) on the side panel's one-click harness buttons.
//
// WHY THESE ARE OUR OWN MARKS AND NOT THE VENDORS' LOGOS. Claude Code is
// Anthropic's product and Codex is OpenAI's; both marks are trademarks, and
// neither project publishes a licence that permits redistributing its artwork
// inside a distributed extension. Bundling them anyway — or drawing something
// close enough to pass for them — would ship a convincing fake of someone
// else's brand into every install. So each harness gets a NEUTRAL, clearly-our-
// own badge instead: an outlined frame carrying a letterform. The letterform is
// derived from the product's own name, and the button's aria-label states the
// real harness name in full, so nothing about the identity is a claim the mark
// cannot support. (An honest placeholder beats a convincing fake.)
//
// If a vendor grants redistribution, replace the entry here — one map, one
// place, no second icon system beside it.
//
// The map's shape follows shared/skill-icons.js deliberately: inline SVG
// strings, currentColor, aria-hidden, no emoji. One icon vocabulary for the
// whole extension, not two.

/** The badge frame every harness mark shares, so the set reads as a set. The
 *  <svg> wrapper is load-bearing: without it the fragment parser treats <rect>
 *  and <text> as unknown HTML elements (namespaceURI .../xhtml), which render
 *  nothing — the badge silently degrades to bare text. The acceptance check
 *  caught exactly that (markW 9px, ns xhtml) before it shipped. */
const frame = (letter, { size = 12, y = 16.5 } = {}) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">` +
  `<rect x="2.5" y="2.5" width="19" height="19" rx="6" fill="none" stroke="currentColor" stroke-width="1.9"/>` +
  `<text x="12" y="${y}" text-anchor="middle" font-size="${size}" font-weight="700"` +
  ` font-family="system-ui,sans-serif" fill="currentColor">${letter}</text></svg>`;

/** id (as the ACP registry reports it) → trusted inline-SVG string. */
export const HARNESS_MARK = {
  // pi ships under a two-letter name; its own letterform is the honest mark.
  pi: frame("π"),
  "claude-code": frame("C"),
  codex: frame("X"),
  // A harness nobody has a mark for yet still gets a badge (the letterform is
  // filled in from the name, via textContent — never interpolated into markup).
  generic: frame("?"),
};

/** Which mark a harness id maps to, or null when we have none for it. */
export function harnessMarkKey(id) {
  const k = String(id ?? "").trim().toLowerCase();
  return Object.hasOwn(HARNESS_MARK, k) && k !== "generic" ? k : null;
}

export const HARNESS_MARK_LABEL = "Our own neutral badge — no vendor logo is redistributed (see the header of this file).";

/** The badge for a harness, as an element. Known harnesses use their trusted
 *  constant; an unknown one gets the shared frame with its own initial set via
 *  textContent, so an agent's name never reaches innerHTML. */
export function harnessMarkEl(doc, id, name) {
  const span = doc.createElement("span");
  span.className = "hq-mark";
  span.setAttribute("aria-hidden", "true");
  const key = harnessMarkKey(id);
  span.innerHTML = key ? HARNESS_MARK[key] : HARNESS_MARK.generic;
  if (!key) {
    const text = span.querySelector("text");
    if (text) {
      const initial = [...String(name ?? id ?? "?").trim()][0] ?? "?";
      text.textContent = initial.toUpperCase();
    }
  }
  return span;
}
