// tests/kat-embedded-settings-canary.test.ts — chrome-agent-platform-4cvua.
//
// Exercise ONE representative embedded-Settings KAT (kat-gi0jw-activity-approval --settings-only)
// under the parallel unit tier as a contention canary. Witnesses real NTP-embedded Settings iframe
// context acquisition and deny flow without serialising the suite.
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { resolveChromiumBinaryReport } from "../scripts/lib/chrome-launch.ts";
import { browserRefusal, refuseWithoutBrowser } from "../scripts/lib/browser-refusal.ts";
import { runBoundedChild } from "../scripts/lib/bounded-child.mjs";
import { readLoadSample } from "../scripts/lib/quiet-window.ts";
import { SETTINGS_CHECKS } from "../scripts/kat-gi0jw-activity-approval.ts";

const CANARY_TEST_NAMES = ["kat-embedded-settings-canary: embedded Settings KAT canary runs under parallel tier"];

export function classifyCanaryFailure(opts: {
  status: number | null;
  signal: string | null;
  ms: number;
  stdout?: string;
  stderr?: string;
  loadSample?: { measurable: boolean; loadPerCore: number; load1?: number };
}): "PASS" | "REFUSAL" | "PRODUCT_RED" {
  const stdout = opts.stdout ?? "";
  const stderr = opts.stderr ?? "";
  if (opts.status === 0) {
    if (stdout.includes("FOCUSED_KAT_RESULT=")) {
      try {
        const match = stdout.match(/FOCUSED_KAT_RESULT=(\{[^\n]+\})/);
        if (match) {
          const res = JSON.parse(match[1]);
          if (res.passed === 6 && res.failed === 0 && !res.failure && !res.teardownError) {
            return "PASS";
          }
        }
      } catch {}
    }
  }

  // utfug honesty: tracker context deadline error is ALWAYS product red, never environmental refusal
  const combined = `${stderr}\n${stdout}`;
  if (
    combined.includes("live context was unavailable") ||
    combined.includes("frame=seen") ||
    combined.includes("AssertionError:") ||
    combined.includes("PRODUCT RED (not environmental):")
  ) {
    return "PRODUCT_RED";
  }

  // Starvation-based refusal: only when bounded child timed out or slot wait failed AND contemporaneous sample proves severe load
  if (
    opts.loadSample?.measurable &&
    opts.loadSample.loadPerCore >= 4.0 &&
    (opts.status === null || opts.signal === "SIGKILL" || opts.ms >= 85000 || combined.includes("slot wait"))
  ) {
    return "REFUSAL";
  }

  return "PRODUCT_RED";
}

Deno.test("kat-embedded-settings-canary: embedded Settings KAT canary runs under parallel tier", async () => {
  const refusal = browserRefusal(resolveChromiumBinaryReport(), CANARY_TEST_NAMES);
  if (refusal) return;

  const root = fileURLToPath(new URL("../", import.meta.url));
  const res = await runBoundedChild(
    Deno.execPath(),
    ["run", "-A", "--no-check", "scripts/kat-gi0jw-activity-approval.ts", "--settings-only"],
    {
      cwd: root,
      stdio: "pipe",
      env: {
        ...Deno.env.toObject(),
        CAP_CHROME_LOCK_WAIT_MS: "30000",
      },
      timeoutMs: 120000,
      label: "kat-embedded-settings-canary",
    }
  );

  const sample = await readLoadSample();
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const verdict = classifyCanaryFailure({
    status: res.status,
    signal: res.signal,
    ms: res.ms,
    stdout,
    stderr,
    loadSample: sample,
  });

  if (verdict === "PASS") {
    for (const name of SETTINGS_CHECKS) {
      assert(stdout.includes(name), `Missing report for check: ${name}`);
    }
    return;
  }

  if (verdict === "REFUSAL") {
    throw new Error(
      `CAP_ENVIRONMENTAL_REFUSAL: ENVIRONMENT: host starved under parallel contention (load/core ${sample.loadPerCore?.toFixed(2)} >= 4.0, 1m=${sample.load1}):\n${stderr}\n${stdout}`
    );
  }

  throw new Error(
    `PRODUCT RED (not environmental): embedded Settings KAT failed under parallel tier (status=${res.status}, signal=${res.signal}, ms=${res.ms}):\n${stderr}\n${stdout}`
  );
});

Deno.test("kat-embedded-settings-canary: refuseWithoutBrowser emits exit 75 when browser missing", () => {
  refuseWithoutBrowser(resolveChromiumBinaryReport(), CANARY_TEST_NAMES);
});

Deno.test("kat-embedded-settings-canary: classifyCanaryFailure honours utfug honesty and load threshold", () => {
  // 1. Success case
  const passOut = 'FOCUSED_KAT_RESULT={"sourceCommit":"abc","passed":6,"failed":0,"notReached":0,"failure":false,"teardownError":false}';
  assertEquals(classifyCanaryFailure({ status: 0, signal: null, ms: 12000, stdout: passOut, stderr: "" }), "PASS");

  // 2. Failure with low load -> PRODUCT_RED
  assertEquals(
    classifyCanaryFailure({
      status: 1,
      signal: null,
      ms: 15000,
      stdout: "",
      stderr: "approval deny failed",
      loadSample: { measurable: true, loadPerCore: 0.5, load1: 1.0 },
    }),
    "PRODUCT_RED"
  );

  // 3. utfug tracker deadline error under high load -> MUST STAY PRODUCT_RED (utfug honesty!)
  assertEquals(
    classifyCanaryFailure({
      status: 1,
      signal: null,
      ms: 18000,
      stdout: "",
      stderr: "live context was unavailable for /options/options.html (frame=seen)",
      loadSample: { measurable: true, loadPerCore: 8.5, load1: 120.0 },
    }),
    "PRODUCT_RED"
  );

  // 4. Timeout under severe load -> REFUSAL
  assertEquals(
    classifyCanaryFailure({
      status: null,
      signal: "SIGKILL",
      ms: 120000,
      stdout: "",
      stderr: "child process timed out",
      loadSample: { measurable: true, loadPerCore: 6.2, load1: 85.0 },
    }),
    "REFUSAL"
  );
});

Deno.test("kat-embedded-settings-canary: synthetic hang terminates promptly under bounded child", async () => {
  const t0 = Date.now();
  const res = await runBoundedChild(
    Deno.execPath(),
    ["eval", "await new Promise(() => {})"],
    {
      timeoutMs: 1500,
      label: "synthetic canary hang",
    }
  );
  const elapsed = Date.now() - t0;
  assert(elapsed < 8000, `Expected bounded termination in < 8s, got ${elapsed}ms`);
  assert(res.status !== 0 || res.signal !== null, "Hanging child must terminate with non-zero exit or signal");
});
