import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { allNamedChecksPass, EXPECTED_CHECKS, runForVerdict } from "../scripts/kat-jobs-panel-live.ts";
import { HARNESSES } from "../scripts/lib/harness-registry.ts";

const green = EXPECTED_CHECKS.map((name) => ({ name, verdict: "PASS" as const }));

Deno.test("focused jobs panel live KAT pins the four expected check names", () => {
  assertEquals(EXPECTED_CHECKS.length, 4);
  assertEquals(EXPECTED_CHECKS[0], "jobs panel: open jobs render with poster + recency (live, no reload)");
  assertEquals(EXPECTED_CHECKS[1], "jobs panel: the message feed renders the broadcast");
  assertEquals(EXPECTED_CHECKS[2], "jobs panel: the open-count hint reflects the board");
  assertEquals(EXPECTED_CHECKS[3], "jobs panel: the settled group renders the outcome + result excerpt (live, no reload)");
  assertEquals(HARNESSES["kat-jobs-panel-live.ts"]?.class, "kat");
  assert(allNamedChecksPass(green));
  assert(!allNamedChecksPass(green.slice(0, -1)), "a missing verdict is NOT a pass");
  assert(!allNamedChecksPass(green.map((row, i) => i === 0 ? { ...row, verdict: "NOT_REACHED" } : row)),
    "a check not reached is NOT a pass");
  assert(!allNamedChecksPass(green.map((row, i) => i === 3 ? { ...row, verdict: "FAIL" } : row)),
    "a failed check cannot pass");
});

Deno.test("focused jobs panel verdict seam exits nonzero for incomplete, failed, or thrown drives", async () => {
  const errors: unknown[] = [];
  assertEquals(await runForVerdict(async () => green), 0);
  assertEquals(await runForVerdict(async () => green.slice(0, -1)), 1);
  assertEquals(await runForVerdict(async () => green.map((row, i) => i === 0 ? { ...row, verdict: "FAIL" } : row)), 1);
  assertEquals(await runForVerdict(async () => { throw new Error("lost browser"); }, (e) => errors.push(e)), 1);
  assertEquals(errors.length, 1);
});

function assertSessionBoundMouse(source: string) {
  const dispatches = source.match(/await cdp\.send\("Input\.dispatchMouseEvent", \{ type: "mouse(?:Pressed|Released)"[^\n]+/g) ?? [];
  assert(dispatches.length === 2 && dispatches.every((line) => line.endsWith("}, session);")),
    "both real mouse events must target their exact page session, never browser-root CDP");
}

function assertRunOutsideCdpDeadline(source: string) {
  const start = source.indexOf("const started = await ntpEval(");
  const end = source.indexOf("// board.list confirms completed job id and result", start);
  assert(start >= 0 && end > start, "named run must be submitted without a long CDP evaluate");
  const run = source.slice(start, end);
  assert(run.includes("chrome.runtime.sendMessage(${JSON.stringify({ type: \"named-agent.run\""),
    "submit the real named-agent.run route from the NTP principal");
  assert(run.includes("window.__jobsPanelRunReply = { value }"),
    "capture the real route reply instead of treating submission as completion");
  assert(run.includes("runDeadline = Date.now() + 90_000") && run.includes("while (!runReply"),
    "the worker reply must be polled within its own explicit bound");
  assert(!run.includes('await ntpMsg({ type: "named-agent.run"'),
    "a long worker run must not exhaust Runtime.evaluate's per-call deadline");
}

Deno.test("named-agent.run completes outside CDP evaluate's 30-second request budget", async () => {
  const source = await Deno.readTextFile(new URL("../scripts/kat-jobs-panel-live.ts", import.meta.url));
  assertRunOutsideCdpDeadline(source);
  const synchronousMutant = source.replace("const started = await ntpEval(", "const jpRun = await ntpMsg(");
  assert(synchronousMutant !== source);
  assertThrows(() => assertRunOutsideCdpDeadline(synchronousMutant), Error, "named run must be submitted");
});

Deno.test("static audit: kat-jobs-panel-live enforces real mouse dispatch, SW_MATCH, dist binding, and fail-closed teardown", async () => {
  const source = await Deno.readTextFile(new URL("../scripts/kat-jobs-panel-live.ts", import.meta.url));
  assert(source.includes("const mouse = async (session: string, x: number, y: number) =>"));
  assertSessionBoundMouse(source);

  const browserRootMutant = source.replace('buttons: 1, clickCount: 1 }, session);', 'buttons: 1, clickCount: 1 });');
  assert(browserRootMutant !== source, "mutant must remove a live press-event session");
  assertThrows(() => assertSessionBoundMouse(browserRootMutant), Error, "both real mouse events");

  assert(source.includes("validateDistCompleteMarker"), "must validate dist complete marker");
  assert(source.includes("distMarker.commit !== sourceCommit"), "must bind exact source commit");
  assert(source.includes("resolveChromiumBinary()"), "must resolve Chromium binary");
  assert(source.includes("SW_MATCH"), "must use shared SW_MATCH");
  assert(!/(?:const|let|var)\s+SW_MATCH\s*=/.test(source), "must not re-declare private SW_MATCH");

  // Ensure real route usage and no synthetic seed bypass
  assert(!source.includes('key: "cap:board-jobs"'), "must not bypass or forge cap:board-jobs memory");
  assert(source.includes('type: "board.post"'), "must post jobs via real route");
  assert(source.includes('type: "board.message"'), "must post message via real route");
  assert(source.includes('"cap:developerFeatures": true'), "must set developer features for demo model");
  assert(source.includes('type: "named-agent.create"'), "must create named agent");
  assert(source.includes('task: "@demo-board"'), "must run @demo-board");
  assert(source.includes('type: "board.list"'), "must check board.list for completed job");

  // Ensure CDP click and settled result expansion
  assert(source.includes("mouse(ntpSession, settledBtnPoint.x, settledBtnPoint.y)"), "must click settled button via CDP mouse");
  assert(source.includes('ariaExpanded: btn?.getAttribute("aria-expanded")'), "must assert aria-expanded");
  assert(source.includes("fullText.includes(completedJob.result)"), "must assert expanded result includes completed job result");

  // Screenshots and manifest
  assert(source.includes('"jobs-panel-empty.png"'), "must capture empty screenshot");
  assert(source.includes('"jobs-panel-populated.png"'), "must capture populated screenshot");
  assert(source.includes('"jobs-panel-settled.png"'), "must capture settled screenshot");
  assert(source.includes("manifest.json"), "must write manifest.json");
  assert(source.includes("domSnapshots"), "must record live DOM snapshots in manifest");

  // Fail-closed teardown
  assert(source.includes("await teardownChrome(chrome, profile)"), "the one browser must be owner-cleaned");
  assert(source.includes("if (failure || teardownError) throw new Error"), "must fail closed on failure or teardown error");
});
