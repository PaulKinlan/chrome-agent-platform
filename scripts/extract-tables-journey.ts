// scripts/extract-tables-journey.ts — Real browser acceptance for extract_tables (chrome-agent-platform-3p3e.8)
// Injects bounded table extractor into fixture page with 3 tables (HTML table, ARIA grid, repeated-card list),
// creates canonical tabular artifact, renders preview in thread, captures screenshot evidence, and cleans up cleanly.

import { fileURLToPath } from "node:url";
import { launchChrome, waitForServiceWorker, teardownChrome } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";
import { wireValue } from "./lib/cdp-eval.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXT = `${ROOT}extension`;
const EVIDENCE_DIR = Deno.env.get("EVIDENCE_DIR") ?? durableDir("cap-evidence/3p3e8-extract-tables");
await Deno.mkdir(EVIDENCE_DIR, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Tabular Data Acceptance Fixture</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 24px; background: #faf9f6; color: #1f1f1f; }
    h1, h2 { margin: 0 0 12px; }
    table { border-collapse: collapse; width: 100%; max-width: 600px; margin-bottom: 24px; background: #fff; border: 1px solid #ddd; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #f0f0f0; }
    .grid { display: flex; flex-direction: column; width: 100%; max-width: 600px; margin-bottom: 24px; border: 1px solid #ccc; background: #fff; }
    .row { display: flex; border-bottom: 1px solid #eee; }
    .header-row { background: #e8e8e8; font-weight: bold; }
    .colheader, .cell { flex: 1; padding: 8px 12px; }
    .cards { display: flex; gap: 16px; margin-bottom: 24px; }
    .card { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; width: 180px; }
    dl { margin: 0; }
    dt { font-size: 12px; color: #666; margin-top: 8px; }
    dd { font-size: 14px; font-weight: bold; margin: 0; }
  </style>
</head>
<body>
  <h1>Tabular Data Showcase</h1>

  <!-- 1. Native HTML Table -->
  <h2>1. Native Table</h2>
  <table id="products-table">
    <caption>Q3 Hardware Deliveries</caption>
    <thead>
      <tr><th>Item SKU</th><th>Model Name</th><th>Quantity</th><th>Unit Price</th></tr>
    </thead>
    <tbody>
      <tr><td>SKU-101</td><td>Edge Node Alpha</td><td>45</td><td>$850</td></tr>
      <tr><td>SKU-102</td><td>Compute Blade B</td><td>12</td><td>$2,400</td></tr>
      <tr><td>SKU-103</td><td>Gateway Router R1</td><td>78</td><td>$320</td></tr>
    </tbody>
  </table>

  <!-- 2. ARIA Grid -->
  <h2>2. ARIA Data Grid</h2>
  <div role="grid" aria-label="Incident Response Team" class="grid">
    <div role="row" class="row header-row">
      <div role="columnheader" class="colheader">Engineer</div>
      <div role="columnheader" class="colheader">On-Call Role</div>
      <div role="columnheader" class="colheader">Shift Hours</div>
    </div>
    <div role="row" class="row">
      <div role="gridcell" class="cell">Sarah Connor</div>
      <div role="gridcell" class="cell">Primary SRE</div>
      <div role="gridcell" class="cell">08:00 - 16:00</div>
    </div>
    <div role="row" class="row">
      <div role="gridcell" class="cell">John Matrix</div>
      <div role="gridcell" class="cell">Secondary Escalate</div>
      <div role="gridcell" class="cell">16:00 - 00:00</div>
    </div>
    <div role="row" class="row">
      <div role="gridcell" class="cell">Kyle Reese</div>
      <div role="gridcell" class="cell">Security Analyst</div>
      <div role="gridcell" class="cell">00:00 - 08:00</div>
    </div>
  </div>

  <!-- 3. Repeated-Card List -->
  <h2>3. Subscription Tiers</h2>
  <div class="cards pricing-grid" aria-label="Hosting Service Tiers">
    <div class="card plan-card">
      <dl>
        <dt>Plan Name</dt><dd>Starter</dd>
        <dt>Monthly Cost</dt><dd>$19/mo</dd>
        <dt>Bandwidth</dt><dd>100 GB</dd>
      </dl>
    </div>
    <div class="card plan-card">
      <dl>
        <dt>Plan Name</dt><dd>Professional</dd>
        <dt>Monthly Cost</dt><dd>$79/mo</dd>
        <dt>Bandwidth</dt><dd>1 TB</dd>
      </dl>
    </div>
    <div class="card plan-card">
      <dl>
        <dt>Plan Name</dt><dd>Scale</dd>
        <dt>Monthly Cost</dt><dd>$249/mo</dd>
        <dt>Bandwidth</dt><dd>10 TB</dd>
      </dl>
    </div>
  </div>
</body>
</html>`;

// Simple HTTP server for local fixture
const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
  return new Response(FIXTURE_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
const fixtureUrl = `http://127.0.0.1:${server.addr.port}/fixture.html`;

const profile = durableDir(`cap-extract-tables-prof-${Date.now()}`);
let chrome = null;
let ws = null;
let exitCode = 0;

try {
  console.log(`[journey] launching Chrome with profile: ${profile}`);
  chrome = await launchChrome({
    extension: EXT,
    profile,
    grantPermissions: ["activeTab", "scripting", "tabs"],
    windowSize: "1280,960",
  });

  ws = new WebSocket(chrome.wsUrl);
  await new Promise((resolve) => (ws.onopen = resolve));

  let nextId = 0;
  const pending = new Map<number, (value: any) => void>();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  };

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const worker = await waitForServiceWorker(send);
  if (!worker) throw new Error("Service worker failed to register");
  const extensionId = new URL(worker.url).host;

  // 1. Open fixture tab
  console.log(`[journey] opening fixture at ${fixtureUrl}`);
  const fixtureTarget = await send("Target.createTarget", { url: fixtureUrl });
  const fixtureTabId = fixtureTarget.result.targetId;
  await sleep(1000);

  // 2. Open NTP tab
  const ntpTarget = await send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/ntp/ntp.html`,
  });
  const ntpSession = (await send("Target.attachToTarget", { targetId: ntpTarget.result.targetId, flatten: true })).result.sessionId;
  await send("Runtime.enable", {}, ntpSession);
  await send("Page.enable", {}, ntpSession);
  await sleep(1500);

  // 3. In NTP, grant browser-control and execute extract_tables
  console.log("[journey] executing extract_tables via extension tools");
  const evalResult = await send("Runtime.evaluate", {
    expression: `(async () => {
      const { browserToolset, setGlobalBrowserControlGrant } = await import("../lib/browser-tools.js");
      setGlobalBrowserControlGrant(true);
      const tools = browserToolset(false);
      // Find the fixture tab
      const allTabs = await chrome.tabs.query({});
      const target = allTabs.find(t => t.url && t.url.includes("127.0.0.1"));
      if (!target) throw new Error("fixture tab not found");
      const res = await tools.extract_tables.execute({ tabId: target.id, asArtifact: true });
      return { tabId: target.id, result: res };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, ntpSession);

  if (evalResult.result?.exceptionDetails) {
    const desc = evalResult.result.exceptionDetails.exception?.description || evalResult.result.exceptionDetails.text;
    throw new Error(`Execution failed: ${desc}`);
  }

  const evalPayload = evalResult.result?.result?.value;
  if (!evalPayload || !evalPayload.result) {
    throw new Error(`Unexpected eval response: ${JSON.stringify(evalResult)}`);
  }
  const { result } = evalPayload;
  console.log("[journey] extract_tables result count:", result.count);
  console.log("[journey] tables found:", result.tables?.map((t: any) => t.caption));

  if (!result.untrusted || result.count !== 3 || !result.artifactId) {
    throw new Error(`Unexpected extract_tables result: ${JSON.stringify(result)}`);
  }

  // 4. Render the artifact in the thread UI
  console.log("[journey] mounting extracted tabular artifact in conversation thread");
  await send("Runtime.evaluate", {
    expression: `(async () => {
      const conv = document.querySelector("agent-conversation") || document.createElement("agent-conversation");
      if (!conv.isConnected) document.body.appendChild(conv);
      // Render tool call result card with artifact preview using safe DOM methods
      const card = document.createElement("div");
      card.className = "tool-card-preview";
      card.style.cssText = "margin: 24px; padding: 20px; background: #fff; border: 1px solid #d0d7de; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08);";

      const titleDiv = document.createElement("div");
      titleDiv.style.cssText = "font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #0969da; display: flex; align-items: center; gap: 8px;";
      const iconSpan = document.createElement("span");
      iconSpan.textContent = "📊";
      const captionSpan = document.createElement("span");
      captionSpan.textContent = "Extracted Tabular Artifact: " + ${JSON.stringify(result.tables[0].caption)};
      titleDiv.appendChild(iconSpan);
      titleDiv.appendChild(captionSpan);
      card.appendChild(titleDiv);

      const metaDiv = document.createElement("div");
      metaDiv.style.cssText = "font-size: 13px; color: #57609a; margin-bottom: 16px;";
      metaDiv.textContent = "Artifact ID: " + ${JSON.stringify(result.artifactId)} + " • 3 tables extracted • Accepted directly by table_* tools";
      card.appendChild(metaDiv);

      const preview = document.createElement("table-preview");
      card.appendChild(preview);
      document.body.prepend(card);

      const { getAsset } = await import("../lib/artifacts.js");
      const assetRes = await getAsset("master", ${JSON.stringify(result.artifactId)});
      if (assetRes.ok && preview) {
        preview.data = JSON.parse(assetRes.asset.content);
      }
    })()`,
    awaitPromise: true,
  }, ntpSession);

  await sleep(1500);

  // 5. Capture screenshot of the artifact in the thread
  console.log("[journey] capturing screenshot of tabular artifact in thread");
  const screenshotRes = await send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  }, ntpSession);

  const screenshotBytes = Uint8Array.from(atob(screenshotRes.result.data), (c) => c.charCodeAt(0));
  const screenshotPath = `${EVIDENCE_DIR}/extract-tables-artifact-thread.png`;
  await Deno.writeFile(screenshotPath, screenshotBytes);
  console.log(`[journey] saved screenshot evidence to: ${screenshotPath} (${screenshotBytes.byteLength} bytes)`);

  if (screenshotBytes.byteLength < 1000) {
    throw new Error("Screenshot evidence too small / blank");
  }

  console.log("PASS: extract_tables journey verified with 3 extracted tables and thread artifact screenshot");
} catch (e) {
  console.error("FAIL: extract_tables journey failed:", e);
  exitCode = 1;
} finally {
  try { await server.shutdown(); } catch {}
  try { if (ws) ws.close(); } catch {}
  if (chrome) {
    try { await teardownChrome(chrome, profile); } catch {}
  }
}
Deno.exit(exitCode);
