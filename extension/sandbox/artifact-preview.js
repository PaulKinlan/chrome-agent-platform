// Stable, opaque manifest-sandbox host for one generated artifact. The host
// never executes or document.write()s untrusted HTML. It mounts that HTML in a
// second allow-scripts-only iframe, so self/location navigation can replace at
// most the disposable inner document — never this message/lifecycle boundary.
const MAX_HTML_BYTES = 300000;
let active = null;

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
      if (!validNonce(nonce) || html.length > MAX_HTML_BYTES) return;
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
