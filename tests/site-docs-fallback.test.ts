// @ts-nocheck — fake-fetch harnesses are intentionally dynamic.
// tests/site-docs-fallback.test.ts — chrome-agent-platform-922q
//
// The site-agent DOCS FALLBACK: when an enrolled site's declared tool fails
// (the owner's beads.gascity.com search_docs throwing DOMException:
// UnknownError from the broken native dispatch layer), the agent fetches the
// site's OWN documentation pages directly and answers from them — with
// explicit attribution — instead of leaving the owner with a bare failure.
//
// These tests drive the REAL module (lib/site-docs-fallback.js) with an
// injected fetch; no mocks of the code under test. Falsification: every test
// here is RED before the module exists and GREEN after.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  extractSameOriginHrefs,
  fetchSiteDocs,
  htmlToText,
  parseLlmsTxt,
  parseSitemapXml,
  rankDocUrls,
  withSiteDocsFallback,
} from "../extension/lib/site-docs-fallback.js";

const ORIGIN = "https://docs.example.com";

const LLMS = `# Docs

- [Installation](https://docs.example.com/docs/install): Install the widget.
- [CLI Reference](https://docs.example.com/cli-reference): All commands.
- [External](https://other.example.com/steal): must be dropped (cross-origin).
`;

const PAGE = (marker) => `<!doctype html><html><head><title>t</title><style>body{color:red}</style></head>
<body><nav><a href="/x">nav</a></nav><h1>Heading</h1><p>${marker} &amp; more &lt;content&gt;</p>
<script>var tracker = 1;</script></body></html>`;

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push(String(url));
    const body = routes[String(url)];
    if (body == null) return new Response("nope", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  };
  fn.calls = calls;
  return fn;
}

Deno.test("parseLlmsTxt: extracts same-origin doc links, drops cross-origin", () => {
  const urls = parseLlmsTxt(LLMS, ORIGIN);
  assertEquals(urls, ["https://docs.example.com/docs/install", "https://docs.example.com/cli-reference"]);
});

