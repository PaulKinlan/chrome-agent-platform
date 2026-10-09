// chrome-agent-platform-0lb4 — the click helper must not read a page-side THROW
// as a click refusal, on the REAL path.
//
// The security gate's helper used to be
//
//     const b = await cdp.eval(session, expr).catch(() => null);
//     if (!b || typeof b.x !== "number") return false;
//
// and that `false` is what the gate reported as a product state (`composer:false`)
// while its instrument had thrown. `scripts/lib/click-target.ts` now returns a
// discriminated outcome for absence and lets instrument death through as an
// error; this file drives the real `openCdp` client over a real WebSocket with
// Chrome's actual response shapes (the mee3 / 4s4j pattern), never a source
// regex.
//
// WHICH GUARD EACH TEST RIDES: every page throw here arrives through
// `openCdp(...).eval()`, so it is chrome-launch.ts's own exceptionDetails
// inspection (:1004-1013) that raises it — that is the guard test (1) reddens if
// it is deleted (verified as mutant M2). scripts/lib/cdp-eval.ts contributes the
// error TYPE (`EvalSurfaceError`, `PageThrowError`) and its own helper guards are
// pinned by tests/cdp-eval.test.ts and tests/cdp-eval-page-exception-honesty.test.ts,
// not by this file.
//
// Six shapes, one control:
//   (1) a page-side throw            -> EvalSurfaceError naming the site + page text
//   (2) a resolved null              -> {clicked:false, reason:"absent-target"}
//   (3) a resolved undefined         -> the same refusal (a VALUE, distinct from (1))
//   (4) a resolved point             -> real mouse input, {clicked:true, x, y}
//   (5) the declared transient retry -> bounded, and only for a TRANSPORT failure
//   (6) a page throw whose TEXT is the retry phrase -> still surfaced, never retried
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert";
import { openCdp } from "../scripts/lib/chrome-launch.ts";
import { EvalSurfaceError } from "../scripts/lib/cdp-eval.ts";
import { clickAt } from "../scripts/lib/click-target.ts";

type Inbound = { id?: number; method?: string; params?: any; sessionId?: string };

/** A stand-in Chrome: answers Runtime.evaluate from `evaluateReply` and records
 * every frame so the mouse input can be asserted as REAL dispatched input. */
