// Settings → Agents and create-agent visual repair KAT.
// Runs against the real loaded extension and writes durable screenshots + metrics.
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}evidence/ui-repair`;
const CHROMIUM = "/usr/bin/chromium";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
await Deno.mkdir(OUT, { recursive: true });

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  ok ? passed++ : failed++;
}

const profile = await Deno.makeTempDir({ prefix: "cap-ui-repair-" });
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", `--user-data-dir=${profile}`,
    "--window-size=1280,900", "--no-first-run", "about:blank",
  ],
});
const ws = new WebSocket(wsUrl);
await new Promise((resolve) => { ws.onopen = resolve; });
let id = 0;
const pending = new Map<number, (value: any) => void>();
ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)!(message);
    pending.delete(message.id);
  }
};
const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<any>((resolve) => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ id: requestId, method, params, sessionId }));
  });
const sw = await waitForServiceWorker(send);
if (!sw) throw new Error("extension service worker did not start");
const extId = new URL(sw.url).host;

async function open(path: string) {
  const targetId = (await send("Target.createTarget", { url: `chrome-extension://${extId}${path}` })).result.targetId;
  const sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await sleep(1800);
  return { targetId, sessionId };
}
async function evaluate(sessionId: string, expression: string) {
  const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description ?? "evaluation failed");
  return response.result?.result?.value;
}
async function screenshot(sessionId: string, name: string) {
  const response = await send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId);
  const bytes = Uint8Array.from(atob(response.result.data), (char) => char.charCodeAt(0));
  const path = `${OUT}/${name}.png`;
  await Deno.writeFile(path, bytes);
  console.log(`SHOT: ${path}`);
}
async function clickAt(sessionId: string, point: { x: number; y: number } | null) {
  if (!point) return;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
  }
  await sleep(250);
}
async function pressEscape(sessionId: string) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await sleep(150);
}

