// lib/page-reader.js — pure / DOM-compatible reader-mode extraction
// Converts HTML documents or strings into clean structured Markdown with YAML frontmatter.
// Bounded to 512 kB markdown and 500 links.
// No eval, no DOM library dependencies (pure tokenizer/parser for non-DOM contexts).

import { fenceUntrustedText, UNTRUSTED_TOKEN_PLACEHOLDER } from "./untrusted-fence.js";

const MAX_MARKDOWN_BYTES = 512 * 1024; // 512 KiB
const MAX_LINKS = 500;

/** Decode common HTML entities. */
function decodeEntities(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => {
      const n = parseInt(dec, 10);
      return Number.isFinite(n) ? String.fromCharCode(n) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCharCode(n) : "";
    })
    .replace(/&amp;/g, "&");
}

/** Resolve URL against base URL if possible. */
function resolveUrl(href, baseUrl) {
  if (!href) return "";
  const trimmed = href.trim();
  if (!baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

/** Calculate UTF-8 byte length. */
function utf8Length(str) {
  return new TextEncoder().encode(str).byteLength;
}

/** Truncate string to maximum byte length at clean UTF-8 boundary. */
function truncateToBytes(str, maxBytes) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  if (bytes.byteLength <= maxBytes) return { text: str, truncated: false };

  // Slice to maxBytes
  let slice = bytes.subarray(0, maxBytes);
  // Decode ignoring trailing incomplete sequence
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let truncatedText = decoder.decode(slice);

  // Try to cleanly break at the last newline before cut
  const lastNewline = truncatedText.lastIndexOf("\n");
  if (lastNewline > maxBytes * 0.8) {
    truncatedText = truncatedText.slice(0, lastNewline);
  }

  return { text: truncatedText, truncated: true };
}

/** Count words in plain text. */
function countWords(str) {
  if (!str) return 0;
  // Strip markdown markers for honest word counting
  const plain = str
    .replace(/---[\s\S]*?---/, "") // strip frontmatter
    .replace(/[#*_`~[\]()<>|]/g, " ")
    .trim();
  if (!plain) return 0;
  return plain.split(/\s+/).filter(Boolean).length;
}

/** Elements whose entire subtree should be stripped. */
const STRIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
]);

/** Void elements in HTML. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Extract metadata and convert HTML or DOM Document to clean structured Markdown.
 *
 * @param {string | Document | Element} docOrHtml
 * @param {{ url?: string, title?: string, capturedAt?: string }} [options]
 * @returns {{
 *   title: string,
 *   byline: string | null,
 *   published: string | null,
 *   canonicalUrl: string,
 *   source_url: string,
 *   captured_at: string,
 *   markdown: string,
 *   body: string,
 *   links: Array<{ text: string, href: string }>,
 *   wordCount: number,
 *   truncated: boolean
 * }}
 */
export function extractReadableMarkdown(docOrHtml, options = {}) {
  const baseUrl = options.url || "";
  const capturedAt = options.capturedAt || new Date().toISOString();

  let html = "";
  let domTitle = "";
  let domCanonical = "";
  let domByline = null;
  let domPublished = null;

  if (typeof docOrHtml === "string") {
    html = docOrHtml;
  } else if (docOrHtml && typeof docOrHtml === "object") {
    // DOM Document or Element
    try {
      if (typeof docOrHtml.title === "string") domTitle = docOrHtml.title;
      if (docOrHtml.querySelector) {
        const canEl = docOrHtml.querySelector('link[rel="canonical"]');
        if (canEl?.getAttribute) domCanonical = canEl.getAttribute("href") || "";
        const authEl = docOrHtml.querySelector('meta[name="author"], meta[property="author"], [rel="author"], [itemprop="author"]');
        if (authEl) domByline = authEl.getAttribute?.("content") || authEl.textContent?.trim() || null;
        const pubEl = docOrHtml.querySelector('meta[property="article:published_time"], meta[name="publication_date"], time[datetime]');
        if (pubEl) domPublished = pubEl.getAttribute?.("content") || pubEl.getAttribute?.("datetime") || null;
      }
      if (docOrHtml.documentElement) {
        html = docOrHtml.documentElement.outerHTML || "";
      } else if (docOrHtml.outerHTML) {
        html = docOrHtml.outerHTML;
      } else if (docOrHtml.body) {
        html = docOrHtml.body.innerHTML || "";
      }
    } catch {
      html = String(docOrHtml ?? "");
    }
  }

  // Fallback metadata from HTML string if not resolved from DOM
  const title = options.title || domTitle || extractTitleFromHtml(html) || "Untitled";
  const canonicalUrl = domCanonical ? resolveUrl(domCanonical, baseUrl) : extractCanonicalFromHtml(html, baseUrl);
  const byline = domByline || extractBylineFromHtml(html);
  const published = domPublished || extractPublishedFromHtml(html);

  // Convert HTML to clean markdown & links
  const { bodyMarkdown, links } = parseHtmlToMarkdown(html, baseUrl);

  // Calculate word count of body
  const wordCount = countWords(bodyMarkdown);

  // Build YAML frontmatter
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `source_url: ${JSON.stringify(canonicalUrl)}`,
    `captured_at: ${JSON.stringify(capturedAt)}`,
    `word_count: ${wordCount}`,
    "---",
    "",
  ].join("\n");

  const fullMarkdownUnchecked = `${frontmatter}\n${bodyMarkdown}`.trim() + "\n";

  // Enforce byte bound ≤ 512 KiB
  const { text: boundedMarkdown, truncated } = truncateToBytes(fullMarkdownUnchecked, MAX_MARKDOWN_BYTES);

  const boundedLinks = links.slice(0, MAX_LINKS);

  return {
    title,
    byline,
    published,
    canonicalUrl,
    source_url: canonicalUrl,
    captured_at: capturedAt,
    markdown: boundedMarkdown,
    body: bodyMarkdown,
    links: boundedLinks,
    wordCount,
    truncated,
    toString() {
      return this.markdown;
    },
  };
}

