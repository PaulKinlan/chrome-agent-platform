// chrome-agent-platform-4s4j (under kwrx) — the security-suite isolated-world
// probe must tell instrument death from a product answer, on the REAL path.
//
// Per the cap-astra requirement this test drives the actual openCdp client
// over a real WebSocket with Chrome's actual response shapes (pattern from
// cdp-eval-page-exception-honesty.test.ts / mee3) — no source regex. The
// guard lives in scripts/lib/cdp-eval.ts; delete its exceptionDetails
// inspection and case (2) here goes red.
//
// WHAT the probe must distinguish (security-suite sender-authority):
//   (1) a RESOLVED refusal — {ok:false, error:"not authorized…"} — is a
//       PRODUCT answer and must pass through untouched;
//   (2) a PAGE-SIDE throw used to read `undefined` (the 4s4j class: composer
//       :false) and must now be a named EvalDiagnostic;
//   (3) a PROTOCOL error (dead context) rejects send() and must surface as a
//       named diagnostic through the probe's catch, never swallow;
//   (4) positive control: a clean evaluate returns the value — the probe is
//       not just "always fail".
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { openCdp } from "../scripts/lib/chrome-launch.ts";
import { isEvalDiagnostic, wireValue } from "../scripts/lib/cdp-eval.ts";

type Inbound = { id?: number; method?: string; params?: unknown; sessionId?: string };

/** The migrated inWorld core from scripts/security-suite.ts, verbatim in
 * its three moving parts: session send -> wireValue tolerant + catch. If
 * security-suite's copy drifts from this one, case (2) tells on it there. */
async function probe(send: (m: string, p?: unknown, s?: string) => Promise<any>, sessionId: string, isolatedCtxId: number, expr: string) {
  try {
    const r = await send("Runtime.evaluate", { expression: expr, contextId: isolatedCtxId, returnByValue: true, awaitPromise: true }, sessionId);
    return wireValue(r, "sender-authority.world-probe", {
      tolerant: true,
      why: "probe distinguishes a resolved refusal ({thrown}) from an instrument-dead read; consumers branch on isEvalDiagnostic",
    });
  } catch (e) {
    return { __cdpEvalError: `send-failed ${String((e as Error)?.message ?? e)}`, site: "sender-authority.world-probe" };
  }
}

async function serveChromeFrames(evaluateReply: (msg: Inbound) => Record<string, unknown>) {
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onerror = () => {};
    socket.onmessage = (ev) => {
      let msg: Inbound;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      let reply: Record<string, unknown>;
      if (msg.method === "Runtime.evaluate") reply = evaluateReply(msg);
      else if (msg.method === "Target.attachToTarget") reply = { result: { sessionId: "sess-1" } };
      else if (msg.method === "Target.createTarget") reply = { result: { targetId: "tgt-1" } };
      else reply = { result: {} };
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, ...reply }));
      }
    };
    return response;
  });
  const port = (server.addr as Deno.NetAddr).port;
  return { url: `ws://127.0.0.1:${port}/devtools/browser/fake`, close: () => server.shutdown().catch(() => {}) };
}

async function withClient(reply: (msg: Inbound) => Record<string, unknown>, fn: (send: any, sid: string) => Promise<void>) {
  const fake = await serveChromeFrames(reply);
  const cdp = await openCdp(fake.url);
  try {
    const { sessionId } = await cdp.open("chrome-extension://fake/ntp/ntp.html");
    await fn((m: string, p?: unknown, s?: string) => cdp.send(m, p, s), sessionId);
  } finally {
    cdp.close();
    await fake.close();
  }
}

Deno.test("4s4j(1): a resolved page refusal passes through as the product answer it is", async () => {
  await withClient(
    () => ({ result: { result: { value: { ok: false, error: "sender not authorized from a page context" } } } }),
    async (send, sid) => {
      const v = await probe(send, sid, 7, "x");
      assertEquals(v, { ok: false, error: "sender not authorized from a page context" });
    },
  );
});

Deno.test("4s4j(2): a page-side throw is a NAMED diagnostic, never undefined", async () => {
  await withClient(
    () => ({
      result: {
        result: {},
        exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: isolated world is gone" } },
      },
    }),
    async (send, sid) => {
      const v = await probe(send, sid, 7, "x");
      assert(isEvalDiagnostic(v), `must be a named diagnostic, got ${JSON.stringify(v)}`);
      assertStringIncludes(v.__cdpEvalError, "isolated world is gone");
      assertEquals(v.site, "sender-authority.world-probe");
      // THE HISTON: the pre-4s4j read of this exact frame — kept as an
      // executable record of what the guard replaced.
      const r = await send("Runtime.evaluate", { expression: "x" }, sid);
      assertEquals(r?.result?.result?.value, undefined); // silently "no composer"
    },
  );
});

Deno.test("4s4j(3): a protocol error (dead context) surfaces named, not swallowed", async () => {
  await withClient(
    () => ({ error: { code: -32000, message: "No such isolated world" } }),
    async (send, sid) => {
      const v = await probe(send, sid, 7, "x");
      assert(isEvalDiagnostic(v), "protocol death must be a named diagnostic");
      assertStringIncludes(v.__cdpEvalError, "send-failed");
      assertStringIncludes(v.__cdpEvalError, "No such isolated world");
    },
  );
});

Deno.test("4s4j(4) CONTROL: a clean evaluate still yields the honest value", async () => {
  await withClient(
    () => ({ result: { result: { value: 1 + 1 } } }),
    async (send, sid) => {
      assertEquals(await probe(send, sid, 7, "1+1"), 2);
    },
  );
  // And strict mode over the SAME throwing frame THROWS (falsification
  // anchor: remove the cdp-eval guard and this fails too):
  await withClient(
    () => ({ result: { result: {}, exceptionDetails: { text: "Uncaught", exception: { description: "boom" } } } }),
    async (send, sid) => {
      let threw = false;
      try {
        const r = await send("Runtime.evaluate", { expression: "x" }, sid);
        wireValue(r, "strict-anchor");
      } catch {
        threw = true;
      }
      assert(threw, "strict wireValue must throw on a page exception — the guard is load-bearing");
    },
  );
});
