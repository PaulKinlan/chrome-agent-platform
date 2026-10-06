// @ts-nocheck — stubs browser globals; runtime behavior under test.
// tests/bgagent-delete.test.ts — background agents are DELETED, not toggled.
//
// Owner direction: the enable/disable switch was the wrong primitive for
// background agents. The row is chevron (open) + destructive Delete; the NTP
// delete path must cancel the DETERMINISTIC `recipe:<id>` scheduled task (the
// enabled state derives from the task store), never the raw recipe id.

import { fileURLToPath } from "node:url";
import { assert, assertMatch, assertNotMatch, assertEquals } from "jsr:@std/assert@1";
import { resolveChromiumBinaryReport } from "../scripts/lib/chrome-launch.ts";

const registry = new Map();

class HTMLElementStub {
  attachShadow() { return this.shadowRoot; }
  getAttribute(n) { return this._attrs?.[n] ?? null; }
  hasAttribute(n) { return Boolean(this._attrs?.[n]); }
  setAttribute(n, v) { (this._attrs ??= {})[n] = v; }
  removeAttribute(n) { delete this._attrs?.[n]; }
  dispatchEvent() { return true; }
  addEventListener() {}
  shadowRoot = {
    _html: "",
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    listeners: {} as Record<string, Array<() => void>>,
    querySelector(sel: string) {
      // minimal: expose the delete/open buttons + switch-toggle to the wiring
      if (sel === "[part=delete]") {
        return {
          addEventListener: (_t: string, fn: () => void) => {
            (this.listeners["delete"] ??= []).push(fn);
          },
        };
      }
      if (sel === "[part=open]" || sel === ".open") {
        return {
          addEventListener: (_t: string, fn: () => void) => {
            (this.listeners["open"] ??= []).push(fn);
          },
        };
      }
      return null;
    },
    querySelectorAll() { return []; },
  };
}

globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name: string, cls: unknown) { registry.set(name, cls); },
  get(name: string) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  type: string;
  detail: Record<string, unknown>;
  constructor(type: string, init: { detail?: Record<string, unknown> } = {}) {
    this.type = type;
    this.detail = init.detail ?? {};
  }
};
globalThis.matchMedia = () => ({ matches: false });

Deno.test("bgagent delete: capability-row open-delete renders a Delete button and NO toggle", async () => {
  await import("../extension/shared/components.js");
  const CapabilityRow = registry.get("capability-row");
  assert(CapabilityRow, "capability-row must be registered");
  const row = new CapabilityRow();
  row._attrs = { name: "nightly-summarizer", description: "Runs in the background", action: "open-delete" };
  row._render();
  assertMatch(row.shadowRoot.innerHTML, /part="delete"/, "a delete button must render");
  assertMatch(row.shadowRoot.innerHTML, /Delete</, "the delete control is labelled Delete");
  assertNotMatch(row.shadowRoot.innerHTML, /switch-toggle/, "the toggle primitive is GONE");
  // the run/Plain actions are untouched
  const runRow = new CapabilityRow();
  runRow._attrs = { name: "x", action: "run" };
  runRow._render();
  assertMatch(runRow.shadowRoot.innerHTML, /part="run"/);
  assertNotMatch(runRow.shadowRoot.innerHTML, /part="delete"/, "run rows carry no delete button");
});

Deno.test("bgagent delete: the delete control is WIRED to a delete event (stopPropagation)", async () => {
  await import("../extension/shared/components.js");
  const CapabilityRow = registry.get("capability-row");
  const row = new CapabilityRow();
  const emitted: Array<{ type: string; detail: unknown }> = [];
  row._emit = (type: string, detail?: unknown) => { emitted.push({ type, detail }); };
  row._attrs = { name: "nightly", action: "open-delete" };
  row._render();
  row._wire();
  const handler = row.shadowRoot.listeners["delete"]?.[0];
  assert(handler, "the delete button must have a click listener");
  // stopPropagation must be called so the click never bubbles into row-open
  let propagated = false;
  handler({ stopPropagation: () => { propagated = true; } });
  assertEquals(propagated, true, "delete clicks must not bubble to the row open handler");
  assertEquals(emitted.map((e) => e.type), ["delete"]);
});

