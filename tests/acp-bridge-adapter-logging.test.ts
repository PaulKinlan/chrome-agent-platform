// tests/acp-bridge-adapter-logging.test.ts — chrome-agent-platform-amqlo:
// Verify that ACP bridge surfaces adapter error frames, auth status updates,
// and process exits in bridge stderr so failures are legible instead of silent.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { createAcpServer, sanitizeLogString, StderrSanitizer } from "../scripts/acp-bridge.ts";
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

Deno.test("acp-bridge strips ANSI sequences, OSC commands, and C0 control characters from untrusted error.message", async () => {
  const dir = durableDir("acp-logging-ansi-canary");
  const adapterPath = `${dir}/adapter-ansi-canary-mock.mjs`;

  const evilMessage = `Prefix \u001b[31mANSI_COLOR_CANARY\u001b[0m \u001b]0;FORGED_TERMINAL_TITLE\u0007\u001b]52;c;c2VjcmV0\u001b\\ middle\x01\x02\x07\x08\r\n forged line`;

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
      process.stderr.write("Stderr canary: " + ${JSON.stringify(evilMessage)} + "\\n");
      process.stderr.write("ANTHROPIC_API_KEY takes precedence over login: " + ${JSON.stringify(evilMessage)} + "\\n");
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: "\u001b[35mID_CANARY\u001b[0m",
        error: {
          code: "\u001b[36mCODE_CANARY\u001b[0m",
          message: ${JSON.stringify(evilMessage)}
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
          ws.close();
        }
      };
      ws.onclose = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    await new Promise((r) => setTimeout(r, 200));

    // Assert that NO raw ESC bytes (\u001b) or control characters (\x01, \x02, \x07, \x08, etc.) reach the logged output
    const adapterErrorLine = loggedErrors.find((line) =>
      line.startsWith('[acp-bridge] adapter error for harness "codex"')
    );
    assert(adapterErrorLine, `Expected adapter error log line, got: ${JSON.stringify(loggedErrors)}`);

    const adapterStderrLines = loggedErrors.filter((line) =>
      line.startsWith("[adapter-stderr]")
    );
    assert(adapterStderrLines.length > 0, `Expected adapter stderr log lines, got: ${JSON.stringify(loggedErrors)}`);

    for (const line of [adapterErrorLine, ...adapterStderrLines]) {
      assert(!line.includes("\u001b"), `Found raw ESC in log line: ${line}`);
      assert(!line.includes("\x07"), `Found raw BEL in log line: ${line}`);
      assert(!line.includes("\x01"), `Found raw SOH in log line: ${line}`);
      assert(!line.includes("\x08"), `Found raw BS in log line: ${line}`);
      assert(!line.includes("FORGED_TERMINAL_TITLE"), `Found OSC title payload in log line: ${line}`);
      assert(!line.includes("c2VjcmV0"), `Found OSC 52 clipboard payload in log line: ${line}`);
      assert(!line.includes("\n"), `Found raw newline in log line: ${line}`);
      assert(!line.includes("\r"), `Found raw carriage return in log line: ${line}`);
    }

    // Verify legitimate text remains visible and legible
    assert(adapterErrorLine.includes("ANSI_COLOR_CANARY"), `Expected sanitized text to retain legible content: ${adapterErrorLine}`);
    assert(adapterErrorLine.includes("middle forged line"), `Expected space-collapsed text in error: ${adapterErrorLine}`);
    assert(adapterErrorLine.includes("(id ID_CANARY):"), `Expected sanitized string frame id: ${adapterErrorLine}`);
    assert(adapterErrorLine.includes("(code CODE_CANARY)"), `Expected sanitized string error code: ${adapterErrorLine}`);
    assert(adapterStderrLines.some((l) => l.includes("ANSI_COLOR_CANARY")), `Expected stderr to retain legible text`);
    assert(adapterStderrLines.some((l) => l.includes("forged line")), `Expected stderr to retain legible text`);

    // Verify actionableAuthWarning path was triggered and sanitized
    const authWarningLine = loggedErrors.find((line) =>
      line.includes("the harness reported an auth precedence problem:")
    );
    assert(authWarningLine, `Expected actionableAuthWarning to be triggered: ${JSON.stringify(loggedErrors)}`);
    assert(!authWarningLine.includes("\u001b"), `Found raw ESC in auth warning: ${authWarningLine}`);
    assert(!authWarningLine.includes("\x07"), `Found raw BEL in auth warning: ${authWarningLine}`);
    assert(!authWarningLine.includes("FORGED_TERMINAL_TITLE"), `Found OSC title in auth warning: ${authWarningLine}`);
    assert(authWarningLine.includes("ANSI_COLOR_CANARY"), `Expected auth warning to retain legible text: ${authWarningLine}`);
  } finally {
    console.error = originalConsoleError;
    await server.shutdown();
  }
});

