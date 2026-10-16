// Shipped internal documents need an explicit default language, too.
// Read each real HTML entry; neither is a test fixture or a generated bundle.
import { assertEquals, assertMatch } from "jsr:@std/assert@1";

for (const [path, expectedScript] of [
  ["offscreen/offscreen.html", "../dist/offscreen.bundle.js"],
  ["sandbox/script-sandbox.html", "script-sandbox.js"],
]) {
  Deno.test(`4o7k6: ${path} declares English on its one actual html root`, () => {
    const html = Deno.readTextFileSync(new URL(`../extension/${path}`, import.meta.url));
    const roots = [...html.matchAll(/<html\b([^>]*)>/gi)];
    assertEquals(roots.length, 1, `${path} must have exactly one document root`);
    assertMatch(roots[0][1], /(?:^|\s)lang="en"(?:\s|$)/, `${path} must declare its actual English page language`);
    assertMatch(html, new RegExp(`<script\\b[^>]*\\bsrc="${expectedScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*><\\/script>`),
      `${path} must remain the shipped entry, not an unrelated HTML fixture`);
  });
}
