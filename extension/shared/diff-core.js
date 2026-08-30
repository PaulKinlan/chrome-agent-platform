// extension/shared/diff-core.js — the ONE module that imports the `diff`
// package (jsdiff, BSD-3-Clause). esbuild bundles it into
// extension/dist/shared/diff-core.bundle.js (build.mjs + the test-extension
// mirror), and every consumer — the component library, the artifact viewer,
// the service worker — imports that single bundle. Nothing else in the tree
// imports from "diff" directly.
//
// This is the DIFF CORE (what changed). extension/lib/code-diff-artifacts.js
// is the RETENTION layer (sha256-addressed patch identity + storage) and does
// not compute a diff.
//
// MV3 CSP: jsdiff carries no eval/new Function; the build scrub still runs
// over this bundle and tests/diff-core.test.ts guards it.
import {
  applyPatch,
  createTwoFilesPatch,
  diffLines,
  formatPatch,
  parsePatch,
  structuredPatch,
} from "diff";

export { applyPatch, createTwoFilesPatch, diffLines, formatPatch, parsePatch, structuredPatch };

/** Hard ceiling on one rendered diff line (bytes, UTF-8). Mirrors
 *  CODE_DIFF_LIMITS.maxLineBytes in the retention layer. */
export const DIFF_LINE_MAX_BYTES = 8192;

const textEncoder = new TextEncoder();

function hasLoneSurrogate(value) {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value);
}

/**
 * Replace every control / bidi-override / lone-surrogate character in a diff
 * line with U+FFFD so a hostile artifact body cannot reorder or hide the
 * rendered row. Newlines survive (a diff line may carry its own terminator).
 */
export function neutralizeDiffLine(value) {
  const text = String(value ?? "");
  const safe = hasLoneSurrogate(text) ? text.replace(/[\ud800-\udfff]/gu, "\ufffd") : text;
  return safe.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => character === "\n" ? "\n" : "\ufffd",
  );
}

/**
 * Neutralise then bound a diff line to DIFF_LINE_MAX_BYTES of UTF-8, reserving
 * one byte for the unified +/- marker and never splitting a surrogate pair.
 * A truncated line ends with U+2026.
 */
export function truncateDiffLine(value) {
  const clean = neutralizeDiffLine(value);
  const limit = DIFF_LINE_MAX_BYTES - 1;
  if (textEncoder.encode(clean).byteLength <= limit) return clean;
  let low = 0;
  let high = clean.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (textEncoder.encode(clean.slice(0, mid)).byteLength <= limit - 3) low = mid;
    else high = mid - 1;
  }
  let cut = low;
  while (cut > 0 && /[\ud800-\udbff]/u.test(clean[cut - 1])) cut--;
  return `${clean.slice(0, cut)}…`;
}

/**
 * Line diff → hunks with counts. The shape a viewer renders directly:
 *
 *   { added, removed, hunks: [{ oldStart, oldLines, newStart, newLines,
 *                                added, removed, rows: [{ kind, text }] }] }
 *
 * `kind` is "context" | "add" | "remove"; `text` has the unified marker
 * stripped and is neutralised + bounded by truncateDiffLine. Identical inputs
 * yield { added: 0, removed: 0, hunks: [] }.
 */
export function lineDiffSummary(oldText, newText, { context = 4, oldName = "", newName = "" } = {}) {
  const patch = structuredPatch(oldName, newName, String(oldText ?? ""), String(newText ?? ""), undefined, undefined, { context });
  let added = 0;
  let removed = 0;
  const hunks = patch.hunks.map((hunk) => {
    let hunkAdded = 0;
    let hunkRemoved = 0;
    const rows = [];
    for (const line of hunk.lines) {
      const marker = line[0];
      const text = truncateDiffLine(line.slice(1));
      if (marker === "+") { hunkAdded++; rows.push({ kind: "add", text }); }
      else if (marker === "-") { hunkRemoved++; rows.push({ kind: "remove", text }); }
      else rows.push({ kind: "context", text });
    }
    added += hunkAdded;
    removed += hunkRemoved;
    return {
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      added: hunkAdded,
      removed: hunkRemoved,
      rows,
    };
  });
  return { added, removed, hunks };
}
