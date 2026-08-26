// @ts-nocheck
// tests/cap-log.test.ts — KATs for the extension-wide logger (cap-log.js):
// level gating (off/normal/verbose), secret redaction, bounded output, the
// ring buffer (bounded + honest truncation), and the namespaced prefix shape.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  capLog,
  capLogReady,
  clearLogBuffer,
  dumpLogBuffer,
  getLogVerbosity,
  scrubLogValue,
  setLogVerbosity,
} from "../extension/lib/cap-log.js";

function captureConsole() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  const orig = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.debug = (...a) => calls.debug.push(a);
  console.info = (...a) => calls.info.push(a);
  console.warn = (...a) => calls.warn.push(a);
  console.error = (...a) => calls.error.push(a);
  return { calls, restore: () => Object.assign(console, orig) };
}

Deno.test("cap-log: level gating — off suppresses everything, normal hides debug, verbose emits debug", async () => {
  await capLogReady();
  const log = capLog("test:levels");
  const { calls, restore } = captureConsole();
  try {
    await setLogVerbosity("off");
    log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
    assertEquals(calls.debug.length + calls.info.length + calls.warn.length + calls.error.length, 0);

    await setLogVerbosity("normal");
    log.debug("d");
    log.info("i"); log.warn("w"); log.error("e");
    assertEquals(calls.debug.length, 0, "debug suppressed at normal");
    assertEquals(calls.info.length, 1);
    assertEquals(calls.warn.length, 1);
    assertEquals(calls.error.length, 1);

    await setLogVerbosity("verbose");
    log.debug("d2");
    assertEquals(calls.debug.length, 1, "debug emitted at verbose");
    assertEquals(getLogVerbosity(), "verbose");
  } finally {
    restore();
    await setLogVerbosity("off");
  }
});

Deno.test("cap-log: lines are namespaced + timestamped with an elapsed delta", async () => {
  const log = capLog("test:shape");
  const { calls, restore } = captureConsole();
  try {
    await setLogVerbosity("normal");
    log.info("hello", { a: 1 });
    assertEquals(calls.info.length, 1);
    const [first, ...rest] = calls.info[0];
    assertStringIncludes(first, "[cap:test:shape]");
    assert(/^\[cap:test:shape\] \d{4}-\d{2}-\d{2}T/.test(first), `ISO timestamp in prefix: ${first}`);
    assertStringIncludes(first, "—"); // first call: no delta yet
    log.info("second");
    assertStringIncludes(calls.info[1][0], "+"); // subsequent call carries +Nms
    assertEquals(rest[0], "hello");
  } finally {
    restore();
    await setLogVerbosity("off");
  }
});

Deno.test("cap-log: redaction masks token-shaped strings and bounds length", () => {
  const longHex = "a1b2c3d4e5f6".repeat(4); // 48 hex chars — grant-id shaped
  assertEquals(scrubLogValue(`grant ${longHex}`), "grant «redacted»");
  assertStringIncludes(scrubLogValue("key sk-abc123def456ghi789"), "«redacted»");
  assert(!String(scrubLogValue("key sk-abc123def456ghi789")).includes("sk-"));
  assertStringIncludes(scrubLogValue("AIzaSyA123456789012345678901234567890X"), "«redacted»");
  assertStringIncludes(scrubLogValue("Bearer abcdef1234567890"), "«redacted»");
  // short ordinary strings survive untouched
  assertEquals(scrubLogValue("ordinary message"), "ordinary message");
  // bounding (a long ORDINARY string — word-separated so it is not a token run)
  const long = "lorem ipsum dolor sit amet ".repeat(200);
  const scrubbed = scrubLogValue(long);
  assert(scrubbed.length < 900, `bounded: ${scrubbed.length}`);
  assertStringIncludes(scrubbed, "chars)");
  // a single 5000-char token-shaped run is masked as a secret instead
  assertEquals(scrubLogValue("x".repeat(5000)), "«redacted»");
  // objects are serialised with the same scrub, bounded
  const obj = scrubLogValue({ token: longHex, note: "ok" });
  assertStringIncludes(obj, "«redacted»");
  assertStringIncludes(obj, "ok");
  // Errors reduce to name + scrubbed message
  const err = scrubLogValue(new TypeError(`bad token ${longHex}`));
  assertStringIncludes(err, "TypeError");
  assertStringIncludes(err, "«redacted»");
});

Deno.test("cap-log: ring buffer is bounded with an honest dropped counter", async () => {
  clearLogBuffer();
  const { restore } = captureConsole();
  try {
    await setLogVerbosity("off"); // ring records even when console is gated
    const log = capLog("test:ring");
    for (let i = 0; i < 600; i++) log.info(`line ${i}`);
    const dump = dumpLogBuffer();
    assertEquals(dump.entries.length, 500, "ring is capped");
    assertEquals(dump.dropped, 100, "dropped counted honestly");
    assertEquals(dump.entries.at(-1).msg, "line 599");
    assertEquals(dump.entries[0].msg, "line 100", "oldest retained is honest");
    assertEquals(dump.entries[0].ns, "test:ring");
  } finally {
    restore();
    clearLogBuffer();
  }
});

Deno.test("cap-log: invalid verbosity names are refused", async () => {
  let threw = false;
  try {
    await setLogVerbosity("loud");
  } catch (e) {
    threw = true;
    assertStringIncludes(e.message, "invalid log verbosity");
  }
  assert(threw, "invalid level must throw");
});
