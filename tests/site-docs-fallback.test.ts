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
  extractMarkdownLinks,
  extractSameOriginHrefs,
  fetchSiteDocs,
  htmlToText,
  parseLlmsTxt,
  parseSitemapXml,
  rankDocUrls,
  withSiteDocsFallback,
  MAX_DISCOVERY_DOC_BYTES,
  MAX_DISCOVERED_LINKS,
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

// ── e7gwq: bounded linear discovery parsing ─────────────────────────────────

Deno.test("extractMarkdownLinks: parses standard markdown links, links with titles, and angle bracket URLs", () => {
  const md = [
    "# Links",
    "- [Standard](https://docs.example.com/one)",
    '- [With Title](https://docs.example.com/two "Title text")',
    "- [With Single Quote Title](https://docs.example.com/three 'Title text')",
    "- [With Angle Brackets](<https://docs.example.com/four>)",
    "- [Nested [Inside] Bracket](https://docs.example.com/five)",
    "- Not a link: [just text]",
    "- Not a link: (just parens)",
    "- Not a link: [bracket] (with newline)\n(url)",
  ].join("\n");

  const urls = extractMarkdownLinks(md);
  assertEquals(urls, [
    "https://docs.example.com/one",
    "https://docs.example.com/two",
    "https://docs.example.com/three",
    "https://docs.example.com/four",
    "https://docs.example.com/five",
  ]);
});

Deno.test("e7gwq falsification: crafted adversarial inputs finish in linear time without stalling the service worker", () => {
  // 1. 100,000 unclosed opening brackets that would cause catastrophic scan/regex times
  const unclosedBrackets = "[".repeat(100_000);
  const t0 = performance.now();
  const res1 = parseLlmsTxt(unclosedBrackets, ORIGIN);
  const elapsed1 = performance.now() - t0;
  assertEquals(res1, []);
  assert(elapsed1 < 50, `100k unclosed brackets must finish in <50ms (took ${elapsed1.toFixed(2)}ms)`);

  // 2. 500KiB of unmatched ']' brackets (voya0 finding: previous lastIndexOf backward scan took 21.3s)
  const unmatchedClosing = "]".repeat(500 * 1024);
  const tVoya = performance.now();
  const resVoya = parseLlmsTxt(unmatchedClosing, ORIGIN);
  const elapsedVoya = performance.now() - tVoya;
  assertEquals(resVoya, []);
  assert(elapsedVoya < 50, `500KiB of unmatched ']' must finish in <50ms (took ${elapsedVoya.toFixed(2)}ms)`);

  // 3. sbiel finding: [x](y) followed by repeated '](' patterns that previously triggered backward rescans
  const sbielInput = "[x](https://docs.example.com/y)\n" + "](".repeat(100_000);
  const tSbiel = performance.now();
  const resSbiel = parseLlmsTxt(sbielInput, ORIGIN);
  const elapsedSbiel = performance.now() - tSbiel;
  assertEquals(resSbiel, ["https://docs.example.com/y"]);
  assert(elapsedSbiel < 50, `100k '](' patterns must finish in <50ms (took ${elapsedSbiel.toFixed(2)}ms)`);

  // 4. 20,000 unclosed link patterns: `[text](` repeated
  const unclosedLinks = "[text](".repeat(20_000);
  const t1 = performance.now();
  const res2 = parseLlmsTxt(unclosedLinks, ORIGIN);
  const elapsed2 = performance.now() - t1;
  assertEquals(res2, []);
  assert(elapsed2 < 50, `20k unclosed links must finish in <50ms (took ${elapsed2.toFixed(2)}ms)`);

  // 5. Deeply nested brackets: `[[[[...]]]]`
  const nested = "[".repeat(10_000) + "]".repeat(10_000);
  const t2 = performance.now();
  const res3 = parseLlmsTxt(nested, ORIGIN);
  const elapsed3 = performance.now() - t2;
  assertEquals(res3, []);
  assert(elapsed3 < 50, `10k nested brackets must finish in <50ms (took ${elapsed3.toFixed(2)}ms)`);
});

