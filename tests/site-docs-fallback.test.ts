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
import { assert, assertEquals, assertStringIncludes, assertThrows, AssertionError } from "jsr:@std/assert@1";
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
    if (u === `${ORIGIN}/llms.txt`) return { ok: true, url: u, body: new Response(LLMS).body, text: async () => LLMS };
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
    if (u === `${ORIGIN}/llms.txt`) return { ok: true, url: u, body: new Response(LLMS).body, text: async () => LLMS };
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

// ── e7gwq / j2vok: bounded linear discovery parsing ──────────────────────────

/**
 * Pure scale factor calculation given machine load and CPU count (chrome-agent-platform-v6kut/j2vok).
 * Caps strictly at maxScale (default 6x) regardless of ambient load spikes.
 */
export function computeLoadScale(load: number, cpus: number, maxScale = 6): number {
  if (Number.isNaN(load) || !Number.isFinite(cpus) || cpus <= 0 || load <= 0) return 1;
  const ratio = Math.max(1, load / cpus);
  return Math.min(maxScale, ratio);
}

/**
 * Computes a load-scaled timing budget for adversarial parsing tests (chrome-agent-platform-j2vok).
 * On a quiet box (load/core <= 1), returns baseMs (e.g. 75ms).
 * Under gate load (e.g. load/core = 2.5), scales proportionally (e.g. 188ms),
 * capped at maxScale * baseMs (e.g. 450ms) to ensure resilience against CPU scheduling
 * preemption while failing closed orders of magnitude before any real catastrophic stall
 * (such as voya0's 21.3s quadratic rescan).
 */
export function loadScaledTimingBudget(baseMs = 75, maxScale = 6, load?: number, cpus?: number): number {
  const l = typeof load === "number" && !Number.isNaN(load) ? load : (Deno.loadavg?.()[0] ?? 0);
  const c = typeof cpus === "number" && !Number.isNaN(cpus) && cpus > 0 ? cpus : (navigator.hardwareConcurrency || 1);
  const scale = computeLoadScale(l, c, maxScale);
  return Math.round(baseMs * scale);
}

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

Deno.test("z3xx4: extractMarkdownLinks extracts bracketed URLs and titles matching base regex behavior", () => {
  const md = [
    "- [Wiki bracketed URL](https://docs.example.com/wiki/Foo_[bar])",
    '- [Title with brackets](https://docs.example.com/clean "Title [with] brackets")',
    "- [Single-quoted title with brackets](https://docs.example.com/clean2 'Section [1]')",
    "- [Angle brackets with inner brackets](<https://docs.example.com/wiki/Baz_[qux]>)",
    "- [IPv6 address](http://[::1]:8080/docs)",
    '- [Both URL and title have brackets](https://docs.example.com/a_[b] "Title [c]")',
    "- [Malformed nested link]([nested](https://docs.example.com/bad))",
  ].join("\n");

  const urls = extractMarkdownLinks(md);
  assertEquals(urls, [
    "https://docs.example.com/wiki/Foo_[bar]",
    "https://docs.example.com/clean",
    "https://docs.example.com/clean2",
    "https://docs.example.com/wiki/Baz_[qux]",
    "http://[::1]:8080/docs",
    "https://docs.example.com/a_[b]",
  ]);

  // Also verify parseLlmsTxt preserves same-origin bracketed doc URLs
  const llmsTxt = [
    "# Docs",
    "- [Wiki](https://docs.example.com/wiki/Foo_[bar])",
    '- [Guide](https://docs.example.com/guide "Guide [2026]")',
  ].join("\n");
  const parsed = parseLlmsTxt(llmsTxt, "https://docs.example.com");
  assertEquals(parsed, [
    "https://docs.example.com/wiki/Foo_[bar]",
    "https://docs.example.com/guide",
  ]);
});

Deno.test("e7gwq / j2vok falsification: crafted adversarial inputs finish in linear time without stalling the service worker", () => {
  const budgetMs = loadScaledTimingBudget(75, 6);

  // 1. 100,000 unclosed opening brackets that would cause catastrophic scan/regex times
  const unclosedBrackets = "[".repeat(100_000);
  const stats1 = { steps: 0 };
  const t0 = performance.now();
  const res1 = parseLlmsTxt(unclosedBrackets, ORIGIN, { stats: stats1 });
  const elapsed1 = performance.now() - t0;
  assertEquals(res1, []);
  assert(stats1.steps <= unclosedBrackets.length, `steps (${stats1.steps}) must not exceed input length (${unclosedBrackets.length})`);
  assert(elapsed1 < budgetMs, `100k unclosed brackets must finish in <${budgetMs}ms (took ${elapsed1.toFixed(2)}ms)`);

  // 2. 500KiB of unmatched ']' brackets (voya0 finding: previous lastIndexOf backward scan took 21.3s)
  const unmatchedClosing = "]".repeat(500 * 1024);
  const statsVoya = { steps: 0 };
  const tVoya = performance.now();
  const resVoya = parseLlmsTxt(unmatchedClosing, ORIGIN, { stats: statsVoya });
  const elapsedVoya = performance.now() - tVoya;
  assertEquals(resVoya, []);
  assert(statsVoya.steps <= unmatchedClosing.length, `steps (${statsVoya.steps}) must not exceed input length (${unmatchedClosing.length})`);
  assert(elapsedVoya < budgetMs, `500KiB of unmatched ']' must finish in <${budgetMs}ms (took ${elapsedVoya.toFixed(2)}ms)`);

  // 3. sbiel finding: [x](y) followed by repeated '](' patterns that previously triggered backward rescans
  const sbielInput = "[x](https://docs.example.com/y)\n" + "](".repeat(100_000);
  const statsSbiel = { steps: 0 };
  const tSbiel = performance.now();
  const resSbiel = parseLlmsTxt(sbielInput, ORIGIN, { stats: statsSbiel });
  const elapsedSbiel = performance.now() - tSbiel;
  assertEquals(resSbiel, ["https://docs.example.com/y"]);
  assert(statsSbiel.steps <= sbielInput.length, `steps (${statsSbiel.steps}) must not exceed input length (${sbielInput.length})`);
  assert(elapsedSbiel < budgetMs, `100k '](' patterns must finish in <${budgetMs}ms (took ${elapsedSbiel.toFixed(2)}ms)`);

  // 4. 20,000 unclosed link patterns: `[text](` repeated
  const unclosedLinks = "[text](".repeat(20_000);
  const stats2 = { steps: 0 };
  const t1 = performance.now();
  const res2 = parseLlmsTxt(unclosedLinks, ORIGIN, { stats: stats2 });
  const elapsed2 = performance.now() - t1;
  assertEquals(res2, []);
  assert(stats2.steps <= unclosedLinks.length, `steps (${stats2.steps}) must not exceed input length (${unclosedLinks.length})`);
  assert(elapsed2 < budgetMs, `20k unclosed links must finish in <${budgetMs}ms (took ${elapsed2.toFixed(2)}ms)`);

  // 5. Deeply nested brackets: `[[[[...]]]]`
  const nested = "[".repeat(10_000) + "]".repeat(10_000);
  const stats3 = { steps: 0 };
  const t2 = performance.now();
  const res3 = parseLlmsTxt(nested, ORIGIN, { stats: stats3 });
  const elapsed3 = performance.now() - t2;
  assertEquals(res3, []);
  assert(stats3.steps <= nested.length, `steps (${stats3.steps}) must not exceed input length (${nested.length})`);
  assert(elapsed3 < budgetMs, `10k nested brackets must finish in <${budgetMs}ms (took ${elapsed3.toFixed(2)}ms)`);
});

