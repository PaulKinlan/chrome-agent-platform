// CSP-safe pre-paint boot: marks the document as embedded when this view is
// loaded inside the hub's view frame (openView appends ?embedded=1) or is
// otherwise iframed. Loaded SYNCHRONOUSLY from each page's <head> (no
// defer/async) so the attribute is set before first paint exactly like the
// inline script it replaced — inline scripts are blocked by the MV3 CSP
// ('script-src 'self'), which left the attribute unset in embedded views.
if (new URLSearchParams(location.search).get("embedded") === "1" || window.self !== window.top) {
  document.documentElement.dataset.embedded = "1";
}