Deno.test("e7gwq falsification: parseLlmsTxt bounds candidate URL count to MAX_DISCOVERED_LINKS", () => {
  // 10,000 valid links from same origin
  const manyLinks = Array.from(
    { length: 10_000 },
    (_, i) => `[Link ${i}](https://docs.example.com/page-${i})`,
  ).join("\n");

  const urls = parseLlmsTxt(manyLinks, ORIGIN);
  assertEquals(urls.length, MAX_DISCOVERED_LINKS, `must cap at MAX_DISCOVERED_LINKS (${MAX_DISCOVERED_LINKS})`);
  assertEquals(urls[0], "https://docs.example.com/page-0");
  assertEquals(urls[urls.length - 1], `https://docs.example.com/page-${MAX_DISCOVERED_LINKS - 1}`);
});

Deno.test("e7gwq falsification: parseLlmsTxt bounds input document bytes to MAX_DISCOVERY_DOC_BYTES", () => {
  // Padding exceeding MAX_DISCOVERY_DOC_BYTES followed by a link
  const padding = " ".repeat(MAX_DISCOVERY_DOC_BYTES + 1024);
  const doc = `${padding}\n[Hidden](https://docs.example.com/hidden)`;

  const urls = parseLlmsTxt(doc, ORIGIN);
  // Link past MAX_DISCOVERY_DOC_BYTES must NOT be discovered
  assertEquals(urls, [], "links past MAX_DISCOVERY_DOC_BYTES must not be processed");
});

Deno.test("e7gwq: parseSitemapXml and extractSameOriginHrefs obey MAX_DISCOVERED_LINKS and MAX_DISCOVERY_DOC_BYTES ceilings", () => {
  // Sitemap link cap
  const manySitemap = Array.from(
    { length: 500 },
    (_, i) => `<url><loc>https://docs.example.com/sitemap-${i}</loc></url>`,
  ).join("\n");
  const sitemapUrls = parseSitemapXml(manySitemap, ORIGIN);
  assertEquals(sitemapUrls.length, MAX_DISCOVERED_LINKS);

  // Href link cap
  const manyHrefs = Array.from(
    { length: 500 },
    (_, i) => `<a href="/href-${i}">link ${i}</a>`,
  ).join("\n");
  const hrefUrls = extractSameOriginHrefs(manyHrefs, ORIGIN);
  assertEquals(hrefUrls.length, MAX_DISCOVERED_LINKS);

  // Document byte bound on HTML
  const oversizeHtml = "<!-- " + "x".repeat(MAX_DISCOVERY_DOC_BYTES + 500) + " -->\n<a href=\"/overflow\">Overflow</a>";
  const overflowUrls = extractSameOriginHrefs(oversizeHtml, ORIGIN);
  assertEquals(overflowUrls, []);
});

Deno.test("e7gwq (9yx7a): general documentation content is not truncated, honoring dptw no-size-caps directive", async () => {
  // A large documentation page (> 512 KiB)
  const largePageContent = "Hello docs world! ".repeat(35_000); // ~665 KiB
  assert(largePageContent.length > MAX_DISCOVERY_DOC_BYTES, "fixture must exceed MAX_DISCOVERY_DOC_BYTES");

  const fetchImpl = fakeFetch({
    [`${ORIGIN}/llms.txt`]: "- [Large Doc](https://docs.example.com/large-doc)",
    [`${ORIGIN}/large-doc`]: `<html><body><p>${largePageContent}</p></body></html>`,
  });

  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  assert(docs, "docs fetched successfully");
  assertEquals(docs.pagesUsed, 1);
  assert(docs.content.length > MAX_DISCOVERY_DOC_BYTES, "doc content must not be truncated to discovery cap");
  assertStringIncludes(docs.content, "Hello docs world!");
});
