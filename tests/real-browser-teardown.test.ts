// tests/real-browser-teardown.test.ts — chrome-agent-platform-jixr (successor).
//
// A real-browser TEST must reap the WHOLE Chromium process tree, not just the
// parent proc. Killing only `launched.proc` leaves the zygote/renderer/GPU
// children reparented to init (PPID=1); the fleet reaper then sees an
// "orphaned browser" and kills the whole gate tree. jixr (73a3f366) fixed the
// 12 in-file launch sites; its successor found the remaining leakers OUTSIDE
// those files: two real-browser HARNESSES that parallel-phase tests spawn
// (`scripts/kat-bgagent-delete.ts`, `scripts/kat-site-delegation-attachments.ts`)
// which tore down with a bare `proc.kill()`.
//
// This guard makes the class fail loud. It has two halves:
//   1. Every test in tests/ that launches a REAL browser (a `launchChrome`
//      call whose args do NOT name a fake binary) must call a shared tree-kill
//      teardown (`teardownChrome` / `closeChrome` / `killProcessTree`) carrying
//      a profile.
//   2. Every harness a test spawns that launches a real browser must do the
//      same in the harness file (the two named leakers are pinned here).
//
// A bare `proc.kill()` (parent-only) or a missing teardown satisfies neither
// half, so removing a teardown turns this guard RED.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

