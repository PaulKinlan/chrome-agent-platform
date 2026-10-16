// Exact-path fast-tier coverage for the two user-visible Export HTML entries.
// This reads REAL shipped documents and the scripts they load: not a file-exists
// test, and never declares coverage for any other HTML or selector machinery.
import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
const root = new URL("../extension/", import.meta.url);
const source = (path: string) => Deno.readTextFileSync(new URL(path, root));
// Literal URLs create selector edges from each JS entry to this executable
// Export guard. Dynamic source(path) reads alone do not give it those edges.
const ntpScript = new URL("../extension/ntp/ntp.js", import.meta.url);
const artifactScript = new URL("../extension/artifact/artifact.js", import.meta.url);

function entryButton(html: string, id: string, label: string, initialState: "hidden" | "disabled") {
  const tags = [...html.matchAll(/<button\b[^>]*>[^<]*<\/button>/g)].map((m) => m[0]);
  const matches = tags.filter((tag) => new RegExp(`\\bid="${id}"`).test(tag));
  assertEquals(matches.length, 1, `one real button#${id} in the shipped document`);
  const tag = matches[0];
  assertMatch(tag, /\btype="button"/);
  assertStringIncludes(tag, `aria-label="${label}"`);
  assertMatch(tag, new RegExp(`\\b${initialState}(?:\\s|>)`));
  assert(!/\bstyle="[^"]*display\s*:\s*none/.test(tag), "do not hide the entry with an untracked style");
  return tag;
}

Deno.test("thread HTML: labelled, initially hidden Export action is in the loaded NTP thread header and wired to the exact thread route", () => {
  const html = source("ntp/ntp.html");
  assertMatch(html, /<script\s+type="module"\s+src="\.\.\/dist\/ntp\.bundle\.js"><\/script>/);
  const threadHeader = html.match(/<div id="thread-view"[^>]*>[\s\S]*?<div class="view-head">([\s\S]*?)<div class="thread-body">/)?.[1];
  assert(threadHeader, "the task-thread header exists in the shipped document");
  assertStringIncludes(entryButton(threadHeader, "export-thread", "Export thread as HTML", "hidden"), "Export thread…");
  const js = Deno.readTextFileSync(ntpScript);
  assertStringIncludes(js, 'document.getElementById("export-thread")');
  assertStringIncludes(js, 'exportThreadBtn?.addEventListener("click"');
  assertMatch(js, /openThreadExportPreview\(\{\s*kind:\s*"thread",\s*id/);
  assertMatch(js, /exportThreadBtn\.hidden\s*=\s*!thread/);
});

Deno.test("artifact HTML: labelled, disabled-until-loaded Export action is in the actual viewer toolbar and wired to artifact origin+id", () => {
  const html = source("artifact/artifact.html");
  assertMatch(html, /<script\s+type="module"\s+src="\.\.\/dist\/artifact\.bundle\.js"><\/script>/);
  const toolbar = html.match(/<div\s+class="head-right">[\s\S]*?<\/div>/)?.[0];
  assert(toolbar, "the standalone artifact viewer toolbar exists");
  assertStringIncludes(entryButton(toolbar, "export-html", "Export artifact as HTML", "disabled"), "Export HTML…");
  const js = Deno.readTextFileSync(artifactScript);
  assertStringIncludes(js, 'document.getElementById("export-html")');
  assertStringIncludes(js, 'exportBtn?.addEventListener("click"');
  assertMatch(js, /openThreadExportPreview\(\{\s*kind:\s*"artifact",\s*id,\s*origin/);
  assertMatch(js, /exportBtn\.disabled\s*=\s*!currentAsset/);
});
