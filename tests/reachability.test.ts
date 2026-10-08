// The shipped-package reachability gate (scripts/check-reachability.mjs,
// CAP-FB-20260830-DEAD-CODE-CUT-01): every source file under extension/ is
// reached from a manifest entry point, a build entry, or a RETAINED root with
// a reason. Runs the checker in-process against the real tree, and proves the
// gate can fail by planting an unreferenced file in a copy of the tree.

// @ts-nocheck — the checker is plain ESM shared with node's build.mjs.
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  checkReachability,
  checkExportReachability,
  checkScriptsExportReachability,
  RETAINED,
  RETAINED_EXPORTS,
  candidateRefs,
  exportedFunctions,
  parseBundleMap,
  resolveRef,
} from "../scripts/check-reachability.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");

const io = {
  readFile: (p: string) => Deno.readTextFile(p),
  readdir: async (d: string) => {
    const out = [];
    for await (const e of Deno.readDir(d)) out.push({ name: e.name, isDirectory: e.isDirectory });
    return out;
  },
};

async function run(root = `${REPO}/extension`, retained = RETAINED) {
  return await checkReachability({
    root,
    buildSource: await Deno.readTextFile(`${REPO}/build.mjs`),
    manifest: JSON.parse(await Deno.readTextFile(`${REPO}/extension/manifest.json`)),
    retained,
    io,
  });
}

Deno.test("reachability: zero unlisted unreachable files under extension/", async () => {
  const result = await run();
  assertEquals(result.violations, [], "every shipped source file is reached or RETAINED with a reason");
  assertEquals(result.unreached, []);
  assert(result.reachedFromEntry.size > 100, "the entry-point walk covers the product");
});

Deno.test("reachability: RETAINED names only existing files, each with a non-empty reason, none already reached", async () => {
  const result = await run();
  assertEquals(result.staleRetained, []);
  assertEquals(result.retainedReachable, []);
  for (const [file, reason] of Object.entries(RETAINED)) {
    assert(typeof reason === "string" && reason.trim().length > 20, `${file}: reason must say why it stays`);
    const st = await Deno.stat(`${REPO}/extension/${file}`);
    assert(st.isFile, `${file}: RETAINED must name a shipped file`);
  }
});

// The falsification gate for the guard itself: a planted unreferenced module
// must turn the check RED, and a RETAINED line that names a missing file or a
// file already reached must be reported.
Deno.test("reachability: a planted unreferenced module fails the check", async () => {
  const planted = `${REPO}/extension/lib/zz-dead-reachability-probe.js`;
  await Deno.writeTextFile(planted, "export const dead = true;\n");
  try {
    const result = await run();
    assert(
      result.violations.some((v) => v.startsWith("lib/zz-dead-reachability-probe.js: shipped but nothing reaches it")),
      `the planted file must be reported; got ${JSON.stringify(result.violations)}`,
    );
    assertEquals(result.unreached, ["lib/zz-dead-reachability-probe.js"]);
  } finally {
    await Deno.remove(planted).catch(() => {});
  }
  const after = await run();
  assertEquals(after.violations, [], "removing the planted file turns the check green again");
});

Deno.test("reachability: a stale generated *.bundle.js artifact under extension/ is not shipped (gitignore parity)", async () => {
  // A pre-dist-era build left `options/options.bundle.js` on some machines; it is
  // gitignored (extension/**/*.bundle.js) and must not fail the gate. Real dead
  // sources are still caught (the probe above) — only generated bundle outputs
  // are excluded from the shipped walk.
  const stale = `${REPO}/extension/options/zz-stale-options.bundle.js`;
  await Deno.writeTextFile(stale, "// stale generated output, never a source\n");
  try {
    const result = await run();
    assertEquals(
      result.violations.filter((v) => v.includes("zz-stale-options.bundle.js")),
      [],
      `a generated *.bundle.js artifact must be ignored; got ${JSON.stringify(result.violations)}`,
    );
    assert(!result.shipped.includes("options/zz-stale-options.bundle.js"), "bundle artifacts are not in the shipped set");
    assertEquals(result.violations, [], "the rest of the tree stays green with the stale artifact present");
  } finally {
    await Deno.remove(stale).catch(() => {});
  }
});

