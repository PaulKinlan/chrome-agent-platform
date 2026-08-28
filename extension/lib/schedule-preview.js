// lib/schedule-preview.js — the ONE schedule-preview projector (per-agent
// alarms P1-4/P2-B): credential-shaped text is redacted BEFORE the bounded
// slice. The NTP per-agent schedule row renders through THIS function and the
// test pins ITS output — a preview path must never re-implement redaction
// (an unredacted or unbounded copy would leak secrets into the DOM).
import { redactSecretText } from "./pure.js";

export const SCHEDULE_PREVIEW_CHARS = 80;

export function schedulePreviewText(task) {
  return redactSecretText(String(task || "(no prompt)")).slice(
    0,
    SCHEDULE_PREVIEW_CHARS,
  );
}
