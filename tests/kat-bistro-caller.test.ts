// tests/kat-bistro-caller.test.ts — chrome-agent-platform-cvlf: the French
// Bistro KAT caller's guards are pinned by EXECUTING the extracted units
// (scripts/lib/kat-bistro-caller.ts — extracted verbatim from the caller, the
// kat-finalizer.ts pattern), never by grepping the caller's source text.
// Replaces er6x's source pins (tests/kat-bistro-caller-pins.test.ts, deleted):
// two nets for one guard means neither is trusted.
// @ts-nocheck — the caller units are deliberately dynamic.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  announceRunError,
  assembleBistroReport,
  assembleBistroTeardown,
  BISTRO_DEFAULT_BINARY,
  BISTRO_READY_EXPRESSION,
  bistroDomBookingHolds,
  bistroFalsificationHolds,
  bistroJsonStringProbe,
  bistroJsonStringSuccessHolds,
  bistroProfileDir,
  bistroRunReport,
  buildBistroLaunchConfig,
  captureRunError,
  hasGitChanges,
  mainWorldSha256Of,
  persistBistroScreenshot,
  runBistroEvidenceDir,
  screenshotCapturedHolds,
  serviceWorkerRegisteredHolds,
  settleBistroRun,
  URL_BISTRO,
  WEBMCP_LAUNCH_ARGS,
} from "../scripts/lib/kat-bistro-caller.ts";

const VALID_BOOKING = {
  name: "Jean-Luc Picard",
  phone: "1234567890",
  date: "2026-09-10",
  time: "19:00",
  guests: "2",
  seating: "Main Dining",
};

// ── launch configuration ─────────────────────────────────────────────────────

Deno.test("bistro caller: the demo URL carries the toolautosubmit flag (U1)", () => {
  assertStringIncludes(URL_BISTRO, "?toolautosubmit");
  assertStringIncludes(URL_BISTRO, "french-bistro");
});

Deno.test("bistro caller: launch config keeps the WebMCP feature flag and parameterizes the binary (U2)", () => {
  const cfg = buildBistroLaunchConfig({ extensionDir: "/ext", profileDir: "/prof" });
  assertEquals(cfg.args, ["--enable-features=WebMCP"], "the WebMCP flag is launched, never disabled/absent");
  assertEquals(cfg.binary, BISTRO_DEFAULT_BINARY, "the default binary is the repo's chromium");
  assertEquals(cfg.extension, "/ext");
  assertEquals(cfg.profile, "/prof");
  assertEquals(cfg.timeoutMs, 30_000);
  const redirected = buildBistroLaunchConfig({ extensionDir: "/e", profileDir: "/p", binary: "/usr/bin/google-chrome", timeoutMs: 5_000 });
  assertEquals(redirected.binary, "/usr/bin/google-chrome", "a harness can redirect the binary");
});

Deno.test("bistro caller: the readiness expression demands a REAL modelContext (U17)", () => {
  assertStringIncludes(BISTRO_READY_EXPRESSION, `document.readyState === "complete"`);
  assertStringIncludes(BISTRO_READY_EXPRESSION, "document.modelContext");
  assertStringIncludes(BISTRO_READY_EXPRESSION, "getTools");
});

// ── evidence dir / profile ───────────────────────────────────────────────────

Deno.test("bistro caller: the run's evidence dir is the ALLOCATOR's fresh child, never the parent (U19)", async () => {
  let allocatedWith = null;
  const child = await runBistroEvidenceDir({
    parent: "/ev/parent",
    allocate: async (parent) => { allocatedWith = parent; return `${parent}/run-abc`; },
  });
  assertEquals(allocatedWith, "/ev/parent", "the allocator is consulted with the parent");
  assertEquals(child, "/ev/parent/run-abc", "the RUN owns the fresh child");
  // And the DEFAULT is the real allocator (executed, not simulated):
  const tmpParent = await Deno.makeTempDir();
  try {
    const real = await runBistroEvidenceDir({ parent: tmpParent });
    assert(real !== tmpParent, "the real allocator created a fresh CHILD, not the parent");
    assertStringIncludes(real, tmpParent);
  } finally {
    await Deno.remove(tmpParent, { recursive: true }).catch(() => {});
  }
});

