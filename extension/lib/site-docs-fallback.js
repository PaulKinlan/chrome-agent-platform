// lib/site-docs-fallback.js — chrome-agent-platform-922q
//
// The site-agent DOCS FALLBACK. When an enrolled site's declared tool fails
// (the owner's beads.gascity.com search_docs throwing DOMException:
// UnknownError from Chrome's native WebMCP dispatch layer), the agent must not
// hand the owner a bare failure when the answer is sitting in the site's own
// documentation. This module fetches the enrolled origin's documentation
// directly — the Mintlify-style /llms.txt index when the site publishes one,
// else /sitemap.xml, else the same-origin links on the site's root page —
// ranks what it finds against the tool call's query, reads the most relevant
// pages, and composes a tool result that SAYS it came from the docs because
// the tool failed.
//
// Trust: every fetched URL is pinned SAME-ORIGIN to the enrolled origin (the
// owner already approved running this site's code; reading its public pages
// adds no new trust surface). The composed content is page-controlled text,
// exactly like any tool RESULT the page returns — it is carried whole (the
// dptw directive: no size caps), and the fetch window is honestly reported
// ("N of M pages") rather than silently truncating.

// The fetch-count window per fallback: a TIME/REQUEST budget (each page is a
// network round-trip inside a tool call the owner is waiting on), not a size
// cap. The window is always reported ("fetched N of M"), so nothing is hidden.
export const DOCS_FETCH_WINDOW = 8;
export const PER_FETCH_TIMEOUT_MS = 10_000;

// Maximum byte size of page-controlled discovery documents (llms.txt / sitemap.xml / root HTML).
// Prevents superlinear or memory-exhausting scans on oversized documents (e7gwq).
export const MAX_DISCOVERY_DOC_BYTES = 512 * 1024; // 512 KiB

// Maximum candidate URLs discovered per index before filtering and ranking.
// Bounds memory allocation and prevents link-flooding DoS on the service worker (e7gwq).
export const MAX_DISCOVERED_LINKS = 256;

// Asset-ish paths are never documentation.
const ASSET_PATH_RE = /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|json|xml|woff2?|ttf|otf|eot|mp[34]|webm|pdf|zip|tar|gz)$/i;

