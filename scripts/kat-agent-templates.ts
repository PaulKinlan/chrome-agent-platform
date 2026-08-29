// kat-agent-templates.ts — agent template picker KAT (real browser).
// Proves docs/AGENT-PRODUCT-GAPS.md G2 end to end:
//   1. the create-agent dialog renders the template gallery (21 templates +
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
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-agent-templates`;
const CHROMIUM = "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The debugging port is assigned by the kernel and read back from THIS Chrome's
// stderr — a fixed port silently attaches the harness to another lane's browser.
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-agent-templates-${Date.now()}`, "about:blank"],
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
// MV3 registers the worker a beat after the browser is reachable — wait for
// it rather than depending on how long the CDP handshake happened to take.
const sw = await waitForServiceWorker(send);
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

// Attach to the SERVICE WORKER too — the real-alarm assertions (a schedule
// must mint a live chrome.alarms entry, not just a store row) evaluate
// chrome.alarms in the SW context.
const { result: { sessionId: swSession } } = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
await send("Runtime.enable", {}, swSession);
const evSw = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, swSession)).result?.result?.value;
const alarms = async () => (await evSw(`chrome.alarms.getAll().then(a => a.map(x => ({ name: x.name, periodInMinutes: x.periodInMinutes ?? null })))`)) ?? [];

// 0. FIRST-RUN OFFER (owner directive): a fresh profile with zero agents shows
//    the one-click starter action in the empty state. Clicking it creates the
//    curated seven as REAL agents (never automatic — the owner clicked).
const emptyOffer = await ev(`(() => {
  const btn = document.getElementById('add-starter-agents');
  return { present: !!btn, label: btn?.textContent ?? null };
})()`);
check("first-run empty state offers Add starter agents (one click, not automatic)", emptyOffer?.present === true && /starter agents/i.test(emptyOffer.label ?? ""), emptyOffer);
await ev(`document.getElementById('add-starter-agents')?.click()`);
await sleep(4000); // seven creates + avatar follow-ups settle
const starters = await ev(`(async () => {
  const res = await chrome.runtime.sendMessage({ type: 'named-agent.list' }).catch(() => null);
  return (res?.agents ?? []).map(a => ({ id: a.id, name: a.name }));
})()`);
const STARTERS = ["chief-of-staff", "research-analyst", "advanced-web-developer", "site-auditor", "critic", "webapp-test-pilot", "skill-smith"];
// Agent ids derive from the template NAME (e.g. "Skill Smith (Recipe Author)"
// → skill-smith-recipe-author) — assert by name against the catalogue.
const starterNames = await ev(`(async () => {
  const { AGENT_TEMPLATES } = await import(chrome.runtime.getURL('lib/agent-templates.js'));
  return AGENT_TEMPLATES.filter(t => ${JSON.stringify(STARTERS)}.includes(t.id)).map(t => t.name);
})()`);
check("Add starter agents creates the curated seven as real agents",
  (starterNames ?? []).every((n: string) => (starters ?? []).some((a: any) => a.name === n)), starters);
// None of the seven starters is scheduled — no agent:<id> alarms may exist.
const starterAlarms = (await alarms()).filter((a: any) => STARTERS.some((s) => a.name === `agent:${s}`));
check("starter agents are on-demand (no schedule alarms minted)", starterAlarms.length === 0, starterAlarms);
// The empty state is gone — the agents list shows rows now.
const rowsAfterSeed = await ev(`document.querySelectorAll('#named-agents capability-row').length`);
check("the agents list shows the seeded agents (empty state replaced)", (rowsAfterSeed ?? 0) >= 7, rowsAfterSeed);

// Open the create-agent dialog.
await ev(`document.getElementById('new-agent')?.click()`);
await sleep(700);

// 1. The visual gallery renders every shipped template. The blank form itself
// is the custom-agent default; cards are optional starting points.
const cards = await ev(`(() => {
  const gallery = document.getElementById('agent-template-gallery');
  const items = [...(gallery?.querySelectorAll('agent-template-card') ?? [])];
  return { count: items.length, labelled: gallery?.getAttribute('aria-label') ?? '',
    names: items.map((card) => card.template?.name ?? ''),
    blankName: [...document.querySelectorAll('.agent-config-scroll label')].find((label) => label.textContent.startsWith('Name'))?.querySelector('input')?.value ?? '',
    labelledUse: items.every((card) => /Use .+ template/.test(card.shadowRoot?.querySelector('.use')?.getAttribute('aria-label') ?? '')) };
})()`);
check("visual picker is labelled for assistive tech and every Use button names its template", /Agent templates/.test(cards?.labelled ?? '') && cards?.labelledUse === true, cards);
check("the untouched form remains the custom-agent blank default", cards?.blankName === '', cards?.blankName);
check("picker offers the 21 shipped templates", cards?.count === 21, cards?.count);
check("catalogue includes Chief of Staff / Research Analyst / Advanced Web Developer / Site Auditor",
  !!cards && ["Chief of Staff", "Research Analyst", "Advanced Web Developer", "Site Auditor"].every((n) => cards.names.includes(n)),
  cards?.names);

