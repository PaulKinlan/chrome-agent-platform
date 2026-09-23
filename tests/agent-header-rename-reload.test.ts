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

  // 2. openAgentSurface named-agent.list callback must update threadTitle.textContent if a.name changed
  assert(
    /if \(a\.name && threadTitle\.textContent !== a\.name\) \{\s*threadTitle\.textContent = a\.name;/.test(ntpJs),
    "openAgentSurface named-agent.list callback must update threadTitle.textContent when a.name differs",
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

      // 4. Reload page on the agent hash route (the exact 7zf0 defect trigger where stale history.state was preserved)
      await send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html#agent=named:agent-7zf0-browser` }, sessionId);
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
