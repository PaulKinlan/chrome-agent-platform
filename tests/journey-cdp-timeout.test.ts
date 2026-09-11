// Execute the REAL journey client, not a parallel formatter or a substring pin.
// Only its TypeScript optional-parameter marker is erased. Fake timers/socket
// keep this a pure unit check: importing the journey would launch its browsers.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isCdpEvaluateTimeout } from "../scripts/lib/quiet-window.ts";

const source = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));
const start = source.indexOf("class Cdp {");
const end = source.indexOf("\n/** Open a tab", start);
assert(start >= 0 && end > start, "the real Cdp class must be found");
const clientSource = source.slice(start, end).replace("sessionId?", "sessionId");
const TARGET = "0123456789ABCDEF0123456789ABCDEF";
const SESSION = "FEDCBA9876543210FEDCBA9876543210";

function fixture() {
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const Cdp = new Function("setTimeout", "clearTimeout", `${clientSource}\nreturn Cdp;`)(
    (callback: () => void, delay: number) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    (id: number) => timers.delete(id),
  );
  const frames: string[] = [];
  const ws: any = { send: (frame: string) => frames.push(frame) };
  return { client: new Cdp(ws), ws, frames, timers };
}

function expire(f: ReturnType<typeof fixture>, timerId: number) {
  const timer = f.timers.get(timerId)!;
  assertEquals(timer.delay, 15000, "the real send path must retain the 15s deadline");
  f.timers.delete(timerId);
  timer.callback();
}

Deno.test("journey CDP timeout identifies the exact attach request without changing its frame", async () => {
  const f = fixture();
  const params = { targetId: TARGET, flatten: true };
  const failed = assertRejects(() => f.client.send("Target.attachToTarget", params), Error);
  assertEquals(f.frames, [JSON.stringify({ id: 1, method: "Target.attachToTarget", params })]);
  // A caller changing its object after send must not rewrite the diagnostic.
  params.targetId = SESSION;
  expire(f, 1);
  const error = await failed;
  assertEquals(error.message, `cdp timeout: Target.attachToTarget (requestId=1, targetId=${TARGET}, sessionId=unavailable)`);
  assertEquals(f.client.pending.size, 0);
  assertEquals(isCdpEvaluateTimeout(error.message), false);
});

Deno.test("journey CDP timeout uses the actual request counter and session, not another request", async () => {
  const f = fixture();
  const first = f.client.send("Target.getTargets");
  f.ws.onmessage({ data: JSON.stringify({ id: 1, result: { targetInfos: [] } }) });
  assertEquals(await first, { id: 1, result: { targetInfos: [] } });
  assertEquals(f.timers.size, 0);
  const failed = assertRejects(() => f.client.send("Runtime.enable", {}, SESSION), Error);
  assertEquals(JSON.parse(f.frames[1]), { id: 2, method: "Runtime.enable", params: {}, sessionId: SESSION });
  expire(f, 2);
  const error = await failed;
  assertEquals(error.message, `cdp timeout: Runtime.enable (requestId=2, targetId=unavailable, sessionId=${SESSION})`);
  assertEquals(f.client.pending.size, 0);
  assertEquals(isCdpEvaluateTimeout(error.message), false);
});

Deno.test("journey CDP timeout never emits payloads or malformed opaque IDs; evaluate verdict is unchanged", async () => {
  for (const value of [undefined, null, 42, "", "https://private.invalid/?token=DO-NOT-LOG", "a".repeat(65536),
    { toString() { throw new Error("must not coerce IDs"); } }]) {
    const f = fixture();
    const params = { targetId: value, expression: "DO-NOT-LOG", url: "https://private.invalid/" };
    const failed = assertRejects(() => f.client.send("Runtime.evaluate", params, value), Error);
    assertEquals(f.frames[0], JSON.stringify({ id: 1, method: "Runtime.evaluate", params, sessionId: value }));
    expire(f, 1);
    const error = await failed;
    assertEquals(error.message, "cdp timeout: Runtime.evaluate (requestId=1, targetId=unavailable, sessionId=unavailable)");
    assert(error.message.length < 200, "metadata must be bounded even for oversized payloads");
    assertEquals(isCdpEvaluateTimeout(error.message), true);
    assertEquals(f.client.pending.size, 0);
  }
});

Deno.test("journey CDP replies still settle only their own pending request and preserve protocol errors", async () => {
  const f = fixture();
  const first = f.client.send("Target.getTargets");
  const second = assertRejects(() => f.client.send("Runtime.enable", {}, SESSION), Error);
  const reply = { id: 1, result: { targetInfos: [] } };
  f.ws.onmessage({ data: JSON.stringify(reply) });
  assertEquals(await first, reply);
  assertEquals([...f.client.pending.keys()], [2]);
  assertEquals([...f.timers.keys()], [2]);
  f.ws.onmessage({ data: JSON.stringify({ id: 2, error: { code: -32601, message: "unknown method" } }) });
  assertEquals((await second).message, "cdp error 2 (-32601): unknown method");
  assertEquals(f.client.pending.size, 0);
  assertEquals(f.timers.size, 0);
  assertEquals(f.frames.length, 2, "no diagnostic frame is added");
});
