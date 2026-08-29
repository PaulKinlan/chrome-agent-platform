// kat-template-cards.ts — create-agent template-select acceptance.
// Proves the shipped catalogue uses the shared subtle native select, stays
// behind Advanced, applies an editable template, and saves through real MV3.
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${Deno.env.get("HOME")}/.local/state/chrome-agent-platform/template-cards/green`;
const CHROMIUM = "/usr/bin/chromium";
let pass = 0, fail = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
await Deno.mkdir(OUT, { recursive: true });

const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", `--user-data-dir=${OUT}/profile-${Date.now()}`, "about:blank"],
});
const ws = new WebSocket(wsUrl);
await new Promise((resolve) => { ws.onopen = () => resolve(null); });
let id = 0;
const pending = new Map<string, (value: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((resolve) => {
  const mid = ++id;
  pending.set(String(mid), resolve);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (event) => {
  const message = JSON.parse(event.data as string);
  if (!message.id || !pending.has(String(message.id))) return;
  pending.get(String(message.id))!(message);
  pending.delete(String(message.id));
};

const sw = await waitForServiceWorker(send);
if (!sw) { console.log("FAIL: no service worker target"); Deno.exit(1); }
const extId = new URL(sw.url).host;
const target = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const attached = await send("Target.attachToTarget", { targetId: target.result.targetId, flatten: true });
const page = attached.result.sessionId;
await send("Runtime.enable", {}, page);
await send("Page.enable", {}, page);
await send("Emulation.setDeviceMetricsOverride", { width: 1120, height: 900, deviceScaleFactor: 1, mobile: false }, page);
const ev = async (expression: string) => (await send("Runtime.evaluate", {
  expression, returnByValue: true, awaitPromise: true,
}, page)).result?.result?.value;
const shot = async (name: string) => {
  const result = (await send("Page.captureScreenshot", { format: "png" }, page)).result;
  await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
};
await sleep(3000);
await ev(`document.getElementById('new-agent')?.click()`);
await sleep(700);

const catalogueCount = await ev(`import(chrome.runtime.getURL('lib/agent-templates.js')).then((m) => m.AGENT_TEMPLATES.length)`);
const picker = await ev(`(() => {
  const advanced = document.querySelector('.agent-config-advanced');
  const host = document.getElementById('agent-template-select');
  const select = host?.shadowRoot?.querySelector('select');
  const primary = [...document.querySelectorAll('.agent-config-scroll > label')].map((label) => label.textContent?.trim());
  const before = { advancedOpen: advanced?.open === true, primary, optionCount: (select?.options.length ?? 1) - 1,
    label: select?.getAttribute('aria-label') ?? '', height: select ? getComputedStyle(select).height : '' };
  if (advanced) advanced.open = true;
  return before;
})()`);
check("dialog opens on the direct Name / What it does path with Advanced collapsed", picker?.advancedOpen === false && picker?.primary?.length === 2, picker);
check("shared template select offers every shipped template", picker?.optionCount === catalogueCount, picker);
check("template select is labelled and follows the 36px control grid", picker?.label === "Start from a template" && picker?.height === "36px", picker);
await shot("01-template-select");

const used = await ev(`(() => {
  const select = document.getElementById('agent-template-select')?.shadowRoot?.querySelector('select');
  if (select) { select.value = 'chief-of-staff'; select.dispatchEvent(new Event('change', { bubbles: true })); }
  const name = [...document.querySelectorAll('.agent-config-scroll label')].find((label) => label.textContent.startsWith('Name'))?.querySelector('input')?.value ?? '';
  const role = [...document.querySelectorAll('.agent-config-scroll textarea')][0]?.value ?? '';
  const checked = [...document.querySelectorAll('.skills-list input[type=checkbox]')].filter((input) => input.checked).length;
  return { select: !!select, name, roleHasPersona: role.includes('Chief of Staff Persona'), checked };
})()`);
check("selecting a template instantiates the editable form", used?.select === true && used?.name === "Chief of Staff" && used?.roleHasPersona === true && used?.checked === 5, used);

// Fail closed: inaccessible/unavailable axe is a failed KAT, never a skipped note.
try {
  const response = await fetch("https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js");
  if (!response.ok) throw new Error(`axe fetch returned ${response.status}`);
  const injected = await send("Runtime.evaluate", { expression: await response.text() }, page);
  if (injected?.error || injected?.result?.exceptionDetails) throw new Error("axe injection failed");
  const violations = await ev(`axe.run(document, { resultTypes: ['violations'] }).then((r) => r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => (n.target || []).join(' ')) })))`);
  if (!Array.isArray(violations)) throw new Error("axe returned no violation array");
  const relevant = violations.filter((violation: any) => (violation.nodes ?? []).some((node: string) => node.includes("agent-template-select") || node.includes("agent-config-advanced")));
  check("axe finds no violations in the template select", picker?.optionCount > 0 && relevant.length === 0, relevant);
} catch (error) {
  check("axe loads and runs (fail closed)", false, String(error).slice(0, 160));
}

await ev(`(() => {
  const buttons = [...document.querySelectorAll('agent-dialog button')];
  buttons.find((button) => /^create agent$/i.test((button.textContent ?? '').trim()))?.click();
})()`);
await sleep(1600);
const saved = await ev(`chrome.runtime.sendMessage({ type: 'named-agent.get', id: 'chief-of-staff' }).then((res) => ({ ok: res?.ok === true, name: res?.agent?.name, role: res?.agent?.role ?? '', skills: (res?.agent?.skills ?? []).map((skill) => skill?.id ?? skill?.name ?? String(skill)) })).catch(() => null)`);
check("Create persists the selected template through named-agent.create", saved?.ok === true && saved?.name === "Chief of Staff" && saved?.role.includes("Chief of Staff Persona") && saved?.skills.length === 5, saved);
await shot("02-template-created");

console.log(`\nkat-template-cards: ${pass} passed, ${fail} failed`);
try { proc.kill(); } catch { /* already exited */ }
await proc.status.catch(() => null);
ws.close();
if (fail) Deno.exit(1);
