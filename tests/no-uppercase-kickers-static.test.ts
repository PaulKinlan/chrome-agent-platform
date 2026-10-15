// Static source half of no-uppercase-kickers-716s10. The original file keeps
// its real-Chrome visual check in the full suite, never in the fast gate.
import { assertEquals } from "jsr:@std/assert@1";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION = join(ROOT, "extension");

export function uppercaseRules(source: string): string[] {
  return [...source.matchAll(/text-transform\s*:\s*uppercase\b/gi)].map(([rule]) => rule);
}

function* shippedFiles(dir: string): Generator<string> {
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || entry.name.startsWith("dist") || entry.name === "node_modules") continue;
      yield* shippedFiles(path);
    } else if (entry.isFile && /\.(?:css|js|html)$/.test(entry.name)) {
      yield path;
    }
  }
}

Deno.test("luq4w: shipped extension source has no uppercase text-transform rules", () => {
  const offenders: string[] = [];
  for (const path of shippedFiles(EXTENSION)) {
    for (const rule of uppercaseRules(Deno.readTextFileSync(path))) {
      offenders.push(`${relative(ROOT, path)}: ${rule}`);
    }
  }
  assertEquals(offenders, [], "uppercase text-transform rules in shipped extension source");
});

Deno.test("luq4w: uppercase source detector catches CSS in HTML, JS, and CSS spelling", () => {
  assertEquals(uppercaseRules('a { text-transform: uppercase; }'), ["text-transform: uppercase"]);
  assertEquals(uppercaseRules('<style>.k { TEXT-TRANSFORM:\n UPPERCASE }</style>'), ["TEXT-TRANSFORM:\n UPPERCASE"]);
  assertEquals(uppercaseRules('const style = "text-transform:uppercase";'), ["text-transform:uppercase"]);
  assertEquals(uppercaseRules('a { text-transform: none; }'), []);
});
