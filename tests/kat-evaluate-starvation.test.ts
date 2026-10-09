// tests/kat-evaluate-starvation.test.ts — chrome-agent-platform-tf48c
// Tests for load-classified CDP evaluate and CPU starvation resilience:
// 1. Passing path: fast evaluate resolves under base budget with no extensions.
// 2. CPU starvation recovery: evaluate exceeding base budget under host load is granted
//    a named starvation extension and succeeds.
// 3. FALSIFICATION: legacy bare timeout drops the in-flight request at base budget and fails.
// 4. Exhausted deadline under persistent host load produces environmental refusal (exit 75, marker).
// 5. Idle box timeout produces PRODUCT RED (exit 1, no environmental marker).
// 6. Protocol errors fail fast without extension.
// 7. Client close cancels pending requests cleanly.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createClassifiedCdpClient,
  CdpEvaluateLoadTimeoutError,
  CdpEvaluateIdleTimeoutError,
  evaluateTimeoutReport,
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
} from "../scripts/lib/kat-evaluate.ts";

Deno.test("tf48c: normal evaluate resolves under base budget without starvation extension", async () => {
  const sentFrames: string[] = [];
  const logMessages: string[] = [];

  const client = createClassifiedCdpClient(
    (msg) => sentFrames.push(msg),
    {
      baseTimeoutMs: 50,
      starvationTimeoutMs: 200,
      onLog: (msg) => logMessages.push(msg),
    },
  );

  const evalPromise = client.send("Runtime.evaluate", { expression: "1 + 1" });
  assertEquals(sentFrames.length, 1);
  const frame = JSON.parse(sentFrames[0]);
  assertEquals(frame.method, "Runtime.evaluate");

  // Immediate reply
  client.onMessage({ id: frame.id, result: { result: { value: 2 } } });
  const res = await evalPromise;
  assertEquals(res.result.result.value, 2);
  assertEquals(logMessages.length, 0, "no starvation extension logged on fast evaluate");
  assertEquals(client.pendingCount(), 0);
});

Deno.test("tf48c: evaluate under CPU starvation extends budget with named reason and succeeds", async () => {
  const sentFrames: string[] = [];
  const logMessages: string[] = [];

  const mockLoadedVerdict: any = {
    cause: "loaded",
    environmental: true,
    reason: "cdp evaluate exceeded the budget and the box WAS loaded (load1/core > 0.8)",
    environment: "load1=24.50 cores=14 load/core=1.75 heavy-builders=2[esbuild,cargo]",
    sample: null,
  };

  const client = createClassifiedCdpClient(
    (msg) => sentFrames.push(msg),
    {
      baseTimeoutMs: 30,
      starvationTimeoutMs: 150,
      measureVerdict: async () => mockLoadedVerdict,
      onLog: (msg) => logMessages.push(msg),
    },
  );

  const evalPromise = client.send("Runtime.evaluate", { expression: "heavyOperation()" });
  const frame = JSON.parse(sentFrames[0]);

  // Wait 40ms: baseTimeoutMs (30ms) expires, triggering load measurement & extension
  await new Promise((r) => setTimeout(r, 45));

  // Must have logged the named starvation reason and extension
  assertEquals(logMessages.length, 1);
  assert(logMessages[0].includes("exceeded initial budget (30ms) under host load [loaded]"));
  assert(logMessages[0].includes("extending budget to 150ms for CPU starvation retry"));
  assert(logMessages[0].includes("load/core=1.75"));

  // Still pending under extended budget
  assertEquals(client.pendingCount(), 1);

  // Chrome finally finishes at 60ms (well before 150ms starvation timeout)
  client.onMessage({ id: frame.id, result: { result: { value: "done-under-load" } } });

  const res = await evalPromise;
  assertEquals(res.result.result.value, "done-under-load");
  assertEquals(logMessages.length, 2);
  assert(logMessages[1].includes("succeeded within CPU starvation extension"));
  assertEquals(client.pendingCount(), 0);
});

