import { assert, assertStringIncludes } from "jsr:@std/assert@1";

Deno.test("provider-run tools explain the global capability and each agent opt-in", async () => {
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
  const source = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
  assertStringIncludes(html, "Google Search grounding (Gemini) and web search (Anthropic)");
  assertStringIncludes(html, "Agents that may use provider-run tools");
  assertStringIncludes(html, "Each enabled agent can run provider-side web searches during its tasks.");
  assertStringIncludes(source, 'hint.textContent = "Can search the web during its runs."');
  assert(source.includes('const list = $("#server-tools-agent-list")'), "per-agent rows need a stable list below the explainer");
});