Deno.test("sanitizeLogString strips ANSI CSI/OSC sequences, collapses C0/C1 control characters, and trims cleanly", () => {
  // 1. Basic empty / invalid inputs
  assertEquals(sanitizeLogString(""), "");
  assertEquals(sanitizeLogString(null as unknown as string), "");
  assertEquals(sanitizeLogString(undefined as unknown as string), "");

  // 2. ANSI color & cursor CSI sequences
  assertEquals(
    sanitizeLogString("\u001b[31;1mRed Bold\u001b[0m normal \u001b[2K\u001b[1;1Hcursor"),
    "Red Bold normal cursor",
  );

  // 3. OSC sequences (title, clipboard OSC 52, 7-bit and 8-bit C1)
  assertEquals(
    sanitizeLogString("Before \u001b]0;Title\u0007 After"),
    "Before After",
  );
  assertEquals(
    sanitizeLogString("Before \u001b]52;c;c2VjcmV0\u001b\\ After"),
    "Before After",
  );
  assertEquals(
    sanitizeLogString("Before \u009d52;c;c2VjcmV0\u009c After"),
    "Before After",
  );
  assertEquals(
    sanitizeLogString("Before \u009d0;Title\u0007 After"),
    "Before After",
  );

  // 4. C0 control characters (BEL, BS, NUL, tabs, CR, LF)
  assertEquals(
    sanitizeLogString("Hello\x00\x01\x07\x08World\r\n\tNew   Line"),
    "Hello World New Line",
  );

  // 5. C1 control characters and DEL
  assertEquals(
    sanitizeLogString("Text\x7fwith\x80\x9fDEL and C1"),
    "Text with DEL and C1",
  );

  // 6. Mixed compound attack payload
  const attackPayload = "\u001b]0;hacked\u0007\u001b[2J\u001b[H\u001b[31mError:\u001b[0m\r\n\x00Forged admin message\u001b]52;c;YmFk\u001b\\";
  assertEquals(
    sanitizeLogString(attackPayload),
    "Error: Forged admin message",
  );

  // 7. Embedded CSI escape sequences inside OSC payload
  assertEquals(
    sanitizeLogString("Prefix \u001b]52;c;FIRST\u001b[31mSECRET\u001b\\ Suffix"),
    "Prefix Suffix",
  );
  assertEquals(
    sanitizeLogString("Prefix \u001b]52;c;FIRST\u001b[31mSECRET\u0007 Suffix"),
    "Prefix Suffix",
  );

  // 8. OSC sequence starting inside an unfinished CSI sequence
  assertEquals(
    sanitizeLogString("Prefix \u001b[31\u001b]52;c;SECRET\u0007 Suffix"),
    "Prefix Suffix",
  );

  // 9. CSI sequence with private parameter character (e.g., > in DA2 query)
  assertEquals(
    sanitizeLogString("Before \u001b[>0c After"),
    "Before After",
  );
});

Deno.test("StderrSanitizer discards split OSC, split ST, and C1 sequences while suppressing unterminated OSC across newlines and bounding memory", () => {
  const sanitizer = new StderrSanitizer();
  const logged: string[] = [];
  const onLine = (l: string) => logged.push(l);

  // 1. Split OSC across chunk reads
  sanitizer.processChunk("Prefix \x1b]52;c;", onLine);
  sanitizer.processChunk("c2VjcmV0\x07 Suffix\n", onLine);

  // 2. Multiline OSC sequence spanning a newline and split ST across chunks
  sanitizer.processChunk("Start \x1b]52;c;LINE1_SECRET\nLINE2_SECRET\x1b", onLine);
  sanitizer.processChunk("\\ End\n", onLine);

  // 2b. Multiline OSC sequence spanning two newlines terminated by ST (Finding P1)
  sanitizer.processChunk("Start2 \x1b]52;c;L1_SECRET\nL2_SECRET\nL3_SECRET\x1b\\ End2\n", onLine);

  // 3. Unterminated OSC unclosed before newline suppresses ambiguous text fail-closed (chrome-agent-platform-l5rup)
  sanitizer.processChunk("Before \x1b]0;MALFORMED_TITLE_SECRET", onLine);
  sanitizer.processChunk("\nERROR: real adapter failure, exit 17\n", onLine);
  sanitizer.flush(onLine);

  // 4. C1 8-bit OSC sequence
  sanitizer.processChunk("C1Start \u009d52;c;C1_SECRET\u009c C1End\n", onLine);

  // 4. CSI color and cursor sequences
  sanitizer.processChunk("Color \x1b[31;1mRedText\x1b[0m Done\n", onLine);

  // 5. Embedded CSI escape sequences inside OSC payload
  sanitizer.processChunk("Embedded \x1b]52;c;FIRST\x1b[31mEMBEDDED_SECRET\x1b\\ Suffix\n", onLine);

  // 6. OSC sequence starting inside an unfinished CSI sequence (single and split across chunks)
  sanitizer.processChunk("Prefix \x1b[31\x1b]52;c;CSI_INTERRUPT_SECRET\x07 Suffix\n", onLine);
  sanitizer.processChunk("SplitCSI \x1b[31\x1b", onLine);
  sanitizer.processChunk("]52;c;SPLIT_CSI_SECRET\x07 Done\n", onLine);

  // 8. CSI sequence with private parameter character (e.g. > in DA2)
  sanitizer.processChunk("BeforeCSI \x1b[>0c AfterCSI\n", onLine);

  // 9. Oversized line bounding (> 4096 chars without newline flushes bounded chunk)
  const hugeChunk = "HugeHeader " + "A".repeat(5000) + "\n";
  sanitizer.processChunk(hugeChunk, onLine);

  // 10. Repeated non-ST escape pairs inside candidate continuation bounded at 4096 chars (Finding P2)
  sanitizer.processChunk("PrefixEsc \x1b]0;x\n" + "\x1bX".repeat(3000) + "\x1b\\ SuffixEsc\n", onLine);

  // 11. Multiline OSC payload spanning beyond continuation line limit terminated by ST (Finding P1)
  sanitizer.processChunk("StartBeyond \x1b]52;c;first\nSECOND_SECRET\nthird\nfourth\n\x1b\\ EndBeyond\n", onLine);

  sanitizer.flush(onLine);

  // Assertions:
  assertEquals(logged[0], "Prefix Suffix");
  assertEquals(logged[1], "Start End");
  assertEquals(logged[2], "Start2 End2");
  assertEquals(logged[3], "Before");
  assertEquals(logged[4], "C1Start C1End");
  assertEquals(logged[5], "Color RedText Done");
  assertEquals(logged[6], "Embedded Suffix");
  assertEquals(logged[7], "Prefix Suffix");
  assertEquals(logged[8], "SplitCSI Done");
  assertEquals(logged[9], "BeforeCSI AfterCSI");
  assertEquals(logged[11], "PrefixEsc SuffixEsc");
  assertEquals(logged[12], "StartBeyond EndBeyond");

  // Ensure secrets were never added to lines
  assert(!logged.some((l) => l.includes("c2VjcmV0")));
  assert(!logged.some((l) => l.includes("LINE1_SECRET")));
  assert(!logged.some((l) => l.includes("LINE2_SECRET")));
  assert(!logged.some((l) => l.includes("L1_SECRET")));
  assert(!logged.some((l) => l.includes("L2_SECRET")));
  assert(!logged.some((l) => l.includes("L3_SECRET")));
  assert(!logged.some((l) => l.includes("MALFORMED_TITLE_SECRET")));
  assert(!logged.some((l) => l.includes("C1_SECRET")));
  assert(!logged.some((l) => l.includes("EMBEDDED_SECRET")));
  assert(!logged.some((l) => l.includes("CSI_INTERRUPT_SECRET")));
  assert(!logged.some((l) => l.includes("SPLIT_CSI_SECRET")));
  assert(!logged.some((l) => l.includes("SECOND_SECRET")));

  // Verify huge line was bounded and split into chunks
  assert(logged.some((l) => l.startsWith("HugeHeader A")));
  assert(logged.some((l) => l.includes("SuffixEsc")));
});