Deno.test("tf48c: FALSIFICATION — legacy fixed budget fails immediately on a slow evaluate under CPU starvation", async () => {
  // Simulates legacy send with fixed 30ms timeout
  let legacyTimedOut = false;
  let legacyError: any = null;

  const legacySend = (timeoutMs: number) =>
    new Promise((res, rej) => {
      const t = setTimeout(() => {
        legacyTimedOut = true;
        rej(new Error("CDP Runtime.evaluate timed out"));
      }, timeoutMs);
      // Simulates task that needs 60ms due to CPU contention
      setTimeout(() => {
        clearTimeout(t);
        res({ result: { value: "done" } });
      }, 60);
    });

  try {
    await legacySend(30);
  } catch (err: any) {
    legacyError = err;
  }

  assert(legacyTimedOut, "legacy fixed timeout must have timed out");
  assertEquals(legacyError?.message, "CDP Runtime.evaluate timed out");
});

Deno.test("tf48c: exhausted starvation deadline under host load throws CdpEvaluateLoadTimeoutError (exit 75, marker)", async () => {
  const sentFrames: string[] = [];
  const logMessages: string[] = [];

  const mockLoadedVerdict: any = {
    cause: "loaded",
    environmental: true,
    reason: "cdp evaluate exceeded the budget and the box WAS loaded (load1/core > 0.8)",
    environment: "load1=28.00 cores=14 load/core=2.00 heavy-builders=3",
    sample: null,
  };

  const client = createClassifiedCdpClient(
    (msg) => sentFrames.push(msg),
    {
      baseTimeoutMs: 25,
      starvationTimeoutMs: 60,
      measureVerdict: async () => mockLoadedVerdict,
      onLog: (msg) => logMessages.push(msg),
    },
  );

  const evalPromise = client.send("Runtime.evaluate", { expression: "stuckForever()" });

  // Await failure
  const err: any = await assertRejects(
    () => evalPromise,
    CdpEvaluateLoadTimeoutError,
  );

  assert(err instanceof CdpEvaluateLoadTimeoutError);
  assertEquals(err.baseTimeoutMs, 25);
  assertEquals(err.totalTimeoutMs, 60);
  assertEquals(err.verdict.cause, "loaded");
  assert(err.message.includes("[loaded]"));
  assert(err.message.includes("load1=28.00"));

  // Check report format matches environmental refusal protocol
  const report = evaluateTimeoutReport(err.verdict);
  assertEquals(report.exitCode, ENVIRONMENTAL_REFUSAL_EXIT);
  assert(report.line.startsWith(ENVIRONMENTAL_REFUSAL_MARKER));
  const payload = JSON.parse(report.line.slice(ENVIRONMENTAL_REFUSAL_MARKER.length));
  assertEquals(payload.cause, "loaded");
  assertEquals(client.pendingCount(), 0);
});

Deno.test("tf48c: idle box timeout throws CdpEvaluateIdleTimeoutError (exit 1, PRODUCT RED)", async () => {
  const sentFrames: string[] = [];
  const logMessages: string[] = [];

  const mockIdleVerdict: any = {
    cause: "idle-never-settled",
    environmental: false,
    reason: "cdp evaluate exceeded the budget while the box was measurably IDLE — something never settled",
    environment: "load1=0.15 cores=14 load/core=0.01 heavy-builders=0",
    sample: null,
  };

  const client = createClassifiedCdpClient(
    (msg) => sentFrames.push(msg),
    {
      baseTimeoutMs: 30,
      starvationTimeoutMs: 150,
      measureVerdict: async () => mockIdleVerdict,
      onLog: (msg) => logMessages.push(msg),
    },
  );

  const evalPromise = client.send("Runtime.evaluate", { expression: "idleHang()" });

  const err: any = await assertRejects(
    () => evalPromise,
    CdpEvaluateIdleTimeoutError,
  );

  assert(err instanceof CdpEvaluateIdleTimeoutError);
  assertEquals(err.verdict.cause, "idle-never-settled");
  assertEquals(err.verdict.environmental, false);

  // Check report format matches product red protocol
  const report = evaluateTimeoutReport(err.verdict);
  assertEquals(report.exitCode, 1, "idle box timeout MUST be exit 1 (product red)");
  assert(report.line.includes("PRODUCT RED (not environmental)"));
  assert(!report.line.includes(ENVIRONMENTAL_REFUSAL_MARKER), "product red must NOT have environmental marker");
  assertEquals(client.pendingCount(), 0);
});

