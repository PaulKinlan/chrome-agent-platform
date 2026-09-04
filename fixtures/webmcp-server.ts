// fixtures/webmcp-server.ts — a tiny static server for the WebMCP pages:
//   /            fixtures/webmcp-fixture.html — the discovery fixture (declared
//                WebMCP tools + an inferred window function + a collision decoy)
//   /shop        fixtures/showcase-shop.html — the sites-as-sub-agents SHOWCASE
//                (a small shop with five declared tools and a visible cart;
//                CAP-FB-20260825-SITE-AGENT-SHOWCASE-01)
//   /errors      fixtures/webmcp-errors.html — the failure-mode fixture
//                (chrome-agent-platform-ajcc): tools that throw specific/
//                bare DOMExceptions, a TypeError, a credential-leaking error,
//                a non-cloneable result, and a happy-path echo. Also hosts
//                the 922q broken-native-dispatch tools (dispatch_broken_*).
//   /llms.txt + /docs/*  — the 922q docs-fallback fixture: a Mintlify-shaped
//                docs index + pages with distinctive markers, so the
//                site-agent docs fallback has real pages to fetch when the
//                site's tools fail.
// Both on http://127.0.0.1:8934/. Used by scripts/webmcp-acceptance.ts so the
// production-path acceptance has REAL pages to drive.
//
//   deno run -A fixtures/webmcp-server.ts
const PORT = 8934;
const ROOT = new URL(".", import.meta.url).pathname;

const HTML = await Deno.readTextFile(`${ROOT}webmcp-fixture.html`);
const SHOP = await Deno.readTextFile(`${ROOT}showcase-shop.html`);
const ERRORS = await Deno.readTextFile(`${ROOT}webmcp-errors.html`);

const LLMS_TXT = `# Fixture Docs

- [Installation](http://127.0.0.1:8934/docs/install): How to install the fixture widget.
- [CLI Reference](http://127.0.0.1:8934/docs/cli-reference): Every fixture CLI command.
`;

const DOCS_INSTALL = `<!doctype html><html><head><title>Installation</title></head>
<body><h1>Installing the fixture widget</h1>
<p>FROBNICATE-INSTALL-MARKER: run npm install fixture-widget, then fixture init.</p>
</body></html>`;

const DOCS_CLI = `<!doctype html><html><head><title>CLI Reference</title></head>
<body><h1>Fixture CLI reference</h1>
<p>FROBNICATE-CLI-MARKER: fixture --search &lt;query&gt; searches the docs index.</p>
</body></html>`;

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/llms.txt") {
    return new Response(LLMS_TXT, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (url.pathname === "/docs/install") {
    return new Response(DOCS_INSTALL, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/docs/cli-reference") {
    return new Response(DOCS_CLI, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
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