Deno.test("StderrSanitizer defers candidate diagnostic release until untermination established and retains discard state beyond limits", () => {
  // 1. Limit abort retains payload-discard state until ST/BEL (Finding P1)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("Start \x1b]52;c;x\na\nb\nc\nTAIL_SECRET\x1b\\ Suffix\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["Start Suffix"]);
    assert(!out.some((l) => l.includes("TAIL_SECRET")));
  }

  // 1b. Byte bound (>4096 bytes) retains payload-discard state until ST/BEL (Finding P2)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("Start \x1b]52;c;x\n" + "A".repeat(5000) + "\nTAIL_4096\x1b\\ Suffix\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["Start Suffix"]);
    assert(!out.some((l) => l.includes("TAIL_4096")));
  }

  // 1c. Candidate bound (>8 candidates) retains payload-discard state until ST/BEL (Finding P2)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("Start \x1b]52;c;x\n" + Array.from({ length: 12 }, (_, i) => "ERROR: candidate " + i).join("\n") + "\nTAIL_8CAND\x1b\\ Suffix\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["Start Suffix"]);
    assert(!out.some((l) => l.includes("TAIL_8CAND")));
  }

  // 1d. Byte bound overrun (>4096 bytes) latches discard-only state through EOF without terminator or trailing newline (Finding P1)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("Start \x1b]52;c;x\n" + "A".repeat(5000) + "\nERROR: SECRET_AFTER_BYTE_LIMIT", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["Start"]);
    assert(!out.some((l) => l.includes("SECRET_AFTER_BYTE_LIMIT")));
  }

  // 1e. Candidate bound overrun (>8 candidates) latches discard-only state through EOF without terminator (Finding P1)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("Start \x1b]52;c;x\n" + Array.from({ length: 12 }, (_, i) => "ERROR: secret candidate " + i).join("\n") + "\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["Start"]);
    assert(!out.some((l) => l.includes("secret candidate")));
  }

  // 1f. Cumulative byte bound across newlines without trailing newline latches discard-only state (Finding P1)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("Start \x1b]0;x\n" + "A".repeat(3000) + "\nERROR: " + "B".repeat(1500), (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["Start"]);
  }

  // 1g. Exactly nine candidates with ninth candidate unterminated at EOF latches discard-only state (Finding P1)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("Start \x1b]52;c;x\n" + Array.from({ length: 8 }, (_, i) => "ERROR: candidate " + i).join("\n") + "\nERROR: candidate 9", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["Start"]);
    assert(!out.some((l) => l.includes("candidate")));
  }

  // 2. Diagnostic-looking payload inside terminated OSC is discarded when ST arrives (Finding P1)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("Start \x1b]52;c;x\nERROR: SECRET_DIAGNOSTIC\n\x1b\\ Suffix\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["Start Suffix"]);
    assert(!out.some((l) => l.includes("SECRET_DIAGNOSTIC")));
  }

  // 2b. Discard unverified continuation (including diagnostic-looking payload) at C1 OSC boundary (Finding P1)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("\x1b]52;c;secret\nTAIL_SECRET\u009d0;title\x07 Suffix\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["Suffix"]);
    assert(!out.some((l) => l.includes("TAIL_SECRET")));
  }
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("\x1b]52;c;secret\nERROR: SECRET_VALUE\u009d0;title\x07 Suffix\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["Suffix"]);
    assert(!out.some((l) => l.includes("SECRET_VALUE")));
  }

  // 2c. Interrupted unclosed OSC with diagnostic discarded across new 7-bit OSC (Finding P1)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("\x1b]0;broken\nFATAL: crash\n\x1b]0;title\x07 Suffix\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["Suffix"]);
    assert(!out.some((l) => l.includes("broken")));
    assert(!out.some((l) => l.includes("title")));
    assert(!out.some((l) => l.includes("FATAL: crash")));
  }

  // 3. Pre-OSC text is flushed at EOF even if unclosed OSC follows (Finding P2)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("FATAL: crash \x1b]0;x\ncontinuation", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["FATAL: crash"]);
  }

  // 4. Terminated OSC sequence with real diagnostic afterwards emits the diagnostic
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("\u001b]0;my-title\x07", (l) => out.push(l));
    s.processChunk("ERROR: real adapter failure, exit 17\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, ["ERROR: real adapter failure, exit 17"]);
    assert(!out.some((l) => l.includes("my-title")));
  }

  // 5. Unterminated title OSC 0/1/2 continuation refuses replay even if matching allowlist (Finding vpo4n)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("\u001b]0;broken-title", (l) => out.push(l));
    s.processChunk("\nAPI_KEY=sk-ant-SECRET-CANARY", (l) => out.push(l));
    s.processChunk("\nERROR: spoofed diagnostic from untrusted payload\n", (l) => out.push(l));
    s.processChunk("SUFFIX\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, []);
    assertEquals(s.droppedLinesCount, 4);
    assert(!out.some((l) => l.includes("SECRET-CANARY")));
    assert(!out.some((l) => l.includes("spoofed diagnostic")));
  }

  // 6. Unterminated OSC 52 clipboard continuation refuses replay even if matching allowlist (Finding vpo4n)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("\u001b]52;c;clipboard-copy", (l) => out.push(l));
    s.processChunk("\nAPI_KEY=sk-ant-SECRET-CANARY", (l) => out.push(l));
    s.processChunk("\nERROR: spoofed diagnostic from untrusted payload\n", (l) => out.push(l));
    s.processChunk("SUFFIX\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, []);
    assertEquals(s.droppedLinesCount, 4);
    assert(!out.some((l) => l.includes("SECRET-CANARY")));
    assert(!out.some((l) => l.includes("spoofed diagnostic")));
  }

  // 7. Non-allowlisted stderr lines after malformed OSC track dropped lines count (Finding h1r6b)
  {
    const s = new StderrSanitizer();
    const out: string[] = [];
    s.processChunk("\u001b]0;broken-title", (l) => out.push(l));
    s.processChunk("\nserver listening on 127.0.0.1:7788\nturn rejected: policy\ndone\n", (l) => out.push(l));
    s.flush((l) => out.push(l));
    assertEquals(out, []);
    assertEquals(s.droppedLinesCount, 4);
  }
});

