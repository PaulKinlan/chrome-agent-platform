import { assertEquals } from "jsr:@std/assert@1";

Deno.test("Settings nav order matches rendered section order", async () => {
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
  const nav = html.match(/<aside\b[\s\S]*?<\/aside>/)?.[0] ?? "";
  const main = html.match(/<main\b[\s\S]*?<\/main>/)?.[0] ?? "";
  const navOrder = [...nav.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  const sectionOrder = [...main.matchAll(/<section\s+id="([^"]+)"/g)].map((match) => match[1]);
  assertEquals(navOrder, sectionOrder);
});