Deno.test("parseSitemapXml: extracts same-origin <loc> entries only", () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://docs.example.com/guide</loc></url>
    <url><loc>https://cdn.other.net/asset</loc></url>
  </urlset>`;
  assertEquals(parseSitemapXml(xml, ORIGIN), ["https://docs.example.com/guide"]);
});

Deno.test("extractSameOriginHrefs: pulls same-origin hrefs out of a page, deduped, no fragments-only", () => {
  const html = `<a href="/a">A</a><a href="https://docs.example.com/b#frag">B</a><a href="https://evil.example.com/c">C</a><a href="/a">A2</a>`;
  const urls = extractSameOriginHrefs(html, ORIGIN);
  assertEquals(urls, [`${ORIGIN}/a`, `${ORIGIN}/b`]);
});

Deno.test("rankDocUrls: query-relevant pages rank first, stable for ties", () => {
  const ranked = rankDocUrls(
    [`${ORIGIN}/about`, `${ORIGIN}/docs/installation`, `${ORIGIN}/docs/cli`],
    ["installation"],
  );
  assertEquals(ranked[0], `${ORIGIN}/docs/installation`);
});

Deno.test("htmlToText: strips script/style/tags, decodes basic entities, keeps prose", () => {
  const text = htmlToText(PAGE("FROBNICATE-MARKER"));
  assertStringIncludes(text, "FROBNICATE-MARKER & more <content>");
  assert(!text.includes("tracker"), "script content must not survive");
  assert(!text.includes("color:red"), "style content must not survive");
  assert(!text.includes("<nav"), "markup must not survive");
});

Deno.test("fetchSiteDocs: prefers /llms.txt, fetches ranked pages, reports the honest window (N of M)", async () => {
  const fetchImpl = fakeFetch({
    [`${ORIGIN}/llms.txt`]: LLMS,
    [`${ORIGIN}/docs/install`]: PAGE("INSTALL-MARKER-922q"),
    [`${ORIGIN}/cli-reference`]: PAGE("CLI-MARKER-922q"),
  });
  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: ["install"], fetchImpl });
  assert(docs, "docs discovered");
  assertEquals(docs.pagesDiscovered, 2);
  assertEquals(docs.pagesUsed, 2);
  assert(docs.urls.includes(`${ORIGIN}/docs/install`));
  assertStringIncludes(docs.content, "INSTALL-MARKER-922q");
  assertStringIncludes(docs.content, "CLI-MARKER-922q");
  // The install page ranks first for the query "install".
  assert(docs.content.indexOf("INSTALL-MARKER-922q") < docs.content.indexOf("CLI-MARKER-922q"), "ranked by relevance");
  // llms.txt was consulted; the sitemap was not needed.
  assert(fetchImpl.calls.includes(`${ORIGIN}/llms.txt`));
  assert(!fetchImpl.calls.includes(`${ORIGIN}/sitemap.xml`), "sitemap is the fallback, not the first try");
});

Deno.test("fetchSiteDocs: falls back to sitemap.xml when llms.txt is absent", async () => {
  const fetchImpl = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: `<?xml version="1.0"?><urlset><url><loc>${ORIGIN}/guide</loc></url></urlset>`,
    [`${ORIGIN}/guide`]: PAGE("SITEMAP-MARKER-922q"),
  });
  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  assert(docs, "docs discovered via sitemap");
  assertStringIncludes(docs.content, "SITEMAP-MARKER-922q");
});

Deno.test("fetchSiteDocs: falls back to the site's own pages when neither index exists", async () => {
  const fetchImpl = fakeFetch({
    [`${ORIGIN}/`]: `<html><body><a href="/core-concepts">Core concepts</a></body></html>`,
    [`${ORIGIN}/core-concepts`]: PAGE("NAV-MARKER-922q"),
  });
  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  assert(docs, "docs discovered via the root page's links");
  assertStringIncludes(docs.content, "NAV-MARKER-922q");
});

Deno.test("fetchSiteDocs: returns null when nothing is discoverable (honest no-docs)", async () => {
  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl: fakeFetch({}) });
  assertEquals(docs, null);
});

Deno.test("fetchSiteDocs: per-page fetch failures are skipped, not fatal", async () => {
  const fetchImpl = fakeFetch({
    [`${ORIGIN}/llms.txt`]: LLMS,
    // /docs/install 404s; /cli-reference works.
    [`${ORIGIN}/cli-reference`]: PAGE("CLI-MARKER-922q"),
  });
  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  assert(docs);
  assertEquals(docs.pagesUsed, 1);
  assertStringIncludes(docs.content, "CLI-MARKER-922q");
});

Deno.test("withSiteDocsFallback: a successful tool result passes through untouched", async () => {
  const res = { ok: true, result: { answer: 42 } };
  const out = await withSiteDocsFallback({
    origin: ORIGIN, name: "search_docs", args: {}, res,
    fetchImpl: fakeFetch({}),
  });
  assertEquals(out, res);
});

Deno.test("withSiteDocsFallback: a failed tool result becomes docs with explicit attribution", async () => {
  const res = { ok: false, error: "tool search_docs failed (DOMException: UnknownError) — the page's handler threw a DOMException with no message" };
  const fetchImpl = fakeFetch({
    [`${ORIGIN}/llms.txt`]: LLMS,
    [`${ORIGIN}/docs/install`]: PAGE("INSTALL-MARKER-922q"),
    [`${ORIGIN}/cli-reference`]: PAGE("CLI-MARKER-922q"),
  });
  const out = await withSiteDocsFallback({
    origin: ORIGIN, name: "search_docs", args: { query: "install" }, res, fetchImpl,
  });
  assertEquals(out.ok, true);
  assertStringIncludes(out.result, "search_docs");
  assertStringIncludes(out.result, "documentation");
  assertStringIncludes(out.result, "INSTALL-MARKER-922q");
  assertStringIncludes(out.result, `${ORIGIN}/docs/install`);
  assertStringIncludes(out.result, "2 of 2");
  // The original failure is preserved for honesty/debugging.
  assertStringIncludes(out.docsFallback.toolError, "UnknownError");
  assertEquals(out.docsFallback.pagesUsed, 2);
  assertEquals(out.docsFallback.pagesDiscovered, 2);
});

Deno.test("withSiteDocsFallback: no discoverable docs → the ORIGINAL honest error is returned unchanged", async () => {
  const res = { ok: false, error: "tool search_docs failed (TypeError): boom" };
  const out = await withSiteDocsFallback({
    origin: ORIGIN, name: "search_docs", args: {}, res, fetchImpl: fakeFetch({}),
  });
  assertEquals(out, res);
});

// 922q review P2: fetch follows redirects — a same-origin docs URL that 302s
// CROSS-ORIGIN must not feed third-party content into the docs answer
// (sameOriginOnly filters the URL STRINGS discovered, not where they land).
// The final response URL is verified against the enrolled origin.
Deno.test("fetchSiteDocs: a docs URL that redirects CROSS-ORIGIN is refused honestly (skipped, not ingested, not a crash)", async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === `${ORIGIN}/llms.txt`) return { ok: true, url: u, text: async () => LLMS };
    if (u === `${ORIGIN}/docs/install`) {
      // The enrolled origin's page 302s to a third party — must be refused.
      return { ok: true, url: "https://evil.example.net/harvested", text: async () => PAGE("EVIL-CROSS-ORIGIN-MARKER") };
    }
    if (u === `${ORIGIN}/cli-reference`) return { ok: true, url: u, text: async () => PAGE("CLI-MARKER-922q") };
    return { ok: false, url: u, status: 404, text: async () => "" };
  };
  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  assert(docs, "the good page still lands");
  assertEquals(docs.pagesUsed, 1);
  assertStringIncludes(docs.content, "CLI-MARKER-922q");
  assert(!docs.content.includes("EVIL-CROSS-ORIGIN-MARKER"), "cross-origin redirect content must never be ingested");
  assert(!docs.urls.some((u) => u.includes("evil.example.net")), "the reported page list stays same-origin");
});

Deno.test("fetchSiteDocs: a docs URL that redirects SAME-ORIGIN still works", async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === `${ORIGIN}/llms.txt`) return { ok: true, url: u, text: async () => LLMS };
    if (u === `${ORIGIN}/docs/install`) {
      // Same-origin redirect (e.g. trailing-slash canonicalization) — fine.
      return { ok: true, url: `${ORIGIN}/docs/install/`, text: async () => PAGE("INSTALL-MARKER-922q") };
    }
    if (u === `${ORIGIN}/cli-reference`) return { ok: true, url: u, text: async () => PAGE("CLI-MARKER-922q") };
    return { ok: false, url: u, status: 404, text: async () => "" };
  };
  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  assert(docs);
  assertEquals(docs.pagesUsed, 2);
  assertStringIncludes(docs.content, "INSTALL-MARKER-922q");
});