Deno.test("acp-bridge retains split incomplete OSC and CSI sequences across stderr chunks without leaking payloads", async () => {
  const dir = durableDir("acp-logging-split-stderr");
  const adapterPath = `${dir}/adapter-split-stderr-mock.mjs`;

  Deno.writeTextFileSync(
    adapterPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: 1, agentInfo: { name: "mock-adapter", version: "1.0.0" } }
      }) + "\\n");
    } else if (msg.method === "session/new") {
      // Chunk 1: Incomplete OSC 52 sequence start
      process.stderr.write("Prefix \u001b]52;c;");
      await new Promise((r) => setTimeout(r, 60));
      // Chunk 2: Payload and termination
      process.stderr.write("c2VjcmV0\u0007 Suffix\\n");
      await new Promise((r) => setTimeout(r, 60));
      // Chunk 3: Incomplete CSI sequence start
      process.stderr.write("Color \u001b[31");
      await new Promise((r) => setTimeout(r, 60));
      // Chunk 4: CSI terminator and text
      process.stderr.write("mRedText\u001b[0m Done\\n");
      await new Promise((r) => setTimeout(r, 60));

      // Chunk 5: Multi-line OSC sequence spanning a newline and split ST across chunks
      process.stderr.write("SplitStart \u001b]52;c;LINE1_SECRET\\nLINE2_SECRET\u001b");
      await new Promise((r) => setTimeout(r, 60));

      // Chunk 6: ST terminator completion and clean text
      process.stderr.write("\\\\ SplitEnd\\n");
      await new Promise((r) => setTimeout(r, 60));

      // Chunk 7: 8-bit C1-form OSC payload
      process.stderr.write("C1Start \u009d52;c;C1_SECRET\u009c C1End\\n");
      await new Promise((r) => setTimeout(r, 60));

      // Chunk 8: Embedded CSI sequence inside OSC payload
      process.stderr.write(${JSON.stringify("EmbeddedStart \u001b]52;c;FIRST\u001b[31mEMBEDDED_SECRET\u001b\\ EmbeddedEnd\n")});
      await new Promise((r) => setTimeout(r, 60));

      // Chunk 9: OSC sequence starting inside an unfinished CSI sequence across chunks
      process.stderr.write("UnfinishedCSI \u001b[31\u001b");
      await new Promise((r) => setTimeout(r, 60));
      process.stderr.write("]52;c;UNFINISHED_CSI_SECRET\u0007 FinishedCSI\\n");
      await new Promise((r) => setTimeout(r, 60));

      // Chunk 10 (chrome-agent-platform-l5rup): Terminated OSC followed by real error
      process.stderr.write("PreUnterminated \u001b]0;OSC_PAYLOAD_SECRET\u0007");
      await new Promise((r) => setTimeout(r, 60));
      process.stderr.write("\\nERROR: real adapter diagnostic after terminated OSC\\n");

      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { sessionId: "split-test" }
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
          ws.close();
        }
      };
      ws.onclose = () => resolve();
      ws.onerror = (e) => reject(e);
    });

    await new Promise((r) => setTimeout(r, 300));

    // Verify split OSC payload was completely eliminated across chunk boundaries
    const leakedOscPayload = loggedErrors.some((l) => l.includes("c2VjcmV0"));
    assert(!leakedOscPayload, `Split OSC 52 payload leaked to logs: ${JSON.stringify(loggedErrors)}`);

    // Verify no raw ESC or BEL in logs
    const hasRawEsc = loggedErrors.some((l) => l.includes("\u001b"));
    assert(!hasRawEsc, `Found raw ESC in logged output: ${JSON.stringify(loggedErrors)}`);

    // Verify multi-line, split ST, and C1 OSC payloads were completely eliminated
    assert(!loggedErrors.some((l) => l.includes("LINE1_SECRET")), "LINE1_SECRET leaked across newline");
    assert(!loggedErrors.some((l) => l.includes("LINE2_SECRET")), "LINE2_SECRET leaked across split ST");
    assert(!loggedErrors.some((l) => l.includes("C1_SECRET")), "C1_SECRET leaked from C1 OSC sequence");
    assert(!loggedErrors.some((l) => l.includes("EMBEDDED_SECRET")), "EMBEDDED_SECRET leaked from embedded CSI");
    assert(!loggedErrors.some((l) => l.includes("UNFINISHED_CSI_SECRET")), "UNFINISHED_CSI_SECRET leaked from interrupted CSI");
    assert(!loggedErrors.some((l) => l.includes("UNTERMINATED_OSC_SECRET")), "UNTERMINATED_OSC_SECRET leaked across newline");

    // Verify real adapter diagnostic after terminated OSC is preserved
    assert(
      loggedErrors.some((l) => l.includes("ERROR: real adapter diagnostic after terminated OSC")),
      `Expected real diagnostic after terminated OSC to be preserved in stderr, got: ${JSON.stringify(loggedErrors)}`,
    );
    assert(!loggedErrors.some((l) => l.includes("OSC_PAYLOAD_SECRET")), "OSC_PAYLOAD_SECRET leaked");

    const hasSplitClean = loggedErrors.some((l) => l.includes("SplitStart SplitEnd"));
    assert(hasSplitClean, `Expected "SplitStart SplitEnd" logged, got: ${JSON.stringify(loggedErrors)}`);

    const hasC1Clean = loggedErrors.some((l) => l.includes("C1Start C1End"));
    assert(hasC1Clean, `Expected "C1Start C1End" logged, got: ${JSON.stringify(loggedErrors)}`);

    const hasEmbeddedClean = loggedErrors.some((l) => l.includes("EmbeddedStart EmbeddedEnd"));
    assert(hasEmbeddedClean, `Expected "EmbeddedStart EmbeddedEnd" logged, got: ${JSON.stringify(loggedErrors)}`);

    const hasUnfinishedClean = loggedErrors.some((l) => l.includes("UnfinishedCSI FinishedCSI"));
    assert(hasUnfinishedClean, `Expected "UnfinishedCSI FinishedCSI" logged, got: ${JSON.stringify(loggedErrors)}`);
  } finally {
    console.error = originalConsoleError;
    await server.shutdown();
  }
});