Deno.test("bistro caller: the browser profile is DURABLE, never /tmp (U20)", () => {
  const seen = [];
  const profile = bistroProfileDir(1234, (p) => { seen.push(p); return `/durable/${p}`; });
  assertEquals(seen, ["kat-webmcp-bistro-profile-1234"], "the durable-root seam is consulted with the run-bound name");
  assertEquals(profile, "/durable/kat-webmcp-bistro-profile-1234");
  assert(!profile.startsWith("/tmp/"), "the profile never lands on tmpfs");
});

// ── run-error capture (ll7q) ─────────────────────────────────────────────────

Deno.test("bistro caller: a crash captures the bounded error, never null (U7)", () => {
  const withStack = new Error("boom at the step");
  withStack.stack = "Error: boom at the step\n    at run (/somewhere/real.ts:1:2)";
  assertStringIncludes(captureRunError(withStack), "boom at the step");
  const noStack = new Error("message-only");
  (noStack as any).stack = undefined;
  assertEquals(captureRunError(noStack), "message-only");
  assertEquals(captureRunError("plain string failure"), "plain string failure");
});

Deno.test("bistro caller: the console gets the SANITIZED class, never raw run paths (U8)", () => {
  const seen = [];
  const err = new Error("failed");
  err.stack = "Error: failed\n    at /home/owner/secret-run-path/file.ts:1:2";
  announceRunError(err, { consoleError: (...a) => seen.push(a) });
  assertEquals(seen.length, 1, "exactly one console line");
  assertEquals(seen[0][0], "KAT Execution Error:");
  const surfaced = String(seen[0][1]);
  assert(!surfaced.includes("/home/owner/secret-run-path"), "raw paths never reach the console");
});

// ── the four check predicates + the service-worker check ────────────────────

Deno.test("bistro caller: falsification demands the JSONReader parse error, not any failure (U9/U10)", () => {
  const real = { ok: false, error: "Error: Failed to parse input string as JSON: unexpected token" };
  assert(bistroFalsificationHolds(real) === true, "the REAL failure shape is accepted");
  assert(bistroFalsificationHolds({ ok: false, error: "Error: some unrelated failure" }) === false, "a different failure is NOT the falsification pass (U9)");
  assert(bistroFalsificationHolds({ ok: true, res: "We look forward to welcoming you" }) === false, "a SUCCESS must not pass the falsification check (U10)");
  assert(bistroFalsificationHolds(undefined) === false);
  assert(bistroFalsificationHolds(null) === false);
});

Deno.test("bistro caller: success demands ok AND the demo's real confirmation copy as a STRING (U11)", () => {
  const real = { ok: true, res: "Merci! We look forward to welcoming you soon." };
  assert(bistroJsonStringSuccessHolds(real) === true, "the REAL success shape is accepted");
  assert(bistroJsonStringSuccessHolds({ ok: true, res: 12345 }) === false, "a non-string body is not the confirmation");
  assert(bistroJsonStringSuccessHolds({ ok: true, res: "some other page text" }) === false, "an ok with the WRONG body is not a pass");
  assert(bistroJsonStringSuccessHolds({ ok: false, error: "We look forward to welcoming you" }) === false);
});

Deno.test("bistro caller: the DOM check demands EVERY exact booking field plus the dialog (U12)", () => {
  const visible = {
    dialogOpen: true,
    modalText: "Merci! We look forward to welcoming you.",
    ...VALID_BOOKING,
  };
  assert(bistroDomBookingHolds(visible, VALID_BOOKING) === true, "the REAL visible state is accepted");
  assert(bistroDomBookingHolds({ ...visible, name: "someone else" }, VALID_BOOKING) === false, "a wrong name is caught");
  assert(bistroDomBookingHolds({ dialogOpen: true }, VALID_BOOKING) === false, "a dialog alone is NOT the check (U12)");
  assert(bistroDomBookingHolds({ ...visible, dialogOpen: false }, VALID_BOOKING) === false, "fields without the dialog fail");
  assert(bistroDomBookingHolds({ ...visible, modalText: "" }, VALID_BOOKING) === false, "an empty dialog body fails");
});

Deno.test("bistro caller: the screenshot check demands real bytes (U13)", () => {
  assert(screenshotCapturedHolds(new Uint8Array([1, 2, 3])) === true);
  assert(screenshotCapturedHolds(new Uint8Array(0)) === false, "zero bytes is not a capture");
  assert(screenshotCapturedHolds(undefined) === false);
  assert(screenshotCapturedHolds(null) === false);
});

