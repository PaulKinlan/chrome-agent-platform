// Loaded-extension proof for Enclave Quota Settings UI (chrome-agent-platform-jao1.6.1).
// Drives the real Settings panel (#web-services) in headless Chrome:
// 1. Reads initial displayed per-service usage
// 2. Sets a custom limit and observes the displayed usage change
// 3. Clears the custom limit and observes default limit return
// Captures before and after screenshots as evidence.
//
// deno run -A scripts/kat-quota-ui.ts <extension> <out>

import { wireValue } from "./lib/cdp-eval.ts";
import { fileURLToPath } from "node:url";
import { launchChrome, waitForServiceWorker, teardownChrome } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = Deno.args[0] ?? `${ROOT}/extension`;
const OUT = Deno.args[1] ?? `${ROOT}/.cache/kat-quota-ui`;
const CHROMIUM = "/usr/bin/chromium";
await Deno.mkdir(OUT, { recursive: true });

let pass = 0, fail = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

const profile = chromeProfileDir("kat-quota-ui");
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", `--user-data-dir=${profile}`, "about:blank",
  ],
});
const ws = new WebSocket(wsUrl);
try {
  await new Promise((resolve) => { ws.onopen = () => resolve(null); });
  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data as string);
    if (!pending.has(message.id)) return;
    pending.get(message.id)!(message);
    pending.delete(message.id);
  };

  const worker = await waitForServiceWorker(send, { timeoutMs: 20000 });
  check("the loaded extension registered its service worker", Boolean(worker), worker);
  if (!worker) {
    await teardownChrome(proc, profile);
    Deno.exit(1);
  }
  const extensionId = new URL(worker.url).host;
  const target = await send("Target.createTarget", { url: `chrome-extension://${extensionId}/options/options.html#web-services` });
  const attached = await send("Target.attachToTarget", { targetId: target.result.targetId, flatten: true });
  const sessionId = attached.result.sessionId;
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

  // Wait for web-services panel and quotas table to render
  const deadline = Date.now() + 20000;
  let readyState: any = null;
  while (Date.now() < deadline) {
    const result = await send("Runtime.evaluate", {
      expression: `(() => {
        const quotasSection = document.getElementById("vault-quotas-section");
        const rows = document.querySelectorAll("#vault-quotas .vault-quota-row");
        return {
          ready: document.readyState === "complete" && rows.length > 0,
          hasSection: Boolean(quotasSection),
          rowCount: rows.length,
        };
      })()`,
      returnByValue: true,
    }, sessionId);
    readyState = wireValue<any>(result, "k.quota-ui");
    if (readyState?.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check("Web services panel & quotas table rendered", readyState?.ready === true, readyState);

  // Scroll quotas section into view
  await send("Runtime.evaluate", {
    expression: `(() => {
      const section = document.getElementById("vault-quotas-section");
      if (section) section.scrollIntoView({ block: "start" });
    })()`,
  }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 400));

  // 1. Read initial displayed per-service usage
  const initialResult = await send("Runtime.evaluate", {
    expression: `(() => {
      const rows = [...document.querySelectorAll("#vault-quotas .vault-quota-row")];
      return rows.map((r) => ({
        service: r.dataset.service,
        count: r.dataset.count,
        limit: r.dataset.limit,
        remaining: r.dataset.remaining,
        windowMs: r.dataset.windowMs,
        disabled: r.dataset.disabled,
        unmetered: r.dataset.unmetered,
        statusText: r.querySelector(".vault-status-pill")?.textContent?.trim(),
        limitText: r.querySelector(".vault-quota-limit")?.textContent?.trim(),
        remainingText: r.querySelector(".vault-quota-remaining")?.textContent?.trim(),
        windowText: r.querySelector(".vault-quota-window")?.textContent?.trim(),
      }));
    })()`,
    returnByValue: true,
  }, sessionId);
  const initialRows = wireValue<any[]>(initialResult, "k.quota-ui");
  console.log("INITIAL USAGE:", JSON.stringify(initialRows, null, 2));

  const initialBrave = initialRows?.find((r: any) => r.service === "brave-search");
  check("brave-search has default initial limit 50", initialBrave?.limit === "50", initialBrave);
  check("brave-search has initial status Active", initialBrave?.statusText === "Active", initialBrave);

  // Capture screenshot: 01-initial-quotas.png
  const shot1 = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  const shot1Path = `${OUT}/01-initial-quotas.png`;
  await Deno.writeFile(shot1Path, Uint8Array.from(atob(shot1.result.data), (c) => c.charCodeAt(0)));
  console.log(`Saved screenshot: ${shot1Path}`);

  // 2. SET a limit for brave-search (limit: 15, window: 1h / 3600000ms)
  const setResult = await send("Runtime.evaluate", {
    expression: `(async () => {
      const row = document.querySelector('#vault-quotas .vault-quota-row[data-service="brave-search"]');
      if (!row) return { error: "brave-search row not found" };
      const limitInput = row.querySelector(".vault-quota-limit-input");
      const windowSelect = row.querySelector(".vault-quota-window-select");
      const setBtn = row.querySelector(".vault-quota-set-btn");
      if (!limitInput || !setBtn) return { error: "inputs not found" };

      limitInput.value = "15";
      if (windowSelect) windowSelect.value = "3600000";
      setBtn.click();

      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const updatedRow = document.querySelector('#vault-quotas .vault-quota-row[data-service="brave-search"]');
        if (updatedRow && updatedRow.dataset.limit === "15") {
          return {
            ok: true,
            service: "brave-search",
            limit: updatedRow.dataset.limit,
            remaining: updatedRow.dataset.remaining,
            windowMs: updatedRow.dataset.windowMs,
            statusText: updatedRow.querySelector(".vault-status-pill")?.textContent?.trim(),
            limitText: updatedRow.querySelector(".vault-quota-limit")?.textContent?.trim(),
            windowText: updatedRow.querySelector(".vault-quota-window")?.textContent?.trim(),
          };
        }
      }
      return { error: "timed out waiting for limit 15" };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  const setObserved = wireValue<any>(setResult, "k.quota-ui");
  console.log("AFTER SET LIMIT:", JSON.stringify(setObserved, null, 2));

  check("brave-search limit updated to 15", setObserved?.limit === "15", setObserved);
  check("brave-search remaining updated to 15", setObserved?.remaining === "15", setObserved);
  check("brave-search window updated to 1h", setObserved?.windowMs === "3600000", setObserved);

  // Capture screenshot: 02-after-set-limit.png
  const shot2 = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  const shot2Path = `${OUT}/02-after-set-limit.png`;
  await Deno.writeFile(shot2Path, Uint8Array.from(atob(shot2.result.data), (c) => c.charCodeAt(0)));
  console.log(`Saved screenshot: ${shot2Path}`);

  // 3. CLEAR the limit and observe default return
  const clearResult = await send("Runtime.evaluate", {
    expression: `(async () => {
      const row = document.querySelector('#vault-quotas .vault-quota-row[data-service="brave-search"]');
      if (!row) return { error: "brave-search row not found" };
      const clearBtn = row.querySelector(".vault-quota-clear-btn");
      if (!clearBtn) return { error: "clearBtn not found" };

      clearBtn.click();

      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const restoredRow = document.querySelector('#vault-quotas .vault-quota-row[data-service="brave-search"]');
        if (restoredRow && restoredRow.dataset.limit === "50") {
          return {
            ok: true,
            service: "brave-search",
            limit: restoredRow.dataset.limit,
            remaining: restoredRow.dataset.remaining,
            windowMs: restoredRow.dataset.windowMs,
            statusText: restoredRow.querySelector(".vault-status-pill")?.textContent?.trim(),
            limitText: restoredRow.querySelector(".vault-quota-limit")?.textContent?.trim(),
            windowText: restoredRow.querySelector(".vault-quota-window")?.textContent?.trim(),
          };
        }
      }
      return { error: "timed out waiting for restored limit 50" };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  const clearObserved = wireValue<any>(clearResult, "k.quota-ui");
  console.log("AFTER CLEAR RESTORED:", JSON.stringify(clearObserved, null, 2));

  check("brave-search limit restored to default 50", clearObserved?.limit === "50", clearObserved);
  check("brave-search remaining restored to 50", clearObserved?.remaining === "50", clearObserved);

  // Capture screenshot: 03-after-clear-restored.png
  const shot3 = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  const shot3Path = `${OUT}/03-after-clear-restored.png`;
  await Deno.writeFile(shot3Path, Uint8Array.from(atob(shot3.result.data), (c) => c.charCodeAt(0)));
  console.log(`Saved screenshot: ${shot3Path}`);

} finally {
  try { ws.close(); } catch {}
  await teardownChrome(proc, profile);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) Deno.exit(1);