/**
 * Mutant: reproduces pre-e7gwq quadratic backward rescanning behavior (voya0 / sbiel defect).
 * For each closing bracket ']', it scans backward through the preceding text looking for matching '['.
 */
function mutantQuadraticParseLlmsTxt(
  text: string,
  origin: string,
  { maxBytes = MAX_DISCOVERY_DOC_BYTES, stats = null }: { maxBytes?: number; stats?: { steps?: number } | null } = {},
): string[] {
  const input = typeof text === "string" ? text.slice(0, maxBytes) : "";
  const len = input.length;
  for (let i = 0; i < len; i++) {
    if (stats) stats.steps = (stats.steps || 0) + 1;
    if (input.charCodeAt(i) === 93 /* ] */) {
      // Pre-e7gwq backward scan: look backward for matching '['
      for (let j = i - 1; j >= 0; j--) {
        if (stats) stats.steps = (stats.steps || 0) + 1;
        if (input.charCodeAt(j) === 91 /* [ */) break;
      }
    }
  }
  return [];
}

Deno.test("j2vok: computeLoadScale and loadScaledTimingBudget are bounded, load-responsive, and capped at maxScale independent of ambient load", () => {
  // Pure scale calculation across load spectrum
  assertEquals(computeLoadScale(0, 1), 1, "zero/idle load returns floor scale 1");
  assertEquals(computeLoadScale(1, 1), 1, "load equal to CPUs returns scale 1");
  assertEquals(computeLoadScale(2, 1), 2, "load 2x CPUs returns scale 2");
  assertEquals(computeLoadScale(3, 1), 3, "load 3x CPUs returns scale 3");
  assertEquals(computeLoadScale(6, 1), 6, "load 6x CPUs returns maxScale 6");
  assertEquals(computeLoadScale(100, 1), 6, "extreme load caps at maxScale 6");
  assertEquals(computeLoadScale(Infinity, 1), 6, "infinite load caps strictly at maxScale 6");

  // Non-finite or negative inputs fail safe to floor 1
  assertEquals(computeLoadScale(NaN, 1), 1);
  assertEquals(computeLoadScale(1, 0), 1);
  assertEquals(computeLoadScale(-5, 1), 1);

  // Injected load tests for loadScaledTimingBudget
  assertEquals(loadScaledTimingBudget(75, 6, 0, 1), 75, "floor is 75ms");
  assertEquals(loadScaledTimingBudget(75, 6, 2, 1), 150, "2x load gives 150ms");
  assertEquals(loadScaledTimingBudget(75, 6, 100, 1), 450, "100x load capped at 450ms ceiling");
  assertEquals(loadScaledTimingBudget(75, 6, Infinity, 1), 450, "Infinity load capped at 450ms ceiling");
});

Deno.test("j2vok falsification: negative mutant reproducing pre-e7gwq quadratic scan fails-closed on adversarial input", () => {
  const budgetMs = loadScaledTimingBudget(75, 6);
  const sampleSize = 5_000;
  const sampleInput = "]".repeat(sampleSize);

  // 1. Linear scanner does strictly 1 outer-loop iteration per character (forward-only progression)
  const linearStats = { steps: 0 };
  const tLinear0 = performance.now();
  parseLlmsTxt(sampleInput, ORIGIN, { stats: linearStats });
  const linearElapsed = performance.now() - tLinear0;

  assertEquals(linearStats.steps, sampleSize, "linear scanner outer-loop steps must equal input length");
  assert(linearElapsed < budgetMs, `linear parse on 5k sample must take <${budgetMs}ms (took ${linearElapsed.toFixed(2)}ms)`);

  // 2. Quadratic mutant executes N + N*(N-1)/2 steps (O(N^2) catastrophic backward scan)
  const mutantStats = { steps: 0 };
  const tMutant0 = performance.now();
  mutantQuadraticParseLlmsTxt(sampleInput, ORIGIN, { stats: mutantStats });
  const mutantElapsed = performance.now() - tMutant0;

  const expectedQuadraticSteps = sampleSize + (sampleSize * (sampleSize - 1)) / 2;
  assertEquals(mutantStats.steps, expectedQuadraticSteps, "mutant step count must match O(N^2) backward scan");

  // Step explosion: mutant does >2,000x more operations than linear scanner on just 5,000 characters
  assert(
    mutantStats.steps > linearStats.steps * 1000,
    `mutant step count (${mutantStats.steps}) must exceed linear step count (${linearStats.steps}) by >1000x`,
  );

  // Fails-closed assertion: mutant step count violates the deterministic linear bound (steps <= length)
  assert(
    mutantStats.steps > sampleSize,
    "mutant must violate the deterministic linear step bound (steps <= length)",
  );

  // Fails-closed timing comparison: mutant is detected by superlinear execution steps
  assert(
    mutantElapsed > linearElapsed || mutantStats.steps > 10_000_000,
    "mutant must be detected by superlinear execution steps",
  );
});

