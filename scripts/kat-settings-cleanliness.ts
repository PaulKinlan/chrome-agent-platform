// Loaded-extension proof for the Settings safe-cleanup slice.
// Baseline mode exposes the retired hidden control for the before screenshot;
// candidate mode proves it is absent while real owner controls remain.
//
// deno run -A scripts/kat-settings-cleanliness.ts <extension> <out> [--baseline]

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-settings-cleanliness`;
const BASELINE = Deno.args.includes("--baseline");
const CHROMIUM = "/usr/bin/chromium";
await Deno.mkdir(OUT, { recursive: true });

let pass = 0, fail = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", `--user-data-dir=${OUT}/profile-${Date.now()}`, "about:blank",
  ],
});
const ws = new WebSocket(wsUrl);
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
  try { proc.kill("SIGKILL"); } catch {}
  Deno.exit(1);
}
const extensionId = new URL(worker.url).host;
const target = await send("Target.createTarget", { url: `chrome-extension://${extensionId}/options/options.html#providers` });
const attached = await send("Target.attachToTarget", { targetId: target.result.targetId, flatten: true });
const sessionId = attached.result.sessionId;
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

const deadline = Date.now() + 20000;
let state: any = null;
while (Date.now() < deadline) {
  const result = await send("Runtime.evaluate", {
    expression: `(() => ({
      ready: document.readyState === "complete" && document.querySelectorAll("#provider-tabs [role=tab]").length > 0,
      href: location.href
    }))()`,
    returnByValue: true,
  }, sessionId);
  state = result?.result?.result?.value;
  if (state?.ready) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
check("Settings providers rendered", state?.ready === true, state);

const observedResult = await send("Runtime.evaluate", {
  expression: `(() => {
    const warnings = [...document.querySelectorAll("storage-durability-warning")];
    ${BASELINE ? 'warnings.forEach((warning) => warning.setAttribute("active", ""));' : ""}
    const nav = [...document.querySelectorAll(".nav-item[data-section]")];
    const sections = new Set([...document.querySelectorAll("section.panel[id]")].map((section) => section.id));
    const deadNav = nav.map((item) => item.dataset.section).filter((id) => !sections.has(id));
    const labels = [...document.querySelectorAll("button")].map((button) => (button.textContent || "").trim()).filter(Boolean);
    return {
      warningCount: warnings.length,
      deadNav,
      deadLabels: labels.filter((label) => /verify storage|enable storage/i.test(label)),
      apiKeyInputs: document.querySelectorAll("input.api-key").length,
      permissionRows: document.querySelectorAll("#permission-list .perm-row").length,
      browserControl: Boolean(document.getElementById("browser-grant")),
      localFolderControl: Boolean(document.getElementById("fs-add-directory-btn")),
    };
  })()`,
  returnByValue: true,
}, sessionId);
const observed = observedResult?.result?.result?.value;
if (BASELINE) {
  check("baseline contains the retired storage verifier", observed?.warningCount > 0, observed);
  check("baseline contains a dead Settings navigation item", observed?.deadNav?.includes("appearance"), observed);
} else {
  check("request-era storage verifier is absent", observed?.warningCount === 0 && observed?.deadLabels?.length === 0, observed);
  check("every Settings navigation item resolves to a real section", observed?.deadNav?.length === 0, observed);
  check("provider API-key editing remains available", observed?.apiKeyInputs > 0, observed);
  check("install-grant diagnostics still render", observed?.permissionRows > 0, observed);
  check("real owner-grant controls remain", observed?.browserControl === true && observed?.localFolderControl === true, observed);
}

const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
const shotName = BASELINE ? "before-request-era-controls.png" : "after-settings-clean.png";
await Deno.writeFile(`${OUT}/${shotName}`, Uint8Array.from(atob(screenshot.result.data), (char) => char.charCodeAt(0)));

console.log(`${pass} passed, ${fail} failed`);
try { ws.close(); } catch {}
try { proc.kill("SIGKILL"); } catch {}
try { await proc.status; } catch {}
if (fail) Deno.exit(1);
