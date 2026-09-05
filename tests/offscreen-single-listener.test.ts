// tests/offscreen-single-listener.test.ts — chrome-agent-platform-czwz
// The offscreen host registered the SAME script-run listener twice. The
// announce phase masked it (Chrome honors the first sendResponse), but an
// addressed cap:script-run matched BOTH listeners and runScriptInIframe fired
// TWICE — every scheduled script's side effects double-executed. This test
// loads the REAL offscreen.js with a recording chrome stub and asserts a
// single script-run handling per message.
// @ts-nocheck — browser stubs are intentionally dynamic (house style).
import { assertEquals } from "jsr:@std/assert@1";

Deno.test("offscreen host: exactly ONE listener handles a script-run message (czwz)", async () => {
  const listeners: Array<(...args: unknown[]) => unknown> = [];
  (globalThis as any).chrome = {
    runtime: {
      onMessage: {
        addListener: (fn: (...args: unknown[]) => unknown) => listeners.push(fn),
        removeListener: (fn: (...args: unknown[]) => unknown) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
      getURL: (rel: string) => `chrome-extension://test/${rel}`,
    },
  };
  // The announce path never touches the DOM; the listener closure references
  // `document` unconditionally, so a stub must exist.
  (globalThis as any).document ??= {};

  await import("../extension/offscreen/offscreen.js");

  // Other hosts (agent-worker, python, wasm-stream, table) register their own
  // listeners on this stub — those must not answer a script-run announce.
  // Count the listeners that CLAIM it (handleScriptRunMessage's response).
  const claims: unknown[] = [];
  for (const listener of listeners) {
    listener(
      { type: "cap:script-run-announce", runId: "run-12345678" },
      {}, // sender
      (response: unknown) => claims.push(response),
    );
  }
  assertEquals(claims.length, 1, "exactly one listener claims the script-run announce");
  assertEquals(
    (claims[0] as { host?: string })?.host,
    "offscreen",
    "the claim comes from the offscreen host",
  );
});
