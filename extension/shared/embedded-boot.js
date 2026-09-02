// CSP-safe pre-paint boot for hub-embedded views. Loaded SYNCHRONOUSLY from
// each page's <head> (no defer/async/module) so it runs before first paint and
// before any module script. Inline scripts are blocked by the MV3 CSP
// ('script-src 'self'), which left these duties undone in embedded views:
//
// 1. Mark the document as embedded when this view is loaded inside the hub's
//    view frame (openView appends ?embedded=1) or is otherwise iframed.
// 2. Restore EXACT-document sender authorization. openView appends ?embedded=1
//    to the frame URL, but the owner-surface authorization
//    (isExactOptionsSender, extension/lib/pure.js) accepts only the bare
//    options URL or a #fragment from the closed product set — a query string
//    never matches, so the embedded Settings page lost its owner-options
//    principal and every owner route (provider credentials, tool-catalog
//    diagnostics, tool preview, factory reset) refused the REAL Settings
//    surface (P0, 2026-09-02). With the attribute set, the query is stripped
//    via history.replaceState so the document URL returns to the exact
//    authorized form. Later embedded-readers are unaffected: they test
//    window.self !== window.top, which an iframe always satisfies.
if (new URLSearchParams(location.search).get("embedded") === "1" || window.self !== window.top) {
  document.documentElement.dataset.embedded = "1";
}
if (window.self !== window.top && location.search) {
  history.replaceState(null, "", location.pathname + location.hash);
}
