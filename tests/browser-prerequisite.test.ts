// tests/browser-prerequisite.test.ts — verification for chrome-agent-platform-jy7aj.
//
// DEFECT: When Chrome was absent from the host, the runner executed the serial phase,
// where a single browser test threw an AssertionError, causing the parallel phase to skip 645 files.
// The gate reported an ordinary '1 failed' partial run in 126s, masking 92% of the test suite as a
// code regression instead of identifying a missing environment prerequisite.
//
// CONTRACT & FALSIFICATION:
// 1. Runner pre-flight refuses immediately with a NAMED prerequisite fault (exit 75) when a
//    browser is required and absent, with 0 tests run and 0 masked skips.
// 2. Browser-independent files run without requiring a browser.
// 3. Browser-dependent files are accurately detected.
// 4. In a real subprocess run of scripts/run-tests.mjs with absent Chrome, the runner exits 75 with
//    the CAP_ENVIRONMENTAL_REFUSAL marker and named prerequisite diagnostic, NOT exit 1.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import {
  isUsableBinary,
  isBrowserDependentTest,
  resolveChromiumBinaryReport,
  checkBrowserPrerequisite,
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
  STATIC_BROWSER_EXCLUSIONS,
} from "../scripts/lib/browser-prerequisite.mjs";
import {
  ENVIRONMENTAL_REFUSAL_EXIT as QUIET_WINDOW_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER as QUIET_WINDOW_MARKER,
} from "../scripts/lib/quiet-window.ts";
import {
  ENVIRONMENTAL_REFUSAL_EXIT as VERDICT_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER as VERDICT_MARKER,
} from "../scripts/lib/environmental-verdict.mjs";
import { resolveChromiumBinaryReport as resolveFromLaunch } from "../scripts/lib/chrome-launch.ts";
import { ALWAYS_ON, selectTestFiles } from "../scripts/select-tests.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

Deno.test("9dvae: environmental-verdict constants are single-sourced and match quiet-window.ts", () => {
  assertEquals(ENVIRONMENTAL_REFUSAL_EXIT, 75);
  assertEquals(ENVIRONMENTAL_REFUSAL_MARKER, "CAP_ENVIRONMENTAL_REFUSAL");
  assertEquals(ENVIRONMENTAL_REFUSAL_EXIT, QUIET_WINDOW_EXIT, "browser-prerequisite exit code must equal quiet-window.ts");
  assertEquals(ENVIRONMENTAL_REFUSAL_MARKER, QUIET_WINDOW_MARKER, "browser-prerequisite marker must equal quiet-window.ts");
  assertEquals(ENVIRONMENTAL_REFUSAL_EXIT, VERDICT_EXIT, "environmental-verdict.mjs exit code");
  assertEquals(ENVIRONMENTAL_REFUSAL_MARKER, VERDICT_MARKER, "environmental-verdict.mjs marker");
});

Deno.test("jy7aj: isUsableBinary validates regular executable files and rejects directories/missing files", () => {
  assertEquals(isUsableBinary(null as any), false);
  assertEquals(isUsableBinary(""), false);
  assertEquals(isUsableBinary("/nonexistent/file/path"), false);

  // Injected statSync
  const fakeFile = isUsableBinary("/fake/file", {
    statSync: () => ({ isFile: () => true, mode: 0o755 } as any),
  });
  assertEquals(fakeFile, true, "executable regular file is usable");

  const fakeNonExec = isUsableBinary("/fake/file", {
    statSync: () => ({ isFile: () => true, mode: 0o644 } as any),
  });
  assertEquals(fakeNonExec, Deno.build.os === "windows", "non-executable file is rejected on POSIX");

  const fakeDir = isUsableBinary("/fake/dir", {
    statSync: () => ({ isFile: () => false, mode: 0o755 } as any),
  });
  assertEquals(fakeDir, false, "directory is rejected");
});