/**
 * Independent complexity guard that instruments String.prototype and string proxy access
 * during execution to measure total character inspections, backward reads, and backward rescan method calls.
 * Covers charCodeAt, charAt, codePointAt, at, lastIndexOf, bracket indexing input[j],
 * slice, substring, and substr (uil17, otqr7, 0zj6g).
 * Fails closed without relying on wall-clock timing budgets.
 */
function measureCharacterInspections<T>(
  fn: (wrapString: (s: string) => string) => T,
): {
  result: T;
  charReads: number;
  backwardReads: number;
  lastIndexOfCalls: number;
} {
  let charReads = 0;
  let backwardReads = 0;
  let lastIndexOfCalls = 0;
  let maxIndexSeen = -1;

  const trackIndex = (idx: number) => {
    if (idx < 0) return;
    charReads++;
    if (idx < maxIndexSeen) {
      backwardReads++;
    } else if (idx > maxIndexSeen) {
      maxIndexSeen = idx;
    }
  };

  const origCharCodeAt = String.prototype.charCodeAt;
  const origCharAt = String.prototype.charAt;
  const origCodePointAt = String.prototype.codePointAt;
  const origAt = String.prototype.at;
  const origLastIndexOf = String.prototype.lastIndexOf;
  const origSubstring = String.prototype.substring;
  const origSubstr = (String.prototype as any).substr;

  function createTrackedString(rawStr: string, baseOffset = 0): string {
    const target = new String(rawStr);
    return new Proxy(target, {
      get(t, prop, receiver) {
        if (typeof prop === "string" && /^[0-9]+$/.test(prop)) {
          const idx = Number(prop) + baseOffset;
          trackIndex(idx);
          return rawStr[Number(prop)];
        }
        if (prop === "charCodeAt") {
          return function (idx: number) {
            trackIndex(idx + baseOffset);
            return origCharCodeAt.call(rawStr, idx);
          };
        }
        if (prop === "charAt") {
          return function (idx: number) {
            trackIndex(idx + baseOffset);
            return origCharAt.call(rawStr, idx);
          };
        }
        if (prop === "codePointAt") {
          return function (idx: number) {
            trackIndex(idx + baseOffset);
            return origCodePointAt.call(rawStr, idx);
          };
        }
        if (prop === "at") {
          return function (idx: number) {
            const actual = idx >= 0 ? idx : rawStr.length + idx;
            trackIndex(actual + baseOffset);
            return origAt ? origAt.call(rawStr, idx) : origCharAt.call(rawStr, actual);
          };
        }
        if (prop === "lastIndexOf") {
          return function (...args: any[]) {
            lastIndexOfCalls++;
            return origLastIndexOf.apply(rawStr, args);
          };
        }
        if (prop === "substring") {
          return function (start = 0, end = rawStr.length) {
            const to = typeof end === "number" ? end : rawStr.length;
            const low = Math.max(0, Math.min(rawStr.length, Math.min(start, to)));
            const high = Math.max(0, Math.min(rawStr.length, Math.max(start, to)));
            if (high > low) {
              trackIndex(baseOffset + low);
            }
            return origSubstring.call(rawStr, start, end);
          };
        }
        if (prop === "substr") {
          return function (start = 0, length?: number) {
            const len = typeof length === "number" ? length : rawStr.length;
            const actualStart = start < 0 ? Math.max(0, rawStr.length + start) : Math.min(rawStr.length, start);
            if (len > 0 && actualStart < rawStr.length) {
              trackIndex(baseOffset + actualStart);
            }
            return origSubstr ? origSubstr.call(rawStr, start, length) : origSubstring.call(rawStr, start, start + len);
          };
        }
        if (prop === "slice") {
          return function (start = 0, end = rawStr.length) {
            const actualStart = start < 0 ? Math.max(0, rawStr.length + start) : Math.min(rawStr.length, start);
            const actualEnd = end < 0 ? Math.max(0, rawStr.length + end) : Math.min(rawStr.length, end);
            if (actualEnd > actualStart && actualStart < maxIndexSeen && maxIndexSeen >= 0) {
              trackIndex(baseOffset + actualStart);
            }
            const sliced = rawStr.slice(start, end);
            return createTrackedString(sliced, baseOffset + actualStart);
          };
        }
        if (prop === "indexOf") {
          return function (...args: any[]) {
            return (rawStr as any).indexOf(...args);
          };
        }
        if (prop === "length") return rawStr.length;
        if (prop === Symbol.toPrimitive) return () => rawStr;
        if (prop === "toString" || prop === "valueOf") return () => rawStr;
        const val = Reflect.get(t, prop, t);
        if (typeof val === "function") return val.bind(rawStr);
        return val;
      },
    }) as unknown as string;
  }

  try {
    String.prototype.charCodeAt = function (idx: number) {
      trackIndex(idx);
      return origCharCodeAt.call(this, idx);
    };

    String.prototype.charAt = function (idx: number) {
      trackIndex(idx);
      return origCharAt.call(this, idx);
    };

    String.prototype.codePointAt = function (idx: number) {
      trackIndex(idx);
      return origCodePointAt.call(this, idx);
    };

    if (origAt) {
      String.prototype.at = function (idx: number) {
        const actual = idx >= 0 ? idx : (this.length + idx);
        trackIndex(actual);
        return origAt.call(this, idx);
      };
    }

    String.prototype.lastIndexOf = function (...args: any[]) {
      lastIndexOfCalls++;
      return origLastIndexOf.apply(this, args);
    };

    String.prototype.substring = function (start: number, end?: number) {
      if (typeof start === "number") {
        const to = typeof end === "number" ? end : this.length;
        const low = Math.max(0, Math.min(this.length, Math.min(start, to)));
        const high = Math.max(0, Math.min(this.length, Math.max(start, to)));
        if (high > low) {
          trackIndex(low);
        }
      }
      return origSubstring.call(this, start, end);
    };

    if (origSubstr) {
      (String.prototype as any).substr = function (start: number, length?: number) {
        if (typeof start === "number") {
          const len = typeof length === "number" ? length : this.length;
          const actualStart = start < 0 ? Math.max(0, this.length + start) : Math.min(this.length, start);
          if (len > 0 && actualStart < this.length) {
            trackIndex(actualStart);
          }
        }
        return origSubstr.call(this, start, length);
      };
    }

    const result = fn(createTrackedString);
    return { result, charReads, backwardReads, lastIndexOfCalls };
  } finally {
    String.prototype.charCodeAt = origCharCodeAt;
    String.prototype.charAt = origCharAt;
    String.prototype.codePointAt = origCodePointAt;
    if (origAt) String.prototype.at = origAt;
    String.prototype.lastIndexOf = origLastIndexOf;
    String.prototype.substring = origSubstring;
    if (origSubstr) (String.prototype as any).substr = origSubstr;
  }
}

