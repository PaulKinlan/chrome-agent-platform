// lib/hook-event-fence.js — the ONE way a hook's untrusted browser event is
// framed for the model (chrome-agent-platform-ypafy).
//
// `dispatchHook` (extension/background/service-worker.js) wraps an untrusted
// browser event — a tab title, a download filename, a bookmark title, a storage
// change — in a DATA block whose stated job is to keep page-controlled text from
// prompting the management-capable hub agent. The block is bounded by a FIXED
// literal delimiter (`<untrusted-event-data>` … `</untrusted-event-data>`)
// rather than the random per-run token of lib/untrusted-fence.js, because the
// block frames the hook's TASK text and is built BEFORE the run — and therefore
// the run's boundary token — exists. Its safety is by construction instead: the
// serializer below makes the closing delimiter un-spellable from inside, so no
// payload value can end the DATA block early while the block stays valid JSON
// (`JSON.parse` returns the event exactly as reported, nothing is stripped or
// hidden from the model).
//
// WHY THIS IS ITS OWN MODULE rather than a helper in lib/pure.js or
// lib/untrusted-fence.js (measured on this repo, 2026-10-24): `select-tests`
// maps a changed module to every suite that imports it, and the fast gate is
// bounded. A helper in pure.js selects 533 of 791 suites; in untrusted-fence.js,
// 359 — either way the fast gate cannot finish, so every future fence or title
// tweak would pay (or blow) a near-full-suite bound. This module has two
// importers (the service worker and tests/hook-event-fence-injection.test.ts),
// so a change here lands against the service worker's own 134-suite selection.
//
// Pure: no chrome.*, no I/O. Safe for the SW, the gallery and the tests.

/** The delimiter pair the hook dispatcher frames an untrusted browser event
 * with. Exported as the one source of the literal so the tests derive the fence
 * they assert on instead of restating it. */
export const UNTRUSTED_EVENT_OPEN = "<untrusted-event-data>";
export const UNTRUSTED_EVENT_CLOSE = "</untrusted-event-data>";

/**
 * Serialize an untrusted browser-event payload so that NO value inside it can
 * emit the block's closing delimiter (chrome-agent-platform-ypafy — the fence
 * was injectable: `JSON.stringify` leaves `<` raw, so a hostile tab title
 * containing `</untrusted-event-data>` closed the DATA block early and the rest
 * of the title was read as instructions).
 *
 * Every `<` is emitted as the JSON escape `\u003c`. That makes any tag
 * un-spellable from inside the block — closing, nested or case-changed — while
 * keeping the payload lossless: the content is still JSON, so `JSON.parse`
 * returns the original value byte for byte. The event is delivered, not
 * censored; the model can still read a hostile title and report it.
 */
export function serializeUntrustedEventData(value) {
  const json = JSON.stringify(value);
  // JSON.stringify returns undefined for undefined/function/symbol input; the
  // block must still carry well-formed JSON rather than the text "undefined".
  if (typeof json !== "string") return "null";
  return json.replaceAll("<", "\\u003c");
}

/** The complete fenced block around an untrusted browser-event payload. */
export function untrustedEventDataBlock(value) {
  return `${UNTRUSTED_EVENT_OPEN}\n${serializeUntrustedEventData(value)}\n${UNTRUSTED_EVENT_CLOSE}`;
}