Deno.test("reachability: stale RETAINED lines are reported (missing file, reached file, empty reason)", async () => {
  const result = await run(`${REPO}/extension`, {
    ...RETAINED,
    "lib/no-such-module.js": "a reason for a file that does not exist",
    "lib/pure.js": "already reached from the service worker",
    "lib/profile-store.js": "",
  });
  assert(result.staleRetained.some((v) => v.startsWith("lib/no-such-module.js: RETAINED but no such shipped file")));
  assert(result.staleRetained.some((v) => v.startsWith("lib/profile-store.js: RETAINED without a reason")));
  assert(result.retainedReachable.some((v) => v.startsWith("lib/pure.js: RETAINED but already reached")));
});

Deno.test("reachability: edges come from string tokens, never comments; dist bundles map to their source", async () => {
  const buildSource = await Deno.readTextFile(`${REPO}/build.mjs`);
  const bundles = parseBundleMap(buildSource);
  assertEquals(bundles.get("dist/background/service-worker.js"), "background/service-worker.js");
  assertEquals(bundles.get("dist/options.bundle.js"), "options/options.js");
  const shipped = new Set(["lib/a.js", "lib/b.js", "options/options.js", "page/p.html"]);
  const refs = candidateRefs(
    "lib/a.js",
    `// import "./ignored-in-comment.js"\n/* "./b.js" in a block comment */\nimport x from "./b.js";\nconst u = chrome.runtime.getURL("options/options.html");\nnew Worker(\`./b.js\`);\n`,
  );
  assertEquals(refs, ["./b.js", "options/options.html", "./b.js"]);
  assertEquals(resolveRef("lib/a.js", "./b.js", shipped, bundles), "lib/b.js");
  assertEquals(resolveRef("page/p.html", "../dist/options.bundle.js", shipped, bundles), "options/options.js");
  assertEquals(resolveRef("lib/a.js", "./ignored-in-comment.js", shipped, bundles), null);
  assertEquals(candidateRefs("page/p.html", `<script type="module" src="../lib/a.js"></script><link rel="stylesheet" href="./x.css">`), ["../lib/a.js", "./x.css"]);
});

Deno.test("reachability (kf3h / P2): exportedFunctions extracts callables, excludes comments and non-callables", () => {
  const code = `
    // export function commentedOut() {}
    /* export function inBlockComment() {} */
    export function syncFunc() {}
    export async function asyncFunc() {}
    export const arrowFunc = () => 42;
    export let exprFunc = function() {};
    export const nonFuncValue = 100;
    export const nonFuncObj = { foo: "bar" };
    function localOne() {}
    const localTwo = () => {};
    export { localOne, localTwo as renamedTwo };
  `;
  const fns = exportedFunctions(code, "test.js");
  assertEquals(fns, ["arrowFunc", "asyncFunc", "exprFunc", "localOne", "renamedTwo", "syncFunc"]);
  assert(!fns.includes("commentedOut"), "commented function must not be extracted");
  assert(!fns.includes("inBlockComment"), "block-commented function must not be extracted");
  assert(!fns.includes("nonFuncValue"), "non-callable constant must not be extracted as function (P2)");
  assert(!fns.includes("nonFuncObj"), "non-callable object must not be extracted as function (P2)");
});

