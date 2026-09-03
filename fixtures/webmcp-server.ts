// fixtures/webmcp-server.ts — a tiny static server for the WebMCP pages:
//   /            fixtures/webmcp-fixture.html — the discovery fixture (declared
//                WebMCP tools + an inferred window function + a collision decoy)
//   /shop        fixtures/showcase-shop.html — the sites-as-sub-agents SHOWCASE
//                (a small shop with five declared tools and a visible cart;
//                CAP-FB-20260825-SITE-AGENT-SHOWCASE-01)
//   /errors      fixtures/webmcp-errors.html — the failure-mode fixture
//                (chrome-agent-platform-ajcc): tools that throw specific/
//                bare DOMExceptions, a TypeError, a credential-leaking error,
//                a non-cloneable result, and a happy-path echo.
// Both on http://127.0.0.1:8934/. Used by scripts/webmcp-acceptance.ts so the
// production-path acceptance has REAL pages to drive.
//
//   deno run -A fixtures/webmcp-server.ts
const PORT = 8934;
const ROOT = new URL(".", import.meta.url).pathname;

const HTML = await Deno.readTextFile(`${ROOT}webmcp-fixture.html`);
const SHOP = await Deno.readTextFile(`${ROOT}showcase-shop.html`);
const ERRORS = await Deno.readTextFile(`${ROOT}webmcp-errors.html`);

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/shop" || url.pathname === "/shop.html") {
    return new Response(SHOP, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/errors" || url.pathname === "/errors.html") {
    return new Response(ERRORS, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404 });
});

console.log(`WebMCP fixture server on http://127.0.0.1:${PORT}/ (showcase shop at /shop, failure modes at /errors)`);
