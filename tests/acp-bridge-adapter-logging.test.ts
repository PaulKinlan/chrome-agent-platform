// tests/acp-bridge-adapter-logging.test.ts — chrome-agent-platform-amqlo:
// Verify that ACP bridge surfaces adapter error frames, auth status updates,
// and process exits in bridge stderr so failures are legible instead of silent.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { TEST_BRIDGE_TOKEN } from "./fixtures/acp-bridge-token.ts";

const authedEndpoint = (port: number | string, harness = "codex") =>
  `ws://127.0.0.1:${port}/acp?token=${TEST_BRIDGE_TOKEN}&harness=${harness}`;

Deno.test("acp-bridge surfaces adapter JSON-RPC error frames and auth status in stderr", async () => {
  const dir = durableDir("acp-logging-probe");
  const adapterPath = `${dir}/adapter-error-mock.mjs`;

  // Mock adapter that returns initialize result, auth status not logged in, and an error on session/new
  Deno.writeTextFileSync(
    adapterPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "mock-adapter", version: "1.0.0" }
        }
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "_auth/status_update",
        params: { authStatus: { kind: "none", label: "Not logged in" } }
      }) + "\\n");
    } else if (msg.method === "session/new") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "Authentication required" }
      }) + "\\n");
      setTimeout(() => process.exit(0), 50);
    }
  } catch {}
});
`,
  );

  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map(String).join(" "));
    originalConsoleError(...args);
  };

  const server = createAcpServer(0, adapterPath, {}, undefined, TEST_BRIDGE_TOKEN);
  const port = (server as any).addr.port;

  try {
    const ws = new WebSocket(authedEndpoint(port, "codex"));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "test", version: "1" }, protocolVersion: 1 },
        }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id === 1) {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd: dir, mcpServers: [] },
          }));
        } else if (msg.id === 2 && msg.error) {
          assertEquals(msg.error.code, -32000);
          assertEquals(msg.error.message, "Authentication required");
          // Close socket immediately to test that adapter exit is still logged even after socket close
          ws.close();
        }
      };
      ws.onclose = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    // Wait a moment for adapter exit event to be handled and logged
    await new Promise((r) => setTimeout(r, 200));

    // Verify adapter auth status was logged
    const authStatusLogged = loggedErrors.some((line) =>
      line.includes('[acp-bridge] adapter auth status for harness "codex": Not logged in')
    );
    assert(authStatusLogged, `Expected auth status to be logged, got: ${JSON.stringify(loggedErrors)}`);

    // Verify adapter error frame was logged
    const errorLogged = loggedErrors.some((line) =>
      line.includes('[acp-bridge] adapter error for harness "codex" (id 2): Authentication required (code -32000)')
    );
    assert(errorLogged, `Expected adapter error to be logged, got: ${JSON.stringify(loggedErrors)}`);

    // Verify adapter exit was logged even though socket closed first
    const exitLogged = loggedErrors.some((line) =>
      line.includes('[acp-bridge] adapter for harness "codex" exited')
    );
    assert(exitLogged, `Expected adapter exit to be logged, got: ${JSON.stringify(loggedErrors)}`);
  } finally {
    console.error = originalConsoleError;
    await server.shutdown();
  }
});

Deno.test("acp-bridge redacts arbitrary error.data and handles non-string error messages without leaking secret canaries", async () => {
  const dir = durableDir("acp-logging-canary");
  const adapterPath = `${dir}/adapter-canary-mock.mjs`;

  const SECRET_CANARY_1 = "CANARY_SECRET_DATA_LEAK_TOKEN_99999";
  const SECRET_CANARY_2 = "CANARY_AUTH_DATA_BEARER_88888";

  // Mock adapter that returns initialize result, then error frames with non-string message and secret data payloads
  Deno.writeTextFileSync(
    adapterPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "mock-adapter", version: "1.0.0" }
        }
      }) + "\\n");
    } else if (msg.method === "session/new") {
      // 1. Non-string error message + secret canary in error.data
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32603,
          message: { malformed: true, nestedObj: "not a string" },
          data: { secretToken: "${SECRET_CANARY_1}", nested: { bearer: "should-never-log" } }
        }
      }) + "\\n");
    } else if (msg.method === "session/prompt") {
      // 2. Standard string message + secret canary in error.data
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32001,
          message: "Standard string error message",
          data: { credentials: "${SECRET_CANARY_2}" }
        }
      }) + "\\n");
    } else if (msg.method === "session/cancel") {
      // 3. Oversized string message with newlines to test bounds and sanitization
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32002,
          message: "Oversized error header\\r\\n forged line 2\\n" + "X".repeat(800)
        }
      }) + "\\n");
      setTimeout(() => process.exit(0), 50);
    }
  } catch {}
});
`,
  );

  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map(String).join(" "));
    originalConsoleError(...args);
  };

  const server = createAcpServer(0, adapterPath, {}, undefined, TEST_BRIDGE_TOKEN);
  const port = (server as any).addr.port;

  try {
    const ws = new WebSocket(authedEndpoint(port, "codex"));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "test", version: "1" }, protocolVersion: 1 },
        }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id === 1) {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd: dir, mcpServers: [] },
          }));
        } else if (msg.id === 2) {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "session/prompt",
            params: { prompt: "test" },
          }));
        } else if (msg.id === 3) {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 4,
            method: "session/cancel",
            params: {},
          }));
        } else if (msg.id === 4) {
          ws.close();
        }
      };
      ws.onclose = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    await new Promise((r) => setTimeout(r, 200));

    // Assert that SECRET_CANARY_1 and SECRET_CANARY_2 never appear in logged output
    const leakedCanary1 = loggedErrors.some((line) => line.includes(SECRET_CANARY_1));
    const leakedCanary2 = loggedErrors.some((line) => line.includes(SECRET_CANARY_2));
    assert(!leakedCanary1, `SECRET_CANARY_1 was leaked to bridge log: ${JSON.stringify(loggedErrors)}`);
    assert(!leakedCanary2, `SECRET_CANARY_2 was leaked to bridge log: ${JSON.stringify(loggedErrors)}`);

    // Verify non-string error logged safe message
    const nonStringLogged = loggedErrors.some((line) =>
      line.includes('[acp-bridge] adapter error for harness "codex" (id 2): (non-string error message) (code -32603)')
    );
    assert(nonStringLogged, `Expected safe non-string error message, got: ${JSON.stringify(loggedErrors)}`);

    // Verify string error with data payload logged only string message and code
    const stringLogged = loggedErrors.some((line) =>
      line.includes('[acp-bridge] adapter error for harness "codex" (id 3): Standard string error message (code -32001)')
    );
    assert(stringLogged, `Expected string message without data payload, got: ${JSON.stringify(loggedErrors)}`);

    // Verify oversized message with newlines was sanitized and truncated
    const truncatedLogged = loggedErrors.some((line) =>
      line.includes('[acp-bridge] adapter error for harness "codex" (id 4):') &&
      line.includes("… [truncated] (code -32002)") &&
      !line.includes("\n forged line 2")
    );
    assert(truncatedLogged, `Expected sanitized truncated error message, got: ${JSON.stringify(loggedErrors)}`);
  } finally {
    console.error = originalConsoleError;
    await server.shutdown();
  }
});