/**
 * Mutant A: Reintroduces voya0 pre-e7gwq defect via un-bookkept input.lastIndexOf("[", i)
 * on every closing bracket ']'. Does NOT have any stats or bookkeeping code.
 */
function mutantVoya0LastIndexOfScan(
  text: string,
  { maxBytes = MAX_DISCOVERY_DOC_BYTES, maxLinks = MAX_DISCOVERED_LINKS, stats = null }: any = {},
): string[] {
  const input = typeof text === "string" ? text.slice(0, maxBytes) : "";
  const urls: string[] = [];
  const len = input.length;
  const openStack: number[] = [];

  for (let i = 0; i < len && urls.length < maxLinks; i++) {
    if (stats) stats.steps = (stats.steps || 0) + 1;
    const code = input.charCodeAt(i);
    if (code === 91 /* [ */) {
      if (openStack.length < 32) openStack.push(i);
    } else if (code === 93 /* ] */) {
      // Un-bookkept voya0 backward scan
      input.lastIndexOf("[", i);
      const openBracket = openStack.pop();
      if (openBracket !== undefined && i + 1 < len && input.charCodeAt(i + 1) === 40 /* ( */) {
        const closeParen = input.indexOf(")", i + 2);
        if (closeParen === -1) break;
        i = closeParen;
        openStack.length = 0;
      }
    }
  }
  return urls;
}

/**
 * Mutant B: Reintroduces voya0 backward scan via an explicit un-bookkept backward loop
 * on every closing bracket ']'. Does NOT touch stats.
 */
function mutantVoya0BackwardLoopScan(
  text: string,
  { maxBytes = MAX_DISCOVERY_DOC_BYTES, maxLinks = MAX_DISCOVERED_LINKS, stats = null }: any = {},
): string[] {
  const input = (typeof text === "string" || text instanceof String) ? text.slice(0, maxBytes) : "";
  const urls: string[] = [];
  const len = input.length;
  const openStack: number[] = [];

  for (let i = 0; i < len && urls.length < maxLinks; i++) {
    if (stats) stats.steps = (stats.steps || 0) + 1;
    const code = input.charCodeAt(i);
    if (code === 91 /* [ */) {
      if (openStack.length < 32) openStack.push(i);
    } else if (code === 93 /* ] */) {
      // Un-bookkept backward loop:
      for (let j = i - 1; j >= 0; j--) {
        if (input.charCodeAt(j) === 91 /* [ */) break;
      }
      const openBracket = openStack.pop();
      if (openBracket !== undefined && i + 1 < len && input.charCodeAt(i + 1) === 40 /* ( */) {
        const closeParen = input.indexOf(")", i + 2);
        if (closeParen === -1) break;
        i = closeParen;
        openStack.length = 0;
      }
    }
  }
  return urls;
}

/**
 * Mutant C: Reintroduces backward scan via charAt(j) loop on every closing bracket ']'.
 */
function mutantVoya0CharAtScan(
  text: string,
  { maxBytes = MAX_DISCOVERY_DOC_BYTES, maxLinks = MAX_DISCOVERED_LINKS, stats = null }: any = {},
): string[] {
  const input = (typeof text === "string" || text instanceof String) ? text.slice(0, maxBytes) : "";
  const urls: string[] = [];
  const len = input.length;
  const openStack: number[] = [];

  for (let i = 0; i < len && urls.length < maxLinks; i++) {
    if (stats) stats.steps = (stats.steps || 0) + 1;
    const code = input.charCodeAt(i);
    if (code === 91 /* [ */) {
      if (openStack.length < 32) openStack.push(i);
    } else if (code === 93 /* ] */) {
      for (let j = i - 1; j >= 0; j--) {
        if (input.charAt(j) === "[") break;
      }
      const openBracket = openStack.pop();
      if (openBracket !== undefined && i + 1 < len && input.charCodeAt(i + 1) === 40 /* ( */) {
        const closeParen = input.indexOf(")", i + 2);
        if (closeParen === -1) break;
        i = closeParen;
        openStack.length = 0;
      }
    }
  }
  return urls;
}

