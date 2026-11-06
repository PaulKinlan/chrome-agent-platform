// lib/pure-text.js — the text seam (UTF-8 byte maths, surrogate safety, truncation,
// escaping, ids, sleep, relative time). Extracted from lib/pure.js by
// chrome-agent-platform-ux4ud; pure.js re-exports all of it.
import { sha256Hex } from "./pure-hash.js";

/** The UTF-8 BYTE length of a string (JS `.length` counts UTF-16 code units —
 * wrong for any non-ASCII text). */
export function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text ?? "")).byteLength;
}

/** Does the string contain a LONE surrogate (malformed Unicode)? A lone
 * surrogate can never round-trip through UTF-8 (TextEncoder silently rewrites
 * it to U+FFFD), so inputs carrying one are REJECTED fail-closed rather than
 * silently mutated. */
export function hasLoneSurrogates(text) {
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true; // unpaired lead
      i++; // skip the trail half of a valid pair
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // unpaired trail
    }
  }
  return false;
}

/** Truncate to at most `maxBytes` of UTF-8 WITHOUT splitting a code point
 * (iterates code points, so a surrogate pair is never halved — the review's
 * UTF-16 slice finding).
 *
 * MALFORMED-INPUT CONTRACT (sanitize, never propagate): a lone surrogate can
 * never round-trip through UTF-8 (TextEncoder silently rewrites it to U+FFFD),
 * so truncateUtf8 DROPS lone-surrogate code units instead of re-appending the
 * malformed original. The output is ALWAYS well-formed Unicode:
 * hasLoneSurrogates(truncateUtf8(x, n)) === false for every input. Callers
 * that must REJECT malformed input outright (owner-entered override text) use
 * hasLoneSurrogates fail-closed BEFORE this helper; this helper guarantees it
 * never manufactures or propagates malformed output. */
export function truncateUtf8(text, maxBytes) {
  const s = String(text ?? "");
  const enc = new TextEncoder();
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    // A single-code-unit iteration value in the surrogate range is a LONE
    // surrogate (a valid pair iterates as one two-unit code point) — drop it.
    if (ch.length === 1) {
      const c = ch.charCodeAt(0);
      if (c >= 0xd800 && c <= 0xdfff) continue;
    }
    bytes += enc.encode(ch).byteLength;
    if (bytes > maxBytes) break;
    out += ch;
  }
  return out;
}

/** Escape untrusted text for an HTML sink. THE STRICT ONE: `& < > " '` — the
 * single quote too, so a single-quoted attribute built with it cannot be broken
 * out of. components.js re-exports this for the pages and the gallery. */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** A relative timestamp label ("just now" / "5m ago" / "3h ago" / "2d ago"). */
export function timeAgo(ts) {
  const d = Date.now() - (ts ?? 0);
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** A unique id: `${prefix}_${hex}` (or the bare hex with no prefix), where
 * hex is a v4 UUID with its hyphens stripped — 32 lowercase `[0-9a-f]`. Every
 * store-facing id (threads, tasks, screenshots, assets, scripts, board jobs,
 * grants, lock tokens) mints here, and the charset is the STRICTEST any
 * consumer in the tree validates: the screenshot-id extractor reads
 * `shot_[A-Za-z0-9_]{1,64}` out of truncated text (a hyphen would cut the id
 * short), thread ids are `[A-Za-z0-9_-]{1,200}`. The Date/Math fallback exists
 * ONLY for a realm without crypto.randomUUID and is the one place that pattern
 * is allowed to live. */
export function newId(prefix = "") {
  const hex = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replaceAll("-", "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${hex}` : hex;
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