Deno.test("jy7aj / aa4zf: isBrowserDependentTest distinguishes browser launchers from static guards without false positives", () => {
  // Static guards that inspect source strings without launching a browser
  assertEquals(isBrowserDependentTest("tests/real-browser-teardown.test.ts"), false);
  assertEquals(isBrowserDependentTest("tests/chrome-profile-static.test.ts"), false);
  assertEquals(isBrowserDependentTest("tests/browser-prerequisite.test.ts"), false);

  // aa4zf: 5 measured false positives from reviewer finding are proven browserless
  const aa4zfFalsePositives = [
    "tests/census-resolution-wiring.test.ts",
    "tests/machine-path-honesty.test.ts",
    "tests/chrome-lock-fixture-scope.test.ts",
    "tests/chrome-test-contract.test.ts",
    "tests/harness-registry.test.ts",
  ];
  for (const file of aa4zfFalsePositives) {
    assertEquals(
      isBrowserDependentTest(file),
      false,
      `aa4zf: ${file} must NOT be flagged as browser-dependent`,
    );
  }

  // All 44 ALWAYS_ON guards must never be flagged as browser-dependent
  for (const file of ALWAYS_ON) {
    assertEquals(
      isBrowserDependentTest(file),
      false,
      `always-on guard ${file} must be host-independent and browser-free`,
    );
  }

  // Real browser tests
  assertEquals(isBrowserDependentTest("tests/chunk-resolution-browser.test.ts"), true);
  assertEquals(isBrowserDependentTest("tests/sandbox-egress-confinement.test.ts"), true);

  // Pure logic tests
  assertEquals(isBrowserDependentTest("tests/pure.test.ts"), false);
  assertEquals(isBrowserDependentTest("tests/vocabulary.test.ts"), false);
});

Deno.test("aa4zf: empty-change gate plan (44 ALWAYS_ON guards) does not refuse on a host without Chrome", () => {
  const plan = selectTestFiles([], null);
  assertEquals(plan.length, 44, "empty-change plan must select the 44 always-on guards");

  const check = checkBrowserPrerequisite(plan, {
    isFullSuite: false,
    env: { CAP_CHROMIUM: "/nonexistent/jy7aj-probe" },
    cacheRoot: "/nonexistent/cache",
    statSync: () => { throw new Error("ENOENT"); },
    readdirSync: () => { throw new Error("ENOENT"); },
  } as any);

  assertEquals(check.required, false, "empty-change subset does not require browser");
  assertEquals(check.refused, false, "empty-change subset must not refuse with exit 75 on missing browser");
  assertEquals(check.refusal, null);
});

Deno.test("9dvae: resolveChromiumBinaryReport in browser-prerequisite.mjs and chrome-launch.ts yield identical answers", () => {
  // Scenario 1: missing override
  const envMissing = { CAP_CHROMIUM: "/nonexistent/override" };
  const fromPrereqMissing = resolveChromiumBinaryReport({
    env: envMissing,
    statSync: () => { throw new Error("ENOENT"); },
  });
  const fromLaunchMissing = resolveFromLaunch({
    envGet: (k: string) => (envMissing as any)[k],
  });
  assertEquals(fromPrereqMissing.binary, fromLaunchMissing.binary, "missing override must both return null");

  // Scenario 2: usable override
  const envUsable = { CAP_CHROMIUM: "/bin/sh" };
  const fromPrereqUsable = resolveChromiumBinaryReport({
    env: envUsable,
    statSync: () => ({ isFile: () => true, mode: 0o755 } as any),
  });
  const fromLaunchUsable = resolveFromLaunch({
    envGet: (k: string) => (envUsable as any)[k],
  });
  assertEquals(fromPrereqUsable.binary, fromLaunchUsable.binary, "usable override must both return the path");

  // Scenario 3: absent browser on host (no override, empty cache)
  const fromPrereqAbsent = resolveChromiumBinaryReport({
    env: {},
    cacheRoot: "/empty-cache",
    statSync: () => { throw new Error("ENOENT"); },
    readdirSync: () => { throw new Error("ENOENT"); },
  } as any);
  const fromLaunchAbsent = resolveFromLaunch({
    envGet: () => undefined,
    cacheRoot: "/empty-cache",
    exists: () => false,
  });
  assertEquals(fromPrereqAbsent.binary, null);
  assertEquals(fromLaunchAbsent.binary, null);
});

