// lib/durability-ui.js — the sidebar durability status rendered as a PURE
// function of the durability state + the two DOM surfaces. Extracted from
// ntp.js so the STATE → ELEMENT contract (session/error/durable text, the
// stale-text clear, the ARIA live-region visibility, and the data-durability
// attribute) is directly unit-testable without a browser or a fault seam.
//
// The state is one of:
//   "durable" — the persistent backend wrote the sidebar state (survives restart)
//   "session" — storage ungranted; the write is in-memory only (lost on restart)
//   "error"   — the backend was available but the write FAILED (fail closed)
//   anything else (e.g. "unknown") — treat as durable/unknown: clear + hide.

export const DURABILITY_TEXT = {
  session: "Session-only — storage is granted at install; if changes still do not persist, reload the extension.",
  error: "Couldn't save the sidebar state (storage failed).",
};

/**
 * Render the durability state onto the sidebar surfaces. `surfaces` is
 * `{ side, hint }` where `side` carries the `data-durability` attribute and
 * `hint` is the visible/ARIA `role=status` live region. Either may be null/absent.
 */
export function renderDurabilityState({ side, hint }, state) {
  const s = state === "session" || state === "error" ? state : "durable";
  side?.setAttribute?.("data-durability", s);
  if (!hint) return;
  if (s === "session") {
    hint.textContent = DURABILITY_TEXT.session;
    hint.hidden = false;
  } else if (s === "error") {
    hint.textContent = DURABILITY_TEXT.error;
    hint.hidden = false;
  } else {
    // Durable (or unknown): clear the stale live-region text AND hide it.
    hint.textContent = "";
    hint.hidden = true;
  }
}