Deno.test("reachability (kf3h / P1c): import classification is comment-safe", async () => {
  const fixtureFiles: Record<string, string> = {
    "lib/provider.js": `
      export function commentShadowedFunc() { return "shadowed"; }
    `,
    "lib/consumer.js": `
      // A commented-out import statement must not affect real call counting
      // import { commentShadowedFunc } from "./provider.js";
      commentShadowedFunc();
    `,
  };

  const fixtureIo = {
    readFile: async (p: string) => {
      const rel = p.replace(/^mock\//, "");
      if (fixtureFiles[rel]) return fixtureFiles[rel];
      throw new Error(`File not found: ${p}`);
    },
    readdir: async () => [],
  };

  const report = await checkExportReachability({
    root: "mock",
    reached: new Set(["lib/provider.js", "lib/consumer.js"]),
    io: fixtureIo,
    strictExports: true,
  });

  assert(
    report.reachedExports.includes("lib/provider.js:commentShadowedFunc"),
    "commented-out import must not confuse call counter (kf3h P1c)",
  );
});

Deno.test("reachability (kf3h / P1b): aliased imports and re-export barrels", async () => {
  const fixtureFiles: Record<string, string> = {
    "lib/provider.js": `
      export function calledThroughAlias() { return 1; }
      export function unusedAliased() { return 2; }
      export function calledThroughBarrel() { return 3; }
      export function unusedBarrel() { return 4; }
    `,
    "lib/barrel.js": `
      // Barrel re-exports without calling
      export { calledThroughBarrel, unusedBarrel as barrelUnused } from "./provider.js";
    `,
    "lib/consumer.js": `
      import { calledThroughAlias as myAlias, unusedAliased as deadAlias } from "./provider.js";
      import { calledThroughBarrel } from "./barrel.js";
      // myAlias is called; deadAlias is never called
      myAlias();
      // calledThroughBarrel is called through barrel
      calledThroughBarrel();
    `,
  };

  const fixtureIo = {
    readFile: async (p: string) => {
      const rel = p.replace(/^mock\//, "");
      if (fixtureFiles[rel]) return fixtureFiles[rel];
      throw new Error(`File not found: ${p}`);
    },
    readdir: async () => [],
  };

  const report = await checkExportReachability({
    root: "mock",
    reached: new Set(["lib/provider.js", "lib/barrel.js", "lib/consumer.js"]),
    io: fixtureIo,
    strictExports: true,
  });

  // calledThroughAlias was called via myAlias -> reached
  assert(
    report.reachedExports.includes("lib/provider.js:calledThroughAlias"),
    "calledThroughAlias must be marked reached via local alias call",
  );

  // unusedAliased was imported as deadAlias but never called -> unreached
  assert(
    report.unreachedExports.some((e: string) => e.startsWith("lib/provider.js:unusedAliased")),
    "unusedAliased must be caught as unreached (unused alias does not clear)",
  );

  // calledThroughBarrel was called via barrel import -> reached
  assert(
    report.reachedExports.includes("lib/provider.js:calledThroughBarrel"),
    "calledThroughBarrel must be marked reached via barrel import and call",
  );

  // unusedBarrel was re-exported in barrel but nobody calls it -> unreached
  assert(
    report.unreachedExports.some((e: string) => e.startsWith("lib/provider.js:unusedBarrel")),
    "unusedBarrel must be caught as unreached (barrel re-export alone does not clear)",
  );
});

Deno.test("reachability (kf3h / P1a): checkScriptsExportReachability walks .ts import edges", async () => {
  const fixtureFiles: Record<string, string> = {
    "package.json": JSON.stringify({
      scripts: {
        "acp:bridge": "deno run -A scripts/acp-bridge.ts",
      },
    }),
    "scripts/acp-bridge.ts": `
      import { liveSubHelper, isBrowserLaunchingMcpServer } from "./lib/acp-tools.ts";
      console.log(liveSubHelper());
    `,
    "scripts/lib/acp-tools.ts": `
      export function liveSubHelper(): string { return "live"; }
      export function isBrowserLaunchingMcpServer(): boolean { return false; }
    `,
  };

  const fixtureIo = {
    readFile: async (p: string) => {
      const rel = p.replace(/^mock\//, "");
      if (fixtureFiles[rel]) return fixtureFiles[rel];
      throw new Error(`File not found: ${p}`);
    },
    readdir: async () => [],
  };

  // Run actual checkScriptsExportReachability without injecting reached
  const report = await checkScriptsExportReachability({
    repoRoot: "mock",
    io: fixtureIo,
    strictExports: true,
  });

  // liveSubHelper reached through TS walk
  assert(
    report.reachedExports.includes("scripts/lib/acp-tools.ts:liveSubHelper"),
    "liveSubHelper reached through TS import walk must be marked reached",
  );

  // isBrowserLaunchingMcpServer imported but never called -> caught as unreached!
  assert(
    report.unreachedExports.some((e: string) => e.startsWith("scripts/lib/acp-tools.ts:isBrowserLaunchingMcpServer")),
    "isBrowserLaunchingMcpServer must be caught by scripts TS walk as unreached (kf3h P1a)",
  );
});

Deno.test("reachability (kf3h / P1b-new): cross-scan RETAINED_EXPORTS keys do not collide", async () => {
  const combinedRetainedExports = {
    "scripts/acp-tools.ts:isBrowserLaunchingMcpServer": "Roadmap adoption bead",
    "lib/provider.js:completelyDead": "Exempted extension function with reason",
  };

  const fixtureFiles: Record<string, string> = {
    "package.json": JSON.stringify({
      scripts: { "tool": "deno run -A scripts/tool.ts" },
    }),
    "scripts/tool.ts": `
      export function liveTool(): string { return "ok"; }
      liveTool();
    `,
  };

  const fixtureIo = {
    readFile: async (p: string) => {
      const rel = p.replace(/^mock\//, "");
      if (fixtureFiles[rel]) return fixtureFiles[rel];
      throw new Error(`File not found: ${p}`);
    },
    readdir: async () => [],
  };

  const scriptsReport = await checkScriptsExportReachability({
    repoRoot: "mock",
    io: fixtureIo,
    retainedExports: combinedRetainedExports,
    strictExports: false,
  });

  // The scripts scan must NOT flag "lib/provider.js:completelyDead" as stale!
  assert(
    !scriptsReport.staleRetainedExports.some((e: string) => e.includes("lib/provider.js")),
    "scripts scan must not collide with or flag extension retained exports (P1b new)",
  );
});

Deno.test("reachability (kf3h / P2a): re-exports of non-callable objects are not classified callable", async () => {
  const fixtureFiles: Record<string, string> = {
    "lib/enclave.js": `
      export const DEFAULT_SERVICES = { timeout: 5000, secure: true };
    `,
    "lib/index.js": `
      export { DEFAULT_SERVICES } from "./enclave.js";
    `,
    "lib/consumer.js": `
      import { DEFAULT_SERVICES } from "./index.js";
      console.log(DEFAULT_SERVICES.timeout);
    `,
  };

  const fixtureIo = {
    readFile: async (p: string) => {
      const rel = p.replace(/^mock\//, "");
      if (fixtureFiles[rel]) return fixtureFiles[rel];
      throw new Error(`File not found: ${p}`);
    },
    readdir: async () => [],
  };

  const report = await checkExportReachability({
    root: "mock",
    reached: new Set(["lib/enclave.js", "lib/index.js", "lib/consumer.js"]),
    io: fixtureIo,
    strictExports: true,
  });

  // DEFAULT_SERVICES is an object, not a function; must not appear in exported function reports
  assert(
    !report.reachedExports.some((e: string) => e.includes("DEFAULT_SERVICES")),
    "non-callable re-exported object must not appear in reachedExports",
  );
  assert(
    !report.unreachedExports.some((e: string) => e.includes("DEFAULT_SERVICES")),
    "non-callable re-exported object must not appear in unreachedExports (P2a)",
  );
});

Deno.test("reachability (kf3h / P2b): local-alias internal-usage clears export", async () => {
  const fixtureFiles: Record<string, string> = {
    "lib/aliased.js": `
      function localWorkhorse() { return 42; }
      export { localWorkhorse as publicWorkhorse };

      // Self-used via local name in internal composition
      const r = localWorkhorse();
    `,
  };

  const fixtureIo = {
    readFile: async (p: string) => {
      const rel = p.replace(/^mock\//, "");
      if (fixtureFiles[rel]) return fixtureFiles[rel];
      throw new Error(`File not found: ${p}`);
    },
    readdir: async () => [],
  };

  const report = await checkExportReachability({
    root: "mock",
    reached: new Set(["lib/aliased.js"]),
    io: fixtureIo,
    strictExports: true,
  });

  assert(
    report.reachedExports.includes("lib/aliased.js:publicWorkhorse"),
    "local-alias internal-usage via localWorkhorse must clear publicWorkhorse (P2b)",
  );
  assert(
    !report.unreachedExports.some((e: string) => e.includes("publicWorkhorse")),
    "publicWorkhorse must not be reported unreached when local alias is called internally",
  );
});

Deno.test("reachability (kf3h): dead exported functions are caught and genuinely-used exports are cleared", async () => {
  const fixtureFiles: Record<string, string> = {
    "lib/provider.js": `
      export function activelyUsed() { return "active"; }
      export function internallyUsed() { return "internal"; }
      export function unusedImported() { return "unused-import"; }
      export function completelyDead() { return "dead"; }
      export function retainedExempt() { return "exempt"; }

      // Internal call clears internallyUsed
      const x = internallyUsed();
    `,
    "lib/consumer.js": `
      // unusedImported is imported but never referenced in an expression/call
      import { activelyUsed, unusedImported } from "./provider.js";
      // activelyUsed is actually called
      console.log(activelyUsed());
    `,
  };

  const fixtureIo = {
    readFile: async (p: string) => {
      const rel = p.replace(/^mock\//, "");
      if (fixtureFiles[rel]) return fixtureFiles[rel];
      throw new Error(`File not found: ${p}`);
    },
    readdir: async () => [],
  };

  const retainedExports = {
    "lib/provider.js:retainedExempt": "Exempted for test reasons with non-empty justification",
    "lib/provider.js:activelyUsed": "Already actively used — should be flagged as stale/redundant",
    "lib/provider.js:nonExistent": "Does not exist — should be flagged as stale",
  };

  const report = await checkExportReachability({
    root: "mock",
    reached: new Set(["lib/provider.js", "lib/consumer.js"]),
    io: fixtureIo,
    retainedExports,
    strictExports: true,
  });

  // 1. Actively used function is marked reached
  assert(
    report.reachedExports.includes("lib/provider.js:activelyUsed"),
    "activelyUsed must be recognized as reached",
  );

  // 2. Internally composed function is marked reached
  assert(
    report.reachedExports.includes("lib/provider.js:internallyUsed"),
    "internallyUsed must be recognized as reached via internal composition",
  );

  // 3. Unused import does NOT clear the export (kf3h F5 falsification)
  assert(
    report.unreachedExports.some((e: string) => e.startsWith("lib/provider.js:unusedImported")),
    "unusedImported must be caught as unreached despite import statement in consumer",
  );

  // 4. Completely uncalled export is caught
  assert(
    report.unreachedExports.some((e: string) => e.startsWith("lib/provider.js:completelyDead")),
    "completelyDead must be caught as unreached",
  );

  // 5. Retained export is excused from unreachedExports
  assert(
    !report.unreachedExports.some((e: string) => e.includes("retainedExempt")),
    "retainedExempt must be excused by retainedExports",
  );

  // 6. Stale retained export (non-existent) is caught
  assert(
    report.staleRetainedExports.some((e: string) => e.includes("nonExistent")),
    "non-existent retained export must be caught in staleRetainedExports",
  );

  // 7. Retained export that is actually reached is caught
  assert(
    report.retainedReachableExports.some((e: string) => e.includes("activelyUsed")),
    "retained export that is already reached must be caught in retainedReachableExports",
  );

  // 8. Strict export violations include unreached and stale entries
  assert(report.exportViolations.length >= 4, "strict violations must include unreached and stale entries");
});