function stripStrings(src: string): string {
  // Preserve the fake-binary string literals (`"/bin/true"`, `"/bin/false"`) so
  // isFakeBinary can still see them after stripping; every other string literal
  // is fixture text and must not read as an executable launch site.
  const preserved = src
    .replace(/["']\/bin\/true["']/g, "__FAKE_BIN_TRUE__")
    .replace(/["']\/bin\/false["']/g, "__FAKE_BIN_FALSE__");
  return preserved
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/'(?:\\[\s\S]|[^\\'\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^\\"\n])*"/g, '""');
}

/** Source with comments and string literals removed: what is executable. */
function codeOnly(src: string): string {
  return stripComments(stripStrings(src));
}

/** A launchChrome call is a FAKE-browser probe iff its args name a fake binary. */
function isFakeBinary(argsBlock: string): boolean {
  return (
    /\bbinary\s*:\s*fake\b/.test(argsBlock) ||
    /\bbinary\s*:\s*__FAKE_BIN_(?:TRUE|FALSE)__/.test(argsBlock)
  );
}

/** All launchChrome({...}) call sites in a code-only source. */
function launchSites(code: string): string[] {
  const sites: string[] = [];
  for (const m of code.matchAll(/launchChrome\s*\(\s*\{/g)) {
    const from = code.indexOf("{", m.index!);
    let depth = 0;
    let end = -1;
    for (let j = from; j < code.length; j++) {
      if (code[j] === "{") depth++;
      else if (code[j] === "}") {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    sites.push(code.slice(m.index!, end + 1));
  }
  return sites;
}

/** True when a source contains a shared tree-kill teardown carrying a profile. */
function hasTreeKillTeardown(code: string): boolean {
  if (/\b(?:launched|chrome|chromeInstance)\.close\s*\(\s*\)/.test(code)) {
    return true;
  }
  const matches = [...code.matchAll(/(?:teardownChrome|closeChrome|killProcessTree)\s*\(\s*([^,()]+)\s*,\s*([^,()]+)\s*\)/g)];
  for (const m of matches) {
    const profileArg = m[2].trim();
    // A re-minting call like chromeProfileDir(...) fails closed: it mints a fresh unattached path
    if (/\bchromeProfileDir\s*\(/.test(profileArg)) continue;
    if (profileArg.length > 0) return true;
  }
  return false;
}

async function testFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}tests`)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) out.push(`tests/${entry.name}`);
  }
  return out.sort();
}

Deno.test("jixr: every real-browser test tears down its whole tree with a profile", async () => {
  const offenders: string[] = [];
  for (const rel of await testFiles()) {
    const code = codeOnly(await Deno.readTextFile(`${ROOT}${rel}`));
    const sites = launchSites(code);
    if (sites.length === 0) continue;
    if (sites.every(isFakeBinary)) continue; // fake-runner probes need no tree kill
    if (!hasTreeKillTeardown(code)) offenders.push(rel);
  }
  assertEquals(
    offenders,
    [],
    "a real-browser test launches Chrome but does not call teardownChrome/closeChrome/killProcessTree " +
      "with a profile (a bare proc.kill() orphans the tree):\n" + offenders.join("\n"),
  );
});

// The harnesses a test spawns that launch a real browser.
// Each must reap the tree via the shared helper, carrying its profile. A revert
// to `proc.kill()` here is exactly the orphan the reaper killed the gate for.
const SPAWNED_REAL_BROWSER_HARNESSES = [
  "scripts/agent-provider-picker.ts",
  "scripts/kat-bgagent-delete.ts",
  "scripts/kat-site-delegation-attachments.ts",
];

Deno.test("jixr: every test-spawned real-browser harness tears down its whole tree with a profile", async () => {
  const offenders: string[] = [];
  for (const rel of SPAWNED_REAL_BROWSER_HARNESSES) {
    const code = codeOnly(await Deno.readTextFile(`${ROOT}${rel}`));
    const sites = launchSites(code);
    assert(sites.length > 0, `${rel} must launch a real browser (the pin targets a real leak)`);
    if (!hasTreeKillTeardown(code)) offenders.push(rel);
  }
  assertEquals(
    offenders,
    [],
    "a test-spawned real-browser harness must use teardownChrome/closeChrome/killProcessTree with a profile:\n" +
      offenders.join("\n"),
  );
});

async function katHarnessFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}scripts`)) {
    if (entry.isFile && entry.name.startsWith("kat-") && entry.name.endsWith(".ts") && entry.name !== "kat-runner.ts") {
      out.push(`scripts/${entry.name}`);
    }
  }
  return out.sort();
}

Deno.test("elst: every test:kat real-browser harness tears down its whole tree with a profile", async () => {
  const offenders: string[] = [];
  const kats = await katHarnessFiles();
  assert(kats.length > 50, `must discover the test:kat harness suite (found ${kats.length})`);
  for (const rel of kats) {
    const code = codeOnly(await Deno.readTextFile(`${ROOT}${rel}`));
    const sites = launchSites(code);
    if (sites.length === 0) continue;
    if (sites.every(isFakeBinary)) continue;
    if (!hasTreeKillTeardown(code)) offenders.push(rel);
  }
  assertEquals(
    offenders,
    [],
    "a test:kat harness launches Chrome but does not call teardownChrome/closeChrome/killProcessTree " +
      "with a profile (a bare proc.kill() orphans the tree):\n" + offenders.join("\n"),
  );
});

Deno.test("elst: falsification — dropping teardownChrome or using bare proc.kill turns the guard RED", () => {
  // Mutant A: a launch with a bare proc.kill() and no profile teardown
  const mutantBareKill = `
    const { proc } = await launchChrome({ binary: "/usr/bin/chromium" });
    try { doWork(); } finally { proc.kill(); }
  `;
  const codeA = codeOnly(mutantBareKill);
  assert(launchSites(codeA).length > 0, "Mutant A must register as a real launch");
  assertEquals(hasTreeKillTeardown(codeA), false, "Mutant A with bare proc.kill() must FAIL teardown check");

  // Mutant B: a launch with no teardown at all
  const mutantNoTeardown = `
    const { proc } = await launchChrome({ binary: "/usr/bin/chromium" });
    doWork();
  `;
  const codeB = codeOnly(mutantNoTeardown);
  assert(launchSites(codeB).length > 0, "Mutant B must register as a real launch");
  assertEquals(hasTreeKillTeardown(codeB), false, "Mutant B with no teardown must FAIL teardown check");

  // Mutant C: teardownChrome called without a profile (parent-only single-arg form)
  const mutantNoProfile = `
    const { proc } = await launchChrome({ binary: "/usr/bin/chromium" });
    try { doWork(); } finally { await teardownChrome(proc); }
  `;
  const codeC = codeOnly(mutantNoProfile);
  assert(launchSites(codeC).length > 0, "Mutant C must register as a real launch");
  assertEquals(hasTreeKillTeardown(codeC), false, "Mutant C without profile must FAIL teardown check");

  // Compliant: real compliant teardown passes
  const compliant = `
    const { proc } = await launchChrome({ binary: "/usr/bin/chromium", profile });
    try { doWork(); } finally { await teardownChrome(proc, profile); }
  `;
  const codeD = codeOnly(compliant);
  assert(launchSites(codeD).length > 0, "Compliant code must register as a real launch");
  assertEquals(hasTreeKillTeardown(codeD), true, "Compliant code must PASS teardown check");
});

Deno.test("elst: REAL-TREE falsification — a real kat-*.ts harness dropping teardown fails the guard", async () => {
  const probePath = `${ROOT}scripts/kat-__probe_unreaped_test.ts`;
  try {
    await Deno.writeTextFile(
      probePath,
      `// Temporary test probe\nimport { launchChrome } from "./lib/chrome-launch.ts";\nconst { proc } = await launchChrome({ binary: "/usr/bin/chromium" });\nproc.kill();\n`,
    );
    const files = await katHarnessFiles();
    assert(files.includes("scripts/kat-__probe_unreaped_test.ts"), "katHarnessFiles must discover the probe harness");
    const code = codeOnly(await Deno.readTextFile(probePath));
    const sites = launchSites(code);
    assert(sites.length > 0, "probe must register as a real launch site");
    assertEquals(hasTreeKillTeardown(code), false, "probe with bare proc.kill must FAIL teardown check");
  } finally {
    try { await Deno.remove(probePath); } catch { /* ignore */ }
  }
});