Deno.test("acp-bridge captures exit diagnostics even when stderr lacks a trailing newline", async () => {
  const dir = durableDir("acp-logging-no-newline-exit");
  const adapterPath = `${dir}/adapter-no-newline-mock.mjs`;

  Deno.writeTextFileSync(
    adapterPath,
    `// Immediately write stderr without newline and exit
process.stderr.write("fatal adapter boot error without newline");
process.exit(1);
`,
  );

  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map(String).join(" "));
  };

  const server = createAcpServer(0, adapterPath, {}, undefined, TEST_BRIDGE_TOKEN);
  const port = (server as any).addr.port;

  try {
    let closeReason = "";
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(authedEndpoint(port, "codex"));
      ws.onclose = (ev) => {
        closeReason = ev.reason;
        resolve();
      };
      ws.onerror = () => resolve();
    });

    const exitLog = loggedErrors.find((l) => l.includes("adapter for harness \"codex\" exited"));
    assert(exitLog, `Expected exit log in logged errors, got: ${JSON.stringify(loggedErrors)}`);
    assert(
      exitLog.includes("fatal adapter boot error without newline"),
      `Expected exit log to include un-newlined stderr, got: ${exitLog}`,
    );
    assert(
      closeReason.includes("fatal adapter boot error without newline"),
      `Expected socket close reason to include un-newlined stderr, got: "${closeReason}"`,
    );
  } finally {
    console.error = originalConsoleError;
    await server.shutdown();
  }
});