// 2. Use Chief of Staff → prefill (a starting point).
await ev(`(() => { const card = [...document.querySelectorAll('#agent-template-gallery agent-template-card')].find((el) => el.template?.id === 'chief-of-staff');
  card?.shadowRoot?.querySelector('.use')?.click(); })()`);
await sleep(200);
const prefill = await ev(`(() => {
  const name = [...document.querySelectorAll('.agent-config-scroll label')].find(l => l.textContent.startsWith('Name'))?.querySelector('input')?.value ?? '';
  const role = [...document.querySelectorAll('.agent-config-scroll textarea')][0]?.value ?? '';
  const desc = [...document.querySelectorAll('#agent-template-gallery agent-template-card')].find((el) => el.template?.id === 'chief-of-staff')?.shadowRoot?.querySelector('.persona')?.textContent ?? '';
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

// 5. P1-a: the first-task suggestion lands in the VISIBLE composer (the opened
//    agent view's #thread-composer), never the hidden hub #composer.
await sleep(700);
const composers = await ev(`(() => ({
  thread: document.getElementById('thread-composer')?.value ?? null,
  hub: document.getElementById('composer')?.value ?? null,
  threadVisible: (() => { const el = document.getElementById('thread-view'); return !!el && !el.hidden && getComputedStyle(el).display !== 'none'; })(),
}))()`);
check("the first-task suggestion lands in the VISIBLE thread composer",
  !!composers && composers.threadVisible === true && typeof composers.thread === "string" && /Brief me:/i.test(composers.thread), composers);
check("the hidden hub composer stays EMPTY (the suggestion is never stranded)",
  !!composers && (composers.hub === "" || composers.hub === null), composers?.hub);

// 6. UNIFIED AGENT MODEL (owner directive): one creation flow with an OPTIONAL
//    schedule. Picking a background template prefills the schedule field;
//    creating mints a REAL recurring alarm on the SAME agent record.
//
//    Precondition on THIS base: the "Scheduled tasks" capability (chrome alarms
//    permission) is opt-in until the P0 permanent-permissions lane lands —
//    grant it the way the owner would: a REAL click on its Settings row.
const optT = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
const optS = await send("Target.attachToTarget", { targetId: optT.result.targetId, flatten: true });
const optSession = optS.result.sessionId;
await send("Runtime.enable", {}, optSession);
const evOpt = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, optSession)).result?.result?.value;
for (let i = 0; i < 40; i++) {
  const n = await evOpt(`document.querySelectorAll('.grant-perm[data-capability="alarms"]').length`);
  if (Number(n) >= 1) break;
  await sleep(200);
}
const grantRect = await evOpt(`(() => { const el = document.querySelector('.grant-perm[data-capability="alarms"]'); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
if (grantRect) {
  const gx = Math.round(grantRect.x), gy = Math.round(grantRect.y);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: gx, y: gy, button: "left", clickCount: 1 }, optSession);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: gx, y: gy, button: "left", clickCount: 1 }, optSession);
}
await sleep(1200);
const alarmsGranted = await evOpt(`chrome.permissions.contains({ permissions: ['alarms'] }).then(r => !!r).catch(() => false)`);
check("the Scheduled tasks capability grants via a real Settings click (KAT precondition)", alarmsGranted === true, alarmsGranted);
await send("Target.closeTarget", { targetId: optT.result.targetId });
await ev(`document.getElementById('thread-back')?.click()`);
await sleep(400);
await ev(`document.getElementById('new-agent')?.click()`);
await sleep(700);
await ev(`(() => { const card = [...document.querySelectorAll('#agent-template-gallery agent-template-card')].find((el) => el.template?.id === 'tab-janitor');
  card?.shadowRoot?.querySelector('.use')?.click(); })()`);
