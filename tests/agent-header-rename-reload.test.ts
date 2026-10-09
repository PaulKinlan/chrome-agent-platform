// tests/agent-header-rename-reload.test.ts
// Regression tests for chrome-agent-platform-7zf0:
// [CAP-FB-20260908-AGENT-HEADER-RELOAD-01] Triage agent-header/name mismatch after rename and reload.
//
// Verifies that:
// 1. When an open named agent is renamed and saved, openAgentSurface updates threadTitle and
//    synchronizes history.state with the new name even when the URL hash is unchanged.
// 2. On reload or deep navigation with a stale history.state name, applyCurrentHashRoute resolves
//    openAgentChat (named-agent.get) so the fresh persisted name is used for the header rather than the stale meta.name.
// 3. When openAgentSurface asynchronously receives named-agent.list, any discrepancy in threadTitle
//    is updated to the live agent name and synchronized to history.state.
// 4. revalidateOpenAgent synchronizes history.state when found.name changes.
// 5. In a real loaded extension (headless Chrome), opening an agent from the hub sets history.state.name,
//    renaming the agent via named-agent.update and reloading the page updates #thread-title and
//    history.state.name to the fresh persisted name (reproducing and fixing the 7zf0 defect).
// @ts-nocheck

import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { launchChrome, waitForServiceWorker, resolveChromiumBinaryReport, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const EXT = `${ROOT}/extension`;
// THE BROWSER COMES FROM THE UNIFIED RESOLUTION (chrome-agent-platform-dsvq, on fyvc):
// CAP_CHROMIUM -> the Chrome-for-Testing cache (bare-version dirs included) -> /usr/bin/chromium.
// Resolving ONLY the cache here (the previous behaviour) made a box whose browser lives at
// /usr/bin/chromium or behind CAP_CHROMIUM self-skip this journey: work that never ran, wearing an
// ignore. The ignore now fires only when NO browser is resolvable anywhere, and it says so with
// everything that was tried, so the tally line can never be mistaken for a pass.
const BROWSER_RESOLUTION = resolveChromiumBinaryReport();
const BROWSER_BINARY = BROWSER_RESOLUTION.binary;
if (BROWSER_BINARY === null) {
  console.warn("agent-header-rename-reload: no Chrome resolvable - tried: " + BROWSER_RESOLUTION.tried.join("; ") +
    ". Reporting the browser journey as IGNORED (a visible tally line, never a pass); set CAP_CHROMIUM or install a browser to run it.");
}

// Hub rows arrive asynchronously from named-agent.list; a fixed delay after Page.navigate
// measures CPU scheduling, not whether the picker finished rendering. Keep the real click,
// but wait for the named row and fail with the observed picker state if it never arrives.
async function clickAgentRowWhenReady(ev: (expression: string) => Promise<any>, name: string, waitMs = 15000) {
  const deadline = Date.now() + waitMs;
  let observed;
  do {
    observed = await ev(`(() => {
      const picker = document.querySelector("#named-agents agent-picker");
      const rows = [...(picker?.shadowRoot?.querySelectorAll(".opt") ?? [])];
      const names = rows.map((r) => r.querySelector(".name")?.textContent || "");
      const row = rows.find((r) => (r.querySelector(".name")?.textContent || "") === ${JSON.stringify(name)});
      if (row) row.click();
      return { clicked: !!row, pickerFound: !!picker, names };
    })()`);
    if (observed?.clicked) return;
    if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
  } while (Date.now() < deadline);
  throw new Error(`Agent row ${JSON.stringify(name)} did not render within ${waitMs}ms: ${JSON.stringify(observed)}`);
}

Deno.test("agent-picker readiness retries delayed rows and fails visibly for a missing row", async () => {
  let calls = 0;
  await clickAgentRowWhenReady(async () => {
    calls++;
    return { clicked: calls === 3, pickerFound: true, names: calls === 3 ? ["V1"] : [] };
  }, "V1", 3000);
  assertEquals(calls, 3, "a late picker row must not be mistaken for a missing agent");
  let error;
  try {
    await clickAgentRowWhenReady(async () => ({ clicked: false, pickerFound: true, names: ["Other"] }), "V1", 0);
  } catch (e) { error = e; }
  assert(error?.message?.includes('"Other"'), "a truly missing row must fail with observed picker names");
});

Deno.test("7zf0 source pin: ntp.js updates threadTitle and history.state on rename, reload, and list refresh", async () => {
  const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));

  // 1. openAgentSurface must update history.state when the name changes, even if location.hash === hash
  assert(
    /location\.hash !== hash \|\| \(name && window\.history\?\.state\?\.name !== name\)/.test(ntpJs),
    "openAgentSurface must update history.state with the new name when hash is already set",
  );

  // 2. openAgentSurface named-agent.list callback must correct EITHER surface
  //    that disagrees with the live registry row (the header or history.state —
  //    q0yg: a title that already agrees must not leave a stale name in history),
  //    and the post-history assignment must prefer the list-resolved name over
  //    the caller's (the measured stale-mention clobber).
  assert(
    /if \(a\.name && \(threadTitle\.textContent !== a\.name \|\| window\.history\?\.state\?\.name !== a\.name\)\)\s*\{\s*threadTitle\.textContent = a\.name;/.test(ntpJs),
    "openAgentSurface named-agent.list callback must correct the header or history.state when a.name differs",
  );
  assert(
    /threadTitle\.textContent = listResolvedName \|\| name \|\| "Agent";/.test(ntpJs),
    "the post-history title assignment must prefer the list-resolved name over the caller's",
  );

  // 3. applyCurrentHashRoute for named agents must call openAgentChat rather than blindly trusting stale meta.name
  assert(
    /if \(parsed\.kind === "named"\) \{\s*await openAgentChat\(parsed\.id, \{ pushHistory: false \}\);/.test(ntpJs),
    "applyCurrentHashRoute must call openAgentChat for named agents to get fresh persisted name",
  );

  // 4. revalidateOpenAgent must update navigation route state on rename
  assert(
    /if \(found\.name && threadTitle\.textContent !== found\.name\) \{\s*threadTitle\.textContent = found\.name;\s*const hash = `#agent=\$\{encodeURIComponent\(kind\)\}:\$\{encodeURIComponent\(id\)\}`;\s*navigateNtpRoute\(window, hash, \{ route: "agent", kind, id, name: found\.name \}\);/.test(ntpJs),
    "revalidateOpenAgent must keep history.state in sync when agent name changes",
  );
});

Deno.test({
  name: "7zf0: real-browser rename-then-reload updates thread header and history state",
  ignore: BROWSER_BINARY === null,
  fn: async () => {
    const profile = chromeProfileDir("agent-header-rename-reload");
    const launched = await launchChrome({
      binary: BROWSER_BINARY,
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--silent-debugger-extension-api",
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
    });

    const ws = new WebSocket(launched.wsUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    const send = (method: string, params: any = {}, sessionId?: string) =>
      new Promise<any>((res) => {
        const mid = ++id;
        pending.set(String(mid), res);
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      });
    ws.onmessage = (m: MessageEvent) => {
      const j = JSON.parse(m.data);
      if (j.id && pending.has(String(j.id))) {
        pending.get(String(j.id))(j);
        pending.delete(String(j.id));
      }
    };

    try {
      const sw = await waitForServiceWorker(send, {
        timeoutMs: 10000,
        match: (t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"),
      });
      assert(sw, "Service worker must be running");
      const extId = new URL(sw.url).host;

      const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
      const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Runtime.enable", {}, sessionId);
      await send("Page.enable", {}, sessionId);

      const ev = async (expr: string) => {
        const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
        return r.result?.result?.value;
      };

      await new Promise((r) => setTimeout(r, 1500));

      // 1. Seed named agent with initial name
      const created = await ev(`new Promise((resolve) => chrome.runtime.sendMessage({
        type: "named-agent.create",
        id: "agent-7zf0-browser",
        name: "ZZZ Original Name",
        role: "tester"
      }, resolve))`);
      assertEquals(created?.ok, true, "Named agent creation must succeed");

      // 2. Open agent from the hub (the real UI path that seeds history.state carrying the name)
      await send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html` }, sessionId);
      await new Promise((r) => setTimeout(r, 1500));

      // muc moved the hub rows into agent-picker's shadow-root .opt buttons;
      // clicking one emits the real agent-select path, not a direct route call.
      await clickAgentRowWhenReady(ev, "ZZZ Original Name");
      await new Promise((r) => setTimeout(r, 1000));

      const titleBefore = await ev("document.getElementById('thread-title')?.textContent");
      const stateBefore = await ev("window.history?.state?.name");
      assertEquals(titleBefore, "ZZZ Original Name", "Initial header must match original agent name");
      assertEquals(stateBefore, "ZZZ Original Name", "History state must capture original name");

      // 3. Rename via backend storage (simulating edit Save)
      const updated = await ev(`new Promise((resolve) => chrome.runtime.sendMessage({
        type: "named-agent.update",
        id: "agent-7zf0-browser",
        name: "ZZZ Renamed Name",
        role: "tester"
      }, resolve))`);
      assertEquals(updated?.ok, true, "Named agent update must succeed");

      // Deterministically reproduce the gate's winning async refresh: the old
      // document now carries the fresh name, whether or not revalidateOpenAgent
      // happened to finish before this CDP turn. The old assertion that it must
      // still be stale failed twice under full-gate load (xlr1i RED control).
      const stateBeforeReload = await ev(`(() => {
        window.history.replaceState({ ...window.history.state, name: "ZZZ Renamed Name" }, "", location.href);
        return window.history.state?.name;
      })()`);
      assertEquals(stateBeforeReload, "ZZZ Renamed Name", "Race control must start from the already-synced entry");

      // Restore the stale entry at the start of the NEW document, before the
      // app boots. A write followed by a separate Page.reload CDP call would
      // race the old document's async list refresh again. This one-shot script
      // only changes the reload entry; post-reload app writes remain untouched.
      const injection = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
        const state = window.history.state;
        if (state?.route !== "agent" || state?.kind !== "named" || state?.id !== "agent-7zf0-browser") return;
        window.history.replaceState({ ...state, name: "ZZZ Original Name" }, "", location.href);
        window.__xlr1iStaleAtDocumentStart = window.history.state?.name;
      })();` }, sessionId);
      assert(injection.result?.identifier, "Pre-boot stale-state injection must register before reload");

      // 4. Real reload: the persisted name is new, but the route entry is stale.
      await send("Page.reload", {}, sessionId);
      const deadline = Date.now() + 15000;
      let after;
      do {
        after = await ev(`({ stale: window.__xlr1iStaleAtDocumentStart,
          title: document.getElementById("thread-title")?.textContent,
          name: window.history?.state?.name })`);
        if (after?.stale === "ZZZ Original Name" && after?.title === "ZZZ Renamed Name" && after?.name === "ZZZ Renamed Name") break;
        if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));
      } while (Date.now() < deadline);
      assertEquals(after?.stale, "ZZZ Original Name", "Reload must start from the deliberately stale history entry");
      const titleAfter = after?.title;
      const stateAfter = after?.name;
      const controlGet = await ev(`new Promise((resolve) => chrome.runtime.sendMessage({ type: "named-agent.get", id: "agent-7zf0-browser" }, (res) => resolve(res?.agent?.name)))`);

      // Control check: storage holds the new name in both runs
      assertEquals(controlGet, "ZZZ Renamed Name", "Storage control must reflect updated name");

      // Fix assertion: header and history.state must reflect the renamed name, never the stale original name
      assertEquals(titleAfter, "ZZZ Renamed Name", "Thread header must show updated name after reload");
      assertEquals(stateAfter, "ZZZ Renamed Name", "History state must be updated to fresh name");
    } finally {
      try { ws.close(); } catch { /* closed */ }
      await teardownChrome(launched, profile);
    }
  },
});

