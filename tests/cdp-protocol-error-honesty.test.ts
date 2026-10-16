// chrome-agent-platform-mee3 — REGRESSION PIN for adjudicated survivor D1.
//
// THE GAP THIS CLOSES
// `openCdp` is the one CDP client every harness in scripts/ shares, and its doc
// comment states the property outright: "every method is bounded and a protocol
// error REJECTS (never resolves as success)". A mutation of onmessage from
//
//     if (m.error) p.reject(new Error(`${m.error.message ?? "cdp error"}`));
//     else p.resolve({ result: m.result });
//
// to an unconditional `p.resolve({ result: m.result })` SURVIVED the full suite
// (npm test, 15-mutant focused tranche on the launch/slot layer). Nothing pinned
// it. Under that mutant every CDP caller in every harness sees a protocol error
// as a good response carrying `result: undefined` — the one failure class a green
// suite can never surface by itself, because it looks like success.
//
// WHY A FAKE CDP WEBSOCKET AND NOT A FAKE BROWSER
// The existing launch tests stand in for a *browser process* (a shell script that
// prints Chrome's DevTools banner) and for a *lock* (real flock). Neither can
// produce a CDP protocol-error frame: that only exists on the WebSocket, after
// the handshake. So this file serves the WebSocket — a real Deno.serve +
// Deno.upgradeWebSocket endpoint speaking just enough CDP to be indistinguishable
// from Chrome to `openCdp` — and answers with the exact frame the guard must
// notice. No browser is launched, no slot or lock is taken, and the port is
// ephemeral (port 0), so this is parallel-phase safe.
//
// DIVERGENCE PROVEN, NOT ASSUMED (the mee3 rule: a survivor is not a gap until a
// probe shows pristine and the mutant differ observably). Against pristine the
// assertions below pass; against the D1 mutant `send` RESOLVES `{result:
// undefined}` and `attach` RESOLVES a session id that does not exist, so both
// pins go RED. Evidence: cap-evidence/launch-sweep-r2/cdp-adjudication.json.
//
// The third test is the CONTROL. Without it these two could pass by making the
// client reject everything; it proves a well-behaved peer still resolves honestly.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  openCdp,
  CdpLoadTimeoutError,
  CdpIdleTimeoutError,
} from "../scripts/lib/chrome-launch.ts";
import { ENVIRONMENTAL_REFUSAL_MARKER } from "../scripts/lib/environmental-verdict.mjs";

type Inbound = { id?: number; method?: string; params?: unknown; sessionId?: string };
/** Returns the CDP reply body; the server adds the matching `id`. */
type Responder = (msg: Inbound) => Record<string, unknown> | null;

/** A stand-in Chrome: accepts the DevTools WebSocket and answers CDP frames. */
async function serveFakeCdp(respond: Responder) {
  const received: Inbound[] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onerror = () => { /* the client hangs up at the end of every test */ };
    socket.onmessage = (ev) => {
      let msg: Inbound;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      received.push(msg);
      const reply = respond(msg);
      if (reply && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: msg.id, ...reply }));
      }
    };
    return response;
  });
  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/fake-cdp`,
    received,
    async close() {
      await server.shutdown().catch(() => {});
    },
  };
}

/** Chrome's answer to a method it will not serve. */
const protocolError = (method: string): Responder => () => ({
  error: { code: -32601, message: `'${method}' wasn't found` },
});

Deno.test("mee3: a CDP protocol error REJECTS — it never resolves as a success with result:undefined", async () => {
  const srv = await serveFakeCdp(protocolError("Target.getTargets"));
  const cdp = await openCdp(srv.url, { timeoutMs: 4000 });
  try {
    // `send` wraps the rejection with the method name, so a caller can say which
    // call failed. Both halves matter: the wrap proves which method, the payload
    // proves the peer's own message came through rather than a generic timeout.
    await assertRejects(
      () => cdp.send("Target.getTargets"),
      Error,
      "Target.getTargets: 'Target.getTargets' wasn't found",
    );
    // The frame really crossed the socket: this is a driven protocol exchange,
    // not an assertion about a client that never connected.
    assert(
      srv.received.some((f) => f.method === "Target.getTargets"),
      "the fake CDP peer never received the Target.getTargets frame",
    );
  } finally {
    cdp.close();
    await srv.close();
  }
});