await sleep(200);
const schedPrefill = await ev(`document.getElementById('agent-schedule-minutes')?.value ?? null`);
check("a background template prefills the schedule field (120 min for tab-janitor)", schedPrefill === "120", schedPrefill);
await ev(`(() => {
  const btns = [...document.querySelectorAll('button')];
  (btns.find(b => /create agent/i.test(b.textContent ?? "")) ?? btns.at(-1))?.click();
})()`);
await sleep(1500);
const janitor = await ev(`(async () => {
  const res = await chrome.runtime.sendMessage({ type: 'named-agent.get', id: 'tab-janitor' }).catch(() => null);
  const list = await chrome.runtime.sendMessage({ type: 'named-agent.list' }).catch(() => null);
  const row = (list?.agents ?? []).find(a => a.id === 'tab-janitor');
  const tasks = await chrome.runtime.sendMessage({ type: 'task.list' }).catch(() => null);
  const sched = (tasks?.tasks ?? []).find(t => t.name === 'agent:tab-janitor');
  return { exists: res?.ok === true, listedSchedule: row?.schedule?.periodInMinutes ?? null,
           taskEntry: sched ? { periodInMinutes: sched.periodInMinutes, hasPrompt: (sched.task ?? '').length > 10 } : null };
})()`);
check("the background-template agent is a REAL named agent (one concept, no separate store path in the UI)", janitor?.exists === true, janitor);
check("the agents list carries its schedule (the chip's data source)", janitor?.listedSchedule === 120, janitor?.listedSchedule);
check("a REAL scheduled task exists (agent:tab-janitor, 120 min, recurring prompt)",
  janitor?.taskEntry?.periodInMinutes === 120 && janitor?.taskEntry?.hasPrompt === true, janitor?.taskEntry);
const janitorAlarm = (await alarms()).find((a: any) => a.name === "agent:tab-janitor");
check("a LIVE chrome.alarms entry backs the schedule (not just a store row)", janitorAlarm?.periodInMinutes === 120, janitorAlarm);
const chipRow = await ev(`(() => {
  const rows = [...document.querySelectorAll('#named-agents capability-row')];
  const row = rows.find(r => (r.getAttribute('name') ?? '') === 'Tab Janitor');
  return row ? { lastRun: row.getAttribute('last-run') } : null;
})()`);
check("the agents list shows the schedule chip ('every 120 min') with no background segregation", chipRow?.lastRun === "every 120 min", chipRow);

// 6b. P1-b: REOPENING the scheduled agent's edit dialog shows the real
//     schedule (named-agent.get shares the list's enrichment). The create
//     flow left us in Tab Janitor's agent view — open its Edit dialog.
await ev(`document.getElementById('edit-agent')?.click()`);
await sleep(700);
const reopen = await ev(`(() => {
  const f = document.getElementById('agent-schedule-minutes');
  return { field: f?.value ?? null };
})()`);
check("reopening a SCHEDULED agent's edit dialog shows the real schedule (120)", reopen?.field === "120", reopen);
// Close without saving (Cancel) — the schedule must remain untouched.
await ev(`(() => { const b = [...document.querySelectorAll('agent-dialog button')].find(x => /^cancel$/i.test((x.textContent ?? '').trim())); b?.click(); })()`);
await sleep(400);
const janitorAfterCancel = (await alarms()).find((a: any) => a.name === "agent:tab-janitor");
check("Cancel leaves the schedule untouched", janitorAfterCancel?.periodInMinutes === 120, janitorAfterCancel);

