// tests/cdp-eval-exception-honesty.test.ts
// Regression tests for chrome-agent-platform-0lb4:
// evalIn/evl swallow page-side exceptions: the shared CDP evaluate helper behind
// chrome-journeys (and sibling scripts) returns undefined for a throw, so a missing
// element reads as a product defect.
//
// Verifies that:
// 1. evalIn in scripts/chrome-journeys.ts and sibling helpers inspect exceptionDetails
//    and throw the page-side error description rather than swallowing it into undefined.
// 2. Behavioral verification through a mock CDP WebSocket:
//    - Runtime.evaluate returning exceptionDetails causes evalIn to reject with the page error.
//    - Clean evaluation returns the unwrapped value without throwing.
// @ts-nocheck

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { evalIn } from "../scripts/chrome-journeys.ts";

type Inbound = { id?: number; method?: string; params?: unknown; sessionId?: string };
type Responder = (msg: Inbound) => Record<string, unknown> | null;

/** Stand-in DevTools WebSocket server answering Runtime.evaluate frames. */
async function serveMockCdp(respond: Responder) {
  const received: Inbound[] = [];
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
    url: `ws://127.0.0.1:${port}/devtools/browser/mock-cdp`,
    received,
    async close() {
      await server.shutdown().catch(() => {});
    },
  };
}

Deno.test("0lb4 source pins: chrome-journeys and sibling evaluate helpers inspect exceptionDetails", async () => {
  const journeys = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));
  const picker = await Deno.readTextFile(new URL("../scripts/agent-provider-picker.ts", import.meta.url));
  const readPage = await Deno.readTextFile(new URL("../scripts/read-page-host-grant-acceptance.ts", import.meta.url));
  const toolEvidence = await Deno.readTextFile(new URL("../scripts/tool-call-evidence.ts", import.meta.url));
  const capLifecycle = await Deno.readTextFile(new URL("../scripts/capability-lifecycle.ts", import.meta.url));
  const perfLeak = await Deno.readTextFile(new URL("../scripts/perf-leak-trace.ts", import.meta.url));

  // 1. chrome-journeys.ts evalIn
  assert(
    /if\s*\(r\?\.result\?\.exceptionDetails\)\s*\{\s*const ex = r\.result\.exceptionDetails;\s*throw new Error/.test(journeys),
    "chrome-journeys.ts evalIn must inspect r.result.exceptionDetails and throw",
  );

  // 2. agent-provider-picker.ts evalIn
  assert(
    /if\s*\(r\?\.result\?\.exceptionDetails\)\s*\{\s*const ex = r\.result\.exceptionDetails;\s*throw new Error/.test(picker),
    "agent-provider-picker.ts evalIn must inspect r.result.exceptionDetails and throw",
  );

  // 3. read-page-host-grant-acceptance.ts evalIn
  assert(
    /if\s*\(r\?\.result\?\.exceptionDetails\)\s*\{\s*const ex = r\.result\.exceptionDetails;\s*throw new Error/.test(readPage),
    "read-page-host-grant-acceptance.ts evalIn must inspect r.result.exceptionDetails and throw",
  );

  // 4. tool-call-evidence.ts evalIn
  assert(
    /if\s*\(\(r as any\)\?\.result\?\.exceptionDetails\)\s*\{\s*const ex = \(r as any\)\.result\.exceptionDetails;\s*throw new Error/.test(toolEvidence),
    "tool-call-evidence.ts evalIn must inspect exceptionDetails and throw",
  );

  // 5. capability-lifecycle.ts evl
  assert(
    /if\s*\(r\?\.exceptionDetails\)\s*\{\s*throw new Error/.test(capLifecycle),
    "capability-lifecycle.ts evl must inspect exceptionDetails and throw",
  );

  // 6. perf-leak-trace.ts evl
  assert(
    /if\s*\(r\?\.exceptionDetails\)\s*\{\s*throw new Error/.test(perfLeak),
    "perf-leak-trace.ts evl must inspect exceptionDetails and throw",
  );
});

Deno.test("0lb4 behavioral: evalIn throws page exception description instead of returning undefined", async () => {
  const srv = await serveMockCdp((msg) => {
    if (msg.method === "Runtime.evaluate") {
      return {
        result: {
          result: { type: "undefined" },
          exceptionDetails: {
            text: "Uncaught",
            lineNumber: 1,
            columnNumber: 5,
            exception: {
              type: "object",
              subtype: "error",
              className: "TypeError",
              description: "TypeError: Cannot read properties of null (reading 'getBoundingClientRect')",
            },
          },
        },
      };
    }
    return { result: {} };
  });

  const ws = new WebSocket(srv.url);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const cdp = {
    send(method: string, params = {}, sessionId?: string) {
      const mid = ++id;
      return new Promise((resolve) => {
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      });
    },
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };

  try {
    await assertRejects(
      () => evalIn(cdp, "SESSION-1", "document.querySelector('#missing').getBoundingClientRect()"),
      Error,
      "page expression threw: TypeError: Cannot read properties of null (reading 'getBoundingClientRect')",
    );
  } finally {
    ws.close();
    await srv.close();
  }
});

Deno.test("0lb4 behavioral: evalIn falls back to exceptionDetails.text when exception object is absent", async () => {
  const srv = await serveMockCdp((msg) => {
    if (msg.method === "Runtime.evaluate") {
      return {
        result: {
          result: { type: "undefined" },
          exceptionDetails: {
            text: "Uncaught SyntaxError: Unexpected token",
            lineNumber: 1,
            columnNumber: 1,
          },
        },
      };
    }
    return { result: {} };
  });

  const ws = new WebSocket(srv.url);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const cdp = {
    send(method: string, params = {}, sessionId?: string) {
      const mid = ++id;
      return new Promise((resolve) => {
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      });
    },
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };

  try {
    await assertRejects(
      () => evalIn(cdp, "SESSION-1", "syntax error"),
      Error,
      "page expression threw: Uncaught SyntaxError: Unexpected token",
    );
  } finally {
    ws.close();
    await srv.close();
  }
});

Deno.test("0lb4 behavioral: clean evaluation returns unwrapped value without throwing", async () => {
  const srv = await serveMockCdp((msg) => {
    if (msg.method === "Runtime.evaluate") {
      return {
        result: {
          result: { type: "string", value: "clean-eval-result" },
        },
      };
    }
    return { result: {} };
  });

  const ws = new WebSocket(srv.url);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const cdp = {
    send(method: string, params = {}, sessionId?: string) {
      const mid = ++id;
      return new Promise((resolve) => {
        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      });
    },
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };

  try {
    const val = await evalIn(cdp, "SESSION-1", "'clean-eval-result'");
    assertEquals(val, "clean-eval-result");
  } finally {
    ws.close();
    await srv.close();
  }
});
