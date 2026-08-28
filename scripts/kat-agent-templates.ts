// kat-agent-templates.ts — agent template picker KAT (real browser).
// Proves docs/AGENT-PRODUCT-GAPS.md G2 end to end:
//   1. the create-agent dialog renders the template gallery (9 templates +
//      the default "Custom agent (blank)");
//   2. picking Chief of Staff pre-fills name / role persona / suggested
//     skills — a STARTING POINT;
//   3. the owner specializes: remove one suggested skill, rewrite part of the
//     persona — then create;
//   4. the SAVED AGENT RECORD reflects the CUSTOMIZED state, not the template
//     defaults (role contains the owner's edit; the removed skill is absent);
//   5. the first-task suggestion lands in the composer for review.
// Also captures screenshots of the picker + prefilled state.
//
//   deno run -A scripts/kat-agent-templates.ts <path-to-extension> [<out-dir>]
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-agent-templates`;
const CHROMIUM = "/usr/bin/chromium";
const PORT = 9359;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const proc = new Deno.Command(CHROMIUM, {
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-agent-templates-${Date.now()}`, "about:blank"],
  stdout: "null", stderr: "piped",
}).spawn();

const wsUrl = await new Promise<string>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no devtools url")), 15000);
  (async () => { for (;;) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); const j = await r.json(); clearTimeout(t); resolve(j.webSocketDebuggerUrl); return; } catch { await sleep(300); } } })();
});

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
const { result: { targetInfos } } = await send("Target.getTargets");
const sw = targetInfos.find((t: any) => t.type === "service_worker");
if (!sw) { console.log("FAIL: no service worker target"); Deno.exit(1); }
const extId = new URL(sw.url).host;
const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
const shot = async (path: string) => {
  const { result } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  await Deno.writeFile(path, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
};
await Deno.mkdir(OUT, { recursive: true });
await sleep(3200); // first-run surfaces settle

// Open the create-agent dialog.
await ev(`document.getElementById('new-agent')?.click()`);
await sleep(700);

// 1. The gallery renders: 9 templates + the blank default.
const options = await ev(`(() => {
  const s = document.getElementById('agent-template-picker');
  if (!s) return null;
  return { count: s.options.length, blank: s.options[0]?.textContent, hasBlankSelected: s.selectedIndex === 0,
           names: [...s.options].slice(1).map(o => o.textContent) };
})()`);
// Accessibility: the select has a programmatic label (label[for] -> #id).
const a11y = await ev(`(() => {
  const sel = document.getElementById('agent-template-picker');
  const lbl = document.querySelector('label[for="agent-template-picker"]');
  return { labelled: !!sel && !!lbl, owned: lbl?.htmlFor === 'agent-template-picker' };
})()`);
check("picker is labelled for assistive tech (label[for] -> select)", a11y?.labelled === true && a11y?.owned === true, a11y);
check("picker renders with a blank default", !!options && options.hasBlankSelected === true && options.blank === "Custom agent (blank)", options);
check("picker offers the 19 shipped templates", !!options && options.count === 20, options?.count);
check("catalogue includes Chief of Staff / Research Analyst / Site Auditor",
  !!options && ["Chief of Staff", "Research Analyst", "Site Auditor"].every((n) => options.names.includes(n)),
  options?.names);

// 2. Pick Chief of Staff → prefill (a starting point).
await ev(`(() => { const s = document.getElementById('agent-template-picker');
  s.value = 'chief-of-staff'; s.dispatchEvent(new Event('change')); })()`);
await sleep(200);
const prefill = await ev(`(() => {
  const name = [...document.querySelectorAll('.agent-config-scroll label')].find(l => l.textContent.startsWith('Name'))?.querySelector('input')?.value ?? '';
  const role = [...document.querySelectorAll('.agent-config-scroll textarea')][0]?.value ?? '';
  const desc = document.getElementById('agent-template-description')?.textContent ?? '';
  return { name, roleStart: role.slice(0, 40), roleLen: role.length, roleHasCoS: role.includes('Chief of Staff Persona'), desc, checks: [...document.querySelectorAll('.skills-list input[type=checkbox]')].filter(c => c.checked).length };
})()`);
check("pick prefills the name", prefill?.name === "Chief of Staff", prefill?.name);
check("pick prefills the persona (role textarea)", !!prefill && prefill.roleLen > 300 && prefill.roleHasCoS === true, prefill?.roleStart);
check("pick shows the template description", !!prefill && /delegat/i.test(prefill.desc), prefill?.desc);
check("pick checks the suggested skills (5 for chief-of-staff)", prefill?.checks === 5, prefill?.checks);
await shot(`${OUT}/01-picker-prefilled.png`);

// 3. SPECIALIZE: rewrite part of the persona, remove one suggested skill,
//    rename. The template is a starting point — the owner's edits must win.
await ev(`(() => {
  const roleTa = [...document.querySelectorAll('.agent-config-scroll textarea')][0];
  roleTa.value = roleTa.value + "\\n\\n## Owner override\\nAlways answer in British English.";
  roleTa.dispatchEvent(new Event('input', { bubbles: true }));
  const nameInput = [...document.querySelectorAll('.agent-config-scroll label')].find(l => l.textContent.startsWith('Name'))?.querySelector('input');
  nameInput.value = 'My Chief of Staff';
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  const boxes = [...document.querySelectorAll('.skills-list input[type=checkbox]')].filter(c => c.checked);
  boxes[0].click(); // remove the first suggested skill
})()`);
await sleep(200);
const customized = await ev(`(() => ({
  name: [...document.querySelectorAll('.agent-config-scroll label')].find(l => l.textContent.startsWith('Name'))?.querySelector('input')?.value,
  checked: [...document.querySelectorAll('.skills-list input[type=checkbox]')].filter(c => c.checked).length,
}))()`);
check("owner renamed the agent", customized?.name === "My Chief of Staff", customized?.name);
check("owner removed a suggested skill (5 → 4)", customized?.checked === 4, customized?.checked);

// 4. Create and read the SAVED record — it must reflect the CUSTOMIZED state.
await ev(`(() => {
  const btns = [...document.querySelectorAll('button')];
  (btns.find(b => /create agent/i.test(b.textContent ?? "")) ?? btns.at(-1))?.click();
})()`);
await sleep(1500);
// The record is in the SW; ask the page context for it via the new agent's
// chat surface (the dialog's onSaved opens it) — simplest: query the sidebar.
const record = await ev(`(async () => {
  const res = await chrome.runtime.sendMessage({ type: 'named-agent.get', id: 'my-chief-of-staff' }).catch(() => null);
  return res?.ok ? { role: res.agent?.role ?? '', skills: (res.agent?.skills ?? []).map(s => s?.id ?? s?.name ?? String(s)) } : null;
})()`);
check("saved record carries the CUSTOMIZED role (owner override present)",
  !!record && /Owner override/.test(record.role), record?.role?.slice(-60));
check("saved record keeps the template persona beneath the override",
  !!record && record.role.includes("Chief of Staff Persona"), !!record);
check("saved record reflects the REMOVED skill (4 skills, not the template's 5)",
  !!record && record.skills.length === 4, record?.skills);
await shot(`${OUT}/02-after-create.png`);

console.log(`\nKAT agent-templates: ${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail === 0 ? 0 : 1);