// 7. SCHEDULE EDIT on an existing ON-DEMAND agent (add → alarm appears; remove
//    → alarm gone, agent stays) — driven through the real edit dialog.
await ev(`document.getElementById('thread-back')?.click()`);
await sleep(300);
// Open My Chief of Staff's agent view from the list, then its Edit dialog.
await ev(`(() => {
  const rows = [...document.querySelectorAll('#named-agents capability-row')];
  const row = rows.find(r => (r.getAttribute('name') ?? '') === 'My Chief of Staff');
  row?.dispatchEvent(new CustomEvent('open'));
})()`);
await sleep(800);
await ev(`document.getElementById('edit-agent')?.click()`);
await sleep(600);
const editDialogOpen = await ev(`(() => {
  const f = document.getElementById('agent-schedule-minutes');
  return { open: !!f, initial: f?.value ?? null };
})()`);
check("the edit dialog shows the schedule field, empty for an on-demand agent", editDialogOpen?.open === true && editDialogOpen.initial === "", editDialogOpen);
await ev(`(() => {
  const f = document.getElementById('agent-schedule-minutes');
  f.value = '45'; f.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await ev(`(() => {
  const btns = [...document.querySelectorAll('agent-dialog button')];
  (btns.find(b => /^save$/i.test((b.textContent ?? '').trim())) ?? btns.at(-1))?.click();
})()`);
await sleep(1200);
const afterAdd = (await alarms()).find((a: any) => a.name === "agent:my-chief-of-staff");
check("adding a schedule to an existing on-demand agent mints the alarm", afterAdd?.periodInMinutes === 45, afterAdd);
// Remove it again — the alarm goes, the agent stays.
await ev(`(async () => { await chrome.runtime.sendMessage({ type: 'named-agent.set-schedule', id: 'my-chief-of-staff', periodInMinutes: null }); })()`);
await sleep(1000);
const afterRemove = (await alarms()).find((a: any) => a.name === "agent:my-chief-of-staff");
const stillThere = await ev(`(async () => {
  const res = await chrome.runtime.sendMessage({ type: 'named-agent.get', id: 'my-chief-of-staff' }).catch(() => null);
  return res?.ok === true;
})()`);
check("removing the schedule clears the alarm (agent:my-chief-of-staff gone)", !afterRemove, afterRemove);
check("the agent itself SURVIVES the schedule removal", stillThere === true, stillThere);

// 8. P1-c COLLISION (the unified list renders a same-id record ONCE):
//    `price-watcher` exists as BOTH a background recipe AND a template. Enable
//    the recipe AND create the agent from the template — one row, one sidebar
//    item, named record wins (avatar + chat), schedule chip from the agent.
await ev(`document.getElementById('thread-back')?.click()`);
await sleep(300);
await ev(`(async () => { await chrome.runtime.sendMessage({ type: 'background-agent.set', id: 'price-watcher', enabled: true }); })()`);
await sleep(600);
await ev(`document.getElementById('new-agent')?.click()`);
await sleep(700);
await ev(`(() => { const card = [...document.querySelectorAll('#agent-template-gallery agent-template-card')].find((el) => el.template?.id === 'price-watcher');
  card?.shadowRoot?.querySelector('.use')?.click(); })()`);
await sleep(200);
const pwPrefill = await ev(`document.getElementById('agent-schedule-minutes')?.value ?? null`);
check("the price-watcher template prefills its schedule (60 min)", pwPrefill === "60", pwPrefill);
// Force the REAL collision: the agent's id derives from its NAME — rename to
// the recipe's exact name ("Price watcher") so the agent id IS the recipe id.
await ev(`(() => {
  const nameInput = [...document.querySelectorAll('.agent-config-scroll label')].find(l => l.textContent.startsWith('Name'))?.querySelector('input');
  nameInput.value = 'Price watcher';
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await ev(`(() => {
  const btns = [...document.querySelectorAll('button')];
  (btns.find(b => /create agent/i.test(b.textContent ?? "")) ?? btns.at(-1))?.click();
})()`);
await sleep(1500);
const collision = await ev(`(() => {
  const main = [...document.querySelectorAll('#named-agents capability-row')].filter(r => (r.getAttribute('name') ?? '') === 'Price watcher');
  const side = [...document.querySelectorAll('#side-agents .agent-item')].filter(b => (b.textContent ?? '').includes('Price watcher'));
  return { mainRows: main.length, mainChip: main[0]?.getAttribute('last-run') ?? null,
           mainHasAvatar: !!main[0]?.getAttribute('icon'), sideRows: side.length,
           sideHasBackgroundLabel: side.some(b => (b.textContent ?? '').includes('background')) };
})()`);
check("a same-id record in BOTH stores renders exactly ONCE in the main list", collision?.mainRows === 1, collision);
check("the collision row is the NAMED agent (avatar + its own 60-min schedule chip beats the recipe's 360)",
  collision?.mainHasAvatar === true && collision?.mainChip === "every 60 min", collision);
check("the sidebar renders the collision once, with no 'background' label",
  collision?.sideRows === 1 && collision?.sideHasBackgroundLabel === false, collision);
const bothAlarms = (await alarms()).filter((a: any) => a.name === "agent:price-watcher" || a.name === "recipe:price-watcher");
check("both schedules genuinely exist under the hood (agent: + recipe: families)",
  bothAlarms.length === 2, bothAlarms);
const countText = await ev(`document.getElementById('agent-count')?.textContent ?? ''`);
check("the agent count is unified (no named/background split)", /agents? ·/.test(countText) && !/background/.test(countText), countText);

console.log(`\nKAT agent-templates: ${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail === 0 ? 0 : 1);
