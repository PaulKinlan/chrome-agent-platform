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
  return stripStrings(stripComments(src));
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
  return /(?:teardownChrome|closeChrome|killProcessTree)\s*\([^)]*,/.test(code);
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

// The two harnesses a parallel-phase test SPAWNS and that launch a real browser.
// Each must reap the tree via the shared helper, carrying its profile. A revert
// to `proc.kill()` here is exactly the orphan the reaper killed the gate for.
const SPAWNED_REAL_BROWSER_HARNESSES = [
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
