// tests/journey-scripted-probe.test.ts — chrome-agent-platform-9t1p
//
// THREE OUTCOMES, NOT TWO: it happened and passed, it happened and did not
// pass, or IT DID NOT HAPPEN. `runScriptedToolProbe`'s wait loop used to exit
// SILENTLY on timeout and hand the caller a partial result — the third case
// wearing the costume of the first two. The caller's check then failed on a
// confusing payload and the real failure (a run that never settled because the
// service worker never answered) surfaced one step later as a generic
// `cdp timeout: Runtime.evaluate`, which the harness blamed on machine load.
//
// This EXECUTES the real function, source-extracted and compiled with
// new Function() — the house pattern from tests/journey-cdp-timeout.test.ts.
// Importing chrome-journeys.ts would launch browsers; a substring pin on the
// new throw would pass with the throw deleted, which is the failure mode the
// repo's own test-honesty canon is about.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isCdpEvaluateTimeout } from "../scripts/lib/quiet-window.ts";
import { composerInput, composerSend } from "../scripts/lib/composer-target.ts";

const source = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));
const start = source.indexOf("async function runScriptedToolProbe(");
const end = source.indexOf("\n/** Capture a PNG screenshot", start);
assert(start >= 0 && end > start, "the real runScriptedToolProbe must be found");
const fnSource = source.slice(start, end);

/** Every module-scope collaborator runScriptedToolProbe may reference, in
 *  injection order (chrome-agent-platform-0jrk).
 *
 *  The probe is COMPILED, not imported (importing chrome-journeys.ts launches
 *  browsers), so its collaborators travel by NAME through new Function(). That
 *  list is a seam: chrome-agent-platform-ady6 migrated the probe's source to
 *  composerInput()/composerSend() and the seam did not follow, so all five tests
 *  in this file died at eval time with "composerInput is not defined" — the eval
 *  named the seam rather than the migration. The guard test below derives the
 *  helpers the source actually calls and fails FIRST, naming the missing
 *  collaborator, so the next migration cannot land as a mystery ReferenceError
 *  from inside a compiled function. */
const PROBE_COLLABORATORS = [
  "startScriptedProvider",
  "evalIn",
  "listRunIds",
  "clickSel",
  "typeInto",
  "sleep",
  "composerInput",
  "composerSend",
  "awaitNewRunTerminal",
  "isCdpEvaluateTimeout",
  "SCRIPTED_DUMMY_KEY",
  "activateNtpSession",
  "Date",
] as const;

type ProbeCollaborator = (typeof PROBE_COLLABORATORS)[number];

interface Harness {
  requests: number[];
  /** What awaitNewRunTerminal does when the probe asks for a diagnosis. */
  terminal: (timeoutMs?: number) => Promise<unknown>;
  terminalCalls: Array<number | undefined>;
  elapsed: () => number;
}

/** Compile the real function with every collaborator injected — including
 *  `Date`, so the 120 s wait is exercised on a FAKE clock (an instant `sleep`
 *  against a real clock would spin for two real minutes). */
function build(opts: {
  requestsOverTime: number[][];
  terminal: (timeoutMs?: number) => Promise<unknown>;
}): { probe: (expect: number) => Promise<unknown>; harness: Harness } {
  let now = 1_000_000;
  let tick = 0;
  const requests: number[] = [];
  const terminalCalls: Array<number | undefined> = [];
  const provider = {
    requests,
    baseURL: "http://127.0.0.1:0",
    close: () => Promise.resolve(),
  };
  const fakeDate = { now: () => now };
  const sleep = (ms: number) => {
    now += ms; // the fake clock only moves when the function waits
    const next = opts.requestsOverTime[Math.min(tick++, opts.requestsOverTime.length - 1)];
    requests.length = 0;
    requests.push(...next);
    return Promise.resolve();
  };
  // The values are keyed by the ONE name list (PROBE_COLLABORATORS, in the same
  // order), so names and injection order can never disagree with each other.
  const collaborators: Record<ProbeCollaborator, unknown> = {
    startScriptedProvider: () => Promise.resolve(provider),
    evalIn: () => Promise.resolve(undefined),
    listRunIds: () => Promise.resolve(new Set()),
    clickSel: () => Promise.resolve(true),
    typeInto: () => Promise.resolve(true),
    sleep,
    composerInput,
    composerSend,
    awaitNewRunTerminal: (_cdp: unknown, _s: unknown, _b: unknown, _t: unknown, timeoutMs?: number) => {
      terminalCalls.push(timeoutMs);
      return opts.terminal(timeoutMs);
    },
    isCdpEvaluateTimeout,
    SCRIPTED_DUMMY_KEY: "dummy-key",
    activateNtpSession: () => Promise.resolve(),
    Date: fakeDate,
  };
  const compiled = new Function(
    ...PROBE_COLLABORATORS,
    `${fnSource}\nreturn runScriptedToolProbe;`,
  )(...PROBE_COLLABORATORS.map((name) => collaborators[name]));
  return {
    probe: (expect: number) => compiled({}, {}, {}, [], "check which cookie tools exist", expect),
    harness: { requests, terminal: opts.terminal, terminalCalls, elapsed: () => now - 1_000_000 },
  };
}

