// tests/chrome-test-contract.test.ts — pins the full-suite Chrome and test gate contract (dqc1).
//
// Invariants guarded:
//   1. docs/CHROME-TEST-CONTRACT.md exists and is referenced in AGENTS.md.
//   2. tests/chrome-profile-location.test.ts is the ONLY test in tests/ that calls
//      launchChrome() without an explicit binary: override (i.e. launches real Chrome).
//   3. All other launchChrome() call sites in tests/ explicitly pass binary: fake (or /bin/true).
//   4. No test in tests/ requests canonicalLock: true on launchChrome().
//   5. tests/chrome-profile-location.test.ts runs in the parallel phase of npm test.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { partition } from "../scripts/test-partition.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

Deno.test("contract: docs/CHROME-TEST-CONTRACT.md exists and is cited in AGENTS.md", async () => {
  const contract = await Deno.readTextFile(`${ROOT}docs/CHROME-TEST-CONTRACT.md`).catch(() => null);
  assert(contract !== null, "docs/CHROME-TEST-CONTRACT.md must exist");
  assert(contract.includes("tests/chrome-profile-location.test.ts"), "contract must cite chrome-profile-location.test.ts");
  assert(contract.includes("acquireLaunchScope"), "contract must document acquireLaunchScope");

  const agents = await Deno.readTextFile(`${ROOT}AGENTS.md`);
  assert(agents.includes("docs/CHROME-TEST-CONTRACT.md"), "AGENTS.md must reference docs/CHROME-TEST-CONTRACT.md");
});

Deno.test("contract: chrome-profile-location.test.ts is the SOLE real-browser test in tests/", async () => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}tests`)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) {
      files.push(`tests/${entry.name}`);
    }
  }

  const realBrowserTests: string[] = [];
  const fakeRunnerTests: string[] = [];

  for (const rel of files.sort()) {
    const raw = await Deno.readTextFile(`${ROOT}${rel}`);
    const code = stripComments(raw);
    for (const m of code.matchAll(/launchChrome\s*\(\s*\{([^)]*)\}\s*\)/gs)) {
      const callArgs = m[1];
      if (/\bbinary\s*:/.test(callArgs)) {
        if (!fakeRunnerTests.includes(rel)) fakeRunnerTests.push(rel);
      } else {
        if (!realBrowserTests.includes(rel)) realBrowserTests.push(rel);
      }
    }
  }

  assertEquals(
    realBrowserTests,
    ["tests/chrome-profile-location.test.ts"],
    `only chrome-profile-location.test.ts may launch real Chrome in tests/: found ${realBrowserTests.join(", ")}`,
  );
  assert(
    fakeRunnerTests.length >= 3,
    `fake-runner probes must specify binary override: found ${fakeRunnerTests.join(", ")}`,
  );
});

Deno.test("contract: no unit test in tests/ requests canonicalLock on launchChrome", async () => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}tests`)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) {
      files.push(`tests/${entry.name}`);
    }
  }

  const offenders: string[] = [];
  for (const rel of files) {
    const raw = await Deno.readTextFile(`${ROOT}${rel}`);
    const code = stripComments(raw);
    for (const m of code.matchAll(/launchChrome\s*\(\s*\{([^)]*)\}\s*\)/gs)) {
      const callArgs = m[1];
      // Canonical lock is reserved for scripts/ acceptance suites; unit tests never take it
      if (/\bcanonicalLock\s*:\s*true\b/.test(callArgs) && !/\bbinary\s*:/.test(callArgs)) {
        offenders.push(rel);
      }
    }
  }

  assertEquals(
    offenders,
    [],
    `real-browser tests in tests/ must not request canonicalLock: true: ${offenders.join(", ")}`,
  );
});

Deno.test("contract: chrome-profile-location.test.ts runs in the parallel phase of npm test", async () => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}tests`)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) {
      files.push(`tests/${entry.name}`);
    }
  }
  const { serial, parallel } = partition(files);
  assert(!serial.includes("tests/chrome-profile-location.test.ts"), "chrome-profile-location is not a serial build hazard");
  assert(parallel.includes("tests/chrome-profile-location.test.ts"), "chrome-profile-location runs in the parallel phase");
});
