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
//   - A stream-less response (unit-test mocks, exotic runtimes) falls back to
//     text()+slice: production service-worker responses always expose a body
//     stream, so the unbuffered shape only survives where the body is
//     bounded by construction.
//   - This helper NEVER throws: a mid-stream read failure returns what was
//     decoded (the brokers' own error paths handle the fetch itself).

/** The brokers' historic 1 MB text ceiling, now applied to the READ. */
export const FETCH_TEXT_MAX_BYTES = 1_000_000;

/**
 * Read a Response body as text, bounded at the stream level.
 * @param {Response|{body?:any, text?:()=>Promise<string>}} res
 * @param {number} [maxBytes]
 * @returns {Promise<{text: string, truncated: boolean, bytesRead: number}>}
 *   bytesRead is -1 on the stream-less fallback path (nothing was metered).
 */
export async function readResponseTextBounded(res, maxBytes = FETCH_TEXT_MAX_BYTES) {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : FETCH_TEXT_MAX_BYTES;
  const body = res?.body;
  if (!body || typeof body.getReader !== "function") {
    // Stream-less fallback (mocks): one text() read, then the char slice.
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    return { text: text.slice(0, cap), truncated: text.length > cap, bytesRead: -1 };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let bytesRead = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
      bytesRead += chunk.byteLength;
      out += decoder.decode(chunk, { stream: true });
      if (bytesRead >= cap || out.length >= cap) {
        // Ceiling reached: CANCEL — the rest of the body is never pulled into
        // this worker. cancel() is best-effort; some mocks reject it.
        truncated = true;
        try {
          await reader.cancel("response body exceeded the bounded-read ceiling");
        } catch { /* already closed/released in some runtimes */ }
        break;
      }
    }
    // Flush a partial multi-byte sequence at the ceiling (yields U+FFFD for a
    // genuinely split character — the honest rendering of a truncated body).
    out += decoder.decode();
  } catch {
    // Mid-stream read failure: keep what was decoded; never throw.
  } finally {
    try {
      reader.releaseLock();
    } catch { /* cancel() already released the lock */ }
  }
  return { text: out.slice(0, cap), truncated: truncated || out.length > cap, bytesRead };
}