Deno.test("0jrk: the eval seam injects every harness helper the probe calls", () => {
  // The probe's collaborators travel by NAME (see PROBE_COLLABORATORS). This is
  // the guard for the seam itself: derive what the source CALLS and fail when one
  // of those names is not injected, so a migration like ady6's reds here — naming
  // the missing helper — rather than inside a compiled function as
  // "composerInput is not defined".
  // Scan the probe's CODE, not its prose: the call pattern also matches words
  // inside string/template literals (it found "unreadable(" inside a template on
  // the first run). Interpolations go with their literal, so a helper called ONLY
  // inside one is not covered HERE — the eval still reds for that; the plain call
  // sites are the migration surface this guard is for.
  const code = fnSource.replace(/`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
  const called = new Set(
    [...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]),
  );
  // The probe also READS this constant without calling it.
  if (/\bSCRIPTED_DUMMY_KEY\b/.test(code)) called.add("SCRIPTED_DUMMY_KEY");

  // Names that legitimately are NOT injected: JS built-ins, the keywords the
  // call pattern also matches, and the probe's own function name, parameters and
  // locals. Everything else the source calls must be injected.
  const NOT_INJECTED = new Set([
    "String", "Number", "Boolean", "Object", "Array", "JSON", "Math", "Error", "Promise", "Set", "Map",
    "if", "while", "for", "catch", "switch", "return", "typeof", "function", "await", "new", "do",
    "runScriptedToolProbe", "cdp", "ntpSession", "optsSession", "steps", "task", "expectRequests",
    "onPause", "provider", "beforeIds", "phase", "message", "record", "run", "t0",
  ]);
  const injected = new Set<string>(PROBE_COLLABORATORS);
  const missing = [...called].filter((name) => !injected.has(name) && !NOT_INJECTED.has(name)).sort();
  assertEquals(
    missing,
    [],
    "runScriptedToolProbe calls harness helpers that PROBE_COLLABORATORS does not inject — add them " +
      "to the list (and their values in build()); the compiled probe cannot see module scope",
  );
});

Deno.test("9t1p: the probe returns normally when the provider receives every expected request", async () => {
  const { probe, harness } = build({
    requestsOverTime: [[1], [1, 2], [1, 2, 3]],
    terminal: () => Promise.resolve({ phase: "terminal", terminal: { ok: true } }),
  });
  const result = await probe(3) as { provider: { requests: number[] }; run: { phase: string } };
  assertEquals(result.run.phase, "terminal");
  assertEquals(result.provider.requests.length, 3);
  // The happy path must NOT spend the diagnosis budget: exactly one terminal
  // wait, with the caller's default timeout rather than the 3 s probe.
  assertEquals(harness.terminalCalls, [undefined], "no diagnostic read on the happy path");
});

Deno.test("9t1p: a SHORTFALL fails where it happens, naming the count and the run's phase", async () => {
  // The provider never reaches 5; the run is readable and still mid-flight.
  const { probe, harness } = build({
    requestsOverTime: [[1, 2, 3]],
    terminal: () => Promise.resolve({ phase: "running" }),
  });
  const error = await assertRejects(() => probe(5), Error);
  assert(/received 3 of 5 requests/.test(error.message), error.message);
  assert(/phase running/.test(error.message), error.message);
  assert(/check which cookie tools exist/.test(error.message), `it names the probe: ${error.message}`);
  assert(/after 120s/.test(error.message), `it reports how long it waited: ${error.message}`);
  // It waited its full budget and then diagnosed with a BOUNDED read — an
  // unbounded one would hang the suite exactly where it is already stuck.
  assert(harness.elapsed() >= 120000, `the loop ran its budget (${harness.elapsed()} ms)`);
  assertEquals(harness.terminalCalls, [3000], "the diagnosis read is bounded at 3 s");
});

Deno.test("9t1p: an UNANSWERED round trip is named as itself, never as fleet load", async () => {
  // The exact filing signature: the provider is short AND the diagnostic read
  // times out, because the service worker is answering nothing at all.
  const { probe } = build({
    requestsOverTime: [[1]],
    terminal: () =>
      Promise.reject(
        new Error("cdp timeout: Runtime.evaluate (requestId=812, targetId=unavailable, sessionId=ABC)"),
      ),
  });
  const error = await assertRejects(() => probe(5), Error);
  assert(/received 1 of 5 requests/.test(error.message), error.message);
  assert(/service worker did not answer run\.list/.test(error.message), error.message);
  assert(/NOT fleet load/.test(error.message), `it must refuse the load story: ${error.message}`);
  // And the failure must NOT be the generic CDP timeout any more — that string
  // is what sent every lane to the environmental verdict.
  assertEquals(isCdpEvaluateTimeout(error.message), false, `still a raw CDP timeout: ${error.message}`);
});

Deno.test("9t1p: a non-timeout diagnosis failure is reported verbatim, not translated", async () => {
  const { probe } = build({
    requestsOverTime: [[1]],
    terminal: () => Promise.reject(new Error("run.list returned malformed rows")),
  });
  const error = await assertRejects(() => probe(4), Error);
  assert(/unreadable \(run\.list returned malformed rows\)/.test(error.message), error.message);
  assert(!/NOT fleet load/.test(error.message), "only the known cause claims the known cause");
});

Deno.test("9t1p: a missing durable record is distinguished from an unreadable one", async () => {
  const { probe } = build({
    requestsOverTime: [[1, 2]],
    terminal: () => Promise.resolve(null),
  });
  const error = await assertRejects(() => probe(3), Error);
  assert(/no durable run record/.test(error.message), error.message);
});
