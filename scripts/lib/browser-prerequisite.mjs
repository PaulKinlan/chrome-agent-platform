// scripts/lib/browser-prerequisite.mjs — runner-level prerequisite validation (chrome-agent-platform-jy7aj).
//
// DEFECT THIS FIXES: When Chrome was absent from the host, the runner executed the serial phase,
// where a single browser test threw an AssertionError, causing the parallel phase to skip 645 files.
// The gate reported an ordinary '1 failed' partial run in 126s, masking 92% of the test suite as a
// code regression instead of identifying a missing environment prerequisite.
//
// CONTRACT: Before running any tests that depend on a browser (including the full gate suite), the
// runner resolves the browser. If no browser is usable on the host, the runner REFUSES immediately with
// a named prerequisite fault (CAP_ENVIRONMENTAL_REFUSAL with reason 'missing-prerequisite') and
// exits with ENVIRONMENTAL_REFUSAL_EXIT (75), with ZERO files executed or masked as skipped.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
} from "./environmental-verdict.mjs";

export { ENVIRONMENTAL_REFUSAL_EXIT, ENVIRONMENTAL_REFUSAL_MARKER };

/**
 * Checks if a given path is an executable file.
 */
export function isUsableBinary(filePath, { statSync = fs.statSync } = {}) {
  if (!filePath || typeof filePath !== "string") return false;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    return process.platform === "win32" || ((st.mode ?? 0) & 0o111) !== 0;
  } catch {
    return false;
  }
}

