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
import { launchChrome, waitForServiceWorker } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { resolveChromeForTesting } from "../scripts/lib/chrome-for-testing.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const EXT = `${ROOT}/extension`;
const CHROME_FOR_TESTING = resolveChromeForTesting();

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
  ignore: CHROME_FOR_TESTING === null,
  fn: async () => {
    const profile = chromeProfileDir("agent-header-rename-reload");
    const launched = await launchChrome({
      binary: CHROME_FOR_TESTING,
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

      const opened = await ev(`(() => {
        // muc moved the hub's agent rows into the shared agent-picker summary list
        // (CAP-FB-20260825-AGENT-PICKER-HUB-ROWS-01): the row is the .opt button in
        // that component's shadow root and a real click emits agent-select, which is
        // the path the other five drivers were moved to. This test landed while muc
        // was in flight and was missed, leaving main red with "Agent row must be
        // found and opened". (No backticks in this template literal.)
        const picker = document.querySelector("#named-agents agent-picker");
        const rows = [...(picker?.shadowRoot?.querySelectorAll(".opt") ?? [])];
        const row = rows.find((r) => (r.querySelector(".name")?.textContent || "") === "ZZZ Original Name");
        if (!row) return false;
        row.click();
        return true;
      })()`);
      assertEquals(opened, true, "Agent row must be found and opened");
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

      // Assert stale-name state remains the reload precondition
      const stateBeforeReload = await ev("window.history?.state?.name");
      assertEquals(stateBeforeReload, "ZZZ Original Name", "Stale name must remain in history.state prior to reload");

      // 4. Real reload of the page (preserving session history with the stale history.state precondition)
      await send("Page.reload", {}, sessionId);
      await new Promise((r) => setTimeout(r, 2000));

      const titleAfter = await ev("document.getElementById('thread-title')?.textContent");
      const stateAfter = await ev("window.history?.state?.name");
      const controlGet = await ev(`new Promise((resolve) => chrome.runtime.sendMessage({ type: "named-agent.get", id: "agent-7zf0-browser" }, (res) => resolve(res?.agent?.name)))`);

      // Control check: storage holds the new name in both runs
      assertEquals(controlGet, "ZZZ Renamed Name", "Storage control must reflect updated name");

      // Fix assertion: header and history.state must reflect the renamed name, never the stale original name
      assertEquals(titleAfter, "ZZZ Renamed Name", "Thread header must show updated name after reload");
      assertEquals(stateAfter, "ZZZ Renamed Name", "History state must be updated to fresh name");
    } finally {
      ws.close();
      try { launched.proc.kill("SIGKILL"); } catch { /* gone */ }
      try { await launched.proc.status; } catch { /* reaped */ }
    }
  },
});

Deno.test({
  name: "q0yg: a stale mention name cannot leave the header and history.state disagreeing after openAgentSurface",
  ignore: CHROME_FOR_TESTING === null,
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
      binary: CHROME_FOR_TESTING,
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
      const opened = await ev(`(() => {
        const picker = document.querySelector("#named-agents agent-picker");
        const rows = [...(picker?.shadowRoot?.querySelectorAll(".opt") ?? [])];
        const row = rows.find((r) => (r.querySelector(".name")?.textContent || "") === "V1");
        if (!row) return false;
        row.click();
        return true;
      })()`);
      assertEquals(opened, true, "Agent row must be found and opened");
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
      ws.close();
      try { launched.proc.kill("SIGKILL"); } catch { /* gone */ }
      try { await launched.proc.status; } catch { /* reaped */ }
    }
  },
});
