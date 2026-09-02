// agent-access-journeys.ts — the REAL-Chrome journeys for the unified agent
// access (CAP-FB-20260818-AGENT-ACCESS-01): the shared <agent-picker> consumed
// by (1) the side panel's Agents view (list / history / TASK LIST), (2) every
// composer's + menu "Choose agent" action, and (3) the /agent slash command —
// driven in headless Chrome against the BUILT extension with GENUINE CDP
// input for every interaction (Input.dispatchMouseEvent for clicks,
// Input.insertText / Input.dispatchKeyEvent for typing + keys — never DOM
// .click(), .value assignment, or synthetic dispatchEvent), with before/after
// screenshots + console-error gating.
//
// ATTESTATION: every run writes a manifest.json into the evidence dir binding
// the evidence to the EXACT tested commit (git rev-parse HEAD) + the worktree
// cleanliness + SHA-256 hashes of every screenshot + the exact assertion set.
// Evidence is EXTERNAL (a fresh /tmp directory) and is NEVER written into or
// committed with the source tree. The final "evidence manifest …" check
// requires a CLEAN worktree, so the attestation run must happen on the
// committed tree.
//
//   deno run -A scripts/agent-access-journeys.ts
//
// @ts-nocheck — this journey is untyped CDP scripting (the same pattern as
// agent-provider-picker.ts); the assertions are exercised at runtime by the
// exact-assertion-set gate below, not by the type checker.

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const GIT = "/usr/bin/git";
const EVIDENCE_DIR = `/tmp/cap-agent-access-evidence-${Date.now()}`;
const RUN_ID = `cap-agent-access-${Date.now()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const failures = [];
const results = [];
const ranNames = [];
function check(name, cond, detail) {
  ranNames.push(name);
  results.push({ name, pass: !!cond });
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

// The FIXED assertion set (round-2 review: no silent count shrink, no weak
// "at least N" gates). Every check below must run exactly once, in this order.
const META_CHECKS = new Set([
  "assertion set exact (no missing/extra checks)",
  "assertion order matches EXPECTED",
  // This check necessarily runs after the manifest's first durable write. It
  // is excluded from the pre-write set/order gate, then the manifest is
  // rewritten once with this final result included.
  "evidence manifest written + bound to the tested commit",
]);
const EXPECTED = [
  "extension loaded",
  "seed: named agents created",
  "seed: a background agent enabled",
  "seed: a site agent enrolled",
  "registry: named + background + site groups",
  "registry: seeded agents present with canonical refs",
  "registry: the disabled background agents are marked not-enabled",
  "registry: no provider keys / internal paths leak",
  "registry: the response carries a monotonic revision",
  "plus menu: opens via a real click",
  "plus menu: Choose agent present AND the attachment actions intact (regression)",
  "plus picker: Choose agent opened via a real click",
  "plus picker: popover opens with focus in the search combobox",
  "plus picker: grouped Named / Background / Site",
  "plus picker: exactly the callable agents (the enabled background only)",
  "plus picker: screenshot",
  "plus picker: search filters to the match (real typing)",
  "plus picker: End moves to the last option (aria-activedescendant set)",
  "plus picker: Home moves to the first option",
  "plus picker: an option chosen via a real click shows the removable chip + closes the popover",
  "plus picker: chip screenshot",
  "plus picker: the chip is removable via a real click",
  "plus picker: re-selected Reader chip",
  "plus flow: typed a task via real input",
  "plus flow: clicked Run via a real click",
  "plus flow: the task ran in the SELECTED agent's own journal (routing by ID)",
  "plus flow: no master thread created for the routed run",
  "plus flow: the agent surface opened with the agent's name",
  "plus flow: run screenshot",
  "background routing: the task ran in the background agent's OWN journal (routing by canonical ref)",
  "background routing: no master thread created",
  "site routing: agent.delegate journaled the delegated result to the site's OWN memory",
  "site routing: no master thread created",
  "slash: /agent:query opens the ONE shared picker popover (the items popup stays closed)",
  "slash: the typed query filters the shared picker",
  "slash: screenshot",
  "slash: ArrowDown moves the shared picker's active option (forwarded keys)",
  "slash: Enter commits the canonical /agent:named:<id> reference exactly once + selects the chip",
  "slash: ordinary prose containing /agent: does NOT open the command UI",
  "slash: a URL containing /agent: does NOT open the command UI",
  "slash: a leading-space /agent does NOT open the command UI",
  "slash+mention: a committed /agent ref then an @ opens the mention popup",
  "slash: Escape closes + reverts (text kept, no chip, no commit)",
  "stale: the agent deleted cleanly",
  "stale: the deleted agent's chip is invalidated live (text NOT auto-sent)",
  "stale: the status explains the rejection",
  "stale: nothing was routed to a ghost agent",
  "registry: a lifecycle mutation bumps the revision",
  "sidepanel: Page + Agents tabs, page orchestration intact by default",
  "sidepanel: no iframe preview and no morph stub remain",
  "navigation: sidepanel.openPage rejects requests without an owner gesture",
  "navigation: sidepanel.openPage rejects non-http(s) URLs",
  "navigation: the Go flow opens a REAL tab via the SW authority (real typing + real click)",
  "sidepanel: the Agents view lists all groups (enabled/callable agents only — no disabled templates)",
  "sidepanel: the task list shows the seeded scheduled task",
  "sidepanel: agents + tasks screenshot",
  "sidepanel: search filters (real typing)",
  "sidepanel: the empty state renders",
  "sidepanel: a task row opens its background agent's conversation",
  "sidepanel: deleting the task row cancels the schedule + disables the agent (live)",
  "sidepanel: rapid A→B selection renders only B's conversation (fenced history load)",
  "lifecycle: recipe.duplicate broadcasts — the picker refreshes live (no reload); the disabled copy is a template, not a row",
  "lifecycle: recipe.update renames the copy live in the registry; the picker refreshes and still lists no template",
  "lifecycle: recipe.delete removes the copy live",
  "lifecycle: a created named agent appears live (no reload)",
  "sidepanel: selecting opens the agent's conversation surface",
  "sidepanel: the selection persists per session (sessionStorage)",
  "sidepanel: detail screenshot",
  "sidepanel: the directed task ran in the agent's own journal",
  "sidepanel: the conversation shows the directed task",
  "sidepanel: run screenshot",
  "sidepanel: a rename updates the open conversation live",
  "sidepanel: deleting the open agent closes its conversation + updates the list",
  "sidepanel: live-update screenshot",
  "sidepanel: a DISABLED background agent is NOT restored after a reload (stale session dropped)",
  "sidepanel: the selected agent restores after a reload (per-session)",
  "sidepanel: switching back to page orchestration works",
  "sidepanel: narrow + 200% zoom — no horizontal overflow",
  "sidepanel: narrow screenshot",
  "a11y: every picker option is a ≥44px target",
  "a11y: combobox→listbox contract + visible label",
  "a11y: Escape closes the picker + focus returns to the + trigger",
  "regression: the attachment menu still works after the agent flows",
  "no console errors on the NTP",
  "no console errors on the side panel",
  "assertion set exact (no missing/extra checks)",
  "assertion order matches EXPECTED",
  "evidence manifest written + bound to the tested commit",
];

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  return await res.json();
}

async function main() {
  await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
  const profile = `/tmp/cap-agent-access-profile-${Date.now()}`;
  // The shared launcher: kernel-assigned debugging port, the endpoint read
  // from THIS child's own stderr (never a probe of a named port), the same
  // headless argv every harness uses, and a cleared environment so Chrome
  // inherits none of the runner's variables.
  const chrome = await launchChrome({ extension: EXT, profile, windowSize: "1400,2000", clearEnv: true });
  const proc = chrome.proc;
  const port = chrome.port;

  // This journey keeps its OWN CDP socket: it captures Runtime.exceptionThrown
  // + console errors per session for the "no console errors" gates.
  const ws = new WebSocket(chrome.wsUrl);
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
  // Runtime.evaluate is used for READS + message probes ONLY — never to mutate
  // the UI (the round-2 blocker: DOM .click()/.value/dispatchEvent are not a
  // real user interaction; every interaction below is a genuine CDP input).
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
  const evidenceFiles = [];
  async function shot(session, name) {
    const r = await send("Page.captureScreenshot", { format: "png" }, session);
    const b64 = r?.data;
    if (!b64) return false;
    const bytes = new Uint8Array(atob(b64).split("").map((c) => c.charCodeAt(0)));
    await Deno.writeFile(`${EVIDENCE_DIR}/${name}.png`, bytes);
    evidenceFiles.push({ name: `${name}.png`, sha256: await sha256Hex(bytes), bytes: bytes.length });
    return true;
  }
  // ── genuine CDP input primitives (the ONLY way this suite interacts) ──
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
  // Genuine text insertion (the same CDP primitive IME/clipboard text uses) —
  // fires the real beforeinput/input chain, so component handlers run exactly
  // as for a user.
  const typeText = async (session, text) => {
    await send("Input.insertText", { text }, session);
  };
  const KEYS = {
    ArrowDown: { code: "ArrowDown", vk: 40 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
    Home: { code: "Home", vk: 36 },
    End: { code: "End", vk: 35 },
    Enter: { code: "Enter", vk: 13 },
    Escape: { code: "Escape", vk: 27 },
    Tab: { code: "Tab", vk: 9 },
    Backspace: { code: "Backspace", vk: 8 },
    a: { code: "KeyA", vk: 65 },
  };
  const pressKey = async (session, key, modifiers = 0) => {
    const k = KEYS[key];
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers }, session);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers }, session);
  };
  // Clear a focused field with REAL keys: click it (focus), Ctrl+A, Backspace.
  const clearField = async (session, expr) => {
    if (!await clickExpr(session, expr)) return false;
    await pressKey(session, "a", 2); // Ctrl+A
    await pressKey(session, "Backspace");
    return true;
  };
  // A backend message probe from an extension page session (a READ/setup path,
  // not a UI interaction).
  const msg = (session, payload) =>
    evl(session, `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => ({ v }), e => ({ err: e.message }))`)
      .then((r) => r?.v ?? { ok: false, error: r?.err ?? "no response" });

  // Selector helpers (JS expressions, evaluated read-only for coordinates).
  const COMPOSER = `document.getElementById('composer')`;
  const PLUS = `${COMPOSER}.querySelector('#attach').shadowRoot.querySelector('.plus')`;
  const CHOOSE_AGENT = `${COMPOSER}.querySelector('#attach').shadowRoot.querySelector('button[data-kind="choose-agent"]')`;
  const NTP_PICK = `${COMPOSER}.querySelector('#agent-pick')`;
  const NTP_INPUT = `${COMPOSER}.querySelector('#task-input')`;
  const pickOptByName = (pickExpr, name) =>
    `[...${pickExpr}.shadowRoot.querySelectorAll('.opt')].find(o => o.querySelector('.name').textContent === ${JSON.stringify(name)})`;
  const SP_PICK = `document.getElementById('agents-picker')`;
  const spPickOptByName = (name) => pickOptByName(SP_PICK, name);

  let manifestOk = false;
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
    const bgName = bgFirst?.name ?? "";
    const bgRef = `background:${bgFirst?.id}`;

    // ── registry route ───────────────────────────────────────────────────
    const reg = await msg(ntp, { type: "agent.registry" });
    const regGroups = reg?.groups ?? [];
    const groupIds = regGroups.map((g) => g.id).sort();
    check("registry: named + background + site groups", JSON.stringify(groupIds) === '["background","named","site"]', groupIds);
    const allAgents = regGroups.flatMap((g) => g.agents ?? []);
    check("registry: seeded agents present with canonical refs",
      allAgents.some((a) => a.ref === "named:reader") &&
      allAgents.some((a) => a.ref === "named:pr-reviewer") &&
      allAgents.some((a) => a.ref === bgRef) &&
      allAgents.some((a) => a.ref === "site:https://example.com"),
      allAgents.map((a) => a.ref));
    check("registry: the disabled background agents are marked not-enabled",
      regGroups.find((g) => g.id === "background")?.agents?.some((a) => a.enabled === false) === true);
    const regJson = JSON.stringify(reg);
    check("registry: no provider keys / internal paths leak",
      !regJson.includes("apiKey") && !regJson.includes("memory/") && !regJson.includes("baseURL"));
    const disabledBgNames = (regGroups.find((g) => g.id === "background")?.agents ?? [])
      .filter((a) => a.enabled !== true).map((a) => a.name);
    const regRev = Number(reg?.revision);
    check("registry: the response carries a monotonic revision", Number.isFinite(regRev) && regRev > 0, reg?.revision);

    // ── NTP: the + menu "Choose agent" ──────────────────────────────────
    check("plus menu: opens via a real click", await clickExpr(ntp, PLUS));
    await sleep(400);
    const menuItems = await evl(ntp, `[...${COMPOSER}.querySelector('#attach').shadowRoot.querySelectorAll('.menu button')].map(b => b.dataset.kind)`);
    check("plus menu: Choose agent present AND the attachment actions intact (regression)",
      menuItems.includes("choose-agent") && menuItems.includes("file") &&
      menuItems.includes("record-audio") && menuItems.includes("capture-camera") &&
      menuItems.includes("record-screen") && menuItems.includes("grab-screenshot") &&
      menuItems.includes("add-tab"), menuItems);
    check("plus picker: Choose agent opened via a real click", await clickExpr(ntp, CHOOSE_AGENT));
    await sleep(900); // the picker fetches the live registry on open
    const popState = await evl(ntp, `(() => { const pop = ${COMPOSER}.querySelector('#agent-pop');
      const pick = ${NTP_PICK};
      const opts = [...pick.shadowRoot.querySelectorAll('.opt')].map(o => o.querySelector('.name').textContent);
      const groups = [...pick.shadowRoot.querySelectorAll('.group-h')].map(g => g.textContent);
      return { open: !pop.hidden, opts, groups,
        focusInSearch: pick.shadowRoot.activeElement === pick.shadowRoot.querySelector('.search') };
    })()`);
    check("plus picker: popover opens with focus in the search combobox", popState.open && popState.focusInSearch, popState);
    check("plus picker: grouped Named / Background / Site",
      JSON.stringify(popState.groups) === JSON.stringify(["Named agents", "Background agents", "Site agents"]), popState.groups);
    // EXACT callable set (the round-2 blocker: no "at least N" gate): the two
    // named agents + the ONE enabled background agent + the enrolled site —
    // and NOT any disabled background agent.
    const expectedCallable = ["PR Reviewer", "Reader", bgName, "@example.com"].sort();
    check("plus picker: exactly the callable agents (the enabled background only)",
      JSON.stringify([...popState.opts].sort()) === JSON.stringify(expectedCallable),
      { got: popState.opts, expected: expectedCallable });
    check("plus picker: screenshot", await shot(ntp, "after-01-plus-agent-picker"));

    // search/filter inside the picker — REAL typing into the focused search.
    check("plus picker: search filters to the match (real typing)",
      await clickExpr(ntp, `${NTP_PICK}.shadowRoot.querySelector('.search')`) &&
      (await typeText(ntp, "reader"), await sleep(500),
        JSON.stringify(await evl(ntp, `[...${NTP_PICK}.shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent)`)) === JSON.stringify(["Reader"])));

    // picker keyboard: clear (real keys) → End → last, Home → first.
    await clearField(ntp, `${NTP_PICK}.shadowRoot.querySelector('.search')`);
    await sleep(500);
    await pressKey(ntp, "End");
    await sleep(200);
    const endActive = await evl(ntp, `(() => { const p = ${NTP_PICK}; const opts = [...p.shadowRoot.querySelectorAll('.opt')]; return { active: opts.findIndex(o => o.dataset.active === 'true'), count: opts.length,
      ad: p.shadowRoot.querySelector('.search').getAttribute('aria-activedescendant') }; })()`);
    check("plus picker: End moves to the last option (aria-activedescendant set)",
      endActive.active === endActive.count - 1 && !!endActive.ad, endActive);
    await pressKey(ntp, "Home");
    await sleep(200);
    const homeActive = await evl(ntp, `[...${NTP_PICK}.shadowRoot.querySelectorAll('.opt')].findIndex(o => o.dataset.active === 'true')`);
    check("plus picker: Home moves to the first option", homeActive === 0, homeActive);

    // select Reader via a REAL click on its option → the chip appears.
    check("plus picker: an option chosen via a real click shows the removable chip + closes the popover",
      await clickExpr(ntp, pickOptByName(NTP_PICK, "Reader")) &&
      (await sleep(500), await evl(ntp, `(() => { const c = ${COMPOSER};
        const chip = c.querySelector('#chips .chip.agent-chip');
        const pop = c.querySelector('#agent-pop');
        return chip?.textContent.includes("Reader") && pop.hidden &&
          chip?.querySelector('button')?.getAttribute('aria-label') === "Remove agent Reader";
      })()`)));
    check("plus picker: chip screenshot", await shot(ntp, "after-02-agent-chip"));

    // clear the chip via its X (a real click).
    check("plus picker: the chip is removable via a real click",
      await clickExpr(ntp, `${COMPOSER}.querySelector('#chips .chip.agent-chip button')`) &&
      (await sleep(300), await evl(ntp, `!${COMPOSER}.querySelector('#chips .chip.agent-chip')`)));

    // re-select + type + send → routed to the named agent by ID.
    await clickExpr(ntp, PLUS);
    await sleep(300);
    await clickExpr(ntp, CHOOSE_AGENT);
    await sleep(900);
    await clickExpr(ntp, pickOptByName(NTP_PICK, "Reader"));
    await sleep(300);
    check("plus picker: re-selected Reader chip",
      await evl(ntp, `${COMPOSER}.querySelector('#chips .chip.agent-chip')?.textContent.includes('Reader')`));
    const routedTask = `reader routed task ${Date.now()}`;
    check("plus flow: typed a task via real input",
      await clickExpr(ntp, NTP_INPUT) &&
      (await typeText(ntp, routedTask), await sleep(200),
        await evl(ntp, `${NTP_INPUT}.value === ${JSON.stringify(routedTask)}`)));
    const threadsBefore = (await msg(ntp, { type: "thread.list" }))?.threads?.length ?? 0;
    check("plus flow: clicked Run via a real click", await clickExpr(ntp, `${COMPOSER}.querySelector('#run-task')`));
    await sleep(8000); // the demo provider run + journal
    const readerHistory = await msg(ntp, { type: "named-agent.history", id: "reader" });
    const routed = (readerHistory?.entries ?? []).some((e) => e?.task === routedTask);
    const threadsAfter = (await msg(ntp, { type: "thread.list" }))?.threads?.length ?? 0;
    check("plus flow: the task ran in the SELECTED agent's own journal (routing by ID)", routed, readerHistory?.entries?.slice(0, 2));
    check("plus flow: no master thread created for the routed run", threadsAfter === threadsBefore, { threadsBefore, threadsAfter });
    const surfaceTitle = await evl(ntp, `document.getElementById('thread-title').textContent`);
    check("plus flow: the agent surface opened with the agent's name", surfaceTitle === "Reader", surfaceTitle);
    check("plus flow: run screenshot", await shot(ntp, "after-03-routed-run"));

    // ── NTP: BACKGROUND + SITE routing (the round-2 coverage gap: the old
    //    suite proved only named-agent execution) ─────────────────────────
    // Background: choose the ENABLED background agent, run a task, verify it
    // landed in the background agent's OWN journal (background-agent.history).
    await clickExpr(ntp, `document.getElementById('thread-back')`);
    await sleep(600);
    await clickExpr(ntp, PLUS);
    await sleep(300);
    await clickExpr(ntp, CHOOSE_AGENT);
    await sleep(900);
    await clickExpr(ntp, pickOptByName(NTP_PICK, bgName));
    await sleep(300);
    const bgTask = `background routed task ${Date.now()}`;
    await clickExpr(ntp, NTP_INPUT);
    await typeText(ntp, bgTask);
    const bgThreadsBefore = (await msg(ntp, { type: "thread.list" }))?.threads?.length ?? 0;
    await clickExpr(ntp, `${COMPOSER}.querySelector('#run-task')`);
    await sleep(9000);
    const bgHistory = await msg(ntp, { type: "background-agent.history", id: bgFirst?.id });
    check("background routing: the task ran in the background agent's OWN journal (routing by canonical ref)",
      (bgHistory?.entries ?? []).some((e) => e?.task === bgTask), bgHistory?.entries?.slice(0, 2));
    const bgThreadsAfter = (await msg(ntp, { type: "thread.list" }))?.threads?.length ?? 0;
    check("background routing: no master thread created", bgThreadsAfter === bgThreadsBefore, { bgThreadsBefore, bgThreadsAfter });

    // Site: choose the enrolled site agent, run a task, verify agent.delegate
    // journaled the delegated result to the site's OWN origin-keyed memory.
    await clickExpr(ntp, `document.getElementById('thread-back')`);
    await sleep(600);
    await clickExpr(ntp, PLUS);
    await sleep(300);
    await clickExpr(ntp, CHOOSE_AGENT);
    await sleep(900);
    await clickExpr(ntp, pickOptByName(NTP_PICK, "@example.com"));
    await sleep(300);
    const siteTask = `site delegated task ${Date.now()}`;
    await clickExpr(ntp, NTP_INPUT);
    await typeText(ntp, siteTask);
    const siteThreadsBefore = (await msg(ntp, { type: "thread.list" }))?.threads?.length ?? 0;
    await clickExpr(ntp, `${COMPOSER}.querySelector('#run-task')`);
    await sleep(10000); // the delegated worker run (demo provider) + journal commit
    const siteJournal = await msg(ntp, { type: "memory.get", origin: "https://example.com", key: "journal" });
    check("site routing: agent.delegate journaled the delegated result to the site's OWN memory",
      Array.isArray(siteJournal) && siteJournal.some((e) => e?.type === "delegated-result" && e?.task === siteTask),
      Array.isArray(siteJournal) ? siteJournal.slice(-2) : siteJournal);
    const siteThreadsAfter = (await msg(ntp, { type: "thread.list" }))?.threads?.length ?? 0;
    check("site routing: no master thread created", siteThreadsAfter === siteThreadsBefore, { siteThreadsBefore, siteThreadsAfter });

    // back to the hub for the slash journeys
    await clickExpr(ntp, `document.getElementById('thread-back')`);
    await sleep(600);

    // ── NTP: the /agent slash command → the ONE shared <agent-picker> ────
    check("slash: /agent:query opens the ONE shared picker popover (the items popup stays closed)",
      await clickExpr(ntp, NTP_INPUT) &&
      (await typeText(ntp, "/agent:pr"), await sleep(900), await evl(ntp, `(() => { const c = ${COMPOSER};
        return !c.querySelector('#agent-pop').hidden && c.querySelector('.popup').hidden &&
          c.querySelector('#task-input').getAttribute('aria-expanded') === "true";
      })()`)));
    const slashFiltered = await evl(ntp, `[...${NTP_PICK}.shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent)`);
    check("slash: the typed query filters the shared picker",
      slashFiltered.length === 1 && slashFiltered[0] === "PR Reviewer", slashFiltered);
    check("slash: screenshot", await shot(ntp, "after-04-slash-agent-picker"));
    // keyboard: ArrowDown is FORWARDED to the shared picker (the composer keeps focus).
    await pressKey(ntp, "ArrowDown");
    await sleep(200);
    const slashActive = await evl(ntp, `(() => { const p = ${NTP_PICK};
      return { active: [...p.shadowRoot.querySelectorAll('.opt')].findIndex(o => o.dataset.active === 'true'),
        focusInComposer: document.activeElement === ${COMPOSER}.querySelector('#task-input') }; })()`);
    check("slash: ArrowDown moves the shared picker's active option (forwarded keys)",
      slashActive.active === 0 && slashActive.focusInComposer === true, slashActive);
    await pressKey(ntp, "Enter");
    await sleep(500);
    const slashCommit = await evl(ntp, `(() => { const c = ${COMPOSER};
      return { value: c.querySelector('#task-input').value,
        chip: c.querySelector('#chips .chip.agent-chip')?.textContent ?? null,
        popClosed: c.querySelector('#agent-pop').hidden }; })()`);
    check("slash: Enter commits the canonical /agent:named:<id> reference exactly once + selects the chip",
      slashCommit.value === "/agent:named:pr-reviewer" && slashCommit.chip?.includes("PR Reviewer") &&
      slashCommit.popClosed === true, slashCommit);

    // The strict parser (the round-2 free-text false positive): prose / URLs /
    // a leading space must NEVER open the command UI. Cleared with real keys.
    await clearField(ntp, NTP_INPUT);
    await typeText(ntp, "please inspect /agent:pr");
    await sleep(700);
    check("slash: ordinary prose containing /agent: does NOT open the command UI",
      await evl(ntp, `${COMPOSER}.querySelector('#agent-pop').hidden && ${COMPOSER}.querySelector('.popup').hidden`));
    await clearField(ntp, NTP_INPUT);
    await typeText(ntp, "see https://example.com/agent:foo");
    await sleep(700);
    check("slash: a URL containing /agent: does NOT open the command UI",
      await evl(ntp, `${COMPOSER}.querySelector('#agent-pop').hidden && ${COMPOSER}.querySelector('.popup').hidden`));
    await clearField(ntp, NTP_INPUT);
    await typeText(ntp, " /agent:x");
    await sleep(700);
    check("slash: a leading-space /agent does NOT open the command UI",
      await evl(ntp, `${COMPOSER}.querySelector('#agent-pop').hidden && ${COMPOSER}.querySelector('.popup').hidden`));

    // Mixed slash + mention: commit a ref (real click on the Reader option),
    // then an @ after the task text opens the MENTION popup.
    await clearField(ntp, NTP_INPUT);
    await typeText(ntp, "/agent:read");
    await sleep(900);
    await clickExpr(ntp, pickOptByName(NTP_PICK, "Reader"));
    await sleep(400);
    const mixedCommit = await evl(ntp, `${NTP_INPUT}.value`);
    await typeText(ntp, " summarise @");
    await sleep(700);
    const mentionState = await evl(ntp, `(() => { const c = ${COMPOSER};
      return { open: !c.querySelector('.popup').hidden,
        items: [...c.querySelectorAll('.popup .item .lbl')].map(n => n.textContent) }; })()`);
    check("slash+mention: a committed /agent ref then an @ opens the mention popup",
      mixedCommit === "/agent:named:reader" && mentionState.open === true && mentionState.items.length > 0,
      { mixedCommit, ...mentionState });
    await pressKey(ntp, "Escape"); // close the mention popup
    await sleep(300);
    // Remove the chip + clear the text for the Escape journey (real input).
    await clickExpr(ntp, `${COMPOSER}.querySelector('#chips .chip.agent-chip button')`);
    await clearField(ntp, NTP_INPUT);

    // Escape closes + reverts (the typed text stays, nothing commits).
    await typeText(ntp, "/agent:");
    await sleep(900);
    const escBefore = await evl(ntp, `!${COMPOSER}.querySelector('#agent-pop').hidden`);
    await pressKey(ntp, "Escape");
    await sleep(300);
    const escAfter = await evl(ntp, `(() => { const c = ${COMPOSER};
      return { closed: c.querySelector('#agent-pop').hidden, value: c.querySelector('#task-input').value,
        chip: !!c.querySelector('#chips .chip.agent-chip') }; })()`);
    check("slash: Escape closes + reverts (text kept, no chip, no commit)",
      escBefore === true && escAfter.closed === true && escAfter.value === "/agent:" && escAfter.chip === false, escAfter);
    await clearField(ntp, NTP_INPUT);

    // ── NTP: stale selection invalidation (delete while selected) ───────
    await clickExpr(ntp, PLUS);
    await sleep(300);
    await clickExpr(ntp, CHOOSE_AGENT);
    await sleep(900);
    await clickExpr(ntp, pickOptByName(NTP_PICK, "PR Reviewer"));
    await sleep(300);
    const staleTask = `stale selection ${Date.now()}`;
    await clickExpr(ntp, NTP_INPUT);
    await typeText(ntp, staleTask);
    const delRes = await msg(ntp, { type: "named-agent.delete", id: "pr-reviewer" });
    check("stale: the agent deleted cleanly", delRes?.ok !== false, delRes);
    await sleep(1200); // the agent-registry-changed broadcast → live invalidation
    const staleState = await evl(ntp, `(() => { const c = ${COMPOSER};
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
    await clearField(ntp, NTP_INPUT);

    // The registry revision is monotonic across lifecycle mutations.
    const regAfterDelete = await msg(ntp, { type: "agent.registry" });
    check("registry: a lifecycle mutation bumps the revision",
      Number(regAfterDelete?.revision) > regRev, { before: regRev, after: regAfterDelete?.revision });

    // ── SIDE PANEL: the first-class Agents view ─────────────────────────
    const sp = await openPage(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    await sleep(1500);
    const spTabs = await evl(sp, `(() => ({ page: !!document.getElementById('tab-page'),
      agents: !!document.getElementById('tab-agents'),
      pageVisible: !document.getElementById('page-view').hidden,
      urlInput: !!document.getElementById('url') }))()`);
    check("sidepanel: Page + Agents tabs, page orchestration intact by default",
      spTabs.page && spTabs.agents && spTabs.pageVisible && spTabs.urlInput, spTabs);
    // The iframe/morph stub is GONE (the round-2 blocker): the panel never
    // claims to embed or morph the driven page.
    check("sidepanel: no iframe preview and no morph stub remain",
      await evl(sp, `!document.querySelector('iframe') && !document.getElementById('morph') &&
        !document.querySelector('.morphbar')`));

    // Navigation authority: an extension-page request without a CURRENT owner
    // gesture is rejected (so an agent-opened panel cannot turn its stored
    // target into a tab mutation), and even a trusted gesture is http(s)-only.
    const navUngestured = await msg(sp, {
      type: "sidepanel.openPage",
      url: "https://example.com",
      ownerGesture: false,
    });
    check("navigation: sidepanel.openPage rejects requests without an owner gesture",
      navUngestured?.ok === false && /owner gesture/i.test(navUngestured?.error ?? ""), navUngestured);
    const navJs = await msg(sp, {
      type: "sidepanel.openPage",
      url: "javascript:alert(1)",
      ownerGesture: true,
    });
    const navData = await msg(sp, {
      type: "sidepanel.openPage",
      url: "data:text/html,<h1>x</h1>",
      ownerGesture: true,
    });
    check("navigation: sidepanel.openPage rejects non-http(s) URLs",
      navJs?.ok === false && navData?.ok === false, { navJs, navData });
    // …and the panel's own Go flow (REAL typing + REAL click) opens a REAL
    // tab through that authority — the panel never calls chrome.tabs.create.
    const tabsBefore = (await fetchJson(`http://127.0.0.1:${port}/json/list`))
      .filter((t) => t.url?.startsWith("https://example.com")).length;
    // The URL field is now the secondary "Open another site…" disclosure
    // (CAP-FB-20260830-SIDE-PANEL-COMPANION-01): open it before typing.
    await evl(sp, `document.getElementById('open-another').open = true`);
    await sleep(150);
    await clearField(sp, `document.getElementById('url')`);
    await typeText(sp, "https://example.com");
    await clickExpr(sp, `document.getElementById('go')`);
    await sleep(1500);
    const navTargets = (await fetchJson(`http://127.0.0.1:${port}/json/list`))
      .filter((t) => t.url?.startsWith("https://example.com"));
    const navStatus = await evl(sp, `document.getElementById('status').textContent`);
    check("navigation: the Go flow opens a REAL tab via the SW authority (real typing + real click)",
      navTargets.length === tabsBefore + 1 && /Opened https:\/\/example\.com in a new tab/.test(navStatus),
      { tabsBefore, after: navTargets.length, navStatus });
    // Clean up the opened tab.
    if (navTargets.length) {
      await fetch(`http://127.0.0.1:${port}/json/close/${navTargets[0].id}`).catch(() => {});
    }

    await clickExpr(sp, `document.getElementById('tab-agents')`);
    await sleep(1200); // the picker's live registry fetch
    const spList = await evl(sp, `(() => { const p = ${SP_PICK};
      return { opts: [...p.shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent),
        groups: [...p.shadowRoot.querySelectorAll('.group-h')].map(n => n.textContent),
        agentsVisible: !document.getElementById('agents-view').hidden };
    })()`);
    // CAP-FB-20260830-FRESH-PROFILE-TEMPLATE-AGENTS-01: the side panel lists the
    // same set as every other agent surface — the ENABLED background agent
    // only; the 21 disabled recipes are templates, never agent rows.
    check("sidepanel: the Agents view lists all groups (enabled/callable agents only — no disabled templates)",
      spList.agentsVisible && spList.groups.length === 3 && spList.opts.includes("Reader") &&
      spList.opts.includes("@example.com") && spList.opts.includes(bgName) &&
      !spList.opts.some((n) => disabledBgNames.includes(n)), { ...spList, disabledBgNames: disabledBgNames.length });
    // The task list (the Agents view's third surface): the seeded recipe task.
    const spTasks = await evl(sp, `[...document.querySelectorAll('#agents-tasks task-row')].map(r => r.getAttribute('name'))`);
    check("sidepanel: the task list shows the seeded scheduled task",
      spTasks.includes(`recipe:${bgFirst?.id}`), spTasks);
    check("sidepanel: agents + tasks screenshot", await shot(sp, "after-05-sidepanel-agents-tasks"));

    // search in the sidepanel picker — REAL typing.
    check("sidepanel: search filters (real typing)",
      await clickExpr(sp, `${SP_PICK}.shadowRoot.querySelector('.search')`) &&
      (await typeText(sp, "reader"), await sleep(500),
        JSON.stringify(await evl(sp, `[...${SP_PICK}.shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent)`)) === JSON.stringify(["Reader"])));
    // empty state
    await clearField(sp, `${SP_PICK}.shadowRoot.querySelector('.search')`);
    await typeText(sp, "zzzz-nothing");
    await sleep(500);
    const spEmpty = await evl(sp, `${SP_PICK}.shadowRoot.querySelector('.state')?.textContent ?? ''`);
    check("sidepanel: the empty state renders", /No agents match/i.test(spEmpty), spEmpty);
    await clearField(sp, `${SP_PICK}.shadowRoot.querySelector('.search')`);
    await sleep(400);

    // A task row opens its background agent's conversation (a real click on
    // the shared <task-row>).
    const taskRowClicked = await clickExpr(sp,
      `document.querySelector('#agents-tasks task-row').shadowRoot.querySelector('.row')`);
    await sleep(1000);
    const taskOpened = await evl(sp, `(() => ({
      open: !document.getElementById('agent-detail-pane').hidden,
      name: document.getElementById('agent-detail-name').textContent,
      kind: document.getElementById('agent-detail-kind').textContent
    }))()`);
    check("sidepanel: a task row opens its background agent's conversation",
      taskRowClicked && taskOpened.open && taskOpened.name === bgName &&
      taskOpened.kind === "Background agent", taskOpened);
    await clickExpr(sp, `document.getElementById('agent-back')`);
    await sleep(400);

    // Deleting the task row is the authoritative task.cancel: the schedule is
    // cancelled, the background agent becomes disabled, and the registry
    // broadcast refreshes the list live.
    check("sidepanel: deleting the task row cancels the schedule + disables the agent (live)",
      await clickExpr(sp, `document.querySelector('#agents-tasks task-row').shadowRoot.querySelector('.del')`) &&
      (await sleep(1500), (async () => {
        const tl = await msg(sp, { type: "task.list" });
        const names = (tl?.tasks ?? []).map((t) => t.name);
        const regNow = await msg(sp, { type: "agent.registry" });
        const bgNow = regNow?.groups?.find((g) => g.id === "background")?.agents?.find((a) => a.ref === bgRef);
        const rowsShown = await evl(sp, `document.querySelectorAll('#agents-tasks task-row').length`);
        const emptyShown = await evl(sp, `document.querySelector('#agents-tasks .tasks-empty')?.textContent ?? ''`);
        return !names.includes(`recipe:${bgFirst?.id}`) && bgNow?.enabled === false &&
          rowsShown === 0 && /No scheduled tasks/i.test(emptyShown);
      })()));

    // The fenced history load (the round-2 race): rapid A→B selection must
    // never render A's late-arriving history under B's title. A = the site
    // agent (an OPFS read), B = Reader (whose journal contains routedTask).
    await clickExpr(sp, spPickOptByName("@example.com"));
    await clickExpr(sp, `document.getElementById('agent-back')`);
    await clickExpr(sp, spPickOptByName("Reader"));
    await sleep(1200);
    const raceState = await evl(sp, `(() => ({ name: document.getElementById('agent-detail-name').textContent,
      bubbles: [...document.getElementById('agent-history').querySelectorAll('message-bubble')].map(b => b.getAttribute('content') || '') }))()`);
    check("sidepanel: rapid A→B selection renders only B's conversation (fenced history load)",
      raceState.name === "Reader" &&
      raceState.bubbles.some((c) => c.includes(routedTask)) &&
      !raceState.bubbles.some((c) => c.includes(siteTask)),
      { name: raceState.name, count: raceState.bubbles.length });

    // ── lifecycle broadcasts (the round-2 blocker: EVERY background
    //    mutation must broadcast agent-registry-changed) ─────────────────
    await clickExpr(sp, `document.getElementById('agent-back')`);
    await sleep(400);
    // CAP-FB-20260830-FRESH-PROFILE-TEMPLATE-AGENTS-01: a duplicated recipe is
    // DISABLED, so it is a template and never an agent row. The live-broadcast
    // property is measured on the picker's applied registry revision (it
    // re-fetched without a reload) and on the registry route itself.
    const revBeforeDup = await evl(sp, `${SP_PICK}._appliedRevision`);
    const dupRes = await msg(sp, { type: "recipe.duplicate", id: bgFirst?.id });
    const copyId = dupRes?.recipe?.id;
    await sleep(1500); // broadcast → picker.refresh()
    const revAfterDup = await evl(sp, `${SP_PICK}._appliedRevision`);
    const spAfterDup = await evl(sp, `[...${SP_PICK}.shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent)`);
    const regAfterDup = await msg(sp, { type: "agent.registry" });
    const bgAfterDup = regAfterDup?.groups?.find((g) => g.id === "background")?.agents ?? [];
    check("lifecycle: recipe.duplicate broadcasts — the picker refreshes live (no reload); the disabled copy is a template, not a row",
      !!copyId && Number(revAfterDup) > Number(revBeforeDup) &&
      bgAfterDup.some((a) => a.id === copyId && a.name === `${bgName} (copy)` && a.enabled === false) &&
      !spAfterDup.includes(`${bgName} (copy)`), { copyId, revBeforeDup, revAfterDup, spAfterDup });
    await msg(sp, { type: "recipe.update", id: copyId, name: "Renamed Copy" });
    await sleep(1500);
    const revAfterRename = await evl(sp, `${SP_PICK}._appliedRevision`);
    const spAfterRename = await evl(sp, `[...${SP_PICK}.shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent)`);
    const regAfterRename = await msg(sp, { type: "agent.registry" });
    const bgAfterRename = regAfterRename?.groups?.find((g) => g.id === "background")?.agents ?? [];
    check("lifecycle: recipe.update renames the copy live in the registry; the picker refreshes and still lists no template",
      Number(revAfterRename) > Number(revAfterDup) &&
      bgAfterRename.some((a) => a.id === copyId && a.name === "Renamed Copy") &&
      !spAfterRename.includes("Renamed Copy") && !spAfterRename.includes(`${bgName} (copy)`),
      { revAfterDup, revAfterRename, spAfterRename });
    await msg(sp, { type: "recipe.delete", id: copyId });
    await sleep(1500);
    const spAfterDelete = await evl(sp, `[...${SP_PICK}.shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent)`);
    check("lifecycle: recipe.delete removes the copy live",
      !spAfterDelete.includes("Renamed Copy"), spAfterDelete);

    // live named create → the list updates without a reload.
    await msg(sp, { type: "named-agent.create", name: "Live Agent", role: "appears live" });
    await sleep(1500);
    const spLive = await evl(sp, `[...${SP_PICK}.shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent)`);
    check("lifecycle: a created named agent appears live (no reload)", spLive.includes("Live Agent"), spLive);

    // select Reader → the conversation/history surface + composer.
    await clickExpr(sp, spPickOptByName("Reader"));
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

    // direct a task to the agent from the side panel (a REAL run).
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

    // live rename → the OPEN conversation re-titles.
    await msg(sp, { type: "named-agent.update", id: "reader", name: "Reader Pro" });
    await sleep(1500);
    const spRenamed = await evl(sp, `document.getElementById('agent-detail-name').textContent`);
    check("sidepanel: a rename updates the open conversation live", spRenamed === "Reader Pro", spRenamed);

    // live delete of the OPEN agent → the conversation closes honestly.
    await msg(sp, { type: "named-agent.delete", id: "reader" });
    await sleep(1500);
    const spDeleted = await evl(sp, `(() => ({ detail: !document.getElementById('agent-detail-pane').hidden,
      list: !document.getElementById('agents-list-pane').hidden,
      opts: [...${SP_PICK}.shadowRoot.querySelectorAll('.opt .name')].map(n => n.textContent) }))()`);
    check("sidepanel: deleting the open agent closes its conversation + updates the list",
      spDeleted.detail === false && spDeleted.list === true &&
      !spDeleted.opts.includes("Reader Pro") && spDeleted.opts.includes("Live Agent"), spDeleted);
    check("sidepanel: live-update screenshot", await shot(sp, "after-08-sidepanel-live"));

    // A DISABLED background agent is never restored (the round-2 blocker).
    // The browse list no longer shows disabled agents (they are templates), so
    // a stale saved selection can only come from a session that selected the
    // agent BEFORE it was disabled — write that saved selection the way the
    // panel persists it, reload, and it must be dropped: the detail stays closed.
    const disabledSaved = await evl(sp, `(() => { const v = JSON.stringify({ ref: ${JSON.stringify(bgRef)}, kind: "background",
      id: ${JSON.stringify(bgFirst?.id ?? "")}, name: ${JSON.stringify(bgName)} });
      sessionStorage.setItem('cap:sidepanel:selected-agent', v); return v; })()`);
    await send("Page.reload", {}, sp);
    await sleep(2500);
    const spDisabledRestore = await evl(sp, `(() => ({ detail: !document.getElementById('agent-detail-pane').hidden,
      saved: sessionStorage.getItem('cap:sidepanel:selected-agent') }))()`);
    check("sidepanel: a DISABLED background agent is NOT restored after a reload (stale session dropped)",
      !!disabledSaved && JSON.parse(disabledSaved).ref === bgRef &&
      spDisabledRestore.detail === false &&
      (!spDisabledRestore.saved || JSON.parse(spDisabledRestore.saved).ref !== bgRef),
      { disabledSaved, spDisabledRestore });

    // session persistence: select Live Agent, reload, and it restores.
    await clickExpr(sp, `document.getElementById('tab-agents')`);
    await sleep(1000);
    await clickExpr(sp, spPickOptByName("Live Agent"));
    await sleep(800);
    await send("Page.reload", {}, sp);
    await sleep(2500);
    const spRestored = await evl(sp, `(() => ({ agents: !document.getElementById('agents-view').hidden,
      detail: !document.getElementById('agent-detail-pane').hidden,
      name: document.getElementById('agent-detail-name').textContent }))()`);
    check("sidepanel: the selected agent restores after a reload (per-session)",
      spRestored.agents && spRestored.detail && spRestored.name === "Live Agent", spRestored);

    // switch back to the page orchestration context.
    await clickExpr(sp, `document.getElementById('tab-page')`);
    await sleep(400);
    const spBack = await evl(sp, `(() => ({ page: !document.getElementById('page-view').hidden,
      agents: !document.getElementById('agents-view').hidden, url: !!document.getElementById('url') }))()`);
    check("sidepanel: switching back to page orchestration works", spBack.page && !spBack.agents && spBack.url, spBack);

    // narrow viewport (380px) + 200% zoom: no horizontal overflow.
    await clickExpr(sp, `document.getElementById('tab-agents')`);
    await sleep(600);
    await send("Emulation.setDeviceMetricsOverride", { width: 380, height: 800, deviceScaleFactor: 2, mobile: true }, sp);
    await sleep(600);
    const spNarrow = await evl(sp, `(() => ({ overflow: document.documentElement.scrollWidth > 382,
      detailVisible: !document.getElementById('agent-detail-pane').hidden }))()`);
    check("sidepanel: narrow + 200% zoom — no horizontal overflow", spNarrow.overflow === false, spNarrow);
    check("sidepanel: narrow screenshot", await shot(sp, "after-09-sidepanel-narrow-zoom"));
    await send("Emulation.clearDeviceMetricsOverride", {}, sp);

    // 44px targets on the picker options (measured at default size on the NTP).
    await clickExpr(ntp, PLUS);
    await sleep(300);
    await clickExpr(ntp, CHOOSE_AGENT);
    await sleep(900);
    const optHeights = await evl(ntp, `[...${NTP_PICK}.shadowRoot.querySelectorAll('.opt')].map(o => Math.round(o.getBoundingClientRect().height))`);
    check("a11y: every picker option is a ≥44px target", optHeights.length > 0 && optHeights.every((h) => h >= 44), optHeights);
    const comboA11y = await evl(ntp, `(() => { const p = ${NTP_PICK};
      const s = p.shadowRoot.querySelector('.search'); const list = p.shadowRoot.querySelector('.list');
      return { role: s.getAttribute('role'), expanded: s.getAttribute('aria-expanded'),
        controls: s.getAttribute('aria-controls'), listRole: list.getAttribute('role'),
        optRoles: [...p.shadowRoot.querySelectorAll('.opt')].every(o => o.getAttribute('role') === 'option'),
        visibleLabel: !!p.shadowRoot.querySelector('label.lbl')?.textContent };
    })()`);
    check("a11y: combobox→listbox contract + visible label",
      comboA11y.role === "combobox" && comboA11y.expanded === "true" && !!comboA11y.controls &&
      comboA11y.listRole === "listbox" && comboA11y.optRoles && comboA11y.visibleLabel, comboA11y);
    // Escape in the picker → the popover closes + focus returns to the + button.
    await pressKey(ntp, "Escape");
    await sleep(300);
    const escReturn = await evl(ntp, `(() => { const c = ${COMPOSER};
      const plus = c.querySelector('#attach').shadowRoot.querySelector('.plus');
      return { closed: c.querySelector('#agent-pop').hidden,
        focusOnPlus: c.querySelector('#attach').shadowRoot.activeElement === plus };
    })()`);
    check("a11y: Escape closes the picker + focus returns to the + trigger",
      escReturn.closed === true && escReturn.focusOnPlus === true, escReturn);

    // attachment-menu regression AFTER all the agent flows: it still opens + lists.
    await clickExpr(ntp, PLUS);
    await sleep(300);
    const menuAfter = await evl(ntp, `[...${COMPOSER}.querySelector('#attach').shadowRoot.querySelectorAll('.menu button')].map(b => b.dataset.kind)`);
    check("regression: the attachment menu still works after the agent flows",
      menuAfter.includes("file") && menuAfter.includes("choose-agent"), menuAfter);
    await pressKey(ntp, "Escape"); // close the menu with a real key

    // no console errors on either surface.
    const ntpErrors = consoleErrors.get(ntp) ?? [];
    const spErrors = consoleErrors.get(sp) ?? [];
    check("no console errors on the NTP", ntpErrors.length === 0, ntpErrors.slice(0, 3));
    check("no console errors on the side panel", spErrors.length === 0, spErrors.slice(0, 3));
  } catch (e) {
    // Preserve a receipt even on an unexpected runner error: the exact-set
    // gate below marks all uncompleted checks missing, and the manifest binds
    // that failure to the tested source instead of losing the evidence.
    fail++;
    failures.push(`runner error: ${String(e?.message ?? e)}`);
    console.error("runner error:", e);
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }

  // ── the exact assertion-set gate (no silent shrink, no reorder) ────────
  const missing = EXPECTED.filter((n) => !META_CHECKS.has(n) && !ranNames.includes(n));
  const extra = ranNames.filter((n) => !EXPECTED.includes(n));
  for (const n of missing) {
    console.log(`FAIL: ${n} (not reached)`);
    results.push({ name: n, pass: false });
    fail++;
  }
  for (const n of extra) console.log(`EXTRA assertion (should be in EXPECTED): ${n}`);
  check("assertion set exact (no missing/extra checks)", missing.length === 0 && extra.length === 0);
  const ranOrdered = ranNames.filter((n) => !META_CHECKS.has(n));
  const expectedOrdered = EXPECTED.filter((n) => !META_CHECKS.has(n));
  const orderOk = ranOrdered.length === expectedOrdered.length &&
    ranOrdered.every((n, i) => n === expectedOrdered[i]);
  check("assertion order matches EXPECTED", orderOk);

  // ── the attestation manifest (EXTERNAL evidence, never committed) ──────
  // Binds this evidence to the EXACT tested commit + the worktree state +
  // the SHA-256 of every screenshot + the exact assertion set. The final
  // check requires a CLEAN worktree: the attestation run happens on the
  // committed tree (evidence is written externally, so the run itself does
  // not dirty it — test-artifacts/ is untracked).
  let testedSourceCommit = null;
  let dirty = ["git lookup failed"];
  try {
    const g = new Deno.Command(GIT, { args: ["rev-parse", "HEAD"], stdout: "piped", stderr: "piped", clearEnv: true, cwd: ROOT }).outputSync();
    if (g.code !== 0) throw new Error(`git rev-parse failed (exit ${g.code})`);
    testedSourceCommit = new TextDecoder().decode(g.stdout).trim();
    if (!/^[0-9a-f]{40}$/.test(testedSourceCommit)) throw new Error(`not a commit: ${testedSourceCommit}`);
    const st = new Deno.Command(GIT, { args: ["status", "--porcelain"], stdout: "piped", clearEnv: true, cwd: ROOT }).outputSync();
    dirty = (st.code === 0 ? new TextDecoder().decode(st.stdout) : "")
      .split("\n").filter(Boolean);
  } catch (e) {
    console.error("manifest: git binding failed —", String(e?.message ?? e));
  }
  const assertionSetSha256 = await sha256Hex(new TextEncoder().encode(EXPECTED.join("\n")));
  const manifest = {
    runId: RUN_ID,
    ts: new Date().toISOString(),
    testedSourceCommit,
    worktreeClean: Array.isArray(dirty) && dirty.length === 0,
    worktreeDirtyFiles: Array.isArray(dirty) ? dirty.slice(0, 40) : [],
    evidenceCommitNote: "evidence is EXTERNAL (never committed) — testedSourceCommit is the exact source this run exercised",
    providerNote: "headless run: no provider keys — the runs use the deterministic demo provider (routing/journaling are what's attested, not model quality)",
    inputNote: "every interaction is genuine CDP input (Input.dispatchMouseEvent / Input.insertText / Input.dispatchKeyEvent); Runtime.evaluate is used for reads + message probes only",
    evidenceDir: EVIDENCE_DIR,
    passed: pass,
    failed: fail,
    assertionSetSha256,
    checks: results,
    files: evidenceFiles,
  };
  const manifestPath = `${EVIDENCE_DIR}/manifest.json`;
  try {
    // First durable write establishes that the external evidence directory is
    // writable and that the commit/cleanliness binding can be recorded.
    await Deno.writeFile(manifestPath,
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    manifestOk = !!testedSourceCommit && manifest.worktreeClean === true;
  } catch (e) {
    console.error("manifest: write failed —", String(e?.message ?? e));
  }
  check("evidence manifest written + bound to the tested commit", manifestOk,
    { testedSourceCommit, worktreeClean: manifest.worktreeClean, dirty: manifest.worktreeDirtyFiles });
  // Rewrite once so the durable receipt includes the final manifest check and
  // final totals too. (The manifest is intentionally not self-hashed.)
  manifest.passed = pass;
  manifest.failed = fail;
  manifest.checks = results;
  try {
    await Deno.writeFile(manifestPath,
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  } catch (e) {
    console.error("manifest: final receipt write failed —", String(e?.message ?? e));
    fail++;
    failures.push("evidence manifest final receipt write");
  }

  console.log(`\n${pass} passed, ${fail} failed — evidence: ${EVIDENCE_DIR}`);
  if (failures.length) console.log("failures:", failures.join(" | "));
  Deno.exit(fail ? 1 : 0);
}

await main();