Deno.test("acp-bridge preserves raw harness in child environment while sanitizing operator logs and close reasons", async () => {
  const dir = durableDir("acp-logging-harness-sanitization");
  const adapterPath = `${dir}/adapter-harness-mock.mjs`;
  const echoFile = `${dir}/harness-echo.txt`;

  Deno.writeTextFileSync(
    adapterPath,
    `import readline from "node:readline";
import fs from "node:fs";
try { fs.writeFileSync(${JSON.stringify(echoFile)}, process.env.PI_ACP_HARNESS ?? ""); } catch {}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "boom" }
      }) + "\\n");
      setTimeout(() => process.exit(0), 50);
    }
  } catch {}
});
`,
  );

  const loggedMessages: string[] = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  console.log = (...args: unknown[]) => {
    loggedMessages.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    loggedMessages.push(args.map(String).join(" "));
  };

  const prevKey = Deno.env.get("ANTHROPIC_API_KEY");
  const prevKeep = Deno.env.get("CAP_ACP_KEEP_API_KEY");
  Deno.env.set("ANTHROPIC_API_KEY", "sk-ant-test-5f5u");
  Deno.env.delete("CAP_ACP_KEEP_API_KEY");

  let server: Awaited<ReturnType<typeof createAcpServer>> | null = null;
  const attackHarness = "\u001b]0;REV_HARNESS_TITLE_PWN\u0007\u001b[31mH\u001b[0m";

  try {
    server = createAcpServer(0, adapterPath, {}, undefined, TEST_BRIDGE_TOKEN);
    const port = (server as any).addr.port;

    let closeReason = "";
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/acp?token=${TEST_BRIDGE_TOKEN}&harness=${encodeURIComponent(attackHarness)}`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }));
      };
      ws.onclose = (ev) => {
        closeReason = ev.reason;
        resolve();
      };
      ws.onerror = (e) => reject(e);
    });

    // 1. Verify child environment received the EXACT raw harness without mutation
    const echoedHarness = Deno.readTextFileSync(echoFile);
    assertEquals(echoedHarness, attackHarness, "Child process PI_ACP_HARNESS must retain exact raw harness string");

    // 2. Verify no raw ESC or BEL in any operator log lines
    assert(!loggedMessages.some((l) => l.includes("\u001b")), `Found raw ESC in logs: ${JSON.stringify(loggedMessages)}`);
    assert(!loggedMessages.some((l) => l.includes("\u0007")), `Found raw BEL in logs: ${JSON.stringify(loggedMessages)}`);
    assert(!loggedMessages.some((l) => l.includes("REV_HARNESS_TITLE_PWN")), `OSC title payload leaked into logs: ${JSON.stringify(loggedMessages)}`);

    // 3. Verify sanitized harness "H" was logged cleanly across connection, env note, error, and exit logs
    assert(loggedMessages.some((l) => l.includes("(harness: H)")), `Expected sanitized connection log, got: ${JSON.stringify(loggedMessages)}`);
    assert(loggedMessages.some((l) => l.includes("[acp-bridge] H: ANTHROPIC_API_KEY is set in this environment")), `Expected sanitized child env note, got: ${JSON.stringify(loggedMessages)}`);
    assert(loggedMessages.some((l) => l.includes('adapter error for harness "H"')), `Expected sanitized error log, got: ${JSON.stringify(loggedMessages)}`);
    assert(loggedMessages.some((l) => l.includes('adapter for harness "H" exited')), `Expected sanitized exit log, got: ${JSON.stringify(loggedMessages)}`);

    // 4. Verify close reason was sanitized and names the sanitized harness
    assert(!closeReason.includes("\u001b"), `Found raw ESC in close reason: "${closeReason}"`);
    assert(!closeReason.includes("\u0007"), `Found raw BEL in close reason: "${closeReason}"`);
    assert(!closeReason.includes("REV_HARNESS_TITLE_PWN"), `OSC title payload in close reason: "${closeReason}"`);
    assert(closeReason.includes('adapter for harness "H" exited'), `Expected close reason to name sanitized harness, got: "${closeReason}"`);
  } finally {
    if (prevKey !== undefined) Deno.env.set("ANTHROPIC_API_KEY", prevKey);
    else Deno.env.delete("ANTHROPIC_API_KEY");
    if (prevKeep !== undefined) Deno.env.set("CAP_ACP_KEEP_API_KEY", prevKeep);
    else Deno.env.delete("CAP_ACP_KEEP_API_KEY");
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    if (server) await server.shutdown();
  }
});

Deno.test("acp-bridge rejects unknown harness with sanitized 400 error when --adapter is NOT pinned", async () => {
  const server = createAcpServer(0, undefined, {}, undefined, TEST_BRIDGE_TOKEN);
  const port = (server as any).addr.port;

  const attackHarness = "bad_\u001b]0;TITLE\u0007\u001b[31mharness\u001b[0m";

  try {
    const res = await fetch(`http://127.0.0.1:${port}/acp?token=${TEST_BRIDGE_TOKEN}&harness=${encodeURIComponent(attackHarness)}`);
    assertEquals(res.status, 400, "Unknown harness must reject with 400");
    const body = await res.text();
    assert(body.includes('unknown harness "bad_harness"'), `Expected sanitized bad harness in response, got: "${body}"`);
    assert(!body.includes("\u001b"), `Found raw ESC in response body: "${body}"`);
    assert(!body.includes("\u0007"), `Found raw BEL in response body: "${body}"`);
    assert(!body.includes("TITLE"), `OSC payload leaked into response body: "${body}"`);
  } finally {
    await server.shutdown();
  }
});