Deno.test("bistro caller: the service-worker check demands an EXTENSION url (U15)", () => {
  assert(serviceWorkerRegisteredHolds({ url: "chrome-extension://abc/sw.js" }) === true);
  assert(serviceWorkerRegisteredHolds({ url: "https://evil.example/sw.js" }) === false, "a truthy worker with a foreign url is NOT ours");
  assert(serviceWorkerRegisteredHolds(undefined) === false);
  assert(serviceWorkerRegisteredHolds({}) === false);
});

Deno.test("bistro caller: the success probe is BOUNDED — a wedged evaluation is cut at the deadline (U16)", async () => {
  const never = new Promise(() => {});
  let evalCalls = 0;
  const fakeCdp = { eval: (_s, expression) => { evalCalls += 1; assertStringIncludes(expression, "book_table_le_petit_bistro"); assertStringIncludes(expression, "executeTool"); return never; } };
  await assertRejects(
    () => bistroJsonStringProbe(fakeCdp, "sess", "{}", { timeoutMs: 20 }),
    undefined,
    undefined,
    "an evaluation that never settles must be rejected by the deadline",
  );
  // And a slow-but-settling evaluation is cut too (the mutant without the
  // bound would RESOLVE here instead of rejecting — that is the kill):
  const slowCdp = { eval: (_s, _e) => new Promise((r) => setTimeout(() => r({ ok: true, res: "late" }), 300)) };
  await assertRejects(() => bistroJsonStringProbe(slowCdp, "sess", "{}", { timeoutMs: 20 }), undefined, undefined, "a 300ms eval is cut at 20ms");
  // The expression probes the REAL tool by name with the JSON payload string.
  assertEquals(evalCalls, 1);
});

// ── report / teardown / digest assembly ─────────────────────────────────────

Deno.test("bistro caller: the report carries the run's CHILD evidence dir, not the parent (U18)", () => {
  const report = bistroRunReport({
    evidence: "/ev/parent/run-abc",
    head: "h4sh", tree: "tr33", dirty: true, mainWorldSha256: "mw", url: "https://demo", browserVersion: { v: 1 }, lockWaitMs: 42,
  });
  assertEquals(report.outDir, "/ev/parent/run-abc");
  assertEquals(report.outDir !== "/ev/parent", true);
});

Deno.test("bistro caller: expected is THIS run's head; every field passes through (U21/U22/U23/U26)", () => {
  const report = assembleBistroReport({
    head: "h4sh", tree: "tr33", dirty: true, mainWorldSha256: "mw-digest", url: "https://demo", browserVersion: { v: 1 }, lockWaitMs: 1234, outDir: "/out",
  });
  assertEquals(report.expected, "h4sh", "expected is the run's own head (U23)");
  assertEquals(report.mainWorldSha256, "mw-digest", "the digest passes through (U21)");
  assertEquals(report.dirty, true, "dirty passes through as observed (U22)");
  assertEquals(report.lockWaitMs, 1234, "the measured lock wait passes through (U26)");
  const clean = assembleBistroReport({ head: "h", tree: "t", dirty: false, mainWorldSha256: "m", url: "u", browserVersion: null, lockWaitMs: null, outDir: "/o" });
  assertEquals(clean.dirty, false);
  assertEquals(clean.lockWaitMs, null, "a null lock wait is preserved, not fabricated");
});

Deno.test("bistro caller: teardown carries the REAL browser, cdp and profile (U24/U25)", () => {
  const cdp = { sentinel: "cdp" };
  const chrome = { sentinel: "chrome" };
  const td = assembleBistroTeardown({ cdp, chrome, profilePath: "/durable/profile-1", withTimeout: (x) => x });
  assertEquals(td.cdp, cdp, "the real cdp connection is torn down (U25)");
  assertEquals(td.chrome, chrome, "the real chrome handle is torn down (U25)");
  assertEquals(td.profilePath, "/durable/profile-1", "the real profile is removed (U24)");
  assert(td.profilePath !== null, "the profile path is never nulled (U24)");
});

Deno.test("bistro caller: the shipped main-world digest is computed from the bytes (U21)", async () => {
  const { createHash } = await import("node:crypto");
  const bytes = new TextEncoder().encode("cap-main-world");
  assertEquals(mainWorldSha256Of(bytes), createHash("sha256").update(bytes).digest("hex"), "the digest is the SHA-256 of the EXACT bytes");
  const a = mainWorldSha256Of(new TextEncoder().encode("one"));
  const b = mainWorldSha256Of(new TextEncoder().encode("two"));
  assert(a !== b, "different bytes give different digests — never a constant");
  assertEquals(a, mainWorldSha256Of(new TextEncoder().encode("one")), "the digest is deterministic over the bytes");
});