/**
 * Mutant D: Reintroduces backward scan via codePointAt(j) loop on every closing bracket ']'.
 */
function mutantVoya0CodePointAtScan(
  text: string,
  { maxBytes = MAX_DISCOVERY_DOC_BYTES, maxLinks = MAX_DISCOVERED_LINKS, stats = null }: any = {},
): string[] {
  const input = (typeof text === "string" || text instanceof String) ? text.slice(0, maxBytes) : "";
  const urls: string[] = [];
  const len = input.length;
  const openStack: number[] = [];

  for (let i = 0; i < len && urls.length < maxLinks; i++) {
    if (stats) stats.steps = (stats.steps || 0) + 1;
    const code = input.charCodeAt(i);
    if (code === 91 /* [ */) {
      if (openStack.length < 32) openStack.push(i);
    } else if (code === 93 /* ] */) {
      for (let j = i - 1; j >= 0; j--) {
        if (input.codePointAt(j) === 91) break;
      }
      const openBracket = openStack.pop();
      if (openBracket !== undefined && i + 1 < len && input.charCodeAt(i + 1) === 40 /* ( */) {
        const closeParen = input.indexOf(")", i + 2);
        if (closeParen === -1) break;
        i = closeParen;
        openStack.length = 0;
      }
    }
  }
  return urls;
}

/**
 * Mutant E: Reintroduces backward scan via bracket indexing input[j] loop on every closing bracket ']'.
 */
function mutantVoya0BracketIndexScan(
  text: string,
  { maxBytes = MAX_DISCOVERY_DOC_BYTES, maxLinks = MAX_DISCOVERED_LINKS, stats = null }: any = {},
): string[] {
  const input = (typeof text === "string" || text instanceof String) ? text.slice(0, maxBytes) : "";
  const urls: string[] = [];
  const len = input.length;
  const openStack: number[] = [];

  for (let i = 0; i < len && urls.length < maxLinks; i++) {
    if (stats) stats.steps = (stats.steps || 0) + 1;
    const code = input.charCodeAt(i);
    if (code === 91 /* [ */) {
      if (openStack.length < 32) openStack.push(i);
    } else if (code === 93 /* ] */) {
      for (let j = i - 1; j >= 0; j--) {
        if (input[j] === "[") break;
      }
      const openBracket = openStack.pop();
      if (openBracket !== undefined && i + 1 < len && input.charCodeAt(i + 1) === 40 /* ( */) {
        const closeParen = input.indexOf(")", i + 2);
        if (closeParen === -1) break;
        i = closeParen;
        openStack.length = 0;
      }
    }
  }
  return urls;
}

/**
 * Mutant F: Reintroduces backward scan via substring(j, j + 1) loop on every closing bracket ']' (0zj6g).
 */
function mutantVoya0SubstringScan(
  text: string,
  { maxBytes = MAX_DISCOVERY_DOC_BYTES, maxLinks = MAX_DISCOVERED_LINKS, stats = null }: any = {},
): string[] {
  const input = (typeof text === "string" || text instanceof String) ? text.slice(0, maxBytes) : "";
  const urls: string[] = [];
  const len = input.length;
  const openStack: number[] = [];

  for (let i = 0; i < len && urls.length < maxLinks; i++) {
    if (stats) stats.steps = (stats.steps || 0) + 1;
    const code = input.charCodeAt(i);
    if (code === 91 /* [ */) {
      if (openStack.length < 32) openStack.push(i);
    } else if (code === 93 /* ] */) {
      for (let j = i - 1; j >= 0; j--) {
        if (input.substring(j, j + 1) === "[") break;
      }
      const openBracket = openStack.pop();
      if (openBracket !== undefined && i + 1 < len && input.charCodeAt(i + 1) === 40 /* ( */) {
        const closeParen = input.indexOf(")", i + 2);
        if (closeParen === -1) break;
        i = closeParen;
        openStack.length = 0;
      }
    }
  }
  return urls;
}