Deno.test("acp-bridge preserves exit diagnostics when adapter emits an unterminated OSC followed by error text and exits", async () => {
  const dir = durableDir("acp-logging-unterminated-osc");
  const adapterPath = `${dir}/adapter-unterminated-osc-mock.mjs`;

  Deno.writeTextFileSync(
    adapterPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stderr.write("\\u001b]0;UNTERMINATED_TITLE_PWN\\nFATAL: adapter crash on boot\\n");
      setTimeout(() => process.exit(17), 50);
    }
  } catch {}
});
`,
  );

  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map(String).join(" "));
  };

  const server = createAcpServer(0, adapterPath, {}, undefined, TEST_BRIDGE_TOKEN);
  const port = (server as any).addr.port;

  try {
    let closeReason = "";
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(authedEndpoint(port, "codex"));
      ws.onopen = () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }));
      };
      ws.onclose = (ev) => {
        closeReason = ev.reason;
        resolve();
      };
      ws.onerror = () => resolve();
    });

    const exitLog = loggedErrors.find((l) => l.includes("adapter for harness \"codex\" exited"));
    assert(exitLog, `Expected exit log in logged errors, got: ${JSON.stringify(loggedErrors)}`);
    assert(
      exitLog.includes("stderr suppressed after unterminated OSC (2 lines dropped)"),
      `Expected exit log to report suppressed diagnostics, got: ${exitLog}`,
    );
    assert(
      closeReason.includes("stderr suppressed after unterminated OSC (2 lines dropped)"),
      `Expected socket close reason to report suppressed diagnostics, got: "${closeReason}"`,
    );
    assert(!exitLog.includes("UNTERMINATED_TITLE_PWN"), `OSC payload leaked into exit log: ${exitLog}`);
    assert(!closeReason.includes("UNTERMINATED_TITLE_PWN"), `OSC payload leaked into close reason: "${closeReason}"`);
    assert(!exitLog.includes("FATAL: adapter crash on boot"), `Ambiguous post-OSC line leaked into exit log: ${exitLog}`);
    assert(!closeReason.includes("FATAL: adapter crash on boot"), `Ambiguous post-OSC line leaked into close reason: "${closeReason}"`);
    assert(!exitLog.includes("\u001b"), `Found raw ESC in exit log: ${exitLog}`);
    assert(!closeReason.includes("\u001b"), `Found raw ESC in close reason: "${closeReason}"`);
  } finally {
    console.error = originalConsoleError;
    await server.shutdown();
  }
});

Deno.test("acp-bridge reports suppressed lines in exit diagnostic when adapter emits an unterminated OSC followed only by un-allowlisted lines", async () => {
  const dir = durableDir("acp-logging-suppressed-exit");
  const adapterPath = `${dir}/adapter-suppressed-mock.mjs`;

  Deno.writeTextFileSync(
    adapterPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stderr.write("\\u001b]0;broken-title\\nserver listening on 127.0.0.1:7788\\nturn rejected: policy\\ndone\\n");
      setTimeout(() => process.exit(1), 50);
    }
  } catch {}
});
`,
  );

  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map(String).join(" "));
  };

  const server = createAcpServer(0, adapterPath, {}, undefined, TEST_BRIDGE_TOKEN);
  const port = (server as any).addr.port;

  try {
    let closeReason = "";
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(authedEndpoint(port, "codex"));
      ws.onopen = () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }));
      };
      ws.onclose = (ev) => {
        closeReason = ev.reason;
        resolve();
      };
      ws.onerror = () => resolve();
    });

    const exitLog = loggedErrors.find((l) => l.includes("adapter for harness \"codex\" exited"));
    assert(exitLog, `Expected exit log in logged errors, got: ${JSON.stringify(loggedErrors)}`);
    assert(
      exitLog.includes("stderr suppressed after unterminated OSC (4 lines dropped)"),
      `Expected exit log to report suppressed diagnostics, got: ${exitLog}`,
    );
    assert(
      closeReason.includes("stderr suppressed after unterminated OSC (4 lines dropped)"),
      `Expected close reason to report suppressed diagnostics, got: "${closeReason}"`,
    );
  } finally {
    console.error = originalConsoleError;
    await server.shutdown();
  }
});

Deno.test("acp-bridge refuses unterminated OSC 52 clipboard payload in real adapter stderr stream even when matching diagnostic allowlist (Finding vpo4n)", async () => {
  const dir = durableDir("acp-logging-osc52-refusal");
  const adapterPath = `${dir}/adapter-osc52-mock.mjs`;

  Deno.writeTextFileSync(
    adapterPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stderr.write("\\u001b]52;c;clipboard-data\\nAPI_KEY=sk-ant-SECRET-CANARY\\nERROR: spoofed diagnostic from untrusted payload\\n");
      setTimeout(() => process.exit(1), 50);
    }
  } catch {}
});
`,
  );

  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map(String).join(" "));
  };

  const server = createAcpServer(0, adapterPath, {}, undefined, TEST_BRIDGE_TOKEN);
  const port = (server as any).addr.port;

  try {
    let closeReason = "";
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(authedEndpoint(port, "codex"));
      ws.onopen = () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }));
      };
      ws.onclose = (ev) => {
        closeReason = ev.reason;
        resolve();
      };
      ws.onerror = () => resolve();
    });

    // 1. Verify unverified OSC 52 payload lines NEVER reached console.error or [adapter-stderr]
    assert(!loggedErrors.some((l) => l.includes("SECRET-CANARY")), `Canary leaked into stderr logs: ${JSON.stringify(loggedErrors)}`);
    assert(!loggedErrors.some((l) => l.includes("spoofed diagnostic")), `Spoofed diagnostic leaked into stderr logs: ${JSON.stringify(loggedErrors)}`);

    // 2. Verify unverified OSC 52 payload lines NEVER reached WebSocket close reason
    assert(!closeReason.includes("SECRET-CANARY"), `Canary leaked into close reason: "${closeReason}"`);
    assert(!closeReason.includes("spoofed diagnostic"), `Spoofed diagnostic leaked into close reason: "${closeReason}"`);

    // 3. Verify exit diagnostic cleanly notes suppressed stderr lines
    const exitLog = loggedErrors.find((l) => l.includes("adapter for harness \"codex\" exited"));
    assert(exitLog, `Expected exit log in logged errors, got: ${JSON.stringify(loggedErrors)}`);
    assert(
      exitLog.includes("stderr suppressed after unterminated OSC (3 lines dropped)"),
      `Expected exit log to report suppressed diagnostics, got: ${exitLog}`,
    );
    assert(
      closeReason.includes("stderr suppressed after unterminated OSC (3 lines dropped)"),
      `Expected close reason to report suppressed diagnostics, got: "${closeReason}"`,
    );
  } finally {
    console.error = originalConsoleError;
    await server.shutdown();
  }
});

Deno.test("acp-bridge refuses unterminated title OSC payload in real adapter stderr stream even when matching diagnostic allowlist (Finding vpo4n)", async () => {
  const dir = durableDir("acp-logging-title-refusal");
  const adapterPath = `${dir}/adapter-title-refusal-mock.mjs`;

  Deno.writeTextFileSync(
    adapterPath,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stderr.write("\\u001b]0;UNTERMINATED_TITLE\\nAPI_KEY=sk-ant-TITLE-INTEGRATION-CANARY\\nERROR: forged integration diagnostic\\n");
      setTimeout(() => process.exit(17), 50);
    }
  } catch {}
});
`,
  );

  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map(String).join(" "));
  };

  const server = createAcpServer(0, adapterPath, {}, undefined, TEST_BRIDGE_TOKEN);
  const port = (server as any).addr.port;

  try {
    let closeReason = "";
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(authedEndpoint(port, "codex"));
      ws.onopen = () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }));
      };
      ws.onclose = (ev) => {
        closeReason = ev.reason;
        resolve();
      };
      ws.onerror = () => resolve();
    });

    // 1. Verify unverified title OSC payload lines NEVER reached console.error or [adapter-stderr]
    assert(!loggedErrors.some((l) => l.includes("TITLE-INTEGRATION-CANARY")), `Canary leaked into stderr logs: ${JSON.stringify(loggedErrors)}`);
    assert(!loggedErrors.some((l) => l.includes("forged integration diagnostic")), `Forged diagnostic leaked into stderr logs: ${JSON.stringify(loggedErrors)}`);
    assert(!loggedErrors.some((l) => l.includes("UNTERMINATED_TITLE")), `Title leaked into stderr logs: ${JSON.stringify(loggedErrors)}`);

    // 2. Verify unverified title OSC payload lines NEVER reached WebSocket close reason
    assert(!closeReason.includes("TITLE-INTEGRATION-CANARY"), `Canary leaked into close reason: "${closeReason}"`);
    assert(!closeReason.includes("forged integration diagnostic"), `Forged diagnostic leaked into close reason: "${closeReason}"`);
    assert(!closeReason.includes("UNTERMINATED_TITLE"), `Title leaked into close reason: "${closeReason}"`);

    // 3. Verify exit diagnostic cleanly notes suppressed stderr lines
    const exitLog = loggedErrors.find((l) => l.includes("adapter for harness \"codex\" exited"));
    assert(exitLog, `Expected exit log in logged errors, got: ${JSON.stringify(loggedErrors)}`);
    assert(
      exitLog.includes("stderr suppressed after unterminated OSC (3 lines dropped)"),
      `Expected exit log to report suppressed diagnostics, got: ${exitLog}`,
    );
    assert(
      closeReason.includes("stderr suppressed after unterminated OSC (3 lines dropped)"),
      `Expected close reason to report suppressed diagnostics, got: "${closeReason}"`,
    );
  } finally {
    console.error = originalConsoleError;
    await server.shutdown();
  }
});