function versionOf(dirName) {
  const m = /^(?:linux|mac_arm|mac)-(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(dirName)
    ?? /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(dirName);
  return m ? m.slice(1).map(Number) : null;
}

const BINARY_SUBPATHS = [
  "chrome-linux64/chrome",
  "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
];

function byVersionDesc(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function byCandidateDesc(a, b) {
  return byVersionDesc(a.version, b.version) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
}

export function defaultCacheRoot(home = process.env.HOME) {
  return home && home.startsWith("/") ? path.join(home, ".cache/puppeteer/chrome") : "";
}

/**
 * Resolves the newest executable Chrome for Testing from the puppeteer cache.
 */
export function resolveChromeForTesting({
  cacheRoot,
  readdirSync = fs.readdirSync,
  statSync = fs.statSync,
} = {}) {
  const root = cacheRoot !== undefined ? cacheRoot : defaultCacheRoot();
  if (!root) return null;

  let names;
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return null;
  }

  const ranked = names
    .map((name) => ({ name, version: versionOf(name) }))
    .filter((c) => c.version !== null)
    .sort(byCandidateDesc);

  for (const c of ranked) {
    for (const subpath of BINARY_SUBPATHS) {
      const binary = path.join(root, c.name, subpath);
      if (isUsableBinary(binary, { statSync })) {
        return binary;
      }
    }
  }
  return null;
}

/**
 * Resolves Chromium binary report following the canonical repo precedence:
 * CAP_CHROMIUM env -> Chrome for Testing cache -> default /usr/bin/chromium.
 */
export function resolveChromiumBinaryReport({
  env = process.env,
  cacheRoot,
  statSync = fs.statSync,
  readdirSync = fs.readdirSync,
} = {}) {
  const tried = [];
  const rawOverride = env.CAP_CHROMIUM;
  if (typeof rawOverride === "string" && rawOverride.trim()) {
    const override = rawOverride.trim();
    const bareName = !override.includes("/") && !override.includes("\\");
    if (bareName) {
      const found = (env.PATH ?? "").split(path.delimiter).filter(Boolean)
        .map((dir) => path.join(dir, override))
        .find((cand) => isUsableBinary(cand, { statSync }));
      if (found) {
        tried.push(`CAP_CHROMIUM=${override} (resolved on $PATH: ${found})`);
        return { binary: found, tried };
      }
      tried.push(`CAP_CHROMIUM=${override} (not found on $PATH)`);
      return { binary: null, tried };
    }
    if (isUsableBinary(override, { statSync })) {
      tried.push(`CAP_CHROMIUM=${override}`);
      return { binary: override, tried };
    }
    let reason = " (missing)";
    try {
      const st = statSync(override);
      if (st.isDirectory()) reason = " (a directory)";
      else if (!st.isFile()) reason = " (not a regular file)";
      else reason = " (not executable)";
    } catch {}
    tried.push(`CAP_CHROMIUM=${override}${reason}`);
    return { binary: null, tried };
  }

  const cached = resolveChromeForTesting({ cacheRoot, readdirSync, statSync });
  if (cached) {
    tried.push(`chrome-for-testing cache: ${cached}`);
    return { binary: cached, tried };
  }

  const defaultChromium = process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/chromium";

  const defaultUsable = isUsableBinary(defaultChromium, { statSync });
  tried.push(`default ${defaultChromium}${defaultUsable ? "" : " (missing on this box)"}`);
  if (defaultUsable) return { binary: defaultChromium, tried };

  return { binary: null, tried };
}

// Known static/source-inspecting guards and mock-browser suites that never launch a real browser
// (docs/CHROME-TEST-CONTRACT.md §2.3: always-on core guards are host-independent and browser-free).
export const STATIC_BROWSER_EXCLUSIONS = new Set([
  // Always-on core and source-inspecting guards (scripts/select-tests.mjs ALWAYS_ON)
  "tests/security.test.ts",
  "tests/secret-redaction.test.ts",
  "tests/security-suite-custody.test.ts",
  "tests/owner-approval-security.test.ts",
  "tests/vocabulary.test.ts",
  "tests/enrollment-authority-reader-census.test.ts",
  "tests/sw-dispatch-authority-census.test.ts",
  "tests/sw-route-modularization.test.ts",
  "tests/census-resolution-wiring.test.ts",
  "tests/security-doc-drift.test.ts",
  "tests/file-url-root-guard.test.ts",
  "tests/docs-process-truth.test.ts",
  "tests/wasm-catalogue-status-truth.test.ts",
  "tests/wasm-manifest-rebuild-ref.test.ts",
  "tests/main-module-check-guard.test.ts",
  "tests/test-partition-guard.test.ts",
  "tests/package-scripts-exist.test.ts",
  "tests/changelog.test.ts",
  "tests/changelog-shipping.test.ts",
  "tests/acp-fixture-env-guard.test.ts",
  "tests/manifest-permissions.test.ts",
  "tests/harness-registry.test.ts",
  "tests/source-materialization.test.ts",
  "tests/evidence-durable-static.test.ts",
  "tests/no-uppercase-kickers-static.test.ts",
  "tests/source-inspecting-tests-guard.test.ts",
  "tests/postmessage-wildcard-guard.test.ts",
  "tests/durable-root.test.ts",
  "tests/dialog-confirm-modernization.test.ts",
  "tests/single-source-helpers.test.ts",
  "tests/chrome-profile-static.test.ts",
  "tests/chrome-test-contract.test.ts",
  "tests/code-health.test.ts",
  "tests/machine-path-honesty.test.ts",
  "tests/settings-strings-audit.test.ts",
  "tests/quiet-window-static.test.ts",
  "tests/chrome-tools-t12-static.test.ts",
  "tests/unbundled-page-census.test.ts",
  "tests/composer-selector-migration.test.ts",
  "tests/chrome-lock-fixture-scope.test.ts",
  "tests/substring-pin-honesty.test.ts",
  "tests/requires-owner-gesture-column-allowlist.test.ts",
  "tests/kat-service-worker-match.test.ts",
  "tests/real-browser-teardown.test.ts",
  // Self and other static/environmental tests that inspect launcher machinery without launching Chrome
  "tests/browser-prerequisite.test.ts",
  "tests/environmental-verdict.test.ts",
  "tests/chromium-resolution.test.ts",
  "tests/chrome-profile-location-environment.test.ts",
  "tests/chrome-slot-semaphore-honesty.test.ts",
  "tests/chrome-tmpdir-cleanup.test.ts",
  "tests/chrome-launch-lock-scope.test.ts",
  "tests/chrome-launch-lock.test.ts",
  "tests/chrome-slot-semaphore.test.ts",
  "tests/launch-chrome-failure-path.test.ts",
  "tests/process-tree-cleanup.test.ts",
  "tests/heavy-gate-slot.test.ts",
  "tests/harness-debug-port.test.ts",
  "tests/extension-dist-guard.test.ts",
  "tests/select-tests-always-on.test.ts",
  "tests/cdp-eval-page-exception-honesty.test.ts",
  "tests/cdp-protocol-error-honesty.test.ts",
  "tests/click-target-honesty.test.ts",
  "tests/security-suite-inworld-honesty.test.ts",
  "tests/kat-finalizer.test.ts",
  "tests/jjsz-lifeline-leader-exit.test.ts",
  "tests/jjsz-lifeline-process-table.test.ts",
  "tests/jjsz-lifeline-match.test.ts",
  "tests/jjsz-lifeline-runner-exit.test.ts",
  "tests/lifeline-reap-rule.test.ts", // 6efbv: AST census only; never spawns Chrome
]);

/**
 * Checks whether a given test file actually executes a real browser.
 */
export function isBrowserDependentTest(filePath, { readFileSync = fs.readFileSync } = {}) {
  const norm = filePath.replace(/^[./]+/, "");
  if (STATIC_BROWSER_EXCLUSIONS.has(norm)) return false;
  try {
    const src = readFileSync(filePath, "utf8");
    return (
      src.includes("launchChrome") ||
      src.includes("kat-bgagent-delete") ||
      src.includes("kat-site-delegation-attachments") ||
      src.includes("chrome-journeys")
    );
  } catch {
    return false;
  }
}

/**
 * Checks browser prerequisite for a given set of test files (or the full gate suite).
 */
export function checkBrowserPrerequisite(files, options = {}) {
  const isFull = !files || files.length === 0 || options.isFullSuite === true;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const browserFiles = isFull ? [] : files.filter((f) => isBrowserDependentTest(f, { readFileSync }));
  const required = isFull || browserFiles.length > 0;
  const report = resolveChromiumBinaryReport(options);

  if (!required || report.binary) {
    return { required, report, refused: false, refusal: null };
  }

  const filesTotal = isFull ? (options.totalFiles ?? 703) : files.length;
  const filesNotRun = isFull ? filesTotal : browserFiles.length;
  const line =
    `PREREQUISITE REFUSAL: missing browser prerequisite (chrome) — no resolvable browser on this box.\n` +
    `Tried: ${report.tried.join(", ") || "<nothing to try>"}.\n` +
    `Refusing ${filesNotRun} of ${filesTotal} file(s) without execution — this is an environment prerequisite failure, NOT a test regression.`;

  const payload = {
    reason: "missing-prerequisite",
    prerequisite: "chrome",
    tried: report.tried,
    filesTotal,
    filesNotRun,
    browserFiles: isFull ? ["<full-suite>"] : browserFiles,
  };

  return {
    required: true,
    report,
    refused: true,
    refusal: {
      line,
      marker: ENVIRONMENTAL_REFUSAL_MARKER,
      payload,
      exit: ENVIRONMENTAL_REFUSAL_EXIT,
    },
  };
}