Deno.test("jy7aj: resolveChromiumBinaryReport handles override, cache, and default with reason diagnostic", () => {
  // 1. Usable override
  const repUsable = resolveChromiumBinaryReport({
    env: { CAP_CHROMIUM: "/opt/my-chrome" },
    statSync: () => ({ isFile: () => true, mode: 0o755 } as any),
  });
  assertEquals(repUsable.binary, "/opt/my-chrome");

  // 2. Missing override
  const repMissing = resolveChromiumBinaryReport({
    env: { CAP_CHROMIUM: "/opt/missing-chrome" },
    statSync: () => { throw new Error("ENOENT"); },
  });
  assertEquals(repMissing.binary, null);
  assertStringIncludes(repMissing.tried[0], "missing");

  // 3. Completely absent host
  const repAbsent = resolveChromiumBinaryReport({
    env: {},
    cacheRoot: "/empty-cache-dir",
    readdirSync: () => { throw new Error("ENOENT"); },
    statSync: () => { throw new Error("ENOENT"); },
  } as any);
  assertEquals(repAbsent.binary, null);
  assertStringIncludes(repAbsent.tried.join("; "), "missing on this box");
});

Deno.test("jy7aj: checkBrowserPrerequisite refuses full suite when browser is absent with named diagnostic and exit 75", () => {
  const prereqAbsent = checkBrowserPrerequisite([], {
    isFullSuite: true,
    totalFiles: 703,
    env: {},
    cacheRoot: "/empty-cache-dir",
    readdirSync: () => { throw new Error("ENOENT"); },
    statSync: () => { throw new Error("ENOENT"); },
  } as any);

  assertEquals(prereqAbsent.required, true, "full suite requires browser");
  assertEquals(prereqAbsent.refused, true, "must refuse when browser is absent");
  assertEquals(prereqAbsent.refusal?.exit, ENVIRONMENTAL_REFUSAL_EXIT);
  assertEquals(prereqAbsent.refusal?.marker, ENVIRONMENTAL_REFUSAL_MARKER);
  assertEquals(prereqAbsent.refusal?.payload.reason, "missing-prerequisite");
  assertEquals(prereqAbsent.refusal?.payload.prerequisite, "chrome");
  assertEquals(prereqAbsent.refusal?.payload.filesNotRun, 703);
  assertStringIncludes(prereqAbsent.refusal?.line ?? "", "PREREQUISITE REFUSAL: missing browser prerequisite (chrome)");

  // When browser is usable, preflight passes without refusal
  const prereqPresent = checkBrowserPrerequisite([], {
    isFullSuite: true,
    env: { CAP_CHROMIUM: "/bin/sh" },
    statSync: () => ({ isFile: () => true, mode: 0o755 } as any),
  });
  assertEquals(prereqPresent.required, true);
  assertEquals(prereqPresent.refused, false);
  assertEquals(prereqPresent.refusal, null);
});

Deno.test("jy7aj: checkBrowserPrerequisite does NOT refuse browser-independent test runs", () => {
  const prereqPure = checkBrowserPrerequisite(["tests/pure.test.ts"], {
    isFullSuite: false,
    env: {},
    cacheRoot: "/empty-cache-dir",
    readdirSync: () => { throw new Error("ENOENT"); },
    statSync: () => { throw new Error("ENOENT"); },
  } as any);

  assertEquals(prereqPure.required, false, "pure tests do not require browser");
  assertEquals(prereqPure.refused, false, "must not refuse browser-independent tests");
  assertEquals(prereqPure.refusal, null);
});

Deno.test("jy7aj: subprocess run-tests.mjs preflight refuses with named prerequisite fault on missing browser", async () => {
  const nodeBin = new TextDecoder()
    .decode((await new Deno.Command("which", { args: ["node"] }).output()).stdout)
    .trim();

  // Run scripts/run-tests.mjs in a child process forcing browser absence via unusable override
  const cmd = new Deno.Command(nodeBin, {
    args: ["scripts/run-tests.mjs"],
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      CAP_CHROMIUM: "/nonexistent/jy7aj-probe-browser",
    },
    stdout: "piped",
    stderr: "piped",
  });

  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  const combined = `${stdout}\n${stderr}`;

  assertEquals(output.code, 75, `must exit with ENVIRONMENTAL_REFUSAL_EXIT (75), got rc=${output.code}\nOutput: ${combined}`);
  assertStringIncludes(combined, "PREREQUISITE REFUSAL: missing browser prerequisite (chrome)");
  assertStringIncludes(combined, "CAP_ENVIRONMENTAL_REFUSAL");
  assertStringIncludes(combined, '"prerequisite":"chrome"');
  assertStringIncludes(combined, '"reason":"missing-prerequisite"');
  assert(
    !combined.includes("skipped ("),
    "must refuse upfront without masking tests as 'skipped' behind a single failure",
  );
});