Deno.test("acp-bridge /health sanitizes client-supplied ?harness= query parameter and reflected error", async () => {
  const server = createAcpServer(0, undefined, {}, undefined, TEST_BRIDGE_TOKEN);
  const port = (server as any).addr.port;

  // 1. Attack payload with 7-bit OSC, C1 CSI, and C1 OSC sequences
  const attackHarness = "\x1b]0;HEALTH_OSC_PWN\u0007\u009b31mbad_\u009dHEALTH_C1_PWN\u009c";

  // 2. Exact bead repro with C1 CSI + BEL + CSI color (chrome-agent-platform-5dez3)
  const reproHarness = "\u009b]0;HEALTH_RAW_C1\u0007\u001b[31mX";

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health?harness=${encodeURIComponent(attackHarness)}`);
    assertEquals(res.status, 200, "/health should answer with 200");
    const rawText = await res.text();
    // Raw response text should not contain unescaped C1 control characters (0x7F - 0x9F)
    assert(!/[\x7f-\x9f]/.test(rawText), `Found C1 control characters in /health response: "${rawText}"`);
    assert(!rawText.includes("HEALTH_OSC_PWN"), `OSC payload leaked in /health response: "${rawText}"`);
    assert(!rawText.includes("HEALTH_C1_PWN"), `C1 OSC payload leaked in /health response: "${rawText}"`);

    const json = JSON.parse(rawText);
    assertEquals(json.ok, true);
    assertEquals(json.probeHarness, "bad_");
    assert(!/[\x00-\x1f\x7f-\x9f]/.test(json.probeHarness), `probeHarness contains control characters: "${json.probeHarness}"`);
    assert(typeof json.error === "string", "Unknown harness probe must produce an error field in /health response");
    assert(!/[\x00-\x1f\x7f-\x9f]/.test(json.error), `error contains control characters: "${json.error}"`);
    assert(!json.error.includes("HEALTH_OSC_PWN"), `OSC payload leaked in error field: "${json.error}"`);
    assert(!json.error.includes("HEALTH_C1_PWN"), `C1 OSC payload leaked in error field: "${json.error}"`);

    // Test exact bead repro: C1 CSI byte is stripped, never emitted verbatim
    const resRepro = await fetch(`http://127.0.0.1:${port}/health?harness=${encodeURIComponent(reproHarness)}`);
    assertEquals(resRepro.status, 200);
    const rawReproText = await resRepro.text();
    assert(!/[\x7f-\x9f]/.test(rawReproText), `C1 control bytes found in /health repro response: "${rawReproText}"`);
    assert(!rawReproText.includes("\u009b"), `Raw U+009B leaked in response`);
    assert(!rawReproText.includes("\u0007"), `Raw BEL leaked in response`);
    assert(!rawReproText.includes("\x1b"), `Raw ESC leaked in response`);
  } finally {
    await server.shutdown();
  }
});