Deno.test("mee3: attach() REFUSES a protocol error — it never resolves a session id that does not exist", async () => {
  const srv = await serveFakeCdp(protocolError("Target.attachToTarget"));
  const cdp = await openCdp(srv.url, { timeoutMs: 4000 });
  try {
    // The dangerous downstream shape. attach() awaits send("Target.attachToTarget")
    // and then reads `a?.result?.sessionId`. If the protocol error resolved, that
    // would be undefined and attach would carry on through Runtime.enable and
    // Page.enable and RESOLVE — reporting a successful attach to a target it never
    // reached. Every harness that drives a page through this client would then be
    // talking to nobody and printing confident results about it.
    const err = await assertRejects(
      () => cdp.attach("TARGET-1"),
      Error,
      "Target.attachToTarget: 'Target.attachToTarget' wasn't found",
    );
    assert(err instanceof Error, "attach must reject with an Error, not resolve");
    assert(
      srv.received.some((f) => f.method === "Target.attachToTarget"),
      "the fake CDP peer never received the Target.attachToTarget frame",
    );
  } finally {
    cdp.close();
    await srv.close();
  }
});

Deno.test("mee3: control — a well-behaved CDP peer still resolves honestly (the pins above are not 'reject everything')", async () => {
  const srv = await serveFakeCdp((msg) => {
    switch (msg.method) {
      case "Target.attachToTarget":
        return { result: { sessionId: "SESSION-HONEST", targetId: "TARGET-1" } };
      case "Target.getTargets":
        return { result: { targetInfos: [{ targetId: "TARGET-1", type: "service_worker" }] } };
      case "Runtime.evaluate":
        return { result: { result: { type: "string", value: "HONEST-EVAL-VALUE" } } };
      default:
        return { result: {} };
    }
  });
  const cdp = await openCdp(srv.url, { timeoutMs: 4000 });
  try {
    const targets = await cdp.send("Target.getTargets");
    assertEquals(targets.result.targetInfos[0].targetId, "TARGET-1");
    assertEquals(await cdp.attach("TARGET-1"), "SESSION-HONEST");
    assertEquals(await cdp.eval("SESSION-HONEST", "1+1"), "HONEST-EVAL-VALUE");
  } finally {
    cdp.close();
    await srv.close();
  }
});

Deno.test("56hfm: openCdp deadline timeout under host load throws CdpLoadTimeoutError naming load environment and marker", async () => {
  // Silent server that never answers
  const srv = await serveFakeCdp(() => null);
  const mockLoadedVerdict: any = {
    cause: "loaded",
    environmental: true,
    reason: "cdp evaluate exceeded the budget and the box WAS loaded (load1/core > 0.8)",
    environment: "load1=12.50 load5=8.20 cores=14 load/core=0.89 heavy-builders=2[esbuild,cargo]",
    sample: null,
  };

  const cdp = await openCdp(srv.url, {
    timeoutMs: 40,
    measureVerdict: async () => mockLoadedVerdict,
    countLiveChrome: () => 7,
  });

  try {
    const err: any = await assertRejects(
      () => cdp.send("Target.getTargets"),
      CdpLoadTimeoutError,
    );

    assert(err instanceof CdpLoadTimeoutError, "must throw CdpLoadTimeoutError");
    assertEquals(err.verdict.cause, "loaded");
    assertEquals(err.verdict.environmental, true);
    assertEquals(err.timeoutMs, 40);
    assertEquals(err.liveChrome, 7);
    assert(err.message.includes(ENVIRONMENTAL_REFUSAL_MARKER), "must carry refusal marker");
    assert(err.message.includes("ENVIRONMENT:"), "must carry ENVIRONMENT prefix");
    assert(err.message.includes("[loaded]"), "must name load cause");
    assert(err.message.includes("live-chrome=7"), "must name live chrome count");
    assert(err.message.includes("load/core=0.89"), "must include host load");
  } finally {
    cdp.close();
    await srv.close();
  }
});

Deno.test("56hfm: FALSIFICATION (two-sided) — openCdp deadline timeout on idle box throws CdpIdleTimeoutError (PRODUCT RED)", async () => {
  // Silent server that never answers
  const srv = await serveFakeCdp(() => null);
  const mockIdleVerdict: any = {
    cause: "idle-never-settled",
    environmental: false,
    reason: "cdp evaluate exceeded the budget while the box was measurably IDLE",
    environment: "load1=0.10 load5=0.08 cores=14 load/core=0.01 heavy-builders=0",
    sample: null,
  };

  const cdp = await openCdp(srv.url, {
    timeoutMs: 40,
    measureVerdict: async () => mockIdleVerdict,
    countLiveChrome: () => 1,
  });

  try {
    const err: any = await assertRejects(
      () => cdp.send("Target.getTargets"),
      CdpIdleTimeoutError,
    );

    assert(err instanceof CdpIdleTimeoutError, "must throw CdpIdleTimeoutError");
    assertEquals(err.verdict.cause, "idle-never-settled");
    assertEquals(err.verdict.environmental, false);
    assertEquals(err.timeoutMs, 40);
    assertEquals(err.liveChrome, 1);
    assert(err.message.includes("PRODUCT RED (not environmental)"), "must carry product red marker");
    assert(!err.message.includes(ENVIRONMENTAL_REFUSAL_MARKER), "must NOT carry environmental refusal marker");
  } finally {
    cdp.close();
    await srv.close();
  }
});