Deno.test("tf48c: protocol error from Chrome rejects immediately without timeout or classification", async () => {
  const sentFrames: string[] = [];

  const client = createClassifiedCdpClient(
    (msg) => sentFrames.push(msg),
    {
      baseTimeoutMs: 100,
      starvationTimeoutMs: 300,
    },
  );

  const evalPromise = client.send("Runtime.evaluate", { expression: "bad syntax {" });
  const frame = JSON.parse(sentFrames[0]);

  client.onMessage({
    id: frame.id,
    error: { code: -32602, message: "Invalid parameters" },
  });

  const err: any = await assertRejects(() => evalPromise, Error, "Invalid parameters");
  assert(!(err instanceof CdpEvaluateLoadTimeoutError));
  assert(!(err instanceof CdpEvaluateIdleTimeoutError));
  assertEquals(client.pendingCount(), 0);
});

Deno.test("tf48c: measurement duration that exhausts starvation budget refuses immediately without scheduling extra timer", async () => {
  let simulatedTime = 1000;
  const mockLoadedVerdict: any = {
    cause: "loaded",
    environmental: true,
    reason: "cdp evaluate exceeded budget under load",
    environment: "load1=30.00 cores=14 load/core=2.14",
    sample: null,
  };

  const client = createClassifiedCdpClient(
    () => {},
    {
      baseTimeoutMs: 20,
      starvationTimeoutMs: 50,
      now: () => simulatedTime,
      measureVerdict: async () => {
        // Measurement took 40ms to complete, pushing total elapsed from 20ms to 60ms (>50ms)
        simulatedTime += 40;
        return mockLoadedVerdict;
      },
    },
  );

  const evalPromise = client.send("Runtime.evaluate", { expression: "slow()" });
  simulatedTime += 20; // baseTimeout reached

  const err: any = await assertRejects(
    () => evalPromise,
    CdpEvaluateLoadTimeoutError,
  );
  assertEquals(err.totalTimeoutMs, 50);
  assertEquals(client.pendingCount(), 0, "request cleaned up immediately when measurement exhausts budget");
});

Deno.test("tf48c: client.close during measurement aborts extension without scheduling extra timer", async () => {
  let resolveMeasurement!: (v: any) => void;
  const measurementPromise = new Promise((r) => {
    resolveMeasurement = r;
  });

  const mockLoadedVerdict: any = {
    cause: "loaded",
    environmental: true,
    reason: "cdp evaluate exceeded budget under load",
    environment: "load1=20.00 cores=14 load/core=1.42",
    sample: null,
  };

  const scheduledTimers: any[] = [];
  const client = createClassifiedCdpClient(
    () => {},
    {
      baseTimeoutMs: 10,
      starvationTimeoutMs: 100,
      measureVerdict: () => measurementPromise as Promise<any>,
      setTimeoutFn: (cb, ms) => {
        const id = setTimeout(cb, ms);
        scheduledTimers.push(id);
        return id;
      },
    },
  );

  const evalPromise = client.send("Runtime.evaluate", { expression: "test()" });
  const rejection = assertRejects(() => evalPromise, Error, "CDP connection closed");

  // Wait for baseTimeoutMs to fire and enter measurement
  await new Promise((r) => setTimeout(r, 15));

  // Now client.close() is called while measurement is still pending
  client.close();
  assertEquals(client.pendingCount(), 0);

  // Allow measurement to resolve
  const beforeTimerCount = scheduledTimers.length;
  resolveMeasurement(mockLoadedVerdict);
  await new Promise((r) => setTimeout(r, 10));

  // No new extension timer should have been scheduled after close
  assertEquals(scheduledTimers.length, beforeTimerCount, "no timer scheduled after close()");
  await rejection;
});

Deno.test("tf48c: client.close rejects all pending requests", async () => {
  const client = createClassifiedCdpClient(() => {}, { baseTimeoutMs: 500 });
  const p1 = client.send("Target.createTarget", { url: "about:blank" });
  const p2 = client.send("Runtime.evaluate", { expression: "test" });
  assertEquals(client.pendingCount(), 2);

  client.close();
  assertEquals(client.pendingCount(), 0);

  await assertRejects(() => p1, Error, "CDP connection closed");
  await assertRejects(() => p2, Error, "CDP connection closed");
});
