// chrome-agent-platform-hvd4s: the bounded response-body READ shared by the
// fetch brokers.
//
// The bug this replaces: both brokers did `const text = await res.text()` and
// applied the 1 MB slice AFTERWARDS (`text.slice(0, MAX)`), so a hostile or
// simply huge response was buffered IN FULL inside the privileged service
// worker before the bound existed — memory exhaustion with a 10 GB response,
// while the shipped comments promised "size-bounded". The bound now applies to
// the READ: the body stream is consumed incrementally, the final chunk is
// SLICED to the exact remaining budget (retained text never exceeds the
// ceiling — stronger than per-chunk granularity), and the stream is CANCELLED
// there, so no further chunks are even delivered.
//
// Semantics (documented because they deliberately differ at the edges):
//   - The ceiling is in BYTES read; for ASCII — the common case — the output is
//     identical to the old buffer-then-slice. For multi-byte bodies the old
//     shape could return up to 4x maxBytes of buffered bytes' worth of chars;
//     bytes are the honest unit for a memory bound, so such bodies now yield
//     fewer chars. A sliced final chunk may end mid-character: the decoder
//     flush renders that as U+FFFD — the honest face of a truncated body.
//   - `truncated` is true whenever the stream was not exhausted — callers may
//     surface it, never guess it.
//   - A body-less response (HEAD, or a stream-less unit-test mock) yields the
//     empty result: production service-worker responses always expose a body
//     stream for GET.
//   - A mid-stream read failure PROPAGATES, exactly like the old `res.text()`
//     did: the SW broker's route turns it into its honest ok:false error, and
//     script-host's fallback catches it to empty text. Never a silent partial
//     body.
//   - Kept deliberately minimal: this module ships inside the store offscreen
//     bundle, whose enforced byte ceiling had only 80 bytes of headroom at the
//     pristine baseline. The hub authorised 259,000 as an explicit TRACKED
//     BRIDGE for this fix (measured +374 B at this helper's shrunk floor);
//     the x2ux1 offscreen split removes the need, and until it lands every
//     byte here stays argued for - shrinking is still the first move.

/**
 * Read a Response body as text, bounded at the stream level.
 * @param {Response|{body?:any}} res
 * @param {number} [maxBytes] must be > 0 (callers pass an explicit budget)
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
export async function readResponseTextBounded(res, maxBytes = 1_000_000) {
  const reader = res?.body?.getReader?.();
  if (!reader) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = value;
    if (bytes + chunk.byteLength > maxBytes) {
      // Exact-cap retention: keep only what fits, then cancel — the rest of
      // the body is never delivered to this worker at all.
      chunk = chunk.subarray(0, maxBytes - bytes);
      truncated = true;
    }
    bytes += chunk.byteLength;
    out += decoder.decode(chunk, { stream: true });
    if (truncated) {
      reader.cancel().catch(() => {});
      break;
    }
  }
  out += decoder.decode();
  // out.length <= bytes <= maxBytes always (UTF-8 chars never outnumber
  // bytes; the flush can add at most one U+FFFD within the cap), so no slice.
  return { text: out, truncated };
}
