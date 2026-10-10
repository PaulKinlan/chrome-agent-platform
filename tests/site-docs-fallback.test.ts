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
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
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
 * Independent complexity guard that instruments String.prototype access during execution
 * to measure total character inspections, backward reads, and backward rescan method calls.
 * Fails closed without relying on wall-clock timing budgets (uil17).
 */
function measureCharacterInspections<T>(fn: () => T): {
  result: T;
  charReads: number;
  backwardReads: number;
  lastIndexOfCalls: number;
} {
  let charReads = 0;
  let backwardReads = 0;
  let lastIndexOfCalls = 0;
  let maxIndexSeen = -1;

  const origCharCodeAt = String.prototype.charCodeAt;
  const origLastIndexOf = String.prototype.lastIndexOf;

  try {
    String.prototype.charCodeAt = function (idx: number) {
      charReads++;
      if (idx < maxIndexSeen) {
        backwardReads++;
      } else if (idx > maxIndexSeen) {
        maxIndexSeen = idx;
      }
      return origCharCodeAt.call(this, idx);
    };

    String.prototype.lastIndexOf = function (...args: any[]) {
      lastIndexOfCalls++;
      return origLastIndexOf.apply(this, args);
    };

    const result = fn();
    return { result, charReads, backwardReads, lastIndexOfCalls };
  } finally {
    String.prototype.charCodeAt = origCharCodeAt;
    String.prototype.lastIndexOf = origLastIndexOf;
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

Deno.test("uil17 acceptance: independent complexity guard deterministically catches un-bookkept backward-rescan mutants without relying on timing", () => {
  // Acceptance criterion for chrome-agent-platform-uil17:
  // Verify that an independent guard observing character inspections fails closed against
  // un-bookkept backward rescan regressions (both lastIndexOf and explicit loop variants)
  // without relying on wall-clock timing budgets.
  const sampleSize = 1_000;
  const sample = "]".repeat(sampleSize);

  // 1. Real production extractMarkdownLinks:
  // Strictly forward single-pass scanner.
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

  // 2. Mutant A: un-bookkept lastIndexOf backward scan
  const mutantAMeasurement = measureCharacterInspections(() => {
    return mutantVoya0LastIndexOfScan(sample);
  });
  // The independent guard catches lastIndexOf calls immediately:
  assertEquals(mutantAMeasurement.lastIndexOfCalls, sampleSize, "mutant A makes lastIndexOf call for every closing bracket");
  assert(mutantAMeasurement.lastIndexOfCalls > 0, "independent guard catches backward scan method calls");

  // 3. Mutant B: un-bookkept backward loop scan
  const mutantBMeasurement = measureCharacterInspections(() => {
    return mutantVoya0BackwardLoopScan(sample);
  });
  // The independent guard catches backward character reads immediately:
  const expectedBackwardReads = (sampleSize * (sampleSize - 1)) / 2;
  assertEquals(mutantBMeasurement.backwardReads, expectedBackwardReads, "mutant B backward reads match O(N^2) backward scan");
  assertEquals(mutantBMeasurement.charReads, sampleSize + expectedBackwardReads, "mutant B total char reads are quadratic");
  assert(
    mutantBMeasurement.charReads > sample.length,
    `mutant B violates deterministic linear complexity: ${mutantBMeasurement.charReads} > ${sample.length}`,
  );

  // Verify that the linear complexity assertions fail closed on both mutants without timing:
  assertThrows(
    () => {
      assert(mutantAMeasurement.lastIndexOfCalls === 0, "backward scan detected via lastIndexOf");
    },
    Error,
    "backward scan detected via lastIndexOf",
  );

  assertThrows(
    () => {
      assert(mutantBMeasurement.backwardReads === 0, "backward scan detected via backward char reads");
    },
    Error,
    "backward scan detected via backward char reads",
  );

  assertThrows(
    () => {
      assert(mutantBMeasurement.charReads <= sample.length, "linear complexity bound exceeded");
    },
    Error,
    "linear complexity bound exceeded",
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
