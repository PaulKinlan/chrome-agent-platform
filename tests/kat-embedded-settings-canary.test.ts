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
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  loadSample?: { measurable: boolean; loadPerCore: number; load1?: number };
}): "PASS" | "REFUSAL" | "PRODUCT_RED" {
  const stdout = opts.stdout ?? "";
  const stderr = opts.stderr ?? "";
  const combined = `${stderr}\n${stdout}`;

  if (opts.status === 0 && !opts.timedOut) {
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

  // Definite product failures: check failures, assertion errors, context deadline errors, explicit product red markers
  if (
    combined.includes("FAIL:") ||
    combined.includes("AssertionError:") ||
    combined.includes("live context was unavailable") ||
    combined.includes("frame=seen") ||
    combined.includes("PRODUCT RED (not environmental):") ||
    combined.includes("NOT_REACHED:")
  ) {
    return "PRODUCT_RED";
  }

  const isStarved = Boolean(opts.loadSample?.measurable && opts.loadSample.loadPerCore >= 4.0);

  // Chrome slot or serialized-lock acquisition timeout under proven starvation
  const isSlotExhaustion =
    combined.includes("launchChrome: could not take a Chrome slot within") ||
    combined.includes("launchChrome: could not take the serialized-Chrome lock within");

  if (isSlotExhaustion && isStarved) {
    return "REFUSAL";
  }

  // Bounded child timeout under proven starvation (and not an assertion failure)
  if ((opts.timedOut || opts.signal === "SIGKILL" || opts.status === null) && isStarved) {
    return "REFUSAL";
  }

  return "PRODUCT_RED";
}

Deno.test("kat-embedded-settings-canary: embedded Settings KAT canary runs under parallel tier", async () => {
  const refusal = browserRefusal(resolveChromiumBinaryReport(), CANARY_TEST_NAMES);
  if (refusal) return;

  const root = fileURLToPath(new URL("../", import.meta.url));

  let highestLoadSample: { measurable: boolean; loadPerCore: number; load1?: number } | undefined;
  const sampleInterval = setInterval(async () => {
    try {
      const s = await readLoadSample();
      if (s.measurable && (!highestLoadSample || (s.loadPerCore ?? 0) > (highestLoadSample.loadPerCore ?? 0))) {
        highestLoadSample = s;
      }
    } catch {}
  }, 2000);

  let res: any = null;
  let childHungError: Error | null = null;
  try {
    res = await runBoundedChild(
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
  } catch (err: any) {
    childHungError = err;
  } finally {
    clearInterval(sampleInterval);
  }

  const finalSample = await readLoadSample();
  const effectiveSample = (highestLoadSample && (highestLoadSample.loadPerCore ?? 0) > (finalSample.loadPerCore ?? 0))
    ? highestLoadSample
    : finalSample;

  const stdout = res?.stdout ?? "";
  const stderr = childHungError ? `${res?.stderr ?? ""}\n${childHungError.message}` : (res?.stderr ?? "");
  const verdict = classifyCanaryFailure({
    status: res?.status ?? null,
    signal: res?.signal ?? (childHungError ? "SIGKILL" : null),
    ms: res?.ms ?? (childHungError ? 120000 : 0),
    timedOut: Boolean(childHungError),
    stdout,
    stderr,
    loadSample: effectiveSample,
  });

  if (verdict === "PASS") {
    for (const name of SETTINGS_CHECKS) {
      assert(stdout.includes(name), `Missing report for check: ${name}`);
    }
    return;
  }

  if (verdict === "REFUSAL") {
    throw new Error(
      `CAP_ENVIRONMENTAL_REFUSAL: ENVIRONMENT: host starved under parallel contention (load/core ${effectiveSample.loadPerCore?.toFixed(2)} >= 4.0, 1m=${effectiveSample.load1}):\n${stderr}\n${stdout}`
    );
  }

  throw new Error(
    `PRODUCT RED (not environmental): embedded Settings KAT failed under parallel tier (status=${res?.status}, signal=${res?.signal}, ms=${res?.ms}):\n${stderr}\n${stdout}`
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

  // 3. Check FAIL that took 90s on loaded box -> MUST STAY PRODUCT_RED (never laundered by duration!)
  assertEquals(
    classifyCanaryFailure({
      status: 1,
      signal: null,
      ms: 90000,
      stdout: 'FAIL: approval: primary NTP Settings iframe can deny an exact request — {"iframeDeny":false}',
      stderr: "FOCUSED_KAT_ABORT: focused acceptance incomplete",
      loadSample: { measurable: true, loadPerCore: 5.0, load1: 40.0 },
    }),
    "PRODUCT_RED"
  );

  // 4. Output with bare 'slot wait' substring -> MUST STAY PRODUCT_RED
  assertEquals(
    classifyCanaryFailure({
      status: 1,
      signal: null,
      ms: 4000,
      stdout: '{"detail":"chrome slot wait budget 30000ms"}',
      stderr: "check failed",
      loadSample: { measurable: true, loadPerCore: 5.0, load1: 40.0 },
    }),
    "PRODUCT_RED"
  );

  // 5. Genuine Chrome slot exhaustion under starvation -> REFUSAL
  assertEquals(
    classifyCanaryFailure({
      status: 1,
      signal: null,
      ms: 30500,
      stdout: "",
      stderr: "FOCUSED_KAT_ABORT: Error: launchChrome: could not take a Chrome slot within 30000 ms (all 2 CAP_CHROME_MAX_CONCURRENT slots are held by other browsers).",
      loadSample: { measurable: true, loadPerCore: 5.0, load1: 40.0 },
    }),
    "REFUSAL"
  );

  // 6. Genuine serialized-lock exhaustion under starvation -> REFUSAL
  assertEquals(
    classifyCanaryFailure({
      status: 1,
      signal: null,
      ms: 30500,
      stdout: "",
      stderr: "FOCUSED_KAT_ABORT: Error: launchChrome: could not take the serialized-Chrome lock within 30000 ms (cap-chrome-test.lock held by other browsers).",
      loadSample: { measurable: true, loadPerCore: 4.5, load1: 30.0 },
    }),
    "REFUSAL"
  );

  // 7. Chrome slot exhaustion on idle box -> PRODUCT_RED
  assertEquals(
    classifyCanaryFailure({
      status: 1,
      signal: null,
      ms: 30500,
      stdout: "",
      stderr: "FOCUSED_KAT_ABORT: Error: launchChrome: could not take a Chrome slot within 30000 ms (all 2 CAP_CHROME_MAX_CONCURRENT slots are held by other browsers).",
      loadSample: { measurable: true, loadPerCore: 0.8, load1: 1.2 },
    }),
    "PRODUCT_RED"
  );

  // 8. utfug tracker deadline error under high load -> MUST STAY PRODUCT_RED (utfug honesty!)
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

  // 9. Timeout under severe load -> REFUSAL
  assertEquals(
    classifyCanaryFailure({
      status: null,
      signal: "SIGKILL",
      ms: 120000,
      timedOut: true,
      stdout: "",
      stderr: "child process timed out",
      loadSample: { measurable: true, loadPerCore: 6.2, load1: 85.0 },
    }),
    "REFUSAL"
  );
});

Deno.test("kat-embedded-settings-canary: synthetic hang terminates promptly under bounded child", async () => {
  const t0 = Date.now();
  let caught: Error | null = null;
  try {
    await runBoundedChild(
      Deno.execPath(),
      ["eval", "setInterval(() => {}, 1000)"],
      {
        timeoutMs: 1500,
        label: "synthetic canary hang",
      }
    );
  } catch (err: any) {
    caught = err;
  }
  const elapsed = Date.now() - t0;
  assert(caught !== null, "Hanging child must trigger HUNG error from runBoundedChild");
  assert(caught.message.includes("HUNG: no exit within"), `Expected HUNG error message, got: ${caught.message}`);
  assert(elapsed >= 1400, `Expected child to run at least to timeoutMs (1500ms), got ${elapsed}ms`);
  assert(elapsed < 8000, `Expected bounded termination in < 8s, got ${elapsed}ms`);
});
