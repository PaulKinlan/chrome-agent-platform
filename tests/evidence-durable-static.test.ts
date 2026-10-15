// Static text-artifact path check from evidence-durable: no full-tree materialization
// or generated-package verification in every fast gate. New or unlisted .wasm
// binaries are NOT inspected here; their hashing and exemptions remain in the
// original tests/evidence-durable.test.ts in the full suite.
import { assertEquals } from "jsr:@std/assert@1";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOTS = ["extension/wasm", "extension/lib", "packages/bundled"];
const TEXT = /\.(?:json|txt|md|sh|c|mjs|js)$/;
const OUTSIDE_TREE_PATH = /\/tmp\/[^\s"')]*|\/home\/[^\s"')]+/g;

export function outsideTreePaths(text: string): string[] {
  return [...text.matchAll(OUTSIDE_TREE_PATH)].map(([value]) => value);
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* sourceFiles(path);
    else if (entry.isFile && TEXT.test(entry.name)) yield path;
  }
}

Deno.test("luq4w: shipped text artifacts carry no /tmp or /home path references", () => {
  const offenders: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const path of sourceFiles(join(ROOT, root))) {
      const rel = relative(ROOT, path);
      for (const value of outsideTreePaths(Deno.readTextFileSync(path))) {
        offenders.push(`${rel}: ${value}`);
      }
    }
  }
  assertEquals(offenders, [], "outside-tree path references in shipped text artifacts");
});

Deno.test("luq4w: path-literal detector rejects both formerly escaped host roots", () => {
  assertEquals(outsideTreePaths('const a="/tmp/build/artifact"; const b="/home/author/worktree";'),
    ["/tmp/build/artifact", "/home/author/worktree"]);
  assertEquals(outsideTreePaths('const a="/root/fixture";'), []);
});
