// lib/text-delta-coalescer.js — bounded batching for streamed model text
// (CAP-FB-20260830-TRANSCRIPT-STREAMING-01).
//
// The provider's text-delta chunks can arrive many times per millisecond;
// forwarding each one over the agent-progress port would wake every listening
// page per token. This coalescer forwards the FIRST delta of a stream at once
// (time-to-first-visible-token is the whole point), then batches the rest:
// a batch flushes when `intervalMs` has elapsed since the last flush (an
// animation-frame-equivalent, ~50 ms) or when the buffer reaches `maxBytes`
// (8 KiB — a bounded port payload). `flush()` drains whatever is pending
// (called at stream end and, defensively, before the step's final text event
// so a delta can never trail its own step).
//
// Pure: no timers of its own. The caller pushes on chunk arrival; a stream
// that stalls mid-batch is drained by the caller's flush at stream end.

export function createTextDeltaCoalescer(emit, { intervalMs = 50, maxBytes = 8192, now = () => Date.now() } = {}) {
  let buffer = "";
  let bufferBytes = 0;
  let lastFlushAt = null; // null → nothing has been forwarded yet
  const utf8 = (s) => {
    try { return new TextEncoder().encode(s).length; } catch { return s.length; }
  };
  const flush = () => {
    if (!buffer) return;
    const chunk = buffer;
    buffer = "";
    bufferBytes = 0;
    lastFlushAt = now();
    try { emit(chunk); } catch { /* the consumer must never break the stream */ }
  };
  return {
    push(delta) {
      const text = typeof delta === "string" ? delta : "";
      if (!text) return;
      buffer += text;
      bufferBytes += utf8(text);
      if (lastFlushAt == null || bufferBytes >= maxBytes || now() - lastFlushAt >= intervalMs) flush();
    },
    flush,
    get pending() { return buffer.length; },
  };
}
