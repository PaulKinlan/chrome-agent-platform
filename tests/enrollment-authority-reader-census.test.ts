import { assert, assertEquals } from "jsr:@std/assert@1";

// This is the authority-reading budget for cap:enrollment. A new raw read may
// silently interpret enrolled:true+promotionPending as active; additions need
// deliberate audit and this guard must fail on the very next focused test.
async function censusReaders(root: URL) {
  const directReads: string[] = [];
  const keyLiterals: string[] = [];
  const keyReferences: Record<string, number> = {};
  async function walk(dir: URL) {
    for await (const entry of Deno.readDir(dir)) {
      // Build outputs may include generated copies of service-worker.js with
      // stale/raw enrollment readers. Audit SOURCE only, never generated dist.
      if (entry.isDirectory && (entry.name === "dist" || entry.name === "dist-versions")) continue;
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) await walk(child);
      else if (entry.name.endsWith(".js")) {
        const source = await Deno.readTextFile(child);
        const path = child.pathname.slice(child.pathname.indexOf("/extension/") + 1);
        // Count SITES, not files. A second read beside the existing permitted
        // read must fail, just as a new raw reader in another file would.
        // Pin all ENROLL_KEY references as well: `kvGet([ENROLL_KEY])` and
        // `const K=ENROLL_KEY; kvGet(K)` then fail instead of bypassing this
        // narrow direct-call matcher. New writes also demand an explicit audit.
        const references = [...source.matchAll(/\bENROLL_KEY\b/g)].length;
        if (references) keyReferences[path] = references;
        for (const hit of source.matchAll(/kvGet\s*\(\s*(?:\[?\s*ENROLL_KEY\b|["']cap:enrollment["'])/g)) {
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
  return { directReads, keyLiterals, keyReferences };
}

Deno.test("D2: generated dist-versions and dist cannot impersonate tracked enrollment source", async () => {
  const temp = await Deno.makeTempDir({ prefix: "d2-source-census-" });
  const root = new URL(`file://${temp}/extension/`);
  try {
    for (const path of ["lib", "dist", "dist-versions/0.3.1"]) {
      await Deno.mkdir(new URL(`${path}/`, root), { recursive: true });
    }
    await Deno.writeTextFile(new URL("lib/tracked.js", root), 'const ENROLL_KEY = "cap:enrollment"; kvGet([ENROLL_KEY]);');
    for (const path of ["dist/service-worker.js", "dist-versions/0.3.1/service-worker.js"]) {
      await Deno.writeTextFile(new URL(path, root), 'const ENROLL_KEY = "cap:enrollment"; kvGet([ENROLL_KEY]);');
    }
    const found = await censusReaders(root);
    assertEquals(found.directReads.map((p) => p.replace(/:\d+$/, "")), ["extension/lib/tracked.js"]);
    assertEquals(Object.keys(found.keyReferences), ["extension/lib/tracked.js"]);
    assertEquals(found.keyLiterals.map((p) => p.replace(/:\d+$/, "")), ["extension/lib/tracked.js"]);
  } finally { await Deno.remove(temp, { recursive: true }); }
});

Deno.test("D2: exactly three public active readers and one fenced locked-audit exception", async () => {
  const { directReads, keyLiterals, keyReferences } = await censusReaders(new URL("../extension/", import.meta.url));
  assertEquals(directReads.map((p) => p.replace(/:\d+$/, "")).sort(), [
    "extension/lib/memory.js", // listOrigins: canonical public worker listing
    "extension/lib/tools.js", // enrolledMap: isEnrolled/snapshot + locked tombstone reads
  ]);
  assertEquals(keyReferences, {
    "extension/lib/memory.js": 3,
    "extension/lib/tools.js": 13,
  });
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
  const lockedConsent = functionBody(tools, "export async function toolConsentStatesLocked(",
    "export async function toolConsentStates(");
  assert(lockedConsent.includes("enrollment.phase || enrollment.promotionPending"),
    "Disable's consent-state reader must not treat pending enrollment as executable");
  assert(sw.includes("enrollmentGeneration(record?.origin, { requireActive: true })"));
  assert(!sw.includes("{ enrolled: true, gen: await enrollmentGeneration("));
  assert(!tools.includes("Object.keys(map).filter((o) => map[o]?.enrolled === true)"),
    "lifecycle return lists must route through listOrigins");
});
