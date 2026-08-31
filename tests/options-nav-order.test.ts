import { assertEquals } from "jsr:@std/assert@1";

Deno.test("Settings nav order matches rendered section order", async () => {
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
  const nav = html.match(/<aside\b[\s\S]*?<\/aside>/)?.[0] ?? "";
  const main = html.match(/<main\b[\s\S]*?<\/main>/)?.[0] ?? "";
  const navOrder = [...nav.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  const sectionOrder = [...main.matchAll(/<section\s+id="([^"]+)"/g)].map((match) => match[1]);
  assertEquals(navOrder, sectionOrder);
});

/** A deterministic, non-vacuous label scan of options.html.
 *
 * Walks the HTML as a tag stream tracking `<label>` nesting: a control is
 * "wrapped" when an unclosed `<label>` is open at the point the control's tag
 * appears; it is "for-associated" when any `<label for="id">` names it. A
 * control with neither is unlabeled. This never uses a spanning regex, so it
 * cannot accidentally match a label from an unrelated section, and it fails
 * RED the moment a `<label for>` or a wrapping label is replaced by a bare
 * `<span class="field-label">`.
 */
Deno.test("Settings field labels are real <label> associations (CAP-FB-20260830-FOCUS-ORDER-VISIBILITY-01)", async () => {
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));

  // <label for="id"> associations (anywhere in the document).
  const labelFor = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));

  // Tag-stream walk: track open <label> depth; record each control's id and
  // whether a label wraps it (an unclosed label is open at that position).
  const controlIds: string[] = [];
  const wrappedIds = new Set<string>();
  let labelDepth = 0;
  const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = TAG_RE.exec(html)) !== null) {
    const tag = m[0];
    const name = m[1].toLowerCase();
    if (tag.startsWith("</")) {
      if (name === "label") labelDepth = Math.max(0, labelDepth - 1);
      continue;
    }
    if (name === "label") {
      labelDepth += 1;
      continue;
    }
    if (["input", "select", "textarea"].includes(name)) {
      const idMatch = tag.match(/\bid="([^"]+)"/);
      if (idMatch) {
        controlIds.push(idMatch[1]);
        if (labelDepth > 0) wrappedIds.add(idMatch[1]);
      }
    }
    lastIndex = m.index;
  }
  assertEquals(controlIds.length > 0, true, "expected at least one control in options.html (the scan must not be vacuous)");

  const unlabeled = controlIds.filter((id) => !labelFor.has(id) && !wrappedIds.has(id));
  assertEquals(unlabeled, [], `controls without a <label for> or a wrapping <label>: ${unlabeled.join(", ")}`);
});
