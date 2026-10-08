import { assert, assertEquals } from "jsr:@std/assert@1";

// This is the authority-reading budget for cap:enrollment. A new raw read may
// silently interpret enrolled:true+promotionPending as active; additions need
// deliberate audit and this guard must fail on the very next focused test.
Deno.test("D2: exactly three public active readers and one fenced locked-audit exception", async () => {
  const root = new URL("../extension/", import.meta.url);
  const directReads: string[] = [];
  const keyLiterals: string[] = [];
  async function walk(dir: URL) {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) await walk(child);
      else if (entry.name.endsWith(".js")) {
        const source = await Deno.readTextFile(child);
        const path = child.pathname.slice(child.pathname.indexOf("/extension/") + 1);
        // Count SITES, not files. A second read beside the existing permitted
        // read must fail, just as a new raw reader in another file would.
        for (const hit of source.matchAll(/kvGet\s*\(\s*(?:ENROLL_KEY|["']cap:enrollment["'])\s*\)/g)) {
          directReads.push(`${path}:${source.slice(0, hit.index).split("\n").length}`);
        }
        // Another alias for the enrollment key (including a direct
        // chrome.storage.local.get) cannot silently evade the read matcher.
        for (const hit of source.matchAll(/["']cap:enrollment["']/g)) {
          keyLiterals.push(`${path}:${source.slice(0, hit.index).split("\n").length}`);
        }
      }
    }
  }
  await walk(root);
  assertEquals(directReads.map((p) => p.replace(/:\d+$/, "")).sort(), [
    "extension/lib/memory.js", // listOrigins: canonical public worker listing
    "extension/lib/tools.js", // enrolledMap: isEnrolled/snapshot + locked tombstone reads
  ]);
  assertEquals(keyLiterals.map((p) => p.replace(/:\d+$/, "")).sort(), [
    "extension/lib/archive-target-registry.js", // export authority exclusion, NOT a reader
    "extension/lib/memory.js", // one named registry key
    "extension/lib/tools.js", // same key, global enrollment lock
  ]);
  const tools = await Deno.readTextFile(new URL("../extension/lib/tools.js", import.meta.url));
  const memory = await Deno.readTextFile(new URL("../extension/lib/memory.js", import.meta.url));
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const functionBody = (source: string, start: string, end: string) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert(from >= 0 && to > from, `function boundary ${start}`);
    return source.slice(from, to);
  };
  for (const body of [
    functionBody(tools, "export async function isEnrolled(", "export async function enrollmentGeneration("),
    functionBody(tools, "export async function enrollmentSnapshot(", "export async function enrollmentPolicy("),
    functionBody(memory, "export async function listOrigins(", "// A small journal abstraction"),
  ]) {
    assert(body.includes("promotionPending"), "public active read must reject pending");
  }
  const generation = functionBody(tools, "export async function enrollmentGeneration(", "export async function enrollmentSnapshot(");
  assert(generation.includes("requireActive") && generation.includes("row?.promotionPending"));
  assert(sw.includes("enrollmentGeneration(record?.origin, { requireActive: true })"));
  assert(!sw.includes("{ enrolled: true, gen: await enrollmentGeneration("));
  assert(!tools.includes("Object.keys(map).filter((o) => map[o]?.enrolled === true)"),
    "lifecycle return lists must route through listOrigins");
});
