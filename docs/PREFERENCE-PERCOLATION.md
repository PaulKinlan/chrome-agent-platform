# Preference percolation — the controlled down-channel

**Goal:** let a safe-subset of the user's preferences (theme, locale, and later
other curated settings) flow DOWN through the layers of the extension — the
outer surface → the sandboxed double-iframe → (future) content scripts / page
agents — the way an MCP app percolates a caller's preferences into a tool. The
untrusted layer never gets direct access to the user's full settings; it gets a
validated, minimal projection.

## Threat model

- The sandboxed frame (the model's HTML) is UNTRUSTED. It must not be able to
  read the user's full settings, the extension's storage, or `chrome.*`.
- An untrusted script in the frame must not be able to FORGE a preference (e.g.
  force the light theme, or a spoofed locale) or to REPLAY an old one.
- The parent must be able to push a preference without exposing anything else.

## The channel

A controlled `postMessage` channel with a **schema + a one-time nonce**, carried
in the frame's bootstrap:

1. **The outer surface** (the extension page rendering the frame) generates a
   random `nonce`, renders the frame (injecting the nonce + a listener into the
   frame's bootstrap), and pushes preferences by calling
   `frame.contentWindow.postMessage({ type: "cap:preference", nonce, preference }, "*")`.
2. **The frame's bootstrap** listens for `message` and applies a preference only
   if ALL of the following hold (fail-closed):
   - `event.source === window.parent` — the message came from the parent, not a
     self-post by the untrusted HTML.
   - `data.type === "cap:preference"`.
   - `data.nonce === expectedNonce` — the one-time token (rejects forgery +
     replay; the nonce is consumed/scoped).
   - `data.preference` is a plain object containing ONLY the allowed keys
     (currently `theme`, `locale`), each validated (theme ∈ the known theme set;
     locale matches BCP-47). Unknown/extra keys are rejected.

`extension/lib/preference-bridge.js` implements the pure helpers:
`buildPreferenceMessage`, `validatePreferenceMessage`, and `applyPreference`.

## The start (implemented)

- `preference-bridge.js` — the schema, the nonce + source + shape validation,
  and the apply step (`data-theme` attribute + `document.documentElement.lang`).
- `renderHtmlFrame` now also exposes the bridge so an outer surface can push the
  theme/locale into a rendered frame with one call.

## Next steps (future)

- Thread the nonce + listener into the frame's bootstrap automatically when a
  preference is requested (so the model's HTML can't strip it).
- Extend the allowed preference set (e.g. `reduceMotion`, `colorScheme`) only
  with the same schema + validation.
- Percolate the same channel into the content-script + page-agent layers, with
  origin-scoped nonces.

## Non-goals

- The untrusted layer NEVER receives the user's secrets, the full settings, or a
  direct handle to the extension. The channel is one-way (down), schema-validated,
  and nonce-gated.