/** Extract <title> or og:title from HTML string. */
function extractTitleFromHtml(html) {
  if (!html) return "";
  const ogMatch = html.match(/<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                  html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  if (ogMatch?.[1]) return decodeEntities(ogMatch[1].trim());

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "").trim());

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) return decodeEntities(h1Match[1].replace(/<[^>]+>/g, "").trim());

  return "";
}

/** Extract canonical URL from HTML string. */
function extractCanonicalFromHtml(html, baseUrl) {
  if (!html) return baseUrl;
  const match = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ||
                html.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (match?.[1]) return resolveUrl(match[1], baseUrl);
  return baseUrl;
}

/** Extract byline/author from HTML string. */
function extractBylineFromHtml(html) {
  if (!html) return null;
  const match = html.match(/<meta\s+[^>]*name=["']author["'][^>]*content=["']([^"']+)["']/i) ||
                html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']author["']/i);
  if (match?.[1]) return decodeEntities(match[1].trim());
  return null;
}

/** Extract publication date from HTML string. */
function extractPublishedFromHtml(html) {
  if (!html) return null;
  const match = html.match(/<meta\s+[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i) ||
                html.match(/<meta\s+[^>]*name=["']publication_date["'][^>]*content=["']([^"']+)["']/i) ||
                html.match(/<time[^>]*datetime=["']([^"']+)["']/i);
  if (match?.[1]) return decodeEntities(match[1].trim());
  return null;
}

/**
 * Pure streaming HTML tokenizer & markdown generator.
 * Fast, jsdom-free, handles nested tags, stripping boilerplate & navigation.
 */
function parseHtmlToMarkdown(html, baseUrl) {
  const links = [];
  const linkSet = new Set();

  if (!html || typeof html !== "string") {
    return { bodyMarkdown: "", links };
  }

  // Pre-strip body bounds if <body> exists to ignore head metadata noise
  let content = html;
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch?.[1]) {
    content = bodyMatch[1];
  }

  // State machine for tag tokenization
  const parts = [];
  const tagStack = []; // [{ name, isStrip, isCode, listType, listIndex, isTable, tableRow, tableCells }]
  let stripDepth = 0;
  let codeDepth = 0;
  let blockquoteDepth = 0;
  let listDepth = 0;
  let currentList = null; // { type: 'ul' | 'ol', index: number }
  const listStack = [];
  let tableState = null; // { headers: [], rows: [] }

  // Regex to match HTML tags vs text
  const tagRegex = /<(?:(?:\/([a-zA-Z0-9]+))|(?:([a-zA-Z0-9]+)((?:\s+[^>]*)?)\s*(\/?)))>|([^<]+)/gi;
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    const [raw, closeTag, openTag, attrString, selfClosingSlash, textChunk] = match;

    if (textChunk) {
      if (stripDepth > 0) continue;
      if (tableState) {
        if (tableState.currentCell !== null) {
          tableState.currentCell += decodeEntities(textChunk);
        }
        continue;
      }
      if (codeDepth > 0) {
        parts.push(decodeEntities(textChunk));
      } else {
        const decoded = decodeEntities(textChunk);
        // Normalize whitespace within text chunks
        const normalized = decoded.replace(/\s+/g, " ");
        if (normalized.length > 0) {
          parts.push(normalized);
        }
      }
      continue;
    }

    if (openTag) {
      const tagLower = openTag.toLowerCase();
      const isSelfClosing = selfClosingSlash === "/" || VOID_TAGS.has(tagLower);

      // Check for strip conditions: tag in STRIP_TAGS or role="navigation" or aria-hidden="true"
      let shouldStrip = STRIP_TAGS.has(tagLower);
      if (!shouldStrip && attrString) {
        if (/\brole=["']navigation["']/i.test(attrString)) shouldStrip = true;
        if (/\baria-hidden=["']true["']/i.test(attrString)) shouldStrip = true;
      }

      if (shouldStrip) {
        if (!isSelfClosing) stripDepth++;
        continue;
      }
      if (stripDepth > 0) {
        if (!isSelfClosing) stripDepth++;
        continue;
      }

      // Handling allowed elements
      if (tagLower === "pre") {
        codeDepth++;
        parts.push("\n\n```\n");
      } else if (tagLower === "code" && codeDepth === 0) {
        parts.push("`");
      } else if (/^h[1-6]$/.test(tagLower)) {
        const level = parseInt(tagLower[1], 10);
        parts.push(`\n\n${"#".repeat(level)} `);
      } else if (tagLower === "p") {
        parts.push("\n\n");
      } else if (tagLower === "blockquote") {
        blockquoteDepth++;
        parts.push("\n\n> ");
      } else if (tagLower === "ul" || tagLower === "ol") {
        listDepth++;
        currentList = { type: tagLower, index: 1 };
        listStack.push(currentList);
        parts.push("\n");
      } else if (tagLower === "li") {
        const indent = "  ".repeat(Math.max(0, listDepth - 1));
        if (currentList?.type === "ol") {
          parts.push(`\n${indent}${currentList.index++}. `);
        } else {
          parts.push(`\n${indent}- `);
        }
      } else if (tagLower === "a" && attrString) {
        const hrefMatch = attrString.match(/href=["']([^"']+)["']/i);
        const rawHref = hrefMatch?.[1] ? hrefMatch[1].trim() : "";
        const href = resolveUrl(rawHref, baseUrl);
        tagStack.push({ name: "a", href, startPart: parts.length });
        parts.push("[");
        continue;
      } else if (tagLower === "strong" || tagLower === "b") {
        parts.push("**");
      } else if (tagLower === "em" || tagLower === "i") {
        parts.push("*");
      } else if (tagLower === "hr") {
        parts.push("\n\n---\n\n");
      } else if (tagLower === "br") {
        parts.push("\n");
      } else if (tagLower === "table") {
        tableState = { headers: [], rows: [], currentRow: null, currentCell: null, isHeader: false };
      } else if (tagLower === "thead") {
        if (tableState) tableState.isHeader = true;
      } else if (tagLower === "tbody") {
        if (tableState) tableState.isHeader = false;
      } else if (tagLower === "tr") {
        if (tableState) tableState.currentRow = [];
      } else if (tagLower === "th" || tagLower === "td") {
        if (tableState) {
          tableState.currentCell = "";
          if (tagLower === "th") tableState.isHeader = true;
        }
      }

      if (!isSelfClosing) {
        tagStack.push({ name: tagLower });
      }
      continue;
    }

    if (closeTag) {
      const tagLower = closeTag.toLowerCase();
      if (stripDepth > 0) {
        stripDepth--;
        continue;
      }

      if (tagLower === "pre") {
        if (codeDepth > 0) {
          codeDepth--;
          parts.push("\n```\n\n");
        }
      } else if (tagLower === "code" && codeDepth === 0) {
        parts.push("`");
      } else if (/^h[1-6]$/.test(tagLower)) {
        parts.push("\n\n");
      } else if (tagLower === "p") {
        parts.push("\n\n");
      } else if (tagLower === "blockquote") {
        if (blockquoteDepth > 0) blockquoteDepth--;
        parts.push("\n\n");
      } else if (tagLower === "ul" || tagLower === "ol") {
        listStack.pop();
        currentList = listStack[listStack.length - 1] || null;
        if (listDepth > 0) listDepth--;
        parts.push("\n");
      } else if (tagLower === "strong" || tagLower === "b") {
        parts.push("**");
      } else if (tagLower === "em" || tagLower === "i") {
        parts.push("*");
      } else if (tagLower === "a") {
        // Find matching 'a' tag in tagStack
        let foundIdx = -1;
        for (let i = tagStack.length - 1; i >= 0; i--) {
          if (tagStack[i].name === "a") {
            foundIdx = i;
            break;
          }
        }
        if (foundIdx !== -1) {
          const aInfo = tagStack[foundIdx];
          tagStack.splice(foundIdx, 1);
          const linkText = parts.slice(aInfo.startPart + 1).join("").trim();
          parts.push(`](${aInfo.href || ""})`);
          if (aInfo.href && !aInfo.href.startsWith("javascript:") && links.length < MAX_LINKS) {
            const key = `${linkText}::${aInfo.href}`;
            if (!linkSet.has(key)) {
              linkSet.add(key);
              links.push({ text: linkText, href: aInfo.href });
            }
          }
        }
      } else if (tagLower === "th" || tagLower === "td") {
        if (tableState && tableState.currentRow && tableState.currentCell !== null) {
          tableState.currentRow.push(tableState.currentCell.trim());
          tableState.currentCell = null;
        }
      } else if (tagLower === "tr") {
        if (tableState && tableState.currentRow) {
          if (tableState.isHeader && tableState.headers.length === 0) {
            tableState.headers = tableState.currentRow;
          } else {
            tableState.rows.push(tableState.currentRow);
          }
          tableState.currentRow = null;
        }
      } else if (tagLower === "table") {
        if (tableState) {
          const tableMd = formatMarkdownTable(tableState);
          if (tableMd) parts.push(`\n\n${tableMd}\n\n`);
          tableState = null;
        }
      }

      // Pop regular tag from stack if present
      for (let i = tagStack.length - 1; i >= 0; i--) {
        if (tagStack[i].name === tagLower) {
          tagStack.splice(i, 1);
          break;
        }
      }
    }
  }

  // Format resulting markdown text
  let bodyMarkdown = parts.join("");

  // Clean excessive blank lines (more than 2 consecutive newlines)
  bodyMarkdown = bodyMarkdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { bodyMarkdown, links };
}

/** Format table rows as a Markdown table. */
function formatMarkdownTable(tableState) {
  let headers = tableState.headers;
  const rows = tableState.rows;

  if ((!headers || headers.length === 0) && rows.length > 0) {
    headers = rows.shift();
  }
  if (!headers || headers.length === 0) return "";

  const colCount = headers.length;
  const cleanHeader = headers.map((h) => h.replace(/\|/g, "\\|"));
  const headerLine = `| ${cleanHeader.join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const rowLines = rows.map((r) => {
    const cells = [];
    for (let c = 0; c < colCount; c++) {
      cells.push((r[c] || "").replace(/\|/g, "\\|"));
    }
    return `| ${cells.join(" | ")} |`;
  });

  return [headerLine, sepLine, ...rowLines].join("\n");
}

/** Wrap untrusted content with random/run boundary token. */
export function wrapUntrustedContent(content, token = UNTRUSTED_TOKEN_PLACEHOLDER) {
  return fenceUntrustedText(content, token);
}
