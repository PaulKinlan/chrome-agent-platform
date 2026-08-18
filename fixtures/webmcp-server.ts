// fixtures/webmcp-server.ts — a tiny static server for the WebMCP discovery
// fixture (serves fixtures/webmcp-fixture.html on http://127.0.0.1:8934/).
// Used by scripts/webmcp-acceptance.ts so the production-path acceptance has
// a REAL page (declared WebMCP tools + an inferred window function) to drive.
//
//   deno run -A fixtures/webmcp-server.ts
const PORT = 8934;
const ROOT = new URL(".", import.meta.url).pathname;

const HTML = await Deno.readTextFile(`${ROOT}webmcp-fixture.html`);

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404 });
});

console.log(`WebMCP fixture server on http://127.0.0.1:${PORT}/`);
