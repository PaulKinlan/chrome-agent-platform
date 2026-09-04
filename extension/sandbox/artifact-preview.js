// Stable, opaque manifest-sandbox host for one generated artifact. The host
// never executes or document.write()s untrusted HTML. It mounts that HTML in a
// second allow-scripts-only iframe, so self/location navigation can replace at
// most the disposable inner document — never this message/lifecycle boundary.
// No size cap: an HTML artifact built across ≤64 KiB appends is a normal
// stored artifact at any size the store admits (owner 2026-09-03: no preview
// limits), so whatever guarded HTML the embedder delivers is mounted as-is.
// Never sit on "Preparing restricted preview…" forever: if no payload arrives
// (the tool call failed, the embedder was removed, or the delivery raced the
// frame load), say so honestly and offer a retry. The embedder re-delivers the
// staged payload on every frame load, so a reload IS the retry.
const PREVIEW_TIMEOUT_MS = 15000;
let active = null;

const statusEl = () => document.getElementById("preview-status");

setTimeout(() => {
  if (active) return;
  const status = statusEl();
  if (!status) return;
  status.textContent = "Preview unavailable — the content never arrived. The tool call may have failed; check the message's raw payload for the error.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.id = "preview-retry";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => {
    // The embedder posts the staged payload on the frame's load event, so a
    // self-reload re-requests it. If nothing is staged any more, this page
    // lands back here after the timeout — still honest.
    location.reload();
  });
  status.after(retry);
}, PREVIEW_TIMEOUT_MS);

function validNonce(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function mountPreview({ nonce, html }) {
  if (active?.nonce === nonce && active.html === html) return;

  const frame = document.createElement("iframe");
  frame.id = "artifact-preview-content";
  frame.title = "Rendered HTML output";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  // The supplied string already starts with the generated-document CSP,
  // preference bootstrap, and navigation guard. Keeping it in this nested
  // opaque frame is the authority boundary; the host URL remains stable.
  frame.srcdoc = html;

  active = { nonce, html, frame };
  document.body.replaceChildren(frame);
}

function relayPreference(data) {
  if (!active || data.nonce !== active.nonce) return;
  try {
    active.frame.contentWindow?.postMessage(data, "*");
  } catch { /* inner frame not ready */ }
}

window.addEventListener("message", (event) => {
  const data = event.data;

  if (event.source === window.parent) {
    if (data?.type === "cap:artifact-preview-open") {
      const html = typeof data.html === "string" ? data.html : "";
      const nonce = typeof data.nonce === "string" ? data.nonce : "";
      if (!validNonce(nonce)) return;
      mountPreview({ nonce, html });
      return;
    }
    if (data?.type === "cap:preference" && validNonce(data.nonce)) {
      relayPreference(data);
    }
    return;
  }

  // The generated document may only announce the existing preference nonce.
  // No arbitrary child message or URL is relayed to the privileged parent.
  if (
    active && event.source === active.frame.contentWindow &&
    data?.type === "cap:preference-ready" && data.nonce === active.nonce
  ) {
    try {
      window.parent.postMessage(data, "*");
    } catch { /* host is being removed */ }
  }
});
