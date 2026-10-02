// @ts-nocheck
// tests/capture-page-reader-3p3e4.test.ts — tests for capture_page reader-mode extraction (chrome-agent-platform-3p3e.4)
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  extractReadableMarkdown,
  wrapUntrustedContent,
} from "../extension/lib/page-reader.js";
import { toolUserLanguage, TOOL_USER_LANGUAGE } from "../extension/lib/permission-language.js";
import { toolPurposeGroup } from "../extension/lib/tool-purpose-groups.js";
import { replaySafetyForTool, REPLAY_READ_ONLY } from "../extension/lib/tool-replay-safety.js";
import { BROWSER_TOOL_NAMES } from "../extension/lib/chrome-tool-capabilities.js";
import { browserToolset, capturePage, capturePageToArtifact } from "../extension/lib/browser-tools.js";

Deno.test("page-reader: extractReadableMarkdown extracts clean Markdown and YAML frontmatter", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Sample Article Title</title>
        <meta name="author" content="Jane Doe">
        <meta property="article:published_time" content="2026-10-01T12:00:00Z">
        <link rel="canonical" href="https://example.com/posts/sample">
      </head>
      <body>
        <header><div class="logo">Site Logo</div><p>Header text</p></header>
        <nav role="navigation"><a href="/">Home</a><a href="/about">About</a></nav>
        <div aria-hidden="true">Hidden decorative modal</div>
        <main>
          <article>
            <h1>Main Article Heading</h1>
            <p>This is the first paragraph with <strong>bold</strong> and <em>italic</em> text and <a href="/more-info">a relative link</a>.</p>
            <h2>Code & Lists</h2>
            <p>Check the list below:</p>
            <ul>
              <li>First item</li>
              <li>Second item with <code>inline code</code></li>
            </ul>
            <ol>
              <li>Numbered one</li>
              <li>Numbered two</li>
            </ol>
            <pre><code>function hello() {
  return "world";
}</code></pre>
            <blockquote>This is an important quote from the author.</blockquote>
            <h2>Tabular Data</h2>
            <table>
              <thead>
                <tr><th>Column A</th><th>Column B</th></tr>
              </thead>
              <tbody>
                <tr><td>Val 1</td><td>Val 2</td></tr>
                <tr><td>Val 3</td><td>Val 4</td></tr>
              </tbody>
            </table>
          </article>
        </main>
        <aside>Related stories</aside>
        <footer>Copyright 2026</footer>
        <script>console.log("bad script");</script>
        <style>body { color: red; }</style>
      </body>
    </html>
  `;

  const result = extractReadableMarkdown(html, {
    url: "https://example.com/posts/sample",
    capturedAt: "2026-10-01T20:00:00.000Z",
  });

  assertEquals(result.title, "Sample Article Title");
  assertEquals(result.byline, "Jane Doe");
  assertEquals(result.published, "2026-10-01T12:00:00Z");
  assertEquals(result.canonicalUrl, "https://example.com/posts/sample");
  assertEquals(result.truncated, false);

  // Check frontmatter
  assert(result.markdown.startsWith("---\n"));
  assert(result.markdown.includes('title: "Sample Article Title"'));
  assert(result.markdown.includes('source_url: "https://example.com/posts/sample"'));
  assert(result.markdown.includes('captured_at: "2026-10-01T20:00:00.000Z"'));
  assert(result.markdown.includes("word_count:"));

  // Check headings
  assert(result.markdown.includes("# Main Article Heading"));
  assert(result.markdown.includes("## Code & Lists"));
  assert(result.markdown.includes("## Tabular Data"));

  // Check paragraphs and inline formatting
  assert(result.markdown.includes("**bold**"));
  assert(result.markdown.includes("*italic*"));
  assert(result.markdown.includes("[a relative link](https://example.com/more-info)"));

  // Check list formatting
  assert(result.markdown.includes("- First item"));
  assert(result.markdown.includes("`inline code`"));
  assert(result.markdown.includes("1. Numbered one"));

  // Check code block
  assert(result.markdown.includes("```\nfunction hello()"));

  // Check blockquote
  assert(result.markdown.includes("> This is an important quote"));

  // Check table formatting
  assert(result.markdown.includes("| Column A | Column B |"));
  assert(result.markdown.includes("| --- | --- |"));
  assert(result.markdown.includes("| Val 1 | Val 2 |"));

  // Verify stripped boilerplate
  assert(!result.markdown.includes("Site Logo"));
  assert(!result.markdown.includes("Header text"));
  assert(!result.markdown.includes("Hidden decorative modal"));
  assert(!result.markdown.includes("Related stories"));
  assert(!result.markdown.includes("Copyright 2026"));
  assert(!result.markdown.includes("bad script"));
  assert(!result.markdown.includes("color: red"));

  // Verify links extracted
  assert(result.links.length >= 1);
  const relLink = result.links.find((l) => l.text === "a relative link");
  assert(relLink, "relative link was captured");
  assertEquals(relLink.href, "https://example.com/more-info");
});