Deno.test("uil17 / otqr7 / 0zj6g acceptance: independent complexity guard deterministically catches un-bookkept backward-rescan mutants across indexed and substring access patterns without timing", () => {
  // Acceptance criterion for chrome-agent-platform-uil17, otqr7, and 0zj6g:
  // Verify that an independent guard observing character inspections fails closed against
  // un-bookkept backward rescan regressions across enumerated indexed/sliced access patterns:
  // - lastIndexOf
  // - charCodeAt(j) loop
  // - charAt(j) loop
  // - codePointAt(j) loop
  // - bracket indexing input[j] loop
  // - substring(j, j + 1) loop
  // without relying on wall-clock timing budgets.
  // Note on scope honesty (0zj6g): Non-character-indexed string operations (e.g. un-anchored regex
  // search or split) are not character accessors and are bounded by the execution step and time limits.
  const sampleSize = 1_000;
  const sample = "]".repeat(sampleSize);
  const expectedBackwardReads = (sampleSize * (sampleSize - 1)) / 2;

  // 1. Real production extractMarkdownLinks on primitive string:
  const realMeasurement = measureCharacterInspections(() => {
    return extractMarkdownLinks(sample);
  });
  assertEquals(realMeasurement.result, []);
  assertEquals(realMeasurement.lastIndexOfCalls, 0, "production code must never call lastIndexOf");
  assertEquals(realMeasurement.backwardReads, 0, "production code must never read characters backward");
  assertEquals(realMeasurement.charReads, sampleSize, "production code reads each character once on unmatched closing bracket input");
  assert(
    realMeasurement.charReads <= sample.length,
    `character inspections (${realMeasurement.charReads}) must not exceed input length (${sample.length})`,
  );

  // 2. Real production extractMarkdownLinks on tracked string proxy:
  const realTrackedMeasurement = measureCharacterInspections((wrap) => {
    return extractMarkdownLinks(wrap(sample));
  });
  assertEquals(realTrackedMeasurement.result, []);
  assertEquals(realTrackedMeasurement.lastIndexOfCalls, 0, "tracked production code must never call lastIndexOf");
  assertEquals(realTrackedMeasurement.backwardReads, 0, "tracked production code must never read characters backward");
  assertEquals(realTrackedMeasurement.charReads, sampleSize, "tracked production code reads each character once");
  assert(
    realTrackedMeasurement.charReads <= sample.length,
    `tracked character inspections (${realTrackedMeasurement.charReads}) must not exceed input length (${sample.length})`,
  );

  // 3. Mutant A: un-bookkept lastIndexOf backward scan
  const mutantAMeasurement = measureCharacterInspections(() => {
    return mutantVoya0LastIndexOfScan(sample);
  });
  assertEquals(mutantAMeasurement.lastIndexOfCalls, sampleSize, "mutant A makes lastIndexOf call for every closing bracket");
  assert(mutantAMeasurement.lastIndexOfCalls > 0, "independent guard catches backward scan method calls");

  // 4. Mutant B: un-bookkept charCodeAt backward loop scan
  const mutantBMeasurement = measureCharacterInspections(() => {
    return mutantVoya0BackwardLoopScan(sample);
  });
  assertEquals(mutantBMeasurement.backwardReads, expectedBackwardReads, "mutant B backward reads match O(N^2) backward scan");
  assertEquals(mutantBMeasurement.charReads, sampleSize + expectedBackwardReads, "mutant B total char reads are quadratic");
  assert(mutantBMeasurement.charReads > sample.length, "mutant B violates deterministic linear complexity");

  // 5. Mutant C: un-bookkept charAt backward loop scan (otqr7)
  const mutantCMeasurement = measureCharacterInspections(() => {
    return mutantVoya0CharAtScan(sample);
  });
  assertEquals(mutantCMeasurement.backwardReads, expectedBackwardReads, "mutant C backward reads match O(N^2) backward scan");
  assertEquals(mutantCMeasurement.charReads, sampleSize + expectedBackwardReads, "mutant C total char reads are quadratic");
  assert(mutantCMeasurement.charReads > sample.length, "mutant C violates deterministic linear complexity");

  // 6. Mutant D: un-bookkept codePointAt backward loop scan (otqr7)
  const mutantDMeasurement = measureCharacterInspections(() => {
    return mutantVoya0CodePointAtScan(sample);
  });
  assertEquals(mutantDMeasurement.backwardReads, expectedBackwardReads, "mutant D backward reads match O(N^2) backward scan");
  assertEquals(mutantDMeasurement.charReads, sampleSize + expectedBackwardReads, "mutant D total char reads are quadratic");
  assert(mutantDMeasurement.charReads > sample.length, "mutant D violates deterministic linear complexity");

  // 7. Mutant E: un-bookkept bracket indexing input[j] backward loop scan (otqr7)
  const mutantEMeasurement = measureCharacterInspections((wrap) => {
    return mutantVoya0BracketIndexScan(wrap(sample));
  });
  assertEquals(mutantEMeasurement.backwardReads, expectedBackwardReads, "mutant E backward reads match O(N^2) backward scan");
  assertEquals(mutantEMeasurement.charReads, sampleSize + expectedBackwardReads, "mutant E total char reads are quadratic");
  assert(mutantEMeasurement.charReads > sample.length, "mutant E violates deterministic linear complexity");

  // 8. Mutant F: un-bookkept substring(j, j + 1) backward loop scan (0zj6g)
  const mutantFMeasurement = measureCharacterInspections(() => {
    return mutantVoya0SubstringScan(sample);
  });
  assertEquals(mutantFMeasurement.backwardReads, expectedBackwardReads, "mutant F backward reads match O(N^2) backward scan");
  assertEquals(mutantFMeasurement.charReads, sampleSize + expectedBackwardReads, "mutant F total char reads are quadratic");
  assert(mutantFMeasurement.charReads > sample.length, "mutant F violates deterministic linear complexity");

  // 9. Mutant F on tracked proxy: un-bookkept substring on tracked string proxy (0zj6g)
  const mutantFTrackedMeasurement = measureCharacterInspections((wrap) => {
    return mutantVoya0SubstringScan(wrap(sample));
  });
  assertEquals(mutantFTrackedMeasurement.backwardReads, expectedBackwardReads, "mutant F tracked backward reads match O(N^2) scan");
  assertEquals(mutantFTrackedMeasurement.charReads, sampleSize + expectedBackwardReads, "mutant F tracked total char reads are quadratic");
  assert(mutantFTrackedMeasurement.charReads > sample.length, "mutant F tracked violates deterministic linear complexity");

  // Verify that the linear complexity assertions fail closed on ALL 6 mutants without timing:
  assertThrows(
    () => { assert(mutantAMeasurement.lastIndexOfCalls === 0, "backward scan detected via lastIndexOf"); },
    Error,
    "backward scan detected via lastIndexOf",
  );

  assertThrows(
    () => { assert(mutantBMeasurement.backwardReads === 0, "backward scan detected via backward charCodeAt reads"); },
    Error,
    "backward scan detected via backward charCodeAt reads",
  );

  assertThrows(
    () => { assert(mutantCMeasurement.backwardReads === 0, "backward scan detected via backward charAt reads"); },
    Error,
    "backward scan detected via backward charAt reads",
  );

  assertThrows(
    () => { assert(mutantDMeasurement.backwardReads === 0, "backward scan detected via backward codePointAt reads"); },
    Error,
    "backward scan detected via backward codePointAt reads",
  );

  assertThrows(
    () => { assert(mutantEMeasurement.backwardReads === 0, "backward scan detected via backward bracket indexing reads"); },
    Error,
    "backward scan detected via backward bracket indexing reads",
  );

  assertThrows(
    () => { assert(mutantEMeasurement.charReads <= sample.length, "linear complexity bound exceeded on bracket indexing"); },
    Error,
    "linear complexity bound exceeded on bracket indexing",
  );

  assertThrows(
    () => { assert(mutantFMeasurement.backwardReads === 0, "backward scan detected via backward substring reads"); },
    Error,
    "backward scan detected via backward substring reads",
  );

  assertThrows(
    () => { assert(mutantFTrackedMeasurement.backwardReads === 0, "backward scan detected via backward tracked substring reads"); },
    Error,
    "backward scan detected via backward tracked substring reads",
  );
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

Deno.test("kiyap: discovery document response bodies are stream-bounded to MAX_DISCOVERY_DOC_BYTES on the wire", async () => {
  // A 32 MiB stream of 64 KiB chunks
  let bytesPulled = 0;
  let cancelCalled = false;
  let cancelReason = "";
  const totalChunks = 512; // 512 * 64 KiB = 32 MiB
  let chunkIdx = 0;

  const stream = new ReadableStream({
    pull(controller) {
      if (chunkIdx >= totalChunks) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(64 * 1024).fill(65);
      chunkIdx++;
      bytesPulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel(reason) {
      cancelCalled = true;
      cancelReason = String(reason);
    },
  });

  const fetchImpl = (url: string) => {
    if (url.endsWith("/llms.txt")) {
      return Promise.resolve(new Response(stream, { status: 200 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  // The stream must be aborted and cancelled once MAX_DISCOVERY_DOC_BYTES is reached
  assert(cancelCalled, "reader.cancel() must be called when maxBytes is reached");
  assertEquals(cancelReason, "maxBytes exceeded");
  // Total bytes pulled must not exceed MAX_DISCOVERY_DOC_BYTES plus at most one in-flight chunk (512 KiB + 64 KiB = 576 KiB)
  const maxAllowedPulled = MAX_DISCOVERY_DOC_BYTES + 64 * 1024;
  assert(
    bytesPulled <= maxAllowedPulled,
    `bytes pulled (${bytesPulled}) must be bounded to <= ${maxAllowedPulled} (preventing 32 MiB pull)`,
  );
  // Exactly 9 chunks of 64 KiB (589,824 bytes) were pulled, saving 31.5 MiB of network/memory transfer
  assertEquals(bytesPulled, 589824);
  assertEquals(chunkIdx, 9);
});

Deno.test("kiyap: exact cap arithmetic handles uneven chunks (100K + 400K + 12K = 512K) without premature cancel", async () => {
  let bytesPulled = 0;
  let chunk4Read = false;
  const chunk1 = new Uint8Array(100 * 1024).fill(65);
  const chunk2 = new Uint8Array(400 * 1024).fill(66);
  const chunk3 = new Uint8Array(12 * 1024).fill(67);
  const chunk4 = new Uint8Array(50 * 1024).fill(68);

  const chunks = [chunk1, chunk2, chunk3, chunk4];
  let idx = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (idx >= chunks.length) {
        controller.close();
        return;
      }
      if (idx === 3) chunk4Read = true;
      const c = chunks[idx++];
      bytesPulled += c.byteLength;
      controller.enqueue(c);
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 0 }));

  const fetchImpl = (url: string) => {
    if (url.endsWith("/llms.txt")) {
      return Promise.resolve(new Response(stream, { status: 200 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  assertEquals(bytesPulled, 524288, "must pull exactly 524288 bytes to reach 512 KiB cap");
  assertEquals(chunk4Read, false, "chunk 4 past 512 KiB must never be pulled");
});

Deno.test("kiyap: adversarial single huge chunk (32 MiB) is sliced before string decoding (documented one-chunk overshoot)", async () => {
  // A single huge chunk: Web Streams delivers the whole chunk when read() resolves,
  // so wire/memory ceiling is maxBytes + max_single_chunk_size (32 MiB in memory).
  // But subarray(0, remaining) slices the Uint8Array down to 512 KiB before string decoding.
  const huge = new Uint8Array(32 * 1024 * 1024).fill(65);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(huge);
    },
    cancel() {
      cancelled = true;
    },
  });

  const fetchImpl = (url: string) => {
    if (url.endsWith("/llms.txt")) {
      return Promise.resolve(new Response(stream, { status: 200 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  assert(cancelled, "stream must be cancelled after slicing huge chunk");
});

Deno.test("kiyap: streaming TextDecoder handles UTF-8 split across chunks and cap-cut without errors", async () => {
  const enc = new TextEncoder();

  // 1. 3-byte Euro sign split across chunks in llms.txt markdown link:
  const euroLink = enc.encode("- [Euro Doc](https://docs.example.com/pricing-€-plans)\n");
  const euroIdx = euroLink.indexOf(0xE2); // start of 3-byte € sequence [0xE2, 0x82, 0xAC]
  assert(euroIdx > 0, "euro character must exist in encoded test fixture");
  const part1 = euroLink.subarray(0, euroIdx + 2); // includes first 2 bytes of €
  const part2 = euroLink.subarray(euroIdx + 2);     // remaining byte of € and rest of line
  const splitStream = new ReadableStream({
    start(controller) {
      controller.enqueue(part1);
      controller.enqueue(part2);
      controller.close();
    },
  });

  const fetchImpl1 = (url: string) => {
    if (url.endsWith("/llms.txt")) {
      return Promise.resolve(new Response(splitStream, { status: 200 }));
    }
    if (url.includes("pricing-")) {
      return Promise.resolve(new Response("<html><body>Pricing in Euros: €50</body></html>", { status: 200 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  const docs1 = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl: fetchImpl1 });
  assert(docs1, "must parse split-UTF8 llms.txt");
  assert(
    docs1.urls.some((u) => decodeURIComponent(u).includes("pricing-€-plans")),
    "must discover URL containing cleanly decoded UTF-8 Euro symbol",
  );
  assertStringIncludes(docs1.content, "Pricing in Euros: €50");

  // 2. Multi-byte cut at 512 KiB cap:
  const head = enc.encode("- [Cut Doc](https://docs.example.com/cut-doc)\n");
  const padding = new Uint8Array(524287 - head.byteLength).fill(32); // spaces
  const euro = enc.encode("€"); // [0xE2, 0x82, 0xAC]
  const cutPayload = new Uint8Array(524287 + 3);
  cutPayload.set(head, 0);
  cutPayload.set(padding, head.byteLength);
  cutPayload.set(euro, 524287); // euro starts at 524287, cap cuts after 1 byte of euro at 524288

  const cutStream = new ReadableStream({
    start(controller) {
      controller.enqueue(cutPayload);
      controller.close();
    },
  });

  const fetchImpl2 = (url: string) => {
    if (url.endsWith("/llms.txt")) {
      return Promise.resolve(new Response(cutStream, { status: 200 }));
    }
    if (url.endsWith("/cut-doc")) {
      return Promise.resolve(new Response("<html><body>Safe cut content</body></html>", { status: 200 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  const docs2 = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl: fetchImpl2 });
  assert(docs2, "cap cut must succeed without throwing");
  assert(docs2.urls.includes("https://docs.example.com/cut-doc"), "doc before cap-cut boundary must be discovered");
});

Deno.test("kiyap: discovery doc with null/missing body fails closed without res.text() fallback", async () => {
  let fallbackTextCalled = false;
  const mockRes = {
    ok: true,
    url: `${ORIGIN}/llms.txt`,
    body: null,
    text: async () => {
      fallbackTextCalled = true;
      return "Dangerously buffered body";
    },
  };

  const fetchImpl = (url: string) => {
    if (url.endsWith("/llms.txt")) {
      return Promise.resolve(mockRes as any);
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  assertEquals(docs, null, "null body discovery doc must fail closed");
  assertEquals(fallbackTextCalled, false, "res.text() must NEVER be called as fallback on discovery path");
});

Deno.test("kiyap: never-resolving reader.cancel settles within bounded timeout and fails closed", async () => {
  const t0 = Date.now();
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(600 * 1024).fill(65));
    },
    cancel() {
      // Returns a promise that NEVER resolves
      return new Promise(() => {});
    },
  });

  const fetchImpl = (url: string) => {
    if (url.endsWith("/llms.txt")) {
      return Promise.resolve(new Response(stream, { status: 200 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  const elapsed = Date.now() - t0;
  assert(elapsed < 1000, `never-resolving cancel must settle boundedly (took ${elapsed}ms, expected < 1000ms)`);
  assertEquals(docs, null, "never-resolving cancel must fail closed without returning partial discovery doc");
});

Deno.test("kiyap: rejecting reader.cancel fails closed without returning partial discovery doc", async () => {
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(600 * 1024).fill(65));
    },
    cancel() {
      return Promise.reject(new Error("socket destroyed"));
    },
  });

  const fetchImpl = (url: string) => {
    if (url.endsWith("/llms.txt")) {
      return Promise.resolve(new Response(stream, { status: 200 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  const docs = await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  assertEquals(docs, null, "rejecting cancel must fail closed without returning partial discovery doc");
});

Deno.test("kiyap: advisory Content-Length header lie cannot bypass streaming byte cap", async () => {
  let bytesPulled = 0;
  let cancelCalled = false;
  let cancelReason = "";
  const stream = new ReadableStream({
    pull(controller) {
      const chunk = new Uint8Array(64 * 1024).fill(65);
      bytesPulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel(reason) {
      cancelCalled = true;
      cancelReason = String(reason);
    },
  });

  const headers = new Headers({ "content-length": "100" }); // Lying Content-Length: claims 100 bytes, streams 32 MiB
  const fetchImpl = (url: string) => {
    if (url.endsWith("/llms.txt")) {
      return Promise.resolve(new Response(stream, { status: 200, headers }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  await fetchSiteDocs({ origin: ORIGIN, queryTerms: [], fetchImpl });
  assert(cancelCalled, "stream must be cancelled despite lying Content-Length header");
  assertEquals(cancelReason, "maxBytes exceeded");
  assert(
    bytesPulled <= MAX_DISCOVERY_DOC_BYTES + 64 * 1024,
    `bytes pulled (${bytesPulled}) must be bounded to <= 576 KiB despite lying Content-Length header`,
  );
});

Deno.test("kiyap falsification: pre-kiyap res.text() regression pulls 32 MiB and fails byte assertion", async () => {
  // Model the exact pre-kiyap fetchText behavior (await res.text() then slice)
  const legacyFetchText = async (res: Response, maxBytes: number | null) => {
    const text = await res.text();
    return typeof maxBytes === "number" && maxBytes > 0 ? text.slice(0, maxBytes) : text;
  };

  let legacyBytesPulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (legacyBytesPulled >= 32 * 1024 * 1024) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(64 * 1024).fill(65);
      legacyBytesPulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });

  const res = new Response(stream, { status: 200 });
  await legacyFetchText(res, MAX_DISCOVERY_DOC_BYTES);

  // Under the legacy implementation, all 32 MiB (33,554,432 bytes) was pulled into memory
  assertEquals(legacyBytesPulled, 33554432, "legacy res.text() pulled full 32 MiB body");

  // Prove that the streaming gate assertion (bytesPulled <= 576 KiB) fails closed RED on the legacy implementation
  const bound = MAX_DISCOVERY_DOC_BYTES + 64 * 1024;
  assertThrows(
    () => {
      assert(legacyBytesPulled <= bound, `bytes pulled must be <= ${bound}`);
    },
    AssertionError,
    "bytes pulled must be <=",
  );
});
