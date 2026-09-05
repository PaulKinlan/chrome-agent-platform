// scripts/kat-site-delegation-attachments.ts
// Real browser verification of site-agent delegation with attachments & live progress.
// CAP-FB-20260825-DELEGATE-ATTACHMENTS-PROGRESS-01.

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { textToDataUrl } from "../extension/lib/attachments.js";

const EXT = new URL("../extension", import.meta.url).pathname;
const profile = await Deno.makeTempDir({ prefix: "site-delegate-evidence-" });

const { proc, wsUrl } = await launchChrome({
  binary: "/usr/bin/chromium",
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", `--user-data-dir=${profile}`,
    "--noerrdialogs", "--no-first-run", "--window-size=1280,900",
    "about:blank",
  ],
});

const HARD_TIMEOUT_MS = 35_000;
const hardTimer = setTimeout(() => {
  console.error(`kat-site-delegation-attachments: timed out after ${HARD_TIMEOUT_MS} ms`);
  try { proc.kill("SIGKILL"); } catch {}
  Deno.exit(1);
}, HARD_TIMEOUT_MS);

const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => {
  const d = JSON.parse(e.data as string);
  if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); }
};
const send = (m: string, p: any = {}, s?: string) =>
  new Promise<any>((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${m} timed out`)); }, 10_000);
    pending.set(i, (val) => { clearTimeout(t); res(val); });
    ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s }));
  });

let failed = 0;

try {
  const sw = await waitForServiceWorker(send, { timeoutMs: 15_000 });
  if (!sw) throw new Error("extension service worker did not register");
  const extId = new URL(sw.url).host;

  const target = (await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` })).result.targetId;
  const s = (await send("Target.attachToTarget", { targetId: target, flatten: true })).result.sessionId;
  await send("Runtime.enable", {}, s);
  await send("Page.enable", {}, s);

  const evalIn = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    if (r?.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? "threw" };
    return r?.result?.result?.value;
  };

  const results: string[] = [];
  const check = (name: string, ok: boolean, detail = "") =>
    results.push(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);

  // 1. Set demo provider
  const provRes = await evalIn(`(async () => { return await chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "demo" } }); })()`);
  check("provider set to demo", provRes?.provider === "demo");

  // 2. Enroll a test site via agent.create
  const enrollRes = await evalIn(`(async () => { return await chrome.runtime.sendMessage({ type: "agent.create", origin: "https://test-site.example", name: "Test Site" }); })()`);
  check("site enrolled", enrollRes?.ok === true);

  // 3. Delegate to site agent with attachments and verify live progress
  const sampleText = "Specification: deliver attachments to site agent workers.";
  const sampleDataUrl = textToDataUrl(sampleText, "text/plain");
  const sampleImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  const delegateRes = await evalIn(`(async () => {
    const targetRunId = "ui_run_" + Date.now();
    const progressEvents = [];
    const port = chrome.runtime.connect({ name: "agent-progress" });
    port.onMessage.addListener((msg) => {
      const ev = msg?.event ?? msg;
      if (ev.runId === targetRunId) progressEvents.push(ev);
    });

    const attachments = [
      {
        name: "spec.txt",
        type: "text/plain",
        size: ${sampleText.length},
        kind: "file",
        dataURL: "${sampleDataUrl}",
      },
      {
        name: "mockup.png",
        type: "image/png",
        size: 68,
        kind: "file",
        dataURL: "${sampleImage}",
      },
      {
        name: "forbidden-local-folder",
        kind: "local-folder",
        folderName: "local-dir",
        grantId: "g_123",
      }
    ];

    const res = await chrome.runtime.sendMessage({
      type: "agent.delegate",
      origin: "https://test-site.example",
      task: "Process the attached spec and mockup",
      attachments,
      runId: targetRunId,
    });

    // Wait a moment for trailing progress events
    await new Promise((r) => setTimeout(r, 200));
    port.disconnect();

    return JSON.stringify({ res, progressCount: progressEvents.length, progressTypes: progressEvents.map(e => e.type) });
  })()`);

  const parsed = typeof delegateRes === "string" ? JSON.parse(delegateRes) : { __err: delegateRes };
  const res = parsed?.res;
  check("delegation completed with ok:true", res?.ok === true);
  check("delegation returned canonical origin", res?.origin === "https://test-site.example");
  check("local-folder grant was dropped with clear reason", Array.isArray(res?.droppedAttachments) && res.droppedAttachments.some((d: any) => d.reason.includes("local folder grants are host-only")));
  check("live progress streamed to the delegating surface", parsed?.progressCount > 0, `received ${parsed?.progressCount} events (${parsed?.progressTypes?.join(", ")})`);

  // 4. Verify durable run log recorded attachments
  const runLogRes = await evalIn(`(async () => { return await chrome.runtime.sendMessage({ type: "run.list" }); })()`);
  const runs = runLogRes?.runs ?? [];
  const delegateRun = runs.find((r: any) => r.executionId === res?.executionId);
  check("delegate run admitted in durable runs registry", !!delegateRun);
  check("delegate run terminal phase is terminal", delegateRun?.phase === "terminal");

  console.log("\n" + results.join("\n"));
  failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\nsite delegation acceptance: ${results.length - failed}/${results.length} passed`);

} finally {
  clearTimeout(hardTimer);
  try { ws.close(); } catch {}
  try { proc.kill("SIGKILL"); } catch {}
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

Deno.exit(failed ? 1 : 0);