Deno.test("bgagent delete: NTP rows are the SHARED summary list; delete goes through background-agent.delete NON-BLOCKING with explicit success + focus restore", async () => {
  const src = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  // The hub's Named/Background rows are rendered by the shared <agent-picker>
  // summary list — with the background Delete — instead of a hand-rolled row
  // (CAP-FB-20260825-AGENT-PICKER-HUB-ROWS-01). One row component, so the hub
  // and the side panel cannot render two ideas of an agent row.
  assertMatch(
    src,
    /agentSummaryList\(\{[\s\S]{0,300}?deletable: "background"/,
    "the unified agents list gets the shared summary rows + the background Delete",
  );
  assertMatch(
    src,
    /onDelete: \(d\) => deleteBackgroundAgentFromHub\(d\?\.agent, el\)/,
    "the shared row's delete event routes to the hub's delete flow",
  );
  // …and the hub's agent panels build NO row of their own. The remaining
  // capability-rows in the hub are the discovered-pages banner and the tab
  // picker (neither is an agent summary row).
  const agentsPanel = src.slice(src.indexOf("async function renderNamedAgents"), src.indexOf("function renderSidebarAgents"));
  assert(agentsPanel.length > 500, "the agents-panel region was located");
  assertEquals(/createElement\("capability-row"\)/.test(agentsPanel), false, "no hand-rolled agent row remains in the hub's agents panel");
  const sitePanel = src.slice(src.indexOf("async function renderSiteAgents"), src.indexOf("function renderSiteOffer"));
  assert(sitePanel.length > 500, "the site-agents region was located");
  assertMatch(
    sitePanel,
    /agentSummaryList\(\{[\s\S]{0,240}?agents: agents\.slice\(0, 6\)\.map/,
    "the site agents are the shared summary rows",
  );
  // The TWO remaining hand-rolled rows in that region are TAB rows an owner can
  // enrol — the discovered-offers banner and the tab-picker dialog — never an
  // agent summary row. A third would be exactly the drift this guard exists for.
  assertEquals(
    [...sitePanel.matchAll(/createElement\("capability-row"\)/g)].length,
    2,
    "the site panel's remaining capability-rows are the two tab-enrolment rows",
  );
  assertMatch(sitePanel, /function openDiscoverPicker/, "the tab-picker row is still located in this region");
  assertEquals(/open-toggle/.test(src), false, "open-toggle must be fully removed");
  assertEquals(/action", "toggle"/.test(src), false, "the plain toggle action is gone from the hub");
  // the row's delete flow: confirm → background-agent.delete (agent record + schedule
  // teardown in one authoritative route; NON-BLOCKING — the running task's 5s
  // termination dance must never block the UI)
  assertMatch(
    src,
    /async function deleteBackgroundAgentFromHub[\s\S]{0,900}?background-agent\.delete", \{ id: a\.id \}/,
    "row delete must confirm then delete via the authoritative background-agent.delete route",
  );
  // success is asserted EXPLICITLY (ok === true) — never "anything but false"
  assertMatch(src, /r\?\.ok === true/);
  // focus preservation: the re-render destroyed the focused Delete button, so
  // a successor must be focused (next/last row, else the Agents container)
  assertMatch(
    src,
    /renderNamedAgents\(\);[\s\S]{0,900}?target\.focus\?\.\(\{ preventScroll: true \}\)/,
    "after re-render a focus successor must be placed",
  );
  // the header path has the SAME route + explicit success
  assertMatch(
    src,
    /else if \(kind === "background"\) \{[\s\S]{0,900}?background-agent\.delete", \{ id \}/,
    "the header delete path uses background-agent.delete, never the raw-id task.cancel",
  );
  assertMatch(src, /out\?\.ok === true/);
  // no stale bare/raw-id cancel remains for background agents (task.cancel is
  // still a legitimate route for the scheduled-task list — only the AGENT
  // delete paths must not use it)
  assertEquals(/task\.cancel", \{ name: id \}/.test(src), false);
  assertEquals(/task\.cancel", \{ name: `recipe:/.test(src), false);
});

Deno.test("bgagent delete: the notifications-permission enable-time request is gone with the toggle", async () => {
  const src = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  // the toggle's enable-time permissions.request was the only NTP call site
  assertEquals(
    /permissions\?\.request\?\.\(\{ permissions: \["notifications"\] \}\)/.test(src),
    false,
    "no enable-time notification permission request without the toggle",
  );
});

Deno.test("bgagent delete: sidepanel routes through background-agent.delete with explicit success", async () => {
  const src = await Deno.readTextFile(new URL("../extension/sidepanel/sidepanel.js", import.meta.url));
  assertMatch(
    src,
    /kind === "background"[\s\S]{0,700}?background-agent\.delete", \{ id \}/,
    "the sidepanel background delete must use the authoritative background-agent.delete route",
  );
  assertMatch(src, /out\?\.ok === true/, "success must be explicit (never \"anything but false\")");
  assertMatch(src, /Could not delete/, "a real failure must surface in status");
  assertEquals(/task\.cancel", \{ name: id \}/.test(src), false, "no bare-id task.cancel may remain");
});

Deno.test("bgagent delete: the service-worker exposes the non-blocking routes", async () => {
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assertMatch(src, /async "task\.cancelBackground"\(/, "task.cancelBackground must exist");
  // background-agent.delete tears the schedule down NON-BLOCKING (instant-delete contract).
  //
  // chrome-agent-platform-4h47, repaired by the merger: this used to allow 2000 CHARACTERS between
  // the handler and the call. 4h47 correctly made the owner-approval gate the FIRST thing the route
  // does (plus the comment explaining the disposition), which pushed the teardown to 2149 characters
  // and redded this pin — a proximity window is a PROXY for the property, and the property is intact:
  // the gate returns early only for a non-owner, and the approved/owner path still marks the payload
  // cancelling DURABLY before responding. Scoping the assertion to the handler's OWN BODY is both
  // faithful and STRONGER than the window: it cannot be satisfied by a call in a different route, and
  // it survives any amount of preamble. (The pin's message is unchanged, because its meaning is.)
  const handlerStart = src.indexOf('async "background-agent.delete"(');
  assert(handlerStart >= 0, "the background-agent.delete handler must exist");
  const nextHandler = src.indexOf('\n  async "', handlerStart + 1);
  const deleteHandlerBody = src.slice(handlerStart, nextHandler === -1 ? undefined : nextHandler);
  assertMatch(
    deleteHandlerBody,
    /cancelScheduledTaskBackground\(`skill:\$\{id\}`\)/,
    "background-agent.delete must use the non-blocking cancel",
  );
  // The durable-before-response contract: BOTH routes await the teardown's
  // `marked` stage (store mark + live-run abort) BEFORE responding — the SW
  // keepalive can then never lose the teardown after ok:true was reported.
  assertMatch(
    src,
    /async "task\.cancelBackground"\([\s\S]{0,1400}?await handle\.marked;[\s\S]{0,400}?return \{ ok: true, name/,
    "task.cancelBackground must await the durable mark before responding",
  );
  assertMatch(
    src,
    /cancelScheduledTaskBackground\(`skill:\$\{id\}`\);[\s\S]{0,300}?await Promise\.all\(\[teardown\.marked, legacyTeardown\.marked\]\);/,
    "background-agent.delete must await the durable mark before responding",
  );
  assertMatch(
    deleteHandlerBody,
    /return \{ ok: true, stopping: true \}/,
    "background-agent.delete reports the non-blocking shape",
  );
});

// The real-browser journey needs Chrome for Testing, resolved at MODULE LOAD from the
// puppeteer cache glob (scripts/lib/chrome-for-testing.ts) — never an absolute,
// version-pinned path. The pin this replaced existed on exactly one machine, so on every
// other checkout the `if (!chrome) return;` below it made this gate report PASS having
// asserted nothing: AGENTS.md "Test honesty" mode 5, CONDITIONAL DEATH. Resolving during
// load rather than inside the body is what lets a box with no browser report the test as
// IGNORED — a visible line in the runner's tally — instead of a green that ran nothing.
// THE BROWSER COMES FROM THE UNIFIED RESOLUTION (chrome-agent-platform-dsvq, on fyvc):
// CAP_CHROMIUM -> the Chrome-for-Testing cache (bare-version dirs included) -> /usr/bin/chromium.
// Resolving ONLY the cache here (the previous behaviour) made a box whose browser lives at
// /usr/bin/chromium or behind CAP_CHROMIUM self-skip this journey: work that never ran, wearing an
// ignore. The ignore now fires only when NO browser is resolvable anywhere, and it says so with
// everything that was tried, so the tally line can never be mistaken for a pass.
const BROWSER_RESOLUTION = resolveChromiumBinaryReport();
const BROWSER_BINARY = BROWSER_RESOLUTION.binary;
if (BROWSER_BINARY === null) {
  console.warn("bgagent-delete: no Chrome resolvable - tried: " + BROWSER_RESOLUTION.tried.join("; ") +
    ". Reporting the browser journey as IGNORED (a visible tally line, never a pass); set CAP_CHROMIUM or install a browser to run it.");
}

// The skip must explain itself where the reader is standing: the actionable message
// lives in the harness, and the harness is never spawned on this path. Without the
// warning above a fresh clone shows "1 ignored" and has to read the source to learn why.

// The journey's own check count (15 `check()` calls in the harness at the time of
// writing). A FLOOR, not an equality: adding checks is fine, losing them is a coverage
// regression that `out.success` cannot catch, because a harness that stopped issuing
// checks after the third one still exits 0 when nothing it did issue failed.
const JOURNEY_CHECK_FLOOR = 15;

// The harness path, resolved once so every spawn here drives the SAME file.
const HARNESS = fileURLToPath(new URL("../scripts/kat-bgagent-delete.ts", import.meta.url));

// Clear any ambient fault-injection knobs so a test can never be flipped by
// another lane's environment, then apply this test's own.
function harnessEnv(extra: Record<string, string>): Record<string, string> {
  const env = Deno.env.toObject();
  for (const k of [
    "CAP_BGAGENT_DELETE_FAIL_AFTER_LAUNCH",
    "CAP_BGAGENT_DELETE_HANG_AFTER_LAUNCH",
    "CAP_BGAGENT_DELETE_HARD_TIMEOUT_MS",
  ]) {
    delete env[k];
  }
  return { ...env, ...extra };
}

// Spawn the harness with a HARD deadline: the child is killed and the test
// fails loudly if it overruns, so a hang can never leave an unbounded await
// (and the live browser that used to ride along with it). P1 fix 4.
async function runHarness(env: Record<string, string>, timeoutMs: number): Promise<{ code: number; log: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", HARNESS],
    stdout: "piped", stderr: "piped",
    env: harnessEnv(env),
  });
  const proc = cmd.spawn();
  let overran = false;
  const timer = setTimeout(() => {
    overran = true;
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }, timeoutMs);
  const out = await proc.output();
  clearTimeout(timer);
  const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assert(
    !overran,
    `the harness must finish within ${timeoutMs}ms (it was killed — a hang left a live browser?):\n${log}`,
  );
  return { code: out.code, log };
}

// True when any process whose argv carries the harness's profile still lives.
// The profile is per-instance and recorded on a `NOTE: Chrome profile:` line,
// so this can only ever match THIS run's browser.
export function survivingChrome(
  profile: string,
  pgRunner: (args: string[]) => { code: number } = (args) =>
    new Deno.Command("/usr/bin/pgrep", { args }).outputSync(),
): boolean {
  const pg = pgRunner(["-f", `user-data-dir=${profile}`]);
  return pg.code !== 1; // 0 = match, 1 = none, else pgrep error (treated as surviving, fail-closed)
}

Deno.test("bgagent delete: survivingChrome treats pgrep exit 0 as surviving, exit 1 as dead, and exit 2/error as surviving (N1)", () => {
  assertEquals(survivingChrome("test-profile", () => ({ code: 0 })), true, "match (exit 0) must report surviving");
  assertEquals(survivingChrome("test-profile", () => ({ code: 1 })), false, "no match (exit 1) must report not surviving");
  assertEquals(survivingChrome("test-profile", () => ({ code: 2 })), true, "pgrep error (exit 2) must fail closed as surviving");
  assertEquals(survivingChrome("test-profile", () => ({ code: 127 })), true, "pgrep error (exit 127) must fail closed as surviving");
});

// Parser matching kat-bgagent-delete's parseHardTimeout to allow pure unit validation
export function parseHardTimeout(raw?: string | null): number {
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
}

Deno.test("bgagent delete: parseHardTimeout input validation (N3)", () => {
  assertEquals(parseHardTimeout(undefined), 300_000, "unset defaults to 300_000");
  assertEquals(parseHardTimeout(null), 300_000, "null defaults to 300_000");
  assertEquals(parseHardTimeout(""), 300_000, "empty string defaults to 300_000 (>0 guard)");
  assertEquals(parseHardTimeout("   "), 300_000, "whitespace defaults to 300_000 (>0 guard)");
  assertEquals(parseHardTimeout("garbage"), 300_000, "NaN string defaults to 300_000 (isFinite guard)");
  assertEquals(parseHardTimeout("-5"), 300_000, "negative defaults to 300_000 (>0 guard)");
  assertEquals(parseHardTimeout("0"), 300_000, "zero defaults to 300_000 (>0 guard)");
  assertEquals(parseHardTimeout("1e999"), 300_000, "Infinity defaults to 300_000 (isFinite guard)");
  assertEquals(parseHardTimeout("3000"), 3000, "valid positive integer parses correctly");
  assertEquals(parseHardTimeout("50000"), 50_000, "valid positive integer parses correctly");
});

/**
 * Asserts the journey log proves teardownChrome ran to completion and that no
 * Chrome process matching the logged user-data-dir survived.
 */
export function verifyJourneyTeardown(
  log: string,
  isChromeSurviving: (profile: string) => boolean = survivingChrome,
): { hasTeardownMarker: boolean; profile: string | null; survives: boolean } {
  const hasTeardownMarker = log.includes("NOTE: teardownChrome complete");
  const m = /NOTE: Chrome profile: (.+)$/m.exec(log);
  const profile = m ? m[1] : null;
  const survives = profile ? isChromeSurviving(profile) : true;
  return { hasTeardownMarker, profile, survives };
}

Deno.test({
  name: "bgagent delete: the real-browser delete journey (loaded extension, real clicks)",
  ignore: BROWSER_BINARY === null,
  fn: async () => {
    // Belt, not coverage: `ignore` above is computed from the same constant, so this can
    // only fail if someone deletes the `ignore` field — which is exactly the regression
    // worth a loud failure for.
    assert(
      BROWSER_BINARY !== null,
      "no browser resolvable — this journey must be reported ignored, never run against a missing browser",
    );
    // The harness resolves the same glob itself and PRINTS its pick ("NOTE: Chrome for
    // Testing: …"), so a run that passes still records which build drove it — this gate
    // changed the build on this box once already (140.0.7339.82 → 150.0.7871.24), and a
    // moved verdict nobody can attribute is AGENTS.md mode 4. Asserting the pick here is
    // also what makes the two resolutions honest: if a concurrent cache refresh makes the
    // harness resolve a different build than this module saw, the gate fails LOUDLY
    // instead of driving a browser nobody chose.
    const { code, log } = await runHarness({}, 320_000);
    assert(code === 0, `the delete journey must pass (Chrome for Testing: ${BROWSER_BINARY}):\n${log}`);
    assert(
      log.includes(`Chrome for Testing: ${BROWSER_BINARY}`),
      `the journey must record which Chrome for Testing build it drove:\n${log}`,
    );
    assert(/FAIL:/.test(log) === false, `no journey check may fail:\n${log}`);
    // The tally is the proof the journey RAN. A browser that never loaded the extension
    // fails above, but a harness that quietly stopped checking would otherwise still
    // print "0 failed" and exit 0 — a skip that looks like a pass. Anchored to a whole
    // line (`^…$`) so a `PASS:` detail that happens to contain the phrase can never be
    // read as the tally.
    const tally = /^\s*(\d+) passed, (\d+) failed\s*$/m.exec(log);
    assert(tally !== null, `the journey must print its tally:\n${log}`);
    assertEquals(Number(tally[2]), 0, `the journey reported failures:\n${log}`);
    assert(
      Number(tally[1]) >= JOURNEY_CHECK_FLOOR,
      `the journey ran ${tally[1]} checks, below the ${JOURNEY_CHECK_FLOOR} it owns — a check went missing ` +
      `(Chrome for Testing: ${BROWSER_BINARY}):\n${log}`,
    );

    // N2: The success path must execute teardownChrome in finally and leave zero surviving processes.
    const teardownStatus = verifyJourneyTeardown(log);
    assert(
      teardownStatus.hasTeardownMarker,
      `the journey must execute teardownChrome on success:\n${log}`,
    );
    assert(
      teardownStatus.profile !== null,
      `the harness must record its profile so the test can verify no survivor:\n${log}`,
    );
    assert(
      !teardownStatus.survives,
      `no Chrome process may survive the success path (${teardownStatus.profile}):\n${log}`,
    );
  },
});

Deno.test("bgagent delete: verifyJourneyTeardown paired discrimination (N2 falsification)", () => {
  // Scenario A: Successful log with teardown marker and dead browser
  const cleanLog = "NOTE: Chrome profile: test-clean\nNOTE: teardownChrome complete\n15 passed, 0 failed";
  const cleanStatus = verifyJourneyTeardown(cleanLog, () => false);
  assertEquals(cleanStatus.hasTeardownMarker, true, "marker must be detected on teardown log");
  assertEquals(cleanStatus.profile, "test-clean", "profile must be extracted");
  assertEquals(cleanStatus.survives, false, "no survivor reported when browser reaped");

  // Scenario B: Mutant omitting finally teardown (lacks marker)
  const mutantNoTeardown = "NOTE: Chrome profile: test-mutant\n15 passed, 0 failed";
  const noTeardownStatus = verifyJourneyTeardown(mutantNoTeardown, () => false);
  assertEquals(noTeardownStatus.hasTeardownMarker, false, "omitted teardown must fail marker check");

  // Scenario C: Surviving browser (reaping failed)
  const leakingStatus = verifyJourneyTeardown(cleanLog, () => true);
  assertEquals(leakingStatus.survives, true, "surviving browser must be flagged");

  // Scenario D: Missing profile line
  const noProfileStatus = verifyJourneyTeardown("NOTE: teardownChrome complete", () => false);
  assertEquals(noProfileStatus.profile, null, "missing profile must be flagged");
});

Deno.test({
  name: "bgagent delete: a mid-journey throw still tears the whole Chrome tree down (P1 falsification)",
  ignore: BROWSER_BINARY === null,
  fn: async () => {
    const { code, log } = await runHarness({ CAP_BGAGENT_DELETE_FAIL_AFTER_LAUNCH: "1" }, 120_000);
    assert(code !== 0, `a mid-journey throw must exit nonzero:\n${log}`);
    assert(log.includes("injected mid-journey throw"), `the injected throw must be the abort cause:\n${log}`);
    // The honest proof teardown RAN. Chrome child processes do NOT reliably
    // self-reap on parent death on this VM (field measurements confirmed the process tree
    // survives exits 0, 1, and 2), so teardownChrome is mandatory and this log line is
    // the required proof.
    assert(log.includes("NOTE: tearing down the Chrome tree (teardownChrome)"), `teardown must actually run on the throw path:\n${log}`);
    const m = /NOTE: Chrome profile: (.+)$/m.exec(log);
    assert(m, `the harness must record its profile so the test can verify no survivor:\n${log}`);
    assert(!survivingChrome(m[1]), `no Chrome process may survive the throw path (${m[1]}):\n${log}`);
  },
});

Deno.test({
  name: "bgagent delete: the hard timer tears the tree down when the journey hangs (P1 falsification)",
  ignore: BROWSER_BINARY === null,
  fn: async () => {
    const { code, log } = await runHarness(
      { CAP_BGAGENT_DELETE_HANG_AFTER_LAUNCH: "1", CAP_BGAGENT_DELETE_HARD_TIMEOUT_MS: "3000" },
      60_000,
    );
    assert(code === 2, `the hard timer must fire and exit 2:\n${log}`);
    assert(log.includes("hard timeout"), `the hard timeout must be the abort cause:\n${log}`);
    assert(log.includes("NOTE: tearing down the Chrome tree (teardownChrome)"), `teardown must actually run on the hang path:\n${log}`);
    const m = /NOTE: Chrome profile: (.+)$/m.exec(log);
    assert(m, `the harness must record its profile:\n${log}`);
    assert(!survivingChrome(m[1]), `no Chrome process may survive the hang path (${m[1]}):\n${log}`);
  },
});

Deno.test({
  name: "bgagent delete: garbage or empty hard timeout defaults safely without premature exit 2 (N3)",
  ignore: BROWSER_BINARY === null,
  fn: async () => {
    // When CAP_BGAGENT_DELETE_HARD_TIMEOUT_MS is garbage or empty, it must NOT parse as
    // NaN or 0 and fire immediately with exit 2. Combined with FAIL_AFTER_LAUNCH, both
    // inputs must proceed to the injected throw and exit 1 (not 2).
    for (const badValue of ["garbage", ""]) {
      const { code, log } = await runHarness(
        { CAP_BGAGENT_DELETE_FAIL_AFTER_LAUNCH: "1", CAP_BGAGENT_DELETE_HARD_TIMEOUT_MS: badValue },
        120_000,
      );
      assert(code === 1, `timeout value ${JSON.stringify(badValue)} must not exit 2 via premature timer fire:\n${log}`);
      assert(log.includes("injected mid-journey throw"), `must reach injected throw with ${JSON.stringify(badValue)}:\n${log}`);
      assert(!log.includes("hard timeout"), `must not trigger hard timeout with ${JSON.stringify(badValue)}:\n${log}`);
    }
  },
});
