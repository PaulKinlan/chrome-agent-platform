// @ts-nocheck
// Dead-surface hardening KATs (owner P0 — "everything is broken"): a service
// worker killed/suspended mid-route leaves sendMessage's callback NEVER fired,
// which dead-renders every surface that awaits it. The bounded `send` (messages.js)
// and the bounded RUNTIME_SEND (components.js) must settle with an honest
// {ok:false, error} on timeout instead of hanging forever.
import { assert, assertEquals } from "jsr:@std/assert@1";

// messages.js `send` reads chrome.runtime.sendMessage at call time.
import { send } from "../extension/lib/messages.js";

function stubChrome(sendMessageImpl) {
  const saved = globalThis.chrome;
  globalThis.chrome = { runtime: { sendMessage: sendMessageImpl } };
  return () => { globalThis.chrome = saved; };
}

Deno.test("messages.send: a never-answering worker settles with an honest error (no hang)", async () => {
  // sendMessage that NEVER calls its callback — the killed-worker shape.
  const restore = stubChrome((_msg, _cb) => { /* no callback */ });
  try {
    const t0 = Date.now();
    const res = await send("activity.list", {}, 300); // short timeout for the KAT
    const elapsed = Date.now() - t0;
    assert(res && res.ok === false, `must settle with ok:false, got ${JSON.stringify(res)}`);
    assert(/didn't answer|busy|retry/i.test(res.error), `error must be the honest timeout, got: ${res.error}`);
    assert(elapsed < 2000, `must settle near the timeout, not hang (took ${elapsed}ms)`);
  } finally {
    restore();
  }
});

Deno.test("messages.send: a responsive worker resolves normally (timeout does not fire)", async () => {
  const restore = stubChrome((_msg, cb) => {
    setTimeout(() => cb({ ok: true, entries: [] }), 5);
    return undefined;
  });
  try {
    const res = await send("activity.list", {}, 1000);
    assertEquals(res.ok, true, "responsive worker must resolve the payload");
  } finally {
    restore();
  }
});

Deno.test("messages.send: lastError settles as ok:false error (unchanged contract)", async () => {
  const restore = stubChrome((_msg, cb) => {
    // Simulate chrome.runtime.lastError on the callback.
    const lastError = new Error("no such route");
    const saved = globalThis.chrome.runtime.lastError;
    globalThis.chrome.runtime.lastError = { message: lastError.message };
    cb(undefined);
    globalThis.chrome.runtime.lastError = saved;
  });
  try {
    const res = await send("nope", {}, 1000);
    assert(res && res.ok === false, "lastError must yield ok:false");
    assert(/no such route/.test(res.error), `error should carry the lastError message: ${res.error}`);
  } finally {
    restore();
  }
});

Deno.test("messages.send: a throwing sendMessage settles as ok:false (never rejects)", async () => {
  const restore = stubChrome(() => { throw new Error("boom"); });
  try {
    const res = await send("x", {}, 1000);
    assert(res && res.ok === false, "a throw must be caught into ok:false");
    assert(/boom/.test(res.error), `error should carry the throw message: ${res.error}`);
  } finally {
    restore();
  }
});
