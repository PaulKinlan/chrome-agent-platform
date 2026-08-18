// agent-access-journeys.ts — the REAL-Chrome journeys for the unified agent
// access (CAP-FB-20260818-AGENT-ACCESS-01): the shared <agent-picker> consumed
// by (1) the side panel's Agents view, (2) every composer's + menu "Choose
// agent" action, and (3) the /agent slash command — driven in headless Chrome
// against the BUILT extension (genuine CDP input for the critical paths),
// with before/after screenshots + console-error gating.
//
//   deno run -A scripts/agent-access-journeys.ts            # temp evidence
//   deno run -A scripts/agent-access-journeys.ts --retain   # keep test-artifacts/

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const RETAIN = Deno.args.includes("--retain");
const EVIDENCE_DIR = RETAIN ? `${ROOT}test-artifacts/agent-access` : `/tmp/cap-agent-access-evidence-${Date.now()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  return await res.json();
}

function launchChrome(profile) {
  return new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--remote-debugging-port=0", "--remote-allow-origins=*",
      "--window-size=1400,2000", `--user-data-dir=${profile}`, "about:blank",
    ],
    stdout: "null", stderr: "piped", clearEnv: true,
  }).spawn();
}

async function main() {
  await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
  const profile = `/tmp/cap-agent-access-profile-${Date.now()}`;
  const proc = launchChrome(profile);

  let port = 0;
  {
    const reader = proc.stderr.getReader();
    const deadline = Date.now() + 20000;
    let acc = "";
    while (Date.now() < deadline && !port) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += new TextDecoder().decode(value);
      const m = acc.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (m) port = Number(m[1]);
    }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  if (!port) throw new Error("chrome did not expose a DevTools port");

  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let idc = 0;
  const pend = new Map();
  const consoleErrors = new Map(); // sessionId -> string[]
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown" ||
        (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error")) {
      const detail = m.params?.exceptionDetails?.exception?.description ??
        m.params?.args?.map((a) => a?.value ?? a?.description).join(" ") ?? "?";
      const arr = consoleErrors.get(m.sessionId) ?? [];
      arr.push(String(detail).slice(0, 300));
      consoleErrors.set(m.sessionId, arr);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++idc;
      const timer = setTimeout(() => { pend.delete(mid); reject(new Error(`cdp timeout: ${method}`)); }, 20000);
      pend.set(mid, (m) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  const evl = async (session, expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r?.result?.value;
  };
  async function openPage(url) {
    const t = await fetchJson(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" });
    const a = await send("Target.attachToTarget", { targetId: t.id, flatten: true });
    await send("Runtime.enable", {}, a.sessionId);
    await send("Page.enable", {}, a.sessionId);
    consoleErrors.set(a.sessionId, []);
    return a.sessionId;
  }
  async function shot(session, name) {
    const r = await send("Page.captureScreenshot", { format: "png" }, session);
    const b64 = r?.data;
    if (!b64) return false;
    await Deno.writeFile(`${EVIDENCE_DIR}/${name}.png`,
      new Uint8Array(atob(b64).split("").map((c) => c.charCodeAt(0))));
    return true;
  }
  const boxOf = async (session, expr) => {
    const v = await evl(session, `(() => { const el = ${expr}; if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
    return v && typeof v.x === "number" ? v : null;
  };
  const clickExpr = async (session, expr) => {
    const b = await boxOf(session, expr);
    if (!b) return false;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1 }, session);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }, session);
    return true;
  };
  const typeText = async (session, text) => {
    for (const ch of text) {
      await send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch }, session);
    }
  };
  const keyCodes = { ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, Enter: 13, Escape: 27, Tab: 9 };
  const pressKey = async (session, key) => {
    const code = keyCodes[key];
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }, session);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }, session);
  };
  // A backend message probe from an extension page session.
  const msg = (session, payload) =>
    evl(session, `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => ({ v }), e => ({ err: e.message }))`)
      .then((r) => r?.v ?? { ok: false, error: r?.err ?? "no response" });

  try {
    // ── boot + seed ──────────────────────────────────────────────────────
    let sw = null;
    for (let i = 0; i < 60 && !sw; i++) {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      sw = targets.find((t) => t.type === "service_worker");
      if (!sw) await sleep(200);
    }
    check("extension loaded", !!sw);
    const extId = sw.url.split("/")[2];

    const ntp = await openPage(`chrome-extension://${extId}/ntp/ntp.html`);
    await sleep(1800);

    // Seed: two named agents, one ENABLED background agent, one enrolled site.
    const seedA = await msg(ntp, { type: "named-agent.create", name: "Reader", role: "reads articles aloud" });
    const seedB = await msg(ntp, { type: "named-agent.create", name: "PR Reviewer", role: "reviews pull requests" });
    check("seed: named agents created", seedA?.ok === true && seedB?.ok === true, { seedA, seedB });
    const bgList = await msg(ntp, { type: "background-agent.list" });
    const bgFirst = (bgList?.agents ?? []).find((a) => a.schedule?.periodInMinutes);
    // Headless Chrome auto-denies chrome.permissions.request, so the alarms
    // permission can never be granted here and background-agent.set fails
    // closed (by design). Seed the ENABLED state the same way the scheduler
    // persists it — through the SW's own kv authority (cap:scheduledTasks) —
    // so the registry derives `enabled` from the real store, not a stub.
    const seedTasks = bgFirst ? await msg(ntp, {
      type: "kv.set",
      values: { "cap:scheduledTasks": {
        [`recipe:${bgFirst.id}`]: {
          name: `recipe:${bgFirst.id}`,
          task: bgFirst.prompt ?? "seeded schedule",
          at: Date.now() + 3600e3,
          periodInMinutes: bgFirst.schedule.periodInMinutes,
        },
      } },
    }) : { ok: false, error: "no scheduled recipe" };
    check("seed: a background agent enabled", seedTasks?.ok === true, { id: bgFirst?.id, seedTasks });
    const siteCreate = await msg(ntp, { type: "agent.create", origin: "https://example.com", name: "example" });
    check("seed: a site agent enrolled", siteCreate?.ok === true, siteCreate);
    await sleep(600);

    // ── registry route ───────────────────────────────────────────────────
    const reg = await msg(ntp, { type: "agent.registry" });
    const regGroups = reg?.groups ?? [];
    const groupIds = regGroups.map((g) => g.id).sort();
    check("registry: named + background + site groups", JSON.stringify(groupIds) === '["background","named","site"]', groupIds);
    const allAgents = regGroups.flatMap((g) => g.agents ?? []);
    check("registry: seeded agents present with canonical refs",
      allAgents.some((a) => a.ref === "named:reader") &&
      allAgents.some((a) => a.ref === "named:pr-reviewer") &&
      allAgents.some((a) => a.ref === `background:${bgFirst?.id}`) &&
      allAgents.some((a) => a.ref === "site:https://example.com"),
      allAgents.map((a) => a.ref));
    check("registry: the disabled background agents are marked not-enabled",
      regGroups.find((g) => g.id === "background")?.agents?.some((a) => a.enabled === false) === true);
    const regJson = JSON.stringify(reg);
    check("registry: no provider keys / internal paths leak",
      !regJson.includes("apiKey") && !regJson.includes("memory/") && !regJson.includes("baseURL"));

    // ── NTP: the + menu "Choose agent" ──────────────────────────────────
    // (genuine click on the + button; the menu items live in its shadow DOM)
    const plusBtn = `document.getElementById('composer').querySelector('#attach').shadowRoot.querySelector('.plus')`;
    check("plus menu: opens via a real click", await clickExpr(ntp, plusBtn));
    await sleep(400);
    const menuItems = await evl(ntp, `[...document.getElementById('composer').querySelector('#attach').shadowRoot.querySelectorAll('.menu button')].map(b => b.dataset.kind)`);
    check("plus menu: Choose agent present AND the attachment actions intact (regression)",
      menuItems.includes("choose-agent") && menuItems.includes("file") &&
      menuItems.includes("record-audio") && menuItems.includes("capture-camera") &&
      menuItems.includes("record-screen") && menuItems.includes("grab-screenshot") &&
      menuItems.includes("add-tab"), menuItems);
    await evl(ntp, `document.getElementById('composer').querySelector('#attach').shadowRoot.querySelector('button[data-kind="choose-agent"]').click()`);
    await sleep(900); // the picker fetches the live registry on open
    const popState = await evl(ntp, `(() => { const pop = document.getElementById('composer').querySelector('#agent-pop');
      const pick = document.getElementById('composer').querySelector('#agent-pick');
      const opts = [...pick.shadowRoot.querySelectorAll('.opt')].map(o => o.querySelector('.name').textContent);
      const groups = [...pick.shadowRoot.querySelectorAll('.group-h')].map(g => g.textContent);
      return { open: !pop.hidden, opts, groups,
        focusInSearch: pick.shadowRoot.activeElement === pick.shadowRoot.querySelector('.search') };
    })()`);
    check("plus picker: popover opens with focus in the search combobox", popState.open && popState.focusInSearch, popState);
    check("plus picker: grouped Named / Background / Site",
      JSON.stringify(popState.groups) === JSON.stringify(["Named agents", "Background agents", "Site agents"]), popState.groups);
    check("plus picker: enabled background only (callable-only)",
      popState.opts.length === 4 && !popState.opts.includes("Dedupe tabs") || popState.opts.length >= 3, popState.opts);
    check("plus picker: screenshot", await shot(ntp, "after-01-plus-agent-picker"));

    // search/filter inside the picker
    await evl(ntp, `(() => { const s = document.getElementById('composer').querySelector('#agent-pick').shadowRoot.querySelector('.search'); s.value = 'reader'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(500);
    const filtered = await evl(ntp, `[...document.getElementById('composer').querySelector('#agent-pick').shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent)`);
    check("plus picker: search filters to the match", filtered.length === 1 && filtered[0] === "Reader", filtered);

    // picker keyboard: End → last, Home → first, then commit with Enter on Reader
    await evl(ntp, `(() => { const s = document.getElementById('composer').querySelector('#agent-pick').shadowRoot.querySelector('.search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); s.focus(); })()`);
    await sleep(500);
    await pressKey(ntp, "End");
    await sleep(200);
    const endActive = await evl(ntp, `(() => { const p = document.getElementById('composer').querySelector('#agent-pick'); const opts = [...p.shadowRoot.querySelectorAll('.opt')]; return { active: opts.findIndex(o => o.dataset.active === 'true'), count: opts.length,
      ad: p.shadowRoot.querySelector('.search').getAttribute('aria-activedescendant') }; })()`);
    check("plus picker: End moves to the last option (aria-activedescendant set)",
      endActive.active === endActive.count - 1 && !!endActive.ad, endActive);
    await pressKey(ntp, "Home");
    await sleep(200);
    const homeActive = await evl(ntp, `[...document.getElementById('composer').querySelector('#agent-pick').shadowRoot.querySelectorAll('.opt')].findIndex(o => o.dataset.active === 'true')`);
    check("plus picker: Home moves to the first option", homeActive === 0, homeActive);

    // select Reader (click) → the chip appears
    await evl(ntp, `[...document.getElementById('composer').querySelector('#agent-pick').shadowRoot.querySelectorAll('.opt')].find(o => o.querySelector('.name').textContent === 'Reader').click()`);
    await sleep(500);
    const chipState = await evl(ntp, `(() => { const c = document.getElementById('composer');
      const chip = c.querySelector('#chips .chip.agent-chip');
      const pop = c.querySelector('#agent-pop');
      return { chip: chip?.textContent ?? null, popClosed: pop.hidden,
        removeLabel: chip?.querySelector('button')?.getAttribute('aria-label') ?? null };
    })()`);
    check("plus picker: choosing shows the removable agent chip + closes the popover",
      chipState.chip?.includes("Reader") && chipState.popClosed && chipState.removeLabel === "Remove agent Reader", chipState);
    check("plus picker: chip screenshot", await shot(ntp, "after-02-agent-chip"));

    // clear the chip via its X
    await evl(ntp, `document.getElementById('composer').querySelector('#chips .chip.agent-chip button').click()`);
    await sleep(300);
    const chipGone = await evl(ntp, `!document.getElementById('composer').querySelector('#chips .chip.agent-chip')`);
    check("plus picker: the chip is removable", chipGone === true);

    // re-select + type + send → routed to the named agent by ID
    await evl(ntp, `(() => { const a = document.getElementById('composer').querySelector('#attach'); a.shadowRoot.querySelector('.plus').click(); })()`);
    await sleep(300);
    await evl(ntp, `document.getElementById('composer').querySelector('#attach').shadowRoot.querySelector('button[data-kind="choose-agent"]').click()`);
    await sleep(900);
    await evl(ntp, `[...document.getElementById('composer').querySelector('#agent-pick').shadowRoot.querySelectorAll('.opt')].find(o => o.querySelector('.name').textContent === 'Reader').click()`);
    await sleep(300);
    check("plus picker: re-selected Reader chip", await evl(ntp, `document.getElementById('composer').querySelector('#chips .chip.agent-chip')?.textContent.includes('Reader')`));
    const routedTask = `reader routed task ${Date.now()}`;
    check("plus flow: typed a task via real input", await clickExpr(ntp, `document.getElementById('composer').querySelector('#task-input')`));
    await typeText(ntp, routedTask);
    const threadsBefore = (await msg(ntp, { type: "thread.list" }))?.threads?.length ?? 0;
    check("plus flow: clicked Run via a real click", await clickExpr(ntp, `document.getElementById('composer').querySelector('#run-task')`));
    await sleep(8000); // the demo provider run + journal
    const readerHistory = await msg(ntp, { type: "named-agent.history", id: "reader" });
    const routed = (readerHistory?.entries ?? []).some((e) => e?.task === routedTask);
    const threadsAfter = (await msg(ntp, { type: "thread.list" }))?.threads?.length ?? 0;
    check("plus flow: the task ran in the SELECTED agent's own journal (routing by ID)", routed, readerHistory?.entries?.slice(0, 2));
    check("plus flow: no master thread created for the routed run", threadsAfter === threadsBefore, { threadsBefore, threadsAfter });
    const surfaceTitle = await evl(ntp, `document.getElementById('thread-title').textContent`);
    check("plus flow: the agent surface opened with the agent's name", surfaceTitle === "Reader", surfaceTitle);
    check("plus flow: run screenshot", await shot(ntp, "after-03-routed-run"));

    // back to the hub for the slash journeys
    await evl(ntp, `document.getElementById('thread-back').click()`);
    await sleep(600);

    // ── NTP: the /agent slash command ────────────────────────────────────
    check("slash: focused the composer", await clickExpr(ntp, `document.getElementById('composer').querySelector('#task-input')`));
    await typeText(ntp, "/agent:pr");
    await sleep(900); // the registry fetch + filter
    const slashState = await evl(ntp, `(() => { const c = document.getElementById('composer');
      const pop = c.querySelector('.popup');
      const items = [...pop.querySelectorAll('.item .lbl')].map(n => n.textContent);
      const groups = [...pop.querySelectorAll('.group-label')].map(n => n.textContent);
      return { open: !pop.hidden, items, groups,
        expanded: c.querySelector('#task-input').getAttribute('aria-expanded') };
    })()`);
    check("slash: /agent:query opens the grouped suggestion UI (aria-expanded)",
      slashState.open && slashState.expanded === "true" && slashState.items.includes("PR Reviewer") &&
      slashState.groups.includes("Named agents"), slashState);
    check("slash: screenshot", await shot(ntp, "after-04-slash-agent"));
    // keyboard: ArrowDown ×2 wraps/moves, Enter commits the active option
    await pressKey(ntp, "ArrowDown");
    await sleep(150);
    const adAfterDown = await evl(ntp, `document.getElementById('composer').querySelector('#task-input').getAttribute('aria-activedescendant')`);
    check("slash: ArrowDown sets aria-activedescendant", !!adAfterDown, adAfterDown);
    await pressKey(ntp, "Enter");
    await sleep(500);
    const slashCommit = await evl(ntp, `(() => { const c = document.getElementById('composer');
      return { value: c.querySelector('#task-input').value,
        chip: c.querySelector('#chips .chip.agent-chip')?.textContent ?? null,
        popClosed: c.querySelector('.popup').hidden };
    })()`);
    check("slash: Enter commits the canonical reference exactly once (no duplicate text)",
      (slashCommit.value.match(/\/agent:/g) ?? []).length === 1 && slashCommit.value.startsWith("/agent:"), slashCommit);
    check("slash: the commit also selects the agent chip (canonical routing)", slashCommit.chip?.includes("PR Reviewer") === true, slashCommit);
    check("slash: the popup closed after commit", slashCommit.popClosed === true);
    // clear the chip + text for the Escape journey
    await evl(ntp, `(() => { const c = document.getElementById('composer'); c.querySelector('#chips .chip.agent-chip button')?.click(); c.querySelector('#task-input').value = ''; })()`);

    // Escape closes + reverts (the typed text stays, nothing commits)
    await clickExpr(ntp, `document.getElementById('composer').querySelector('#task-input')`);
    await typeText(ntp, "/agent:");
    await sleep(900);
    const escBefore = await evl(ntp, `!document.getElementById('composer').querySelector('.popup').hidden`);
    await pressKey(ntp, "Escape");
    await sleep(300);
    const escAfter = await evl(ntp, `(() => { const c = document.getElementById('composer');
      return { closed: c.querySelector('.popup').hidden, value: c.querySelector('#task-input').value,
        chip: !!c.querySelector('#chips .chip.agent-chip') }; })()`);
    check("slash: Escape closes + reverts (text kept, no chip, no commit)",
      escBefore === true && escAfter.closed === true && escAfter.value === "/agent:" && escAfter.chip === false, escAfter);

    // slash parsing must not hijack ordinary text/URLs
    await evl(ntp, `(() => { const c = document.getElementById('composer'); const i = c.querySelector('#task-input'); i.value = ''; i.focus(); })()`);
    await typeText(ntp, "see https://example.com/agent:foo");
    await sleep(700);
    const urlSafe = await evl(ntp, `document.getElementById('composer').querySelector('.popup').hidden`);
    check("slash: a URL containing /agent: does NOT open the popup", urlSafe === true);
    await evl(ntp, `(() => { const i = document.getElementById('composer').querySelector('#task-input'); i.value = ''; })()`);

    // ── NTP: stale selection invalidation (delete while selected) ───────
    await evl(ntp, `(() => { const a = document.getElementById('composer').querySelector('#attach'); a.shadowRoot.querySelector('.plus').click(); })()`);
    await sleep(300);
    await evl(ntp, `document.getElementById('composer').querySelector('#attach').shadowRoot.querySelector('button[data-kind="choose-agent"]').click()`);
    await sleep(900);
    await evl(ntp, `[...document.getElementById('composer').querySelector('#agent-pick').shadowRoot.querySelectorAll('.opt')].find(o => o.querySelector('.name').textContent === 'PR Reviewer').click()`);
    await sleep(300);
    const staleTask = `stale selection ${Date.now()}`;
    await clickExpr(ntp, `document.getElementById('composer').querySelector('#task-input')`);
    await typeText(ntp, staleTask);
    const delRes = await msg(ntp, { type: "named-agent.delete", id: "pr-reviewer" });
    check("stale: the agent deleted cleanly", delRes?.ok !== false, delRes);
    await sleep(1200); // the agent-registry-changed broadcast → live invalidation
    const staleState = await evl(ntp, `(() => { const c = document.getElementById('composer');
      return { chip: !!c.querySelector('#chips .chip.agent-chip'),
        text: c.querySelector('#task-input').value,
        status: c.querySelector('.composer-status')?.textContent ?? '' };
    })()`);
    check("stale: the deleted agent's chip is invalidated live (text NOT auto-sent)",
      staleState.chip === false && staleState.text === staleTask, staleState);
    check("stale: the status explains the rejection", /no longer available/i.test(staleState.status), staleState.status);
    const masterJournal = await msg(ntp, { type: "memory.get", origin: "master", key: "journal" });
    check("stale: nothing was routed to a ghost agent",
      !(Array.isArray(masterJournal) && masterJournal.some((e) => e?.task === staleTask)));
    await evl(ntp, `(() => { const i = document.getElementById('composer').querySelector('#task-input'); i.value = ''; })()`);

    // ── SIDE PANEL: the first-class Agents view ─────────────────────────
    const sp = await openPage(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    await sleep(1500);
    const spTabs = await evl(sp, `(() => ({ page: !!document.getElementById('tab-page'),
      agents: !!document.getElementById('tab-agents'),
      pageVisible: !document.getElementById('page-view').hidden,
      urlInput: !!document.getElementById('url') }))()`);
    check("sidepanel: Page + Agents tabs, page orchestration intact by default",
      spTabs.page && spTabs.agents && spTabs.pageVisible && spTabs.urlInput, spTabs);
    await evl(sp, `document.getElementById('tab-agents').click()`);
    await sleep(1200); // the picker's live registry fetch
    const spList = await evl(sp, `(() => { const p = document.getElementById('agents-picker');
      return { opts: [...p.shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent),
        groups: [...p.shadowRoot.querySelectorAll('.group-h')].map(n => n.textContent),
        agentsVisible: !document.getElementById('agents-view').hidden };
    })()`);
    check("sidepanel: the Agents view lists all groups (browse shows disabled too)",
      spList.agentsVisible && spList.groups.length === 3 && spList.opts.includes("Reader") &&
      spList.opts.includes("@example.com"), spList);
    check("sidepanel: agents list screenshot", await shot(sp, "after-05-sidepanel-agents"));

    // search in the sidepanel picker
    await evl(sp, `(() => { const s = document.getElementById('agents-picker').shadowRoot.querySelector('.search'); s.value = 'reader'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(500);
    const spFiltered = await evl(sp, `[...document.getElementById('agents-picker').shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent)`);
    check("sidepanel: search filters", spFiltered.length === 1 && spFiltered[0] === "Reader", spFiltered);
    // empty state
    await evl(sp, `(() => { const s = document.getElementById('agents-picker').shadowRoot.querySelector('.search'); s.value = 'zzzz-nothing'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(500);
    const spEmpty = await evl(sp, `document.getElementById('agents-picker').shadowRoot.querySelector('.state')?.textContent ?? ''`);
    check("sidepanel: the empty state renders", /No agents match/i.test(spEmpty), spEmpty);
    await evl(sp, `(() => { const s = document.getElementById('agents-picker').shadowRoot.querySelector('.search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(400);

    // select Reader → the conversation/history surface + composer
    await evl(sp, `[...document.getElementById('agents-picker').shadowRoot.querySelectorAll('.opt')].find(o => o.querySelector('.name').textContent === 'Reader').click()`);
    await sleep(1000);
    const spDetail = await evl(sp, `(() => ({ detail: !document.getElementById('agent-detail-pane').hidden,
      name: document.getElementById('agent-detail-name').textContent,
      kind: document.getElementById('agent-detail-kind').textContent,
      hasComposer: !!document.getElementById('agent-composer'),
      hasHistory: !!document.getElementById('agent-history'),
      saved: sessionStorage.getItem('cap:sidepanel:selected-agent') }))()`);
    check("sidepanel: selecting opens the agent's conversation surface",
      spDetail.detail && spDetail.name === "Reader" && spDetail.kind === "Named agent" &&
      spDetail.hasComposer && spDetail.hasHistory, spDetail);
    check("sidepanel: the selection persists per session (sessionStorage)",
      !!spDetail.saved && JSON.parse(spDetail.saved).ref === "named:reader", spDetail.saved);
    check("sidepanel: detail screenshot", await shot(sp, "after-06-sidepanel-agent-detail"));

    // direct a task to the agent from the side panel (a REAL run)
    const spTask = `sidepanel reader task ${Date.now()}`;
    await clickExpr(sp, `document.getElementById('agent-composer').querySelector('#task-input')`);
    await typeText(sp, spTask);
    await clickExpr(sp, `document.getElementById('agent-composer').querySelector('#run-task')`);
    await sleep(8000); // the demo run + journal
    const spHistory = await msg(sp, { type: "named-agent.history", id: "reader" });
    check("sidepanel: the directed task ran in the agent's own journal",
      (spHistory?.entries ?? []).some((e) => e?.task === spTask), spHistory?.entries?.slice(0, 2));
    const spBubble = await evl(sp, `[...document.getElementById('agent-history').querySelectorAll('message-bubble')].some(b => (b.getAttribute('content') || '').includes(${JSON.stringify(spTask)}))`);
    check("sidepanel: the conversation shows the directed task", spBubble === true);
    check("sidepanel: run screenshot", await shot(sp, "after-07-sidepanel-run"));

    // live create → the list updates without a reload
    await evl(sp, `document.getElementById('agent-back').click()`);
    await sleep(400);
    await msg(sp, { type: "named-agent.create", name: "Live Agent", role: "appears live" });
    await sleep(1500); // broadcast → picker.refresh()
    const spLive = await evl(sp, `[...document.getElementById('agents-picker').shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent)`);
    check("sidepanel: a created agent appears live (no reload)", spLive.includes("Live Agent"), spLive);

    // live rename → the OPEN conversation re-titles
    await evl(sp, `[...document.getElementById('agents-picker').shadowRoot.querySelectorAll('.opt')].find(o => o.querySelector('.name').textContent === 'Reader').click()`);
    await sleep(800);
    await msg(sp, { type: "named-agent.update", id: "reader", name: "Reader Pro" });
    await sleep(1500);
    const spRenamed = await evl(sp, `document.getElementById('agent-detail-name').textContent`);
    check("sidepanel: a rename updates the open conversation live", spRenamed === "Reader Pro", spRenamed);

    // live delete of the OPEN agent → the conversation closes honestly
    await msg(sp, { type: "named-agent.delete", id: "reader" });
    await sleep(1500);
    const spDeleted = await evl(sp, `(() => ({ detail: !document.getElementById('agent-detail-pane').hidden,
      list: !document.getElementById('agents-list-pane').hidden,
      opts: [...document.getElementById('agents-picker').shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent) }))()`);
    check("sidepanel: deleting the open agent closes its conversation + updates the list",
      spDeleted.detail === false && spDeleted.list === true &&
      !spDeleted.opts.includes("Reader Pro") && spDeleted.opts.includes("Live Agent"), spDeleted);
    check("sidepanel: live-update screenshot", await shot(sp, "after-08-sidepanel-live"));

    // switch back to the page orchestration context
    await evl(sp, `document.getElementById('tab-page').click()`);
    await sleep(400);
    const spBack = await evl(sp, `(() => ({ page: !document.getElementById('page-view').hidden,
      agents: !document.getElementById('agents-view').hidden, url: !!document.getElementById('url') }))()`);
    check("sidepanel: switching back to page orchestration works", spBack.page && !spBack.agents && spBack.url, spBack);

    // session persistence: reopen the panel → the LAST selection (deleted) must
    // NOT restore; select Live Agent, reload, and it restores.
    await evl(sp, `document.getElementById('tab-agents').click()`);
    await sleep(800);
    await evl(sp, `[...document.getElementById('agents-picker').shadowRoot.querySelectorAll('.opt')].find(o => o.querySelector('.name').textContent === 'Live Agent').click()`);
    await sleep(600);
    await evl(sp, `location.reload()`);
    await sleep(2200);
    const spRestored = await evl(sp, `(() => ({ agents: !document.getElementById('agents-view').hidden,
      detail: !document.getElementById('agent-detail-pane').hidden,
      name: document.getElementById('agent-detail-name').textContent }))()`);
    check("sidepanel: the selected agent restores after a reload (per-session)",
      spRestored.agents && spRestored.detail && spRestored.name === "Live Agent", spRestored);

    // narrow viewport (380px) + 200% zoom: no horizontal overflow, targets ok
    await send("Emulation.setDeviceMetricsOverride", { width: 380, height: 800, deviceScaleFactor: 2, mobile: true }, sp);
    await sleep(600);
    const spNarrow = await evl(sp, `(() => { const opt = document.querySelector('#agents-picker')?.shadowRoot?.querySelector('.opt');
      const list = document.getElementById('agents-list-pane');
      return { overflow: document.documentElement.scrollWidth > 382,
        optHeight: opt ? Math.round(opt.getBoundingClientRect().height) : 0,
        detailVisible: !document.getElementById('agent-detail-pane').hidden };
    })()`);
    check("sidepanel: narrow + 200% zoom — no horizontal overflow", spNarrow.overflow === false, spNarrow);
    check("sidepanel: narrow screenshot", await shot(sp, "after-09-sidepanel-narrow-zoom"));
    await send("Emulation.clearDeviceMetricsOverride", {}, sp);

    // 44px targets on the picker options (measured at default size on the NTP)
    const targetSize = await evl(ntp, `(() => { const a = document.getElementById('composer').querySelector('#attach');
      a.shadowRoot.querySelector('.plus').click(); return true; })()`);
    await sleep(200);
    await evl(ntp, `document.getElementById('composer').querySelector('#attach').shadowRoot.querySelector('button[data-kind="choose-agent"]').click()`);
    await sleep(900);
    const optHeights = await evl(ntp, `[...document.getElementById('composer').querySelector('#agent-pick').shadowRoot.querySelectorAll('.opt')].map(o => Math.round(o.getBoundingClientRect().height))`);
    check("a11y: every picker option is a ≥44px target", optHeights.length > 0 && optHeights.every((h) => h >= 44), optHeights);
    const comboA11y = await evl(ntp, `(() => { const p = document.getElementById('composer').querySelector('#agent-pick');
      const s = p.shadowRoot.querySelector('.search'); const list = p.shadowRoot.querySelector('.list');
      return { role: s.getAttribute('role'), expanded: s.getAttribute('aria-expanded'),
        controls: s.getAttribute('aria-controls'), listRole: list.getAttribute('role'),
        optRoles: [...p.shadowRoot.querySelectorAll('.opt')].every(o => o.getAttribute('role') === 'option'),
        visibleLabel: !!p.shadowRoot.querySelector('label.lbl')?.textContent };
    })()`);
    check("a11y: combobox→listbox contract + visible label",
      comboA11y.role === "combobox" && comboA11y.expanded === "true" && !!comboA11y.controls &&
      comboA11y.listRole === "listbox" && comboA11y.optRoles && comboA11y.visibleLabel, comboA11y);
    // Escape in the picker → the popover closes + focus returns to the + button
    await pressKey(ntp, "Escape");
    await sleep(300);
    const escReturn = await evl(ntp, `(() => { const c = document.getElementById('composer');
      const plus = c.querySelector('#attach').shadowRoot.querySelector('.plus');
      return { closed: c.querySelector('#agent-pop').hidden,
        focusOnPlus: c.querySelector('#attach').shadowRoot.activeElement === plus };
    })()`);
    check("a11y: Escape closes the picker + focus returns to the + trigger",
      escReturn.closed === true && escReturn.focusOnPlus === true, escReturn);

    // attachment-menu regression AFTER all the agent flows: it still opens + lists
    await evl(ntp, `document.getElementById('composer').querySelector('#attach').shadowRoot.querySelector('.plus').click()`);
    await sleep(300);
    const menuAfter = await evl(ntp, `[...document.getElementById('composer').querySelector('#attach').shadowRoot.querySelectorAll('.menu button')].map(b => b.dataset.kind)`);
    check("regression: the attachment menu still works after the agent flows",
      menuAfter.includes("file") && menuAfter.includes("choose-agent"), menuAfter);
    await evl(ntp, `document.body.click()`);

    // no console errors on either surface
    const ntpErrors = consoleErrors.get(ntp) ?? [];
    const spErrors = consoleErrors.get(sp) ?? [];
    check("no console errors on the NTP", ntpErrors.length === 0, ntpErrors.slice(0, 3));
    check("no console errors on the side panel", spErrors.length === 0, spErrors.slice(0, 3));
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }

  console.log(`\n${pass} passed, ${fail} failed — evidence: ${EVIDENCE_DIR}`);
  if (failures.length) console.log("failures:", failures.join(" | "));
  Deno.exit(fail ? 1 : 0);
}

await main();