Deno.test("page-reader: article fixture > 20 kB has wordCount above read_page truncation and headings preserved", () => {
  // read_page truncates at 20,000 characters (~3,000 words).
  // Generate a realistic long article > 25 kB.
  const paragraphs = [];
  for (let i = 1; i <= 100; i++) {
    paragraphs.push(
      `<p>Paragraph ${i}: This is detailed long-form content analyzing the state of distributed systems and local AI agents. We observe substantial improvements in memory safety, durable execution, and task isolation across autonomous subsystems. Paragraph index ${i} demonstrates sustained document density.</p>`
    );
    if (i % 10 === 0) {
      paragraphs.push(`<h2>Section ${i / 10}: Structural Analysis and Empirical Benchmarks</h2>`);
    }
  }

  const longHtml = `
    <html>
      <head><title>Extensive Research Whitepaper</title></head>
      <body>
        <nav><a href="#top">Skip nav</a></nav>
        <header>Banner info</header>
        <article>
          <h1>Long Article Header</h1>
          ${paragraphs.join("\n")}
        </article>
        <footer>Legal disclaimer</footer>
      </body>
    </html>
  `;

  assert(new TextEncoder().encode(longHtml).byteLength > 20000, "fixture exceeds 20 kB");

  const result = extractReadableMarkdown(longHtml, { url: "https://example.com/paper" });

  assert(result.wordCount > 1000, `wordCount (${result.wordCount}) reflects the full article content`);
  assert(result.markdown.includes("# Long Article Header"));
  assert(result.markdown.includes("## Section 1: Structural Analysis"));
  assert(result.markdown.includes("## Section 5: Structural Analysis"));
  assert(!result.markdown.includes("Skip nav"));
  assert(!result.markdown.includes("Banner info"));
  assert(!result.markdown.includes("Legal disclaimer"));
  assertEquals(result.truncated, false);
});

Deno.test("page-reader: a 10 MB fixture returns truncated:true under the 512 kB cap", () => {
  // Build a 10 MB HTML string
  const baseParagraph = "<p>Extensive benchmark segment repeating performance measurements across thousands of nodes. </p>\n";
  const repeatCount = Math.ceil((10 * 1024 * 1024) / baseParagraph.length);
  const largeHtml = `<html><body><h1>Mega Document</h1>${baseParagraph.repeat(repeatCount)}</body></html>`;

  assert(largeHtml.length >= 10 * 1024 * 1024, "fixture is at least 10 MB");

  const result = extractReadableMarkdown(largeHtml, { url: "https://example.com/mega" });

  assertEquals(result.truncated, true);
  const byteLen = new TextEncoder().encode(result.markdown).byteLength;
  assert(byteLen <= 512 * 1024, `markdown size ${byteLen} must be <= 512 KiB`);
  assert(result.markdown.includes("Mega Document"));
});

Deno.test("page-reader: wrapUntrustedContent fences markdown with random or placeholder token", () => {
  const sample = "# Hello World\nSome untrusted web content";
  const fenced = wrapUntrustedContent(sample, "testtoken123");
  assert(fenced.startsWith("<<<UNTRUSTED run:testtoken123>>>"));
  assert(fenced.endsWith("<<<END run:testtoken123>>>"));
  assert(fenced.includes(sample));
});

Deno.test("permission-language: toolUserLanguage maps capture_page to 'Save page as readable note'", () => {
  assertEquals(toolUserLanguage("capture_page"), "Save page as readable note");
  assertEquals(TOOL_USER_LANGUAGE.capture_page, "Save page as readable note");
});

Deno.test("chrome-tool-capabilities: capture_page is registered in BROWSER_TOOL_NAMES and capabilities", () => {
  assert(BROWSER_TOOL_NAMES.includes("capture_page"));
  const idxRead = BROWSER_TOOL_NAMES.indexOf("read_page");
  const idxCapture = BROWSER_TOOL_NAMES.indexOf("capture_page");
  assertEquals(idxCapture, idxRead + 1, "capture_page directly follows read_page");
});

Deno.test("tool-purpose-groups: capture_page is grouped under reading-capture", () => {
  assertEquals(toolPurposeGroup("capture_page"), "reading-capture");
});

Deno.test("tool-replay-safety: capture_page is classified as read-only", () => {
  assertEquals(replaySafetyForTool("capture_page"), REPLAY_READ_ONLY);
});

Deno.test("browser-tools: capture_page refuses privileged chrome:// URL before injection", async () => {
  // Mock global chrome.tabs
  const origChrome = globalThis.chrome;
  try {
    globalThis.chrome = {
      tabs: {
        query: async () => [{ id: 42, url: "chrome://settings" }],
        get: async (id: number) => ({ id, url: "chrome://settings" }),
      },
      permissions: {
        contains: async () => true,
      },
      scripting: {
        executeScript: async () => {
          throw new Error("executeScript MUST NOT be called on chrome:// URLs");
        },
      },
    };

    const res = await capturePage(42);
    assert(res.error, "must return error for privileged tab");
    assert(
      res.error.includes("only available on http(s) pages"),
      `error message must state 'only available on http(s) pages': got "${res.error}"`
    );
  } finally {
    globalThis.chrome = origChrome;
  }
});

Deno.test("browser-tools: capturePageToArtifact helper is exported and callable", () => {
  assertEquals(typeof capturePageToArtifact, "function");
});

Deno.test("browserToolset exposes capture_page with matching description and schema", () => {
  const tools = browserToolset(false);
  assert("capture_page" in tools, "capture_page is in browserToolset");
  const tool = tools.capture_page;
  assert(tool.description.includes("Capture a web page as a clean, readable Markdown"));
  const schema = tool.inputSchema;
  assert(schema.safeParse({}).success);
  assert(schema.safeParse({ asArtifact: true, includeScreenshot: true, screenshot: "full" }).success);
});
