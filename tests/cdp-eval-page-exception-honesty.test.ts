// chrome-agent-platform-mee3 — REGRESSION PIN for adjudicated survivor D5.
//
// THE GAP THIS CLOSES
// `openCdp(...).eval()` is `Runtime.evaluate` with awaitPromise + returnByValue,
// and it carries one guard that makes it trustworthy:
//
//     if (res?.exceptionDetails) {
//       throw new Error(res.exceptionDetails.exception?.description
//         ?? res.exceptionDetails.text ?? "evaluate threw");
//     }
//
// Deleting that guard SURVIVED the full suite (npm test, 15-mutant focused
// tranche on the launch/slot layer). Under the mutant an expression that THREW IN
// THE PAGE resolves to `undefined` exactly as though it had evaluated cleanly.
//
// WHY THIS IS THE WORST OF THE SIX SURVIVORS TO LEAVE UNPINNED
// `eval` is the layer every browser KAT depends on — including the user-WASM
// known-answer tests and the reviewer browser checks. A harness written in the
// ordinary way (`const v = await cdp.eval(...)` then assert on `v`) reads a page
// crash as an absent value and reports a confident result about a page that threw.
// That is a silent false negative: not a red suite, not an error, just a wrong
// answer that looks like evidence.
//
// WHY A FAKE CDP WEBSOCKET
// `exceptionDetails` only ever arrives on the DevTools WebSocket, inside the
// `result` of a `Runtime.evaluate` response. No fake *browser process* and no lock
// fixture can produce it, and driving a real Chrome to throw on demand would make
// the pin depend on a browser being installed. So this file serves the WebSocket:
// a real Deno.serve + Deno.upgradeWebSocket endpoint that answers `Runtime.evaluate`
// with the three shapes Chrome actually reports a page exception in. No browser is
// launched, no slot or lock is taken, and the port is ephemeral (port 0), so this
// is parallel-phase safe.
//
// DIVERGENCE PROVEN, NOT ASSUMED (the mee3 rule: a survivor is not a gap until a
// probe shows pristine and the mutant differ observably). Against pristine all
// three shapes throw; against the D5 mutant all three RESOLVE `undefined`.
// Evidence: cap-evidence/launch-sweep-r2/cdp-adjudication.json.
//
// The last test is the CONTROL: an evaluate response with NO exceptionDetails must
// still return the honest value. Without it the pins above could pass by making
// `eval` always throw, and the control is also what proves the mutant is "the guard
// is gone" rather than "eval is broken".
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { openCdp } from "../scripts/lib/chrome-launch.ts";

type Inbound = { id?: number; method?: string; params?: unknown; sessionId?: string };
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

/** Chrome reports a page exception as `exceptionDetails` INSIDE `result`, which
 *  is precisely why it reaches `eval` rather than looking like a protocol error. */
function evaluateThrew(exceptionDetails: Record<string, unknown>): Responder {
  return (msg) =>
    msg.method === "Runtime.evaluate"
      ? { result: { result: { type: "undefined" }, exceptionDetails } }
      : { result: {} };
}

/** Drive one evaluate through a real socket and return what `eval` did. */
async function evalAgainst(respond: Responder, expression: string) {
  const srv = await serveFakeCdp(respond);
  const cdp = await openCdp(srv.url, { timeoutMs: 4000 });
  try {
    const out = await cdp.eval("SESSION-HONEST", expression);
    return { srv, value: out };
  } finally {
    cdp.close();
    await srv.close();
  }
}

Deno.test("mee3: eval() surfaces a page exception's description — it never resolves undefined as a clean evaluation", async () => {
  const srv = await serveFakeCdp(
    evaluateThrew({
      text: "Uncaught",
      lineNumber: 0,
      columnNumber: 0,
      exception: {
        type: "object",
        subtype: "error",
        className: "Error",
        description: "Error: BOOM-IN-PAGE\n    at <anonymous>:1:7",
      },
    }),
  );
  const cdp = await openCdp(srv.url, { timeoutMs: 4000 });
  try {
    // The thrown message is the page's own error description, so a harness that
    // catches it can say WHAT blew up in the page rather than only that it did.
    await assertRejects(
      () => cdp.eval("SESSION-HONEST", "throw new Error('BOOM-IN-PAGE')"),
      Error,
      "Error: BOOM-IN-PAGE",
    );
    assert(
      srv.received.some((f) => f.method === "Runtime.evaluate"),
      "the fake CDP peer never received the Runtime.evaluate frame",
    );
  } finally {
    cdp.close();
    await srv.close();
  }
});

Deno.test("mee3: eval() falls back to exceptionDetails.text when Chrome sends no exception object", async () => {
  // A page-level parse error arrives with `text` and no `exception`. The guard's
  // first fallback must still refuse to call this a clean evaluation.
  const srv = await serveFakeCdp(
    evaluateThrew({ text: "Uncaught SyntaxError: BOOM-SYNTAX", lineNumber: 0, columnNumber: 0 }),
  );
  const cdp = await openCdp(srv.url, { timeoutMs: 4000 });
  try {
    await assertRejects(
      () => cdp.eval("SESSION-HONEST", "syntax("),
      Error,
      "Uncaught SyntaxError: BOOM-SYNTAX",
    );
  } finally {
    cdp.close();
    await srv.close();
  }
});

Deno.test("mee3: eval() still refuses a bare exceptionDetails carrying neither description nor text", async () => {
  // The last fallback. An exceptionDetails with no usable message at all is still
  // an exception: `eval` must throw rather than hand back undefined.
  const srv = await serveFakeCdp(evaluateThrew({}));
  const cdp = await openCdp(srv.url, { timeoutMs: 4000 });
  try {
    await assertRejects(
      () => cdp.eval("SESSION-HONEST", "(function(){ throw {} })()"),
      Error,
      "evaluate threw",
    );
  } finally {
    cdp.close();
    await srv.close();
  }
});

Deno.test("mee3: control — an evaluate with NO exceptionDetails still returns the honest value", async () => {
  // Without this the three pins above could be satisfied by an `eval` that always
  // throws. It also pins the return path itself: returnByValue means the caller
  // gets the page's value, unwrapped from the CDP envelope.
  const { value } = await evalAgainst(
    () => ({ result: { result: { type: "string", value: "CLEAN-EVAL-VALUE" } } }),
    "'x'",
  );
  assertEquals(value, "CLEAN-EVAL-VALUE");
});
