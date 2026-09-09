// @ts-nocheck — stubs browser globals; runtime behavior under test.
// tests/bgagent-delete.test.ts — background agents are DELETED, not toggled.
//
// Owner direction: the enable/disable switch was the wrong primitive for
// background agents. The row is chevron (open) + destructive Delete; the NTP
// delete path must cancel the DETERMINISTIC `recipe:<id>` scheduled task (the
// enabled state derives from the task store), never the raw recipe id.

import { assert, assertMatch, assertNotMatch, assertEquals } from "jsr:@std/assert@1";
import { resolveChromeForTesting } from "../scripts/lib/chrome-for-testing.ts";

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

Deno.test("bgagent delete: NTP row uses open-delete; delete goes through recipe.delete NON-BLOCKING with explicit success + focus restore", async () => {
  const src = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  // the unified row builder gives recipe-store agents open-delete (the ONLY
  // open-delete path), and no toggle primitive remains
  assertMatch(src, /action", a\.kind === "named" \? "open" : "open-delete"/, "recipe-store rows get open-delete in the unified list");
  assertEquals(/open-toggle/.test(src), false, "open-toggle must be fully removed");
  assertEquals(/action", "toggle"/.test(src), false, "the plain toggle action is gone from the hub");
  // the row's delete flow: confirm → recipe.delete (agent record + schedule
  // teardown in one authoritative route; NON-BLOCKING — the running task's 5s
  // termination dance must never block the UI)
  assertMatch(
    src,
    /addEventListener\("delete"[\s\S]{0,2000}?recipe\.delete", \{ id: a\.id \}/,
    "row delete must confirm then delete via the authoritative recipe.delete route",
  );
  // success is asserted EXPLICITLY (ok === true) — never "anything but false"
  assertMatch(src, /r\?\.ok === true/);
  // focus preservation: the re-render destroyed the focused Delete button, so
  // a successor must be focused (next/last row, else the Agents container)
  assertMatch(
    src,
    /renderNamedAgents\(\);[\s\S]{0,900}?focusEl\?\.focus\?\.\(\{ preventScroll: true \}\)/,
    "after re-render a focus successor must be placed",
  );
  // the header path has the SAME route + explicit success
  assertMatch(
    src,
    /else if \(kind === "background"\) \{[\s\S]{0,900}?recipe\.delete", \{ id \}/,
    "the header delete path uses recipe.delete, never the raw-id task.cancel",
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

Deno.test("bgagent delete: sidepanel routes through recipe.delete with explicit success", async () => {
  const src = await Deno.readTextFile(new URL("../extension/sidepanel/sidepanel.js", import.meta.url));
  assertMatch(
    src,
    /kind === "background"[\s\S]{0,700}?recipe\.delete", \{ id \}/,
    "the sidepanel background delete must use the authoritative recipe.delete route",
  );
  assertMatch(src, /out\?\.ok === true/, "success must be explicit (never \"anything but false\")");
  assertMatch(src, /Could not delete/, "a real failure must surface in status");
  assertEquals(/task\.cancel", \{ name: id \}/.test(src), false, "no bare-id task.cancel may remain");
});

Deno.test("bgagent delete: the service-worker exposes the non-blocking routes", async () => {
  const src = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assertMatch(src, /async "task\.cancelBackground"\(/, "task.cancelBackground must exist");
  // recipe.delete tears the schedule down NON-BLOCKING (instant-delete contract)
  assertMatch(
    src,
    /async "recipe\.delete"\([\s\S]{0,2000}?cancelScheduledTaskBackground\(`recipe:\$\{id\}`\)/,
    "recipe.delete must use the non-blocking cancel",
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
    /cancelScheduledTaskBackground\(`recipe:\$\{id\}`\);[\s\S]{0,200}?await teardown\.marked;/,
    "recipe.delete must await the durable mark before responding",
  );
  assertMatch(
    src,
    /async "recipe\.delete"\([\s\S]{0,2400}?return \{ ok: true, stopping: true \}/,
    "recipe.delete reports the non-blocking shape",
  );
});

// The real-browser journey needs Chrome for Testing, resolved at MODULE LOAD from the
// puppeteer cache glob (scripts/lib/chrome-for-testing.ts) — never an absolute,
// version-pinned path. The pin this replaced existed on exactly one machine, so on every
// other checkout the `if (!chrome) return;` below it made this gate report PASS having
// asserted nothing: AGENTS.md "Test honesty" mode 5, CONDITIONAL DEATH. Resolving during
// load rather than inside the body is what lets a box with no browser report the test as
// IGNORED — a visible line in the runner's tally — instead of a green that ran nothing.
const CHROME_FOR_TESTING = resolveChromeForTesting();

// The skip must explain itself where the reader is standing: the actionable message
// lives in the harness, and the harness is never spawned on this path. Without this line
// a fresh clone (or a box whose cache root is unreadable, which resolves null too) shows
// "1 ignored" and has to go read the source to learn why.
if (CHROME_FOR_TESTING === null) {
  console.log(
    "bgagent-delete: no Chrome for Testing resolved from $HOME/.cache/puppeteer/chrome/*/chrome-linux64/chrome — " +
    "the real-browser delete journey is IGNORED (install one: npx @puppeteer/browsers install chrome@stable)",
  );
}

// The journey's own check count (11 `check()` calls in the harness at the time of
// writing). A FLOOR, not an equality: adding checks is fine, losing them is a coverage
// regression that `out.success` cannot catch, because a harness that stopped issuing
// checks after the third one still exits 0 when nothing it did issue failed.
const JOURNEY_CHECK_FLOOR = 11;

Deno.test({
  name: "bgagent delete: the real-browser delete journey (loaded extension, real clicks)",
  ignore: CHROME_FOR_TESTING === null,
  fn: async () => {
    // Belt, not coverage: `ignore` above is computed from the same constant, so this can
    // only fail if someone deletes the `ignore` field — which is exactly the regression
    // worth a loud failure for.
    assert(
      CHROME_FOR_TESTING !== null,
      "no Chrome for Testing resolved — this journey must be reported ignored, never run against a missing browser",
    );
    // The harness resolves the same glob itself and PRINTS its pick ("NOTE: Chrome for
    // Testing: …"), so a run that passes still records which build drove it — this gate
    // changed the build on this box once already (140.0.7339.82 → 150.0.7871.24), and a
    // moved verdict nobody can attribute is AGENTS.md mode 4. Asserting the pick here is
    // also what makes the two resolutions honest: if a concurrent cache refresh makes the
    // harness resolve a different build than this module saw, the gate fails LOUDLY
    // instead of driving a browser nobody chose.
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("../scripts/kat-bgagent-delete.ts", import.meta.url).pathname],
      stdout: "piped", stderr: "piped",
    });
    const out = await cmd.output();
    const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    assert(out.success, `the delete journey must pass (Chrome for Testing: ${CHROME_FOR_TESTING}):\n${log}`);
    assert(
      log.includes(`Chrome for Testing: ${CHROME_FOR_TESTING}`),
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
      `(Chrome for Testing: ${CHROME_FOR_TESTING}):\n${log}`,
    );
  },
});
