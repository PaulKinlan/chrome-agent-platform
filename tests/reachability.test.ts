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
  RETAINED,
  exportedFunctions,
  scanExportedFunctionReachability,
  candidateRefs,
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

// ── chrome-agent-platform-kf3h: exported-function reachability ──────────────
// A reached module's exported function can still be DEAD: zero callers in the
// shipped package (tests/ is not shipped, so a function whose only caller is
// its own test is dead by definition — the bead's exact example: a safety
// function kept alive by tests nobody in production calls).

Deno.test("kf3h: exportedFunctions finds export function / export async function in order, deduped", () => {
  const src = [
    "export function alpha() {}",
    "export async function beta() {}",
    "export const gamma = () => {}; // arrow-const is v2 scope, not counted",
    "function privateHelper() {}",
    "export function alpha() {} // duplicate declaration is reported once",
    "// export function commented() {} — a comment is not a declaration",
  ].join("\n");
  assertEquals(exportedFunctions(src), ["alpha", "beta"]);
});

Deno.test("kf3h: an export with zero callers anywhere in the package is DEAD", () => {
  const files = ["lib/a.js", "lib/b.js"];
  const sources = {
    "lib/a.js": "export function abandonedSafetyCheck() { return 1; }",
    "lib/b.js": "export function usedCheck() { return 2; }",
  };
  const r = scanExportedFunctionReachability({
    files,
    readSource: (rel) => sources[rel],
  });
  // BOTH exports are dead: neither file references the other's function.
  assertEquals(
    r.dead.map((d) => d.name).sort(),
    ["abandonedSafetyCheck", "usedCheck"],
  );
});

Deno.test("kf3h: a caller in ANOTHER file clears the finding (same-file references are a stated v1 limitation)", () => {
  const files = ["lib/self.js", "lib/other.js", "lib/unused.js"];
  const sources = {
    // self-referential recursion: v1 counts any same-file occurrence as
    // internal use, so this shape is NOT flagged — a stated v1 limitation
    // (the alternative needs flow analysis; recorded in the bead).
    // a real caller elsewhere keeps the export alive.
    "lib/other.js": "import { called } from './self-adjacent.js'; export const x = called;",
    "lib/unused.js": "export function neverReferenced() {}",
  };
  // The scan set only contains these three: a caller living in a file OUTSIDE
  // the scanned package (tests/) does not exist here by construction.
  const r = scanExportedFunctionReachability({
    files: ["lib/self.js", "lib/unused.js", "lib/other.js"],
    readSource: (rel) => sources[rel],
  });
  assertEquals(r.dead.map((d) => d.name).sort(), ["neverReferenced"]);
});

Deno.test("kf3h: exemptions keep dead exports on purpose, and rot LOUDLY", () => {
  const files = ["lib/kept.js"];
  const sources = { "lib/kept.js": "export function keptForLater() { return 1; }" };
  const withExemption = scanExportedFunctionReachability({
    files,
    readSource: (rel) => sources[rel],
    exemptions: { "lib/kept.js": { keptForLater: "11rm: wired into the streaming converter when it lands" } },
  });
  assertEquals(withExemption.dead, []);
  assertEquals(withExemption.exempt.length, 1);
  assertEquals(withExemption.exempt[0].reason, "11rm: wired into the streaming converter when it lands");
  // Rot: the export disappears (or the file does) — the entry is reported.
  const stale = scanExportedFunctionReachability({
    files: ["lib/kept.js"],
    readSource: () => "export function somethingElse() {}",
    exemptions: { "lib/kept.js": { keptForLater: "stale reason" } },
  });
  assertEquals(stale.staleExemptions, ["lib/kept.js: RETAINED_EXPORTS entry keptForLater no longer exists"]);
});
