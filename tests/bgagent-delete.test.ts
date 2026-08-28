// @ts-nocheck — stubs browser globals; runtime behavior under test.
// tests/bgagent-delete.test.ts — background agents are DELETED, not toggled.
//
// Owner direction: the enable/disable switch was the wrong primitive for
// background agents. The row is chevron (open) + destructive Delete; the NTP
// delete path must cancel the DETERMINISTIC `recipe:<id>` scheduled task (the
// enabled state derives from the task store), never the raw recipe id.

import { assert, assertMatch, assertNotMatch, assertEquals } from "jsr:@std/assert@1";

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
  // the background row is the ONLY open-delete user, and no toggle primitive remains
  assertMatch(src, /action", "open-delete"/);
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

Deno.test("bgagent delete: the real-browser delete journey (loaded extension, real clicks)", async () => {
  // Skips cleanly where Chrome for Testing is absent (hermetic CI); runs for
  // real in this environment (the dispatch gate builds dist first).
  const CHROME = "/home/paulkinlan/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome";
  let chrome = false;
  try { await Deno.stat(CHROME); chrome = true; } catch { /* absent */ }
  if (!chrome) return;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("../scripts/kat-bgagent-delete.ts", import.meta.url).pathname],
    stdout: "piped", stderr: "piped",
  });
  const out = await cmd.output();
  const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assert(out.success, `the delete journey must pass:\n${log}`);
  assert(/FAIL:/.test(log) === false, `no journey check may fail:\n${log}`);
});
