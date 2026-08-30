import { assertEquals } from "jsr:@std/assert@1";

Deno.test("Settings nav order matches rendered section order", async () => {
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
  const nav = html.match(/<aside\b[\s\S]*?<\/aside>/)?.[0] ?? "";
  const main = html.match(/<main\b[\s\S]*?<\/main>/)?.[0] ?? "";
  const navOrder = [...nav.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  const sectionOrder = [...main.matchAll(/<section\s+id="([^"]+)"/g)].map((match) => match[1]);
  assertEquals(navOrder, sectionOrder);
});

Deno.test("Settings field labels are real <label for> elements (CAP-FB-20260830-FOCUS-ORDER-VISIBILITY-01)", async () => {
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
  // Every input/select/textarea in options.html must be associated with a
  // <label for="id"> or wrapped in a <label> — never a bare span.field-label.
  const controls = [...html.matchAll(/<(input|select|textarea)[^>]*?id="([^"]+)"[^>]*>/g)];
  const ids = new Set(controls.map((m) => m[2]));
  const labelFors = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]);
  const unlabeled = [...ids].filter((id) => !labelFors.includes(id));
  // wrapped labels: <label ...><span class="field-label">…</span><select id="x">…
  const wrapped = [...html.matchAll(/<label(?![^>]*for=)[\s\S]*?<span class="field-label">[\s\S]*?<(?:select|input|textarea)[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  const trulyUnlabeled = unlabeled.filter((id) => !wrapped.includes(id));
  assertEquals(trulyUnlabeled, [], `controls without a label-for or wrapping label: ${trulyUnlabeled.join(", ")}`);
});