function sameOriginOnly(urls, origin, maxUrls = MAX_DISCOVERED_LINKS) {
  const out = [];
  const seen = new Set();
  for (const raw of urls) {
    if (out.length >= maxUrls) break;
    let u;
    try {
      u = new URL(String(raw ?? ""), origin);
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    u.hash = "";
    const s = u.toString();
    if (seen.has(s)) continue;
    if (ASSET_PATH_RE.test(u.pathname)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Linear single-pass scanner for markdown link URLs [label](url).
 * Strictly O(N) forward-only scanning: no regex backtracking, no backward rescans (e7gwq voya0).
 * Supports URLs and titles containing literal square brackets (e.g. Wikipedia /wiki/Foo_[bar],
 * IPv6 addresses, and titles with brackets), while rejecting multiline links and nested link syntax (z3xx4).
 * Bounded by maxBytes (input slice) and maxLinks (stop early).
 * Optional stats object receives step count covering outer-loop progression and forward inner scan progression
 * for linear scan verification (j2vok, uil17).
 */
export function extractMarkdownLinks(
  text,
  {
    maxBytes = MAX_DISCOVERY_DOC_BYTES,
    maxLinks = MAX_DISCOVERED_LINKS,
    stats = null,
  } = {},
) {
  const input = typeof text === "string" || text instanceof String ? text.slice(0, maxBytes) : "";
  const urls = [];
  const len = input.length;
  const openStack = [];

  for (let i = 0; i < len && urls.length < maxLinks; i++) {
    if (stats) stats.steps = (stats.steps || 0) + 1;
    const code = input.charCodeAt(i);
    if (code === 91 /* [ */) {
      if (openStack.length < 32) openStack.push(i);
    } else if (code === 93 /* ] */) {
      const openBracket = openStack.pop();
      if (openBracket !== undefined && i + 1 < len && input.charCodeAt(i + 1) === 40 /* ( */) {
        const closeParen = input.indexOf(")", i + 2);
        if (closeParen === -1) {
          if (stats) stats.steps = (stats.steps || 0) + Math.max(0, len - (i + 2));
          break;
        }
        if (stats) stats.steps = (stats.steps || 0) + Math.max(0, closeParen - (i + 2));
        const inside = input.slice(i + 2, closeParen).trim();
        if (inside && !inside.includes("\n")) {
          const spaceIdx = inside.search(/\s/);
          let urlCandidate = spaceIdx !== -1 ? inside.slice(0, spaceIdx) : inside;
          if (urlCandidate.startsWith("<") && urlCandidate.endsWith(">")) {
            urlCandidate = urlCandidate.slice(1, -1).trim();
          }
          if (urlCandidate && !urlCandidate.includes("](")) {
            urls.push(urlCandidate);
          }
        }
        i = closeParen;
        openStack.length = 0;
      }
    }
  }

  return urls;
}

// Mintlify (and a growing set of docs platforms) publish /llms.txt: markdown
// with one link per docs page. Extract markdown link targets with linear single-pass scan (e7gwq).
export function parseLlmsTxt(
  text,
  origin,
  {
    maxBytes = MAX_DISCOVERY_DOC_BYTES,
    maxLinks = MAX_DISCOVERED_LINKS,
    stats = null,
  } = {},
) {
  const rawUrls = extractMarkdownLinks(text, {
    maxBytes,
    maxLinks,
    stats,
  });
  return sameOriginOnly(rawUrls, origin, maxLinks);
}

export function parseSitemapXml(text, origin, { maxBytes = MAX_DISCOVERY_DOC_BYTES, maxLinks = MAX_DISCOVERED_LINKS } = {}) {
  const input = typeof text === "string" || text instanceof String ? text.slice(0, maxBytes) : "";
  const urls = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m;
  while (urls.length < maxLinks && (m = re.exec(input)) !== null) {
    const raw = m[1]?.trim();
    if (raw) urls.push(raw);
  }
  return sameOriginOnly(urls, origin, maxLinks);
}

// Last resort: the site's root page. Same-origin hrefs in document order.
export function extractSameOriginHrefs(html, origin, { maxBytes = MAX_DISCOVERY_DOC_BYTES, maxLinks = MAX_DISCOVERED_LINKS } = {}) {
  const input = typeof html === "string" ? html.slice(0, maxBytes) : "";
  const urls = [];
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while (urls.length < maxLinks * 2 && (m = re.exec(input)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw) urls.push(raw);
  }
  return sameOriginOnly(urls, origin, maxLinks).filter((u) => {
    // A bare fragment or the root itself carries no documentation.
    let p;
    try {
      p = new URL(u).pathname;
    } catch {
      return false;
    }
    return p !== "" && p !== "/";
  });
}

// Relevance rank: count of query terms present in the URL path (and each
// term's earlier position breaks toward the front). Stable for ties — the
// site's own ordering (nav order, llms.txt order) is a meaningful signal.
export function rankDocUrls(urls, queryTerms) {
  const terms = (Array.isArray(queryTerms) ? queryTerms : [])
    .map((t) => String(t ?? "").toLowerCase())
    .filter((t) => t.length >= 3);
  const scored = urls.map((u, i) => {
    const path = String(u).toLowerCase();
    let score = 0;
    for (const t of terms) if (path.includes(t)) score++;
    return { u, i, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.u);
}

// A service worker has no DOM: this is a deliberately plain extraction for
// MODEL consumption (not display fidelity). Scripts, styles and markup go;
// prose stays; a handful of common entities are decoded.
export function htmlToText(html) {
  let s = String(html ?? "");
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style\s*>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
  return s.replace(/\s+/g, " ").trim();
}

// fetchText verifies the FINAL response URL: fetch follows redirects, and a
// same-origin docs URL that 302s cross-origin must never feed third-party
// content into the docs answer (922q review P2 — sameOriginOnly filters the
// discovered URL strings, not where they land). res.url is the post-redirect
// URL; when the platform doesn't report it (empty string) there is nothing
// to verify and the enrolled-origin request stands on its own.
async function fetchText(fetchImpl, url, timeoutMs, origin, maxBytes = null) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, credentials: "omit" });
    if (!res || !res.ok) return null;
    if (origin && typeof res.url === "string" && res.url) {
      let finalOrigin = null;
      try {
        finalOrigin = new URL(res.url).origin;
      } catch {
        finalOrigin = null;
      }
      if (finalOrigin !== origin) return null; // redirected off-origin — refused
    }
    const text = await res.text();
    if (typeof text !== "string") return null;
    return typeof maxBytes === "number" && maxBytes > 0 ? text.slice(0, maxBytes) : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Discover + read the site's documentation. Returns
// { urls, content, pagesUsed, pagesDiscovered } or null when nothing
// documentable is reachable (the caller then surfaces the original error).
export async function fetchSiteDocs({ origin, queryTerms = [], fetchImpl }) {
  const f = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof f !== "function") return null;
  let candidates = [];
  const llms = await fetchText(f, `${origin}/llms.txt`, PER_FETCH_TIMEOUT_MS, origin, MAX_DISCOVERY_DOC_BYTES);
  if (llms) candidates = parseLlmsTxt(llms, origin);
  if (!candidates.length) {
    const sitemap = await fetchText(f, `${origin}/sitemap.xml`, PER_FETCH_TIMEOUT_MS, origin, MAX_DISCOVERY_DOC_BYTES);
    if (sitemap) candidates = parseSitemapXml(sitemap, origin);
  }
  if (!candidates.length) {
    const root = await fetchText(f, `${origin}/`, PER_FETCH_TIMEOUT_MS, origin, MAX_DISCOVERY_DOC_BYTES);
    if (root) candidates = extractSameOriginHrefs(root, origin);
  }
  if (!candidates.length) return null;
  const ranked = rankDocUrls(candidates, queryTerms);
  const window_ = ranked.slice(0, DOCS_FETCH_WINDOW);
  const pages = [];
  for (const url of window_) {
    const html = await fetchText(f, url, PER_FETCH_TIMEOUT_MS, origin, null);
    if (html == null) continue; // a page that 404s/dies is skipped, not fatal
    const text = htmlToText(html);
    if (!text) continue;
    pages.push({ url, text });
  }
  if (!pages.length) return null;
  const content = pages.map((p) => `--- ${p.url} ---\n${p.text}`).join("\n\n");
  return {
    urls: pages.map((p) => p.url),
    content,
    pagesUsed: pages.length,
    pagesDiscovered: candidates.length,
  };
}

// The readSiteLazySources seam (the live model-facing site-tool dispatch):
// wrap a site-tool result. A success passes through untouched; a failure tries
// the docs and — when they exist — returns the docs content as the tool
// result, with the failure and the fetch window stated plainly. When no docs
// are discoverable the ORIGINAL result (the honest error) is returned
// unchanged.
export async function withSiteDocsFallback({ origin, name, args, res, fetchImpl }) {
  const failed = res && (typeof res.error === "string" || res.ok === false);
  if (!failed) return res;
  const terms = [String(name ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")];
  if (args && typeof args === "object") {
    for (const v of Object.values(args)) {
      if (typeof v === "string") terms.push(v);
    }
  }
  const queryTerms = terms.join(" ").split(/\s+/).filter(Boolean);
  const docs = await fetchSiteDocs({ origin, queryTerms, fetchImpl }).catch(() => null);
  if (!docs) return res;
  const toolError = String(res.error ?? "the call failed");
  const result =
    `The site's ${name} tool failed (${toolError}) — so this answer comes from the site's own documentation instead. ` +
    `Fetched ${docs.pagesUsed} of ${docs.pagesDiscovered} documentation pages discovered on ${origin} ` +
    `(ranked by relevance to the request; ask a follow-up to read more):\n` +
    docs.urls.map((u) => `- ${u}`).join("\n") +
    `\n\n${docs.content}`;
  return {
    ok: true,
    result,
    docsFallback: {
      tool: String(name ?? ""),
      toolError,
      pagesUsed: docs.pagesUsed,
      pagesDiscovered: docs.pagesDiscovered,
      urls: docs.urls,
    },
  };
}