try {
  const options = await open("/options/options.html#agents");
  await evaluate(options.sessionId, `chrome.runtime.sendMessage({ type: "named-agent.create", name: "Chief of Staff", role: "Coordinates the day, delegates work, and keeps priorities clear." })`);
  await send("Page.reload", {}, options.sessionId);
  await sleep(1800);
  await evaluate(options.sessionId, `(() => { location.hash = "#agents"; document.querySelector('[data-section="agents"]')?.click(); document.querySelector('#agents')?.scrollIntoView({block:'start'}); return true; })()`);
  await sleep(400);
  await screenshot(options.sessionId, "settings-agents");
  const backgroundPickerPoint = await evaluate(options.sessionId, `(() => { const r = document.querySelector('.agent-select')?.getBoundingClientRect(); return r ? {x:r.x+r.width/2,y:r.y+r.height/2} : null; })()`);
  await clickAt(options.sessionId, backgroundPickerPoint);
  await screenshot(options.sessionId, "settings-background-picker-open");
  await pressEscape(options.sessionId);
  const settings = await evaluate(options.sessionId, `(() => {
    const row = document.querySelector('.agent-provider-row');
    const host = row?.querySelector('provider-select');
    const select = host?.shadowRoot?.querySelector('select');
    const sr = select?.getBoundingClientRect();
    const rr = row?.getBoundingClientRect();
    const add = document.querySelector('.background-agent-add');
    return {
      namedRows: document.querySelectorAll('.agent-provider-row').length,
      backgroundRows: document.querySelectorAll('#unified-agent-list > .background-agent-row').length,
      addSection: !!add,
      addButton: !!add?.querySelector('button'),
      addOptions: add?.querySelectorAll('option').length ?? 0,
      backgroundOptionsWithIcons: add?.querySelectorAll('option .opt-icon svg').length ?? 0,
      providerOptionsWithIcons: host?.shadowRoot?.querySelectorAll('option .option-icon svg').length ?? 0,
      providerAppearance: select ? getComputedStyle(select).appearance : '',
      providerPickerIconDisplay: select ? getComputedStyle(select, '::picker-icon').display : '',
      providerCustomArrows: host?.shadowRoot?.querySelectorAll('.wrap > svg').length ?? -1,
      providerHeight: sr?.height ?? 0,
      providerContained: !!sr && !!rr && sr.left >= rr.left && sr.right <= rr.right + 1,
      providerSingleLine: !!select && getComputedStyle(select).whiteSpace === 'nowrap' && (sr?.height ?? 0) <= 36,
      editParent: row?.querySelector('.edit-named-agent')?.parentElement?.className ?? '',
    };
  })()`);
  await Deno.writeTextFile(`${OUT}/settings-metrics.json`, JSON.stringify(settings, null, 2));
  check("Settings restores one compact background-agent add section", settings.addSection && settings.addButton && settings.addOptions > 1 && settings.backgroundOptionsWithIcons === settings.addOptions - 1, settings);
  check("disabled background-agent catalogue is not rendered as phantom rows", settings.backgroundRows === 0 && settings.namedRows === 1, settings);
  check("provider base-select has one picker arrow and rich options", settings.providerAppearance === "base-select" && settings.providerCustomArrows === 0 && settings.providerPickerIconDisplay !== "none" && settings.providerOptionsWithIcons > 0, settings);
  check("provider select is one line and contained in its row", settings.providerContained && settings.providerSingleLine && settings.providerHeight === 36, settings);
  check("persona/schedule edit action is inside the row action group", /ag-actions/.test(settings.editParent), settings.editParent);
  const addPoint = await evaluate(options.sessionId, `(() => {
    const select = document.querySelector('.agent-select');
    select.value = select.options[1]?.value ?? '';
    select.dispatchEvent(new Event('change', {bubbles:true}));
    const r = document.querySelector('.background-agent-add-controls .btn')?.getBoundingClientRect();
    return r ? {x:r.x+r.width/2,y:r.y+r.height/2} : null;
  })()`);
  await clickAt(options.sessionId, addPoint);
  await sleep(700);
  const addedRows = await evaluate(options.sessionId, `document.querySelectorAll('#unified-agent-list > .background-agent-row').length`);
  check("choosing and adding a background agent creates one management row", addedRows === 1, addedRows);
  await screenshot(options.sessionId, "settings-background-agent-added");

  const ntp = await open("/ntp/ntp.html");
  await evaluate(ntp.sessionId, `document.getElementById('new-agent')?.click()`);
  await sleep(700);
  await screenshot(ntp.sessionId, "create-dialog-collapsed");
  const templatePickerPoint = await evaluate(ntp.sessionId, `(() => { const el = document.getElementById('agent-template-select')?.shadowRoot?.querySelector('select'); const r = el?.getBoundingClientRect(); return r ? {x:r.x+r.width/2,y:r.y+r.height/2} : null; })()`);
  await clickAt(ntp.sessionId, templatePickerPoint);
  await screenshot(ntp.sessionId, "create-dialog-template-picker-open");
  await pressEscape(ntp.sessionId);
  const dialogState = async () => await evaluate(ntp.sessionId, `(() => {
    const host = document.querySelector('agent-dialog');
    const dialog = host?.shadowRoot?.querySelector('dialog');
    const template = document.getElementById('agent-template-select');
    const select = template?.shadowRoot?.querySelector('select');
    const named = (label) => [...document.querySelectorAll('.agent-config-scroll label')].find((el) => el.textContent.trim().startsWith(label));
    const box = (el) => { const r = el?.getBoundingClientRect(); return r ? {top:r.top,left:r.left,right:r.right,width:r.width,height:r.height} : null; };
    return {
      dialog: box(dialog), container: box(document.querySelector('.agent-config-container')),
      name: box(named('Name')), role: box(named('What it does')), template: box(template),
      schedule: box(document.getElementById('agent-schedule')?.closest('label')), advanced: box(document.querySelector('.agent-config-advanced')),
      micVisible: (() => { const el = document.querySelector('.agent-role-tools mic-button'); const r = el?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0; })(),
      templateAppearance: select ? getComputedStyle(select).appearance : '',
      templateOptionsWithIcons: template?.shadowRoot?.querySelectorAll('option .option-icon svg').length ?? 0,
      templateCustomArrows: template?.shadowRoot?.querySelectorAll('.wrap > svg').length ?? -1,
      templatePickerIconDisplay: select ? getComputedStyle(select, '::picker-icon').display : '',
      scrollOverflow: document.querySelector('.agent-config-scroll')?.scrollWidth - document.querySelector('.agent-config-scroll')?.clientWidth,
    };
  })()`);
  const collapsed = await dialogState();
  await evaluate(ntp.sessionId, `document.querySelector('.agent-config-advanced').open = true`);
  await sleep(250);
  await screenshot(ntp.sessionId, "create-dialog-advanced-open");
  const advanced = await dialogState();
  await evaluate(ntp.sessionId, `(() => { const details = document.querySelector('.skills-collapse'); details.open = true; details.scrollIntoView({block:'center'}); })()`);
  await sleep(250);
  await screenshot(ntp.sessionId, "create-dialog-skills-open");
  const skills = await dialogState();
  await Deno.writeTextFile(`${OUT}/dialog-metrics.json`, JSON.stringify({ collapsed, advanced, skills }, null, 2));
  const order = [collapsed.name?.top, collapsed.role?.top, collapsed.template?.top, collapsed.schedule?.top, collapsed.advanced?.top];
  check("dialog order is Name → what it does → template → schedule → advanced", order.every(Number.isFinite) && order.every((value, index) => index === 0 || value > order[index - 1]), order);
  check("voice input is visible beside what-it-does", collapsed.micVisible, collapsed);
  check("template base-select has one picker arrow and rich options", collapsed.templateAppearance === "base-select" && collapsed.templateCustomArrows === 0 && collapsed.templatePickerIconDisplay !== "none" && collapsed.templateOptionsWithIcons > 0, collapsed);
  const widths = [collapsed.dialog?.width, advanced.dialog?.width, skills.dialog?.width];
  check("dialog width is stable across disclosures", widths.every(Number.isFinite) && Math.max(...widths) - Math.min(...widths) <= 1, widths);
  check("disclosures stay inside the dialog without horizontal overflow", [collapsed, advanced, skills].every((state) => (state.scrollOverflow ?? 1) <= 0), { collapsed: collapsed.scrollOverflow, advanced: advanced.scrollOverflow, skills: skills.scrollOverflow });
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}
console.log(`\nUI repair KAT: ${passed} passed, ${failed} failed`);
Deno.exit(failed ? 1 : 0);
