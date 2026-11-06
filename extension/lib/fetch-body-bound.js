// chrome-agent-platform-hvd4s: the bounded response-body READ shared by the
// fetch brokers.
//
// The bug this replaces: both brokers did `const text = await res.text()` and
// applied the 1 MB slice AFTERWARDS (`text.slice(0, MAX)`), so a hostile or
// simply huge response was buffered IN FULL inside the privileged service
// worker before the bound existed — memory exhaustion with a 10 GB response,
// while the shipped comments promised "size-bounded". The bound now applies to
// the READ: the body stream is consumed incrementally and CANCELLED the moment
// the ceiling is reached, so at most ceiling + one chunk is ever buffered.
//
// Semantics (documented because they deliberately differ at the edges):
//   - Reading stops at the FIRST of {maxBytes bytes read, maxBytes decoded
//     chars}; the returned text is additionally sliced to maxBytes chars.
//     For ASCII — the common case — the output is identical to the old
//     buffer-then-slice. For multi-byte bodies the old shape could return up
//     to 4x maxBytes of buffered bytes' worth of chars; 1 MB of BYTES is the
//     honest unit for a memory bound, so such bodies now yield fewer chars.
//   - `truncated` is true whenever the stream was not exhausted OR the decoded
//     text exceeded the char ceiling — callers may surface it, never guess it.
//   - A body-less response (HEAD, or a stream-less unit-test mock) yields the
//     empty result: production service-worker responses always expose a body
//     stream for GET, so the unbuffered shape only survives where the body is
//     empty by construction.
//   - A mid-stream read failure PROPAGATES, exactly like the old `res.text()`
//     did: the SW broker's route turns it into its honest ok:false error, and
//     script-host's fallback catches it to empty text like it caught text()
//     failures before. Never a silent partial body.
//   - Kept deliberately lean: this module ships inside the store offscreen
//     bundle, whose byte ceiling is enforced (scripts/bundle-budget.mjs).

/** The brokers' historic 1 MB text ceiling, now applied to the READ. */
export const FETCH_TEXT_MAX_BYTES = 1_000_000;

/**
 * Read a Response body as text, bounded at the stream level.
 * @param {Response|{body?:any}} res
 * @param {number} [maxBytes]
 * @returns {Promise<{text: string, truncated: boolean, bytesRead: number}>}
 */
export async function readResponseTextBounded(res, maxBytes = FETCH_TEXT_MAX_BYTES) {
  const cap = maxBytes > 0 ? maxBytes : FETCH_TEXT_MAX_BYTES;
  const reader = res?.body?.getReader?.();
  if (!reader) return { text: "", truncated: false, bytesRead: 0 };
  const decoder = new TextDecoder();
  let out = "";
  let bytesRead = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (bytesRead >= cap || out.length >= cap) {
        // Ceiling reached: CANCEL — the rest of the body is never pulled into
        // this worker.
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
    // Flush a partial multi-byte sequence at the ceiling (yields U+FFFD for a
    // genuinely split character — the honest rendering of a truncated body).
    out += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch { /* cancel() already released the lock */ }
  }
  if (out.length > cap) truncated = true;
  return { text: out.slice(0, cap), truncated, bytesRead };
}