async function serveChromeFrames(evaluateReply: (msg: Inbound) => Record<string, unknown>) {
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
      const reply = msg.method === "Runtime.evaluate" ? evaluateReply(msg) : { result: {} };
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, ...reply }));
      }
    };
    return response;
  });
  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/fake`,
    received,
    async close() {
      await server.shutdown().catch(() => {});
    },
  };
}

async function withClient(
  evaluateReply: (msg: Inbound) => Record<string, unknown>,
  fn: (cdp: Awaited<ReturnType<typeof openCdp>>, fake: Awaited<ReturnType<typeof serveChromeFrames>>) => Promise<void>,
) {
  const fake = await serveChromeFrames(evaluateReply);
  const cdp = await openCdp(fake.url);
  try {
    await fn(cdp, fake);
  } finally {
    cdp.close();
    await fake.close();
  }
}

const SESSION = "sess-1";
const EXPR = `(() => { const el = document.querySelector("#composer"); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
const POINT = { x: 12.5, y: 40 };

Deno.test("0lb4(1): a page-side throw is a NAMED error, never a click refusal", async () => {
  await withClient(
    () => ({
      result: {
        result: {},
        exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: el is null" } },
      },
    }),
    async (cdp, fake) => {
      const err = await assertRejects(() => clickAt(cdp, SESSION, EXPR), EvalSurfaceError);
      assertStringIncludes(err.message, "TypeError: el is null");
      assertStringIncludes(err.message, "click-target");
      assertStringIncludes(err.message, "#composer"); // the expression travels as evidence
      // THE HISTON: the frame the old helper folded into `false` — kept as an
      // executable record of what the refactor replaced.
      const raw = await cdp.send("Runtime.evaluate", { expression: EXPR }, SESSION);
      assertEquals(raw?.result?.result?.value, undefined); // silently "no click"
      // ...and NOTHING was clicked on the strength of that throw.
      assertEquals(fake.received.filter((m) => m.method === "Input.dispatchMouseEvent").length, 0);
    },
  );
});

Deno.test("0lb4(2): a legitimately absent target is a refusal, not an error", async () => {
  await withClient(
    () => ({ result: { result: { type: "object", subtype: "null", value: null } } }),
    async (cdp, fake) => {
      assertEquals(await clickAt(cdp, SESSION, EXPR), { clicked: false, reason: "absent-target" });
      assertEquals(fake.received.filter((m) => m.method === "Input.dispatchMouseEvent").length, 0);
    },
  );
});

Deno.test("0lb4(3): a resolved undefined is the SAME refusal — a value, not a throw", async () => {
  await withClient(
    () => ({ result: { result: { type: "undefined" } } }),
    async (cdp) => {
      // This is the distinction the bead is about: (1) and (3) are the same
      // `undefined` to the old helper and different outcomes here.
      assertEquals(await clickAt(cdp, SESSION, EXPR), { clicked: false, reason: "absent-target" });
    },
  );
});

Deno.test("0lb4(4): a resolved point dispatches REAL mouse input, pressed then released", async () => {
  await withClient(
    () => ({ result: { result: { value: POINT } } }),
    async (cdp, fake) => {
      assertEquals(await clickAt(cdp, SESSION, EXPR), { clicked: true, x: POINT.x, y: POINT.y });
      const mouse = fake.received.filter((m) => m.method === "Input.dispatchMouseEvent").map((m) => m.params);
      assertEquals(mouse.length, 2);
      assertEquals(mouse[0], { type: "mousePressed", x: POINT.x, y: POINT.y, button: "left", buttons: 1, clickCount: 1 });
      assertEquals(mouse[1], { type: "mouseReleased", x: POINT.x, y: POINT.y, button: "left", buttons: 0, clickCount: 1 });
    },
  );
});

Deno.test("0lb4(5): the not-yet-attached context is the ONLY retried failure, and it is bounded", async () => {
  // (a) tolerated: the frame has not come up, then it has.
  let calls = 0;
  await withClient(
    () => {
      calls++;
      return calls === 1
        ? { error: { code: -32000, message: "Cannot find default execution context" } }
        : { result: { result: { value: POINT } } };
    },
    async (cdp, fake) => {
      assertEquals(await clickAt(cdp, SESSION, EXPR), { clicked: true, x: POINT.x, y: POINT.y });
      assertEquals(fake.received.filter((m) => m.method === "Runtime.evaluate").length, 2);
    },
  );
  // (b) bounded: a context that never appears FAILS by name rather than
  // retrying forever or answering `false`.
  calls = 0;
  await withClient(
    () => {
      calls++;
      return { error: { code: -32000, message: "Cannot find default execution context" } };
    },
    async (cdp, fake) => {
      const err = await assertRejects(() => clickAt(cdp, SESSION, EXPR), EvalSurfaceError);
      assertStringIncludes(err.message, "Cannot find default execution context");
      assertEquals(fake.received.filter((m) => m.method === "Runtime.evaluate").length, 5);
    },
  );
  // (c) an unrelated protocol error is NOT tolerated: it surfaces immediately.
  calls = 0;
  await withClient(
    () => {
      calls++;
      return { error: { code: -32000, message: "Target closed" } };
    },
    async (cdp, fake) => {
      const err = await assertRejects(() => clickAt(cdp, SESSION, EXPR), EvalSurfaceError);
      assertStringIncludes(err.message, "Target closed");
      assertEquals(fake.received.filter((m) => m.method === "Runtime.evaluate").length, 1);
    },
  );
});

Deno.test("0lb4(6): a page throw whose TEXT is the retry phrase still surfaces — it is never retried into an absence", async () => {
  // P1 of the review: the retry used to be decided on the message alone, and
  // openCdp.eval turns a page exception into an ordinary Error — so a page
  // expression throwing the literal transient phrase was retried, and a second
  // evaluation resolving null was reported as {clicked:false}. The page throw is
  // now TAGGED at the source (PageThrowError, chrome-launch.ts) and the tag is
  // checked BEFORE the text.
  const THROWN = { text: "Uncaught", exception: { description: "Error: Cannot find default execution context" } };
  let evaluations = 0;
  await withClient(
    () => {
      evaluations++;
      // Attempt 1: the page throws the retry phrasing. Attempt 2 (which must
      // never happen): a clean absence, so a text-decided retry would answer
      // {clicked:false} here instead of surfacing.
      return evaluations === 1
        ? { result: { result: {}, exceptionDetails: THROWN } }
        : { result: { result: { type: "object", subtype: "null", value: null } } };
    },
    async (cdp, fake) => {
      const err = await assertRejects(() => clickAt(cdp, SESSION, EXPR), EvalSurfaceError);
      assertStringIncludes(err.message, "Cannot find default execution context");
      assertStringIncludes(err.message, "click-target");
      // NO RETRY: one evaluation, and nothing was clicked on the strength of it.
      assertEquals(fake.received.filter((m) => m.method === "Runtime.evaluate").length, 1);
      assertEquals(fake.received.filter((m) => m.method === "Input.dispatchMouseEvent").length, 0);
    },
  );
});

Deno.test("0lb4 CONTROL: a clean evaluate still reads through as the honest value", async () => {
  await withClient(
    (msg) => ({ result: { result: { value: msg.params?.expression === "1+1" ? 2 : POINT } } }),
    async (cdp) => {
      assertEquals(await cdp.eval(SESSION, "1+1"), 2);
      assertEquals(await clickAt(cdp, SESSION, EXPR), { clicked: true, x: POINT.x, y: POINT.y });
    },
  );
});