Deno.test({
  name: "q0yg: a stale mention name cannot leave the header and history.state disagreeing after openAgentSurface",
  ignore: BROWSER_BINARY === null,
  fn: async () => {
    // The measured defect (chrome-agent-platform-q0yg, 2026-09-25): a mention
    // chip captures the agent's name at PICK time; a rename landing between
    // pick and send makes openAgentSurface navigate with a STALE caller name.
    // The named-agent.list reply (read later, therefore newer) corrected the
    // header and history — and then the post-history assignment clobbered the
    // header back to the stale caller name: settled header "V1" over
    // history.state.name "V2", 5/5 in a real loaded extension (pre-fix RED;
    // this test is the in-suite form of that measurement).
    const profile = chromeProfileDir("q0yg-stale-mention");
    const launched = await launchChrome({
      binary: BROWSER_BINARY,
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--silent-debugger-extension-api",
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
    });

    const ws = new WebSocket(launched.wsUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    const send = (method: string, params: any = {}, sessionId?: string) =>
      new Promise<any>((res) => {
        const mid = ++id;
        pending.set(String(mid), res);
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      });
    ws.onmessage = (m: MessageEvent) => {
      const j = JSON.parse(m.data);
      if (j.id && pending.has(String(j.id))) {
        pending.get(String(j.id))(j);
        pending.delete(String(j.id));
      }
    };

    try {
      const sw = await waitForServiceWorker(send, {
        timeoutMs: 10000,
        match: (t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"),
      });
      assert(sw, "Service worker must be running");
      const extId = new URL(sw.url).host;

      const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
      const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Runtime.enable", {}, sessionId);
      await send("Page.enable", {}, sessionId);

      const ev = async (expr: string) => {
        const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
        return r.result?.result?.value;
      };
      await new Promise((r) => setTimeout(r, 1500));

      // Seed the target agent, and put the internal TESTING provider (demo) in
      // front of it: the race window only manifests against real history weight
      // (an empty-history history-view beat the list reply in the measurement).
      const made = await ev(`new Promise((resolve) => chrome.runtime.sendMessage({
        type: "named-agent.create", id: "agent-q0yg-guard", name: "V1", role: "tester"
      }, resolve))`);
      assertEquals(made?.ok, true, "Named agent creation must succeed");
      // (Runs fall back to the internal demo model with no provider set — the
      // provider.* routes are sender-gated and return nothing from this page;
      // the measurement only needs real journal weight, which the fallback gives.)

      // Open TARGET's own surface via the real hub row, then run two REAL demo
      // turns so its journal has the weight a real agent has.
      await send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html` }, sessionId);
      await new Promise((r) => setTimeout(r, 1500));
      await clickAgentRowWhenReady(ev, "V1");
      await new Promise((r) => setTimeout(r, 1200));
      for (let i = 0; i < 2; i++) {
        await ev(`(() => {
          const tc = document.querySelector("#thread-composer");
          tc.dispatchEvent(new CustomEvent("send", { detail: { text: "demo run " + ${i}, attachments: [] } }));
        })()`);
        await new Promise((r) => setTimeout(r, 4000));
      }
      const entries = await ev(`new Promise((resolve) => chrome.runtime.sendMessage({ type: "named-agent.history", id: "agent-q0yg-guard" }, (res) => resolve(res?.entries?.length ?? -1)))`);
      assert(entries > 0, `the target must carry real journal history (got ${entries})`);

      // The rename lands BETWEEN mention-pick and send (the product window):
      // the chip in the send below carries "V1" while storage holds "V2" —
      // the same route the edit dialog performs.
      const renamed = await ev(`new Promise((resolve) => chrome.runtime.sendMessage({
        type: "named-agent.update", id: "agent-q0yg-guard", name: "V2", role: "tester"
      }, resolve))`);
      assertEquals(renamed?.ok, true, "Named agent update must succeed");

      // Send the stale mention from the open agent surface (the chip-navigate
      // path: openAgentSurface runs with the STALE caller name).
      await ev(`(() => {
        const tc = document.querySelector("#thread-composer");
        tc.dispatchEvent(new CustomEvent("send", { detail: { text: "stale mention check", attachments: [], agent: { ref: "named:agent-q0yg-guard", kind: "named", id: "agent-q0yg-guard", name: "V1" } } }));
      })()`);
      await new Promise((r) => setTimeout(r, 3000));

      const title = await ev(`document.getElementById("thread-title")?.textContent`);
      const stateName = await ev(`window.history?.state?.name`);
      const storageName = await ev(`new Promise((resolve) => chrome.runtime.sendMessage({ type: "named-agent.get", id: "agent-q0yg-guard" }, (res) => resolve(res?.agent?.name)))`);

      // Storage control: the rename is real.
      assertEquals(storageName, "V2", "storage must hold the renamed name");
      // The fix property: BOTH surfaces read the newer (list-resolved) name —
      // the pre-fix tree settles here with title "V1" over history "V2".
      assertEquals(title, "V2", "the header must read the newer list-resolved name, never the stale caller name");
      assertEquals(stateName, "V2", "history.state must agree with the header after the surface settles");
    } finally {
      try { ws.close(); } catch { /* closed */ }
      await teardownChrome(launched, profile);
    }
  },
});