Deno.test("bistro caller: the dirty bit is the porcelain output, not a constant (U22)", () => {
  assertEquals(hasGitChanges(""), false);
  assertEquals(hasGitChanges(" M scripts/kat-webmcp-bistro.ts\n"), true);
});

Deno.test("bistro caller: the captured screenshot is PERSISTED into the run's evidence dir (U14)", async () => {
  const writes = [];
  const shot = new Uint8Array([9, 8, 7]);
  await persistBistroScreenshot({ shot, outDir: "/ev/run-abc", write: async (p, b) => writes.push([p, b]) });
  assertEquals(writes.length, 1, "exactly one write");
  assertEquals(writes[0][0], "/ev/run-abc/bistro-json-string-success.png", "the screenshot lands in the run's evidence dir under its exact name");
  assertEquals(writes[0][1], shot, "the captured bytes are written verbatim");
  writes.length = 0;
  await persistBistroScreenshot({ shot: null, outDir: "/ev/run-abc", write: async (p, b) => writes.push([p, b]) });
  assertEquals(writes.length, 0, "no capture -> no write");
});

// ── the finally block ────────────────────────────────────────────────────────

Deno.test("bistro caller: the finally block finalizes ONCE, announces the EXACT receipt only when it exists, and exits with the finalizer's decision (U3/U4/U5/U6/U24/U25)", async () => {
  const order = [];
  const finalize = async (input) => {
    order.push(["finalize", input]);
    return { receiptPath: "/ev/run-abc/receipt.json", exitCode: 1 };
  };
  const logs = [];
  const exits = [];
  const outcome = await settleBistroRun({
    runError: null,
    checks: [{ name: "c", passed: false }],
    teardown: { marker: "td" },
    report: { marker: "report" },
    finalize,
    log: (...a) => order.push(["log", a.join(" ")]),
    exit: (code) => order.push(["exit", code]),
  });
  assertEquals(outcome.receiptPath, "/ev/run-abc/receipt.json");
  assertEquals(order.filter((s) => s[0] === "finalize").length, 1, "the finalizer runs EXACTLY once");
  assertEquals(order.filter((s) => s[0] === "log").length, 1, "the receipt is announced EXACTLY once");
  assertEquals(order.filter((s) => s[0] === "exit").length, 1, "the exit runs EXACTLY once");
  assertEquals(order[0][0], "finalize", "the finalizer runs FIRST");
  assertEquals(order[1][0], "log", "the announcement follows the finalizer");
  assertEquals(order[2][0], "exit", "the exit follows the announcement");
  assertEquals(order[1][1], "KAT receipt: /ev/run-abc/receipt.json", "the EXACT returned receipt path is announced (U6)");
  assertEquals(order[2][1], 1, "the exit is the finalizer's DECISION — a RED run exits 1 (U3/U4)");
  const finInput = order[0][1];
  assertEquals(finInput.teardown?.marker, "td", "the teardown bundle reaches the finalizer intact (U24/U25)");
  assertEquals(finInput.report?.marker, "report", "the assembled report reaches the finalizer intact");
  assertEquals(finInput.runError, null);
  void logs; void exits;

  // GREEN path: exit 0.
  const exits0 = [];
  await settleBistroRun({
    runError: null, checks: [{ name: "c", passed: true }], teardown: {}, report: {},
    finalize: async () => ({ receiptPath: "/r.json", exitCode: 0 }),
    log: () => {}, exit: (code) => exits0.push(code),
  });
  assertEquals(exits0, [0], "a GREEN run exits 0 (U4)");

  // No receipt -> NO announcement (U5), exit still decision-derived.
  const quiet = [];
  await settleBistroRun({
    runError: "Error: crashed", checks: [], teardown: {}, report: {},
    finalize: async () => ({ receiptPath: null, exitCode: 1 }),
    log: (...a) => quiet.push(a.join(" ")), exit: (code) => quiet.push(`exit ${code}`),
  });
  assertEquals(quiet.filter((l) => l.startsWith("KAT receipt")).length, 0, "no receipt is never announced");
  assertEquals(quiet, ["exit 1"], "a run whose receipt failed still exits RED");
});
