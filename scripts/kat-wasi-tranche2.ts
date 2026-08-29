// Real loaded-extension acceptance for the bounded awk/date admissions.
// Drives the exact Settings document -> service-worker `tool.preview.run` route.
// deno run -A scripts/kat-wasi-tranche2.ts [extension-dir] [evidence-dir]

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-wasi-tranche2`;
await Deno.mkdir(OUT, { recursive: true });
const sha = new TextDecoder().decode((await new Deno.Command("git", { cwd: ROOT, args: ["rev-parse", "HEAD"], stdout: "piped" }).output()).stdout).trim();
const extensionSha = Deno.args[2] ?? sha;
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  ok ? pass++ : fail++;
};

const { proc, wsUrl } = await launchChrome({
  binary: "/usr/bin/chromium",
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", `--user-data-dir=${OUT}/profile-${Date.now()}`, "about:blank"],
});
const ws = new WebSocket(wsUrl);
await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
let id = 0;
const pending = new Map<number, (value: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((resolve) => {
  const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (event) => { const m = JSON.parse(event.data); const done = pending.get(m.id); if (done) { pending.delete(m.id); done(m); } };

try {
  const worker = await waitForServiceWorker(send, { timeoutMs: 20_000 });
  check("loaded extension registered its service worker", Boolean(worker), worker);
  if (!worker) throw new Error("service worker unavailable");
  const extId = new URL(worker.url).host;
  const target = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
  const attached = await send("Target.attachToTarget", { targetId: target.result.targetId, flatten: true });
  const sessionId = attached.result.sessionId;
  await send("Runtime.enable", {}, sessionId); await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const evaluated = await send("Runtime.evaluate", {
    expression: `(async () => {
      const run = (toolId, args, stdin) => chrome.runtime.sendMessage({ type: "tool.preview.run", toolId, args, stdin });
      const results = {
        awk: await run("awk_filter_bounded", ["/^alice/ { print $1 }"], "alice 30\\nbob 25\\n"),
        date: await run("date_formatter_bounded", ["-u", "-d", "@1724000000", "+%Y-%m-%d"], ""),
        invalidDate: await run("date_formatter_bounded", ["-u", "-d", "not-a-date", "+%s"], ""),
        impossibleDate: await run("date_formatter_bounded", ["-u", "-d", "2024-02-31", "+%Y-%m-%d"], ""),
        overflowEpoch: await run("date_formatter_bounded", ["-u", "-d", "@999999999999999999999", "+%s"], ""),
        invalidIso: await run("date_formatter_bounded", ["--iso-8601garbage"], ""),
      };
      const panel = document.createElement("pre");
      panel.id = "wasi-tranche2-route-evidence";
      panel.style.cssText = "position:fixed;inset:16px;z-index:2147483647;background:#111;color:#7ff;padding:24px;white-space:pre-wrap;font:16px/1.5 monospace;overflow:auto";
      panel.textContent = "tool.preview.run — loaded Settings extension\\nextension commit ${extensionSha}\\nharness commit ${sha}\\n\\n" + JSON.stringify(results, null, 2);
      document.body.append(panel);
      return results;
    })()`, awaitPromise: true, returnByValue: true,
  }, sessionId);
  const results = evaluated?.result?.result?.value;
  check("awk ran through tool.preview.run with anchored matching", results?.awk?.ok === true && results.awk.result?.ok === true && results.awk.result?.stdout === "alice\n", results?.awk);
  check("date ran through tool.preview.run with deterministic UTC output", results?.date?.ok === true && results.date.result?.ok === true && results.date.result?.stdout?.trim() === "2024-08-18", results?.date);
  const boundedFailure = (response: any) => response?.ok === true && response.result?.ok === false && response.result?.errno === 1 && /proc_exit\(1\)/.test(response.result?.error ?? "") && String(response.result?.error ?? "").length <= 1024;
  check("invalid date failed through tool.preview.run with bounded diagnostics", boundedFailure(results?.invalidDate), results?.invalidDate);
  check("nonexistent calendar date failed through tool.preview.run", boundedFailure(results?.impossibleDate), results?.impossibleDate);
  check("overflowing epoch failed through tool.preview.run", boundedFailure(results?.overflowEpoch), results?.overflowEpoch);
  check("garbage ISO suffix failed through tool.preview.run", boundedFailure(results?.invalidIso), results?.invalidIso);

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  await Deno.writeFile(`${OUT}/tool-preview-route.png`, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
  await Deno.writeTextFile(`${OUT}/browser-result.json`, JSON.stringify({ sha, extensionSha, pass, fail, results }, null, 2) + "\n");
} finally {
  try { ws.close(); } catch {}
  try { proc.kill("SIGKILL"); } catch {}
}
console.log(`SUMMARY: ${pass} passed, ${fail} failed; harnessSha=${sha}; extensionSha=${extensionSha}; evidence=${OUT}`);
Deno.exit(fail ? 1 : 0);
