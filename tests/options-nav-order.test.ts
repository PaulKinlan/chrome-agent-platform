import { assertEquals } from "jsr:@std/assert@1";
import { DEVELOPER_SECTIONS } from "../extension/lib/pure.js";

Deno.test("Settings nav order matches rendered section order", async () => {
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
  const nav = html.match(/<aside\b[\s\S]*?<\/aside>/)?.[0] ?? "";
  const main = html.match(/<main\b[\s\S]*?<\/main>/)?.[0] ?? "";
  const navOrder = [...nav.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  const sectionOrder = [...main.matchAll(/<section\s+id="([^"]+)"/g)].map((match) => match[1]);
  assertEquals(navOrder, sectionOrder);
});

// CAP-FB-20260830-EXEC-BUILD-FLAG-01 — the developer-features flag hides the
// platform lanes from the DEFAULT Settings surface. The four gated sections are
// marked in the HTML with data-developer="true" (both the nav item and the
// <section>), and the pure DEVELOPER_SECTIONS list is the SINGLE source of that
// set so the markup and the runtime gate can never drift.
Deno.test("developer sections are marked and DEVELOPER_SECTIONS is that exact set", async () => {
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
  const nav = html.match(/<aside\b[\s\S]*?<\/aside>/)?.[0] ?? "";
  const main = html.match(/<main\b[\s\S]*?<\/main>/)?.[0] ?? "";

  // The four sections carry data-developer="true".
  const devSectionIds = [...main.matchAll(/<section\s+id="([^"]+)"[^>]*\bdata-developer="true"/g)]
    .map((m) => m[1]).sort();
  assertEquals(devSectionIds, [...DEVELOPER_SECTIONS].sort());

  // The matching nav items carry data-developer="true" too, keyed by their href.
  const devNavIds = [...nav.matchAll(/href="#([^"]+)"[^>]*\bdata-developer="true"/g)]
    .map((m) => m[1]).sort();
  assertEquals(devNavIds, [...DEVELOPER_SECTIONS].sort());

  // The set is exactly the four platform lanes — never a user-facing section.
  assertEquals([...DEVELOPER_SECTIONS].sort(), ["board-permissions", "hooks", "prompts", "tool-library"]);

  // No user-facing section is marked developer (regression guard: the flag must
  // never hide Providers/Agents/Permissions/Skills/Usage/Data/About or the
  // legitimate Local folders / Browser control lanes).
  for (const id of ["providers", "local-folders", "agents", "browser", "permissions", "skills", "usage", "data", "about"]) {
    if (DEVELOPER_SECTIONS.includes(id)) throw new Error(`${id} must not be a developer section`);
  }
});
