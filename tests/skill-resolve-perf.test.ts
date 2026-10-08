// @ts-nocheck
// tests/skill-resolve-perf.test.ts — Performance & deduplication contract for skill resolution (chrome-agent-platform-3m3sn)
import { assertEquals, assert } from "jsr:@std/assert@1";
import { resolveSkillRef, createMemoizedSkillStores } from "../extension/lib/skill-resolve.js";

Deno.test("3m3sn: createMemoizedSkillStores memoizes loadAllImported and getCustomSkills across parallel calls", async () => {
  let loadAllImportedCalls = 0;
  let getCustomSkillsCalls = 0;

  const baseStores = {
    getSkill: (id: string) => undefined,
    getCustomSkills: async () => {
      getCustomSkillsCalls++;
      await new Promise((r) => setTimeout(r, 5));
      return [{ id: "c1", name: "Custom 1" }];
    },
    loadAllImported: async () => {
      loadAllImportedCalls++;
      await new Promise((r) => setTimeout(r, 5));
      return [
        { id: "imp1", name: "Imported 1", promptBytes: 10 },
        { id: "imp2", name: "Imported 2", promptBytes: 10 },
        { id: "imp3", name: "Imported 3", promptBytes: 10 },
      ];
    },
    readSkillFile: async (id: string, file: string) => `body of ${id}`,
  };

  const memoized = createMemoizedSkillStores(baseStores);

  // Concurrently resolve 3 imported skills and 1 custom skill
  const [s1, s2, s3, c1] = await Promise.all([
    resolveSkillRef({ ref: "imported:imp1", stores: memoized }),
    resolveSkillRef({ ref: "imported:imp2", stores: memoized }),
    resolveSkillRef({ ref: "imported:imp3", stores: memoized }),
    resolveSkillRef({ ref: "custom:c1", stores: memoized }),
  ]);

  assertEquals(loadAllImportedCalls, 1, "loadAllImported must be called exactly ONCE across all concurrent resolves");
  assertEquals(getCustomSkillsCalls, 1, "getCustomSkills must be called exactly ONCE across all concurrent resolves");

  assertEquals(s1?.name, "Imported 1");
  assertEquals(s2?.name, "Imported 2");
  assertEquals(s3?.name, "Imported 3");
  assertEquals(c1?.name, "Custom 1");
});

Deno.test("3m3sn: batch error isolation in resolveSkillRefs preserves other skills when one rejects", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const fnSite = sw.indexOf("async function resolveSkillRefs(");
  assert(fnSite > 0);
  const endSite = sw.indexOf("\n}", fnSite);
  const fnSrc = sw.slice(fnSite, endSite + 2);

  const compiled = new Function(
    "skillRefIds",
    "resolveSkill",
    "skillStores",
    `return (${fnSrc.replace("async function resolveSkillRefs", "async function")});`,
  )(
    () => ["s1", "s_error", "s2"],
    async (id: string) => {
      if (id === "s_error") throw new Error("fatal database read failure");
      return { id, name: `Skill ${id}` };
    },
    () => ({}),
  );

  const res = await compiled("run /skill:s1 /skill:s_error /skill:s2");
  assertEquals(res.length, 2, "rejection in one skill resolution must not abort the batch");
  assertEquals(res[0].id, "s1");
  assertEquals(res[1].id, "s2");
});

Deno.test("3m3sn: continuation journaled skills chunk concurrent reads without dropping skills past 24", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const fnSite = sw.indexOf("async function mapConcurrentChunks(");
  assert(fnSite > 0, "mapConcurrentChunks helper must exist");
  const endSite = sw.indexOf("\n}", fnSite);
  const fnSrc = sw.slice(fnSite, endSite + 2);

  const mapConcurrentChunks = new Function(
    `return (${fnSrc.replace("async function mapConcurrentChunks", "async function")});`,
  )();

  // Test with 30 items (> 24)
  const items = Array.from({ length: 30 }, (_, i) => `skill-${i + 1}`);
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  const resolved = await mapConcurrentChunks(
    items,
    async (id: string) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise((r) => setTimeout(r, 10));
      currentConcurrent--;
      return { id };
    },
    24,
  );

  assertEquals(resolved.length, 30, "all 30 items must be resolved without truncation");
  assert(maxConcurrent <= 24, `concurrency must not exceed chunk size of 24 (saw ${maxConcurrent})`);
});

Deno.test("3m3sn: service-worker run-start hoists taskSkills resolution and uses Promise.all for concurrency", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));

  // 1. resolveSkillRefs uses Promise.all
  assert(
    /async\s+function\s+resolveSkillRefs[\s\S]*?Promise\.all\(\s*ids\.map/m.test(sw),
    "resolveSkillRefs must resolve IDs concurrently via Promise.all",
  );

  // 2. resolveAgentSkills uses Promise.all
  assert(
    /async\s+function\s+resolveAgentSkills[\s\S]*?Promise\.all\(\s*ids\.map/m.test(sw),
    "resolveAgentSkills must resolve IDs concurrently via Promise.all",
  );

  // 3. runTask continuation path does NOT call resolveSkillRefs(task) a second time
  const runTaskSite = sw.indexOf("async function runTask(");
  assert(runTaskSite > 0, "runTask exists");
  const endRunTaskSite = sw.indexOf("\nasync function", runTaskSite + 50);
  const runTaskSrc = sw.slice(runTaskSite, endRunTaskSite);

  const resolveSkillRefsMatches = [...runTaskSrc.matchAll(/resolveSkillRefs\s*\(/g)];
  assertEquals(
    resolveSkillRefsMatches.length,
    1,
    `runTask must only invoke resolveSkillRefs once (hoisted taskSkills), found ${resolveSkillRefsMatches.length} calls`,
  );

  // 4. journaledSkillIds loop is parallelized in chunks via mapConcurrentChunks without truncation
  assert(
    /mapConcurrentChunks\(\s*journaledSkillIds,\s*\(skillId\)\s*=>\s*resolveSkill/.test(runTaskSrc),
    "journaledSkillIds resolution must use mapConcurrentChunks for bounded concurrency without truncation",
  );
});
