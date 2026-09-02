// CSP-safe pre-paint boot for hub-embedded views. Loaded SYNCHRONOUSLY from
// each page's <head> (no defer/async/module) so it runs before first paint and
// before any module script. Inline scripts are blocked by the MV3 CSP
// ('script-src 'self'), which left these duties undone in embedded views:
//
// Mark the document as embedded when this view is loaded inside the hub's
// view frame or is otherwise iframed, so the [data-embedded] CSS hides the
// standalone chrome (sidebar brand, page h1) that would double up inside the
// hub shell.
//
// P0 2026-09-02 (pek9): this boot does NOT try to fix sender authorization by
// rewriting the document URL. Chrome reports a frame's COMMITTED url (query
// included) as sender.url on runtime messages, so history.replaceState inside
// the child cannot change what the service worker sees — the previous boot
// stripped ?embedded=1 from location.href yet provider routes still refused
// the real Settings document. The fix is upstream: the hub's openView
// (extension/ntp/ntp.js) loads embedded views at their exact canonical URL
// with no ?embedded=1 marker, so the committed url itself matches
// isExactOptionsSender. Embeddedness is self-detected here
// (window.self !== window.top) and never depends on a query the hub appends.
if (new URLSearchParams(location.search).get("embedded") === "1" || window.self !== window.top) {
  document.documentElement.dataset.embedded = "1";
}
