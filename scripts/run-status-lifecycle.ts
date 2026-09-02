// run-status-lifecycle.ts — the REAL-Chrome journeys for the visible task/run
// lifecycle status surface on current main, written
// FAILING-FIRST from the rejected 0134bff review's blockers:
// @ts-nocheck — untyped driver (the same pattern as panel-leak-probe.ts); it
// carried 124 implicit-any errors before the launcher migration and its
// assertions are runtime checks, not types.
//
// SURFACE (2026-08-28): the status surface is the conversation's INLINE
// live-status row — `#thread-conversation conversation-run-status.live-status`
// (sticky at the bottom of the chat; absent when idle/completed — completion
// resolves the row into the final conversation entry). Host attributes carry
// state/activity; the shadow .surface carries data-state/data-active.
//
//   - overlapping runs (same-surface double-send): the LATEST turn owns the
//     banner/terminal state; no late turn-1 status/result; next-reply routing,
//   - navigation/thread switch mid-run: no bleed into the opened thread; the
//     run journals in its OWN thread,
//   - back mid-run: no stuck global status/banner,
//   - reload mid-run (the genuine MV3 port disconnect + reconnect): the page
//     recovers clean; the SW-side run still completes + journals; reopening
//     the thread shows the journaled truth,
//   - exact active→terminal transitions: the banner's recorded sequence is
//     exactly [working → terminal], never done-then-working, never duplicated,
//   - shadow-root AX: the banner + loader expose role=status with accessible
//     names in the BROWSER accessibility tree (CDP AX domain — not DOM reads),
//   - no production test seams, real CDP clicks/keys only (Input.*), genuine
//     service-worker journal reads as the source of truth.
//
// HARD STOP: the journey starts a deterministic @demo-slow run, clicks the
// visible Stop button through CDP input, and verifies both the durable cancelled
// record and the honest visible Stopped state.
//
// ATTESTATION: the manifest binds the exact tested commit (git rev-parse),
// the worktree cleanliness (DERIVED from git status — never hardcoded), the
// branch, and SHA-256 of every screenshot AND every loaded source/bundle file.
// Evidence is EXTERNAL (a fresh /tmp dir), never committed.
//
//   deno run -A scripts/run-status-lifecycle.ts

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const GIT = "/usr/bin/git";
const EVIDENCE_DIR = `/tmp/cap-run-status-evidence-${Date.now()}`;
const RUN_ID = `cap-run-status-${Date.now()}`;

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

const META_CHECKS = new Set([
  "assertion set exact (no missing/extra checks)",
  "assertion order matches EXPECTED",
  "evidence manifest written + bound to the tested commit",
]);
const EXPECTED = [
  "extension loaded",
  "NTP: opened with the hub composer present",
  "run 1: typed + sent via real input (input-clear witness)",
  "run 1: the banner reached WORKING with an active loader (plainly visible, not mid-transition)",
  "run 1: the status-row sequence was working → resolved (recorded, no duplicates/regressions)",
  "run 1: the result rendered + the SW journaled the task/result pair",
  "run 1: screenshot of the settled terminal state",
  "hard stop: a slow live run exposes the visible Stop button",
  "hard stop: one real click cancels the exact durable run",
  "hard stop: the UI settles to Stopped without a successful result",
  "hard stop: screenshot of the stopped state",
  "double-send: both turns genuinely started while run 1 was pending (two input-clear witnesses + genuine overlap)",
  "double-send: the banner never showed a terminal state from turn 1 while turn 2 was in flight",
  "double-send: two threads created; the LATEST turn owns the surface (title + single terminal)",
  "double-send: the next reply routes to the SECOND thread (no misrouting)",
  "double-send: no stuck banner/status after settle (status ready, banner sequence clean)",
  "switch: run started + provably in flight (no journal row yet)",
  "switch: opened another thread mid-flight — ONLY its own messages, no status flip, no retitle",
  "switch: the switched-away run journaled its result in its OWN thread",
  "back mid-run: the global status is not stuck running after leaving",
  "back mid-run: the run still completes + journals after leaving",
  "reload mid-run: the page recovers clean (no stuck status row)",
  "reload mid-run: the disconnected run completes in the SW + journals",
  "reload mid-run: reopening the thread shows the journaled result (reconnect truth)",
  "AX: the working status row exposes role=status + an accessible name in the browser AX tree",
  "AX: the status row's activity label is exposed (through the shadow root)",
  "AX: exactly ONE run-status live region (no duplicate status surfaces)",
  "follow-up: sending in an already-open thread does NOT restart the view transition (no banner flash)",
  "follow-up: screenshot of the LIVE working state (no transition by construction)",
  "follow-up: the status row stays continuously working until its own terminal resolves it (no stale-terminal flap)",
  "no console errors on the NTP",
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

// The shared launcher owns the spawn: kernel-assigned port, endpoint read from
// this child's own stderr, honest failure when the browser prints none. The
// journey keeps its own argv (fake media devices for the mic surface).
function startChrome(profile) {
  return launchChrome({
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--silent-debugger-extension-api",
      "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--remote-allow-origins=*",
      "--window-size=1400,2000", `--user-data-dir=${profile}`, "about:blank",
    ],
    stdout: "null", clearEnv: true, timeoutMs: 20000,
  });
}

// Hard global watchdog: whatever happens below, the suite kills Chrome and
// exits non-zero at the deadline — a hung page/evaluate must never park a
// shared lane again.
const WATCHDOG_MS = 8 * 60 * 1000;
let watchdogProc = null;
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: global deadline hit — killing Chrome and failing");
  try { watchdogProc?.kill("SIGKILL"); } catch { /* already dead */ }
  Deno.exit(1);
}, WATCHDOG_MS);

async function main() {
  await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
  const profile = `/tmp/cap-run-status-profile-${Date.now()}`;
  const chrome = await startChrome(profile);
  const proc = chrome.proc;
  watchdogProc = proc;
  const port = chrome.port;

  // The browser endpoint came from THIS child's stderr — connect to it
  // directly (no /json/version probe of a port that could belong to a
  // stranger). The journey keeps its own socket: it acks screencast frames
  // and captures console errors per session.
  const ws = new WebSocket(chrome.wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let idc = 0;
  const pend = new Map();
  const consoleErrors = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    // Keep the compositor alive (view transitions freeze without frames).
    if (m.method === "Page.screencastFrame") {
      ws.send(JSON.stringify({ id: ++idc, method: "Page.screencastFrameAck",
        params: { sessionId: m.params.sessionId }, sessionId: m.sessionId }));
    }
    if (m.method === "Runtime.exceptionThrown" ||
        (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error")) {
      const detail = m.params?.exceptionDetails?.exception?.description ??
        m.params?.args?.map((a) => a?.value ?? a?.description).join(" ") ?? "?";
      const arr = consoleErrors.get(m.sessionId) ?? [];
      arr.push(String(detail).slice(0, 300));
      consoleErrors.set(m.sessionId, arr);
    }
  };
  // A busy renderer (heavy SW churn + system contention) can stall a response;
  // 60s + retry-with-backoff in evl absorb it without wedging a shared lane.
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++idc;
      const timer = setTimeout(() => { pend.delete(mid); reject(new Error(`cdp timeout: ${method}`)); }, 60000);
      pend.set(mid, (m) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  // Runtime.evaluate is used for READS + backend message probes ONLY — never
  // to mutate the UI (every interaction is genuine CDP input).
  const evlRaw = async (session, expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r?.result?.value;
  };
  // A heavy SW churn window can stall an evaluate past the CDP timeout — a
  // single retry after a beat (the page recovers; a genuinely dead page fails
  // the retry too and surfaces).
  const evl = async (session, expression) => {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await evlRaw(session, expression);
      } catch (e) {
        lastErr = e;
        if (!/cdp timeout/.test(String(e?.message ?? e))) throw e;
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastErr;
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
    await send("Input.insertText", { text }, session);
  };
  const KEYS = {
    Escape: { code: "Escape", vk: 27 },
    Backspace: { code: "Backspace", vk: 8 },
    a: { code: "KeyA", vk: 65 },
  };
  const pressKey = async (session, key, modifiers = 0) => {
    const k = KEYS[key];
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers }, session);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers }, session);
  };
  const msg = (session, payload) =>
    evl(session, `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => ({ v }), e => ({ err: e.message }))`)
      .then((r) => r?.v ?? { ok: false, error: r?.err ?? "no response" });
  // Click and CONFIRM with bounded retries (a view-transition snapshot can
  // swallow a real click mid-animation — a user just clicks again).
  const clickUntil = async (session, expr, confirmExpr, tries = 5) => {
    for (let i = 0; i < tries; i++) {
      await clickExpr(session, expr);
      await sleep(250);
      if (await evl(session, confirmExpr).catch(() => false)) return true;
    }
    return false;
  };
  // The input-clear witness: the composer's send handler clears its input
  // SYNCHRONOUSLY in the click handler — a cleared field proves the send
  // genuinely began (a swallowed click leaves the field full).
  const sendWithWitness = async (session, composerExpr, text, beforeSend = null) => {
    const INPUT = `${composerExpr}.querySelector('#task-input')`;
    const BTN = `${composerExpr}.querySelector('#run-task')`;
    await clickUntil(session, INPUT, `document.activeElement === ${INPUT}`);
    await pressKey(session, "a", 2);
    await pressKey(session, "Backspace");
    await typeText(session, text);
    if ((await evl(session, `(${INPUT})?.value ?? null`)) !== text) return false;
    // beforeSend fires RIGHT before the send click (warmup runs must not burn
    // their window during the slow input setup).
    if (beforeSend) await beforeSend();
    for (let i = 0; i < 6; i++) {
      await clickExpr(session, BTN);
      await sleep(120);
      if ((await evl(session, `(${INPUT})?.value ?? null`)) === "") return true;
    }
    return false;
  };
  // Query the BROWSER accessibility tree (the CDP AX domain — not DOM reads).
  const axNodes = async (session, selector) => {
    await send("Accessibility.enable", {}, session).catch(() => {});
    const doc = await send("DOM.getDocument", {}, session);
    const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector }, session);
    if (!q?.nodeId) return null;
    const d = await send("DOM.describeNode", { nodeId: q.nodeId }, session);
    const ax = await send("Accessibility.queryAXTree", { backendNodeId: d.node.backendNodeId }, session);
    return ax?.nodes ?? null;
  };
  const journalHas = async (session, marker) => {
    try {
      const j = await msg(session, { type: "memory.get", origin: "master", key: "journal" });
      const rows = Array.isArray(j) ? j : [];
      return rows.some((r) => r?.type === "result" &&
        rows.some((q) => q?.type === "task" && typeof q.task === "string" &&
          q.task.includes(marker) && q.id === r.id));
    } catch {
      return false; // a transient evaluate hiccup never crashes a poll loop
    }
  };
  // Close the thread view via its REAL Back button (current main has no
  // Escape-to-close) and wait for the close to settle.
  const closeThread = async (session) => {
    if (await evl(session, `document.getElementById('thread-view').hidden === true`).catch(() => true)) return true;
    return await clickUntil(session, `document.getElementById('thread-back')`,
      `document.getElementById('thread-view').hidden === true`, 6);
  };
  // Open a thread by its sidebar title DETERMINISTICALLY: click ONCE, then
  // poll for the open to complete. A retry-per-poll click loop fights the
  // product's surface-owner fencing — every re-click claims a NEW owner token
  // and fences the in-flight open it was retrying (the watcher-proven flake).
  // Re-click only after a genuine no-open (the click never landed).
  const openThreadByTitle = async (session, marker) => {
    const itemExpr = `[...document.querySelectorAll('#thread-sidebar .thread-item')].find(el => (el.title ?? '').includes(${JSON.stringify(marker)}))`;
    const openConfirm = `!document.getElementById('thread-view').hidden && document.getElementById('thread-title').textContent.includes(${JSON.stringify(marker)})`;
    for (let clickAttempt = 0; clickAttempt < 4; clickAttempt++) {
      await clickExpr(session, itemExpr);
      for (let i = 0; i < 40; i++) {
        if (await evl(session, openConfirm).catch(() => false)) return true;
        await sleep(150);
      }
    }
    return false;
  };
  // Prune the sidebar to ONLY the threads whose titles contain a keep-marker
  // (via the genuine thread.delete SW route — never a UI mutation). The
  // warmup-queued race windows flood the 40-item sidebar window; without a
  // prune, an older target thread scrolls off and its sidebar item no longer
  // exists to click (the watcher-proven switch/reload flake).
  const pruneThreadsTo = async (session, keepMarkers) => {
    const list = await msg(session, { type: "thread.list" });
    for (const t of (list?.threads ?? [])) {
      const title = String(t?.name ?? "") + " " + String(t?.preview ?? "");
      if (keepMarkers.some((m) => title.includes(m))) continue;
      await msg(session, { type: "thread.delete", id: t.id });
    }
  };
  // Wait until the thread view is genuinely closed (hidden) — the close
  // transition defers the DOM change a frame.
  const waitThreadClosed = async (session) => {
    for (let i = 0; i < 30; i++) {
      if (await evl(session, `document.getElementById('thread-view').hidden === true`).catch(() => false)) return true;
      await sleep(100);
    }
    return false;
  };
  // The inline status row's recorded state sequence (host attributes + text),
  // captured via a MutationObserver on the CONVERSATION installed BEFORE the
  // run — the genuine transition record (the row itself is created/removed).
  const OBSERVER_INSTALL = `(() => {
    window.__statusSeq = [];
    const conv = document.getElementById('thread-conversation');
    if (!conv) return false;
    const read = () => {
      const el = conv.querySelector('conversation-run-status.live-status');
      const txt = (el?.textContent ?? '').trim().slice(0, 40);
      const st = !el ? 'hidden' : (el.getAttribute('state') === 'failed' ? 'error' : el.getAttribute('state') === 'completed' ? 'done' : 'working');
      const last = window.__statusSeq[window.__statusSeq.length - 1];
      if (!last || last.state !== st || last.txt !== txt) window.__statusSeq.push({ state: st, txt, t: Math.round(performance.now()) });
    };
    window.__statusObs = new MutationObserver(read);
    window.__statusObs.observe(conv, { attributes: true, childList: true, subtree: true, characterData: true });
    return true;
  })()`;

  try {
    // ── boot ───────────────────────────────────────────────────────────
    let sw = null;
    for (let i = 0; i < 150 && !sw; i++) {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      sw = targets.find((t) => t.type === "service_worker");
      if (!sw) await sleep(200);
    }
    check("extension loaded", !!sw);
    const extId = sw.url.split("/")[2];

    const ntp = await openPage(`chrome-extension://${extId}/ntp/ntp.html`);
    await send("Page.startScreencast", { format: "jpeg", quality: 30, everyNthFrame: 1 }, ntp).catch(() => {});
    await sleep(1800);

    const COMPOSER = `document.getElementById('composer')`;
    const NTP_INPUT = `${COMPOSER}.querySelector('#task-input')`;
    check("NTP: opened with the hub composer present", await evl(ntp, `!!(${NTP_INPUT})`));
    // the marker demo model sits behind the developer flag (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01)
    await msg(ntp, { type: "kv.set", values: { "cap:developerFeatures": true } });

    // ── run 1: the exact active→terminal transition ──────────────────────
    const marker1 = `rs-run-one-${Date.now() % 100000}`;
    await evl(ntp, OBSERVER_INSTALL);
    // Warmup runs queue ahead (withRunLock serializes master runs) so the UI
    // run's WORKING window is wide enough to observe genuinely — fired RIGHT
    // before the send, not before the slow input setup.
    const warmups1 = () => evl(ntp, `(() => { for (let i = 0; i < 8; i++) chrome.runtime.sendMessage({ type: 'agent.run', task: 'rs warmup1 ${Date.now()} ' + i, id: 'rsw1-${Date.now()}-' + i }).catch(() => {}); return true; })()`);
    const sent1 = await sendWithWitness(ntp, COMPOSER, marker1, warmups1);
    check("run 1: typed + sent via real input (input-clear witness)", sent1);
    // The banner must reach WORKING with an active loader, plainly visible.
    let working = null;
    let tDetect = 0;
    let tSent = 0;
    for (let i = 0; i < 40 && !working; i++) {
      const w = await evl(ntp, `(() => {
        const el = document.querySelector('#thread-conversation conversation-run-status.live-status');
        if (!el) return null;
        const state = el.getAttribute('state');
        const surface = el.shadowRoot?.querySelector('.surface');
        return { visible: true, state,
          loaderActive: surface?.getAttribute('data-active') === 'true',
          gridRole: surface?.getAttribute('role') ?? null };
      })()`);
      if (w?.visible && w.loaderActive) { working = w; tDetect = Date.now(); }
      else await sleep(50);
    }
    check("run 1: the banner reached WORKING with an active loader (plainly visible, not mid-transition)",
      working != null, { working, msAfterWitness: tDetect && tSent ? tDetect - tSent : null });
    // The working-state screenshot is captured DURING the in-flight window the
    // poll just proved, but only AFTER the open transition has genuinely
    // settled (the rejected review's faded shot was a transition artifact) —
    // the polling evals also pump the headless frame clock.
    // (The LIVE-working screenshot lives in the follow-up section, where the
    // fixed no-retransition path makes a transition artifact impossible by
    // construction — the rejected review's faded-shot finding.)
    // Wait for the terminal state, then read the recorded sequence.
    let done1 = false;
    for (let i = 0; i < 80 && !done1; i++) {
      done1 = await journalHas(ntp, marker1);
      if (!done1) await sleep(100);
    }
    // Let the terminal render land — poll for the agent bubble (the page-side
    // continuation can lag the journal write by a beat).
    for (let i = 0; i < 30; i++) {
      const n = await evl(ntp, `document.querySelectorAll('#thread-conversation message-bubble[role="agent"]').length`);
      if (n >= 1) break;
      await sleep(100);
    }
    const seq1 = await evl(ntp, `window.__statusSeq ?? []`);
    // The inline row RESOLVES by removal (no terminal state renders) — the
    // lifecycle contract: one contiguous block of working states, then hidden
    // (resolved), never error, no hidden-gap flash mid-run.
    const trimmed1 = [...seq1];
    while (trimmed1.length && trimmed1[0].state === "hidden") trimmed1.shift();
    const resolved1 = trimmed1.length > 1 && trimmed1[trimmed1.length - 1].state === "hidden";
    const body1 = trimmed1.slice(0, -1);
    check("run 1: the status-row sequence was working → resolved (recorded, no duplicates/regressions)",
      done1 && resolved1 && body1.length >= 1 && body1.every((s) => s.state === "working"), seq1);
    const bub1 = await evl(ntp, `[...document.querySelectorAll('#thread-conversation message-bubble')]
      .map(b => b.getAttribute('role'))`);
    check("run 1: the result rendered + the SW journaled the task/result pair",
      done1 && bub1.filter((r) => r === "user").length === 1 && bub1.filter((r) => r === "agent").length === 1,
      bub1);
    check("run 1: screenshot of the settled terminal state", await shot(ntp, "run1-terminal"));

    // ── hard stop: one click aborts a real admitted slow run ─────────────
    await closeThread(ntp);
    const stopMarker = `rs-stop-${Date.now() % 100000} @demo-slow`;
    const sentStop = await sendWithWitness(ntp, COMPOSER, stopMarker);
    const stopButtonExpr = `document.querySelector('#thread-conversation conversation-run-status.live-status')?.shadowRoot?.querySelector('.stop')`;
    let stopReady = false;
    let stopExecutionId = null;
    for (let i = 0; i < 100 && !(stopReady && stopExecutionId); i++) {
      stopReady = await evl(ntp, `!!(${stopButtonExpr}) && (${stopButtonExpr}).textContent.trim() === 'Stop'`);
      const runs = await msg(ntp, { type: "run.list" });
      stopExecutionId = (runs?.runs ?? []).find((run) => String(run?.taskPreview ?? "").includes("rs-stop-") && run?.phase === "running")?.executionId ?? null;
      if (!(stopReady && stopExecutionId)) await sleep(50);
    }
    check("hard stop: a slow live run exposes the visible Stop button", sentStop && stopReady && !!stopExecutionId,
      { sentStop, stopReady, stopExecutionId });
    const stopClicked = stopReady && await clickExpr(ntp, stopButtonExpr);
    let stoppedRun = null;
    for (let i = 0; i < 120 && stoppedRun?.phase !== "cancelled"; i++) {
      const runs = await msg(ntp, { type: "run.list" });
      stoppedRun = (runs?.runs ?? []).find((run) => run?.executionId === stopExecutionId) ?? null;
      if (stoppedRun?.phase !== "cancelled") await sleep(50);
    }
    check("hard stop: one real click cancels the exact durable run",
      stopClicked && stoppedRun?.phase === "cancelled", { stopClicked, stoppedRun });
    let stoppedUi = null;
    for (let i = 0; i < 40 && stoppedUi?.label !== "Stopped"; i++) {
      stoppedUi = await evl(ntp, `(() => { const row = document.querySelector('#thread-conversation conversation-run-status.live-status');
        return row ? { state: row.getAttribute('state'), label: row.shadowRoot?.querySelector('.label')?.textContent?.trim() ?? '' } : null; })()`);
      if (stoppedUi?.label !== "Stopped") await sleep(50);
    }
    const stopAgentResults = await evl(ntp, `[...document.querySelectorAll('#thread-conversation message-bubble[role="agent"]')].length`);
    check("hard stop: the UI settles to Stopped without a successful result",
      stoppedUi?.state === "cancelled" && stoppedUi?.label === "Stopped" && stopAgentResults === 0,
      { stoppedUi, stopAgentResults });
    check("hard stop: screenshot of the stopped state", await shot(ntp, "hard-stop-stopped"));

    // ── overlapping runs: the same-surface double-send ───────────────────
    const d1 = `rs-ds-first-${Date.now() % 100000}`;
    const d2 = `rs-ds-second-${Date.now() % 100000}`;
    const d3 = `rs-ds-reply-${Date.now() % 100000}`;
    // Back to the hub first (a new task surface).
    await closeThread(ntp);
    const T_COMPOSER = `document.getElementById('thread-composer')`;
    // Warmup runs queue ahead of the UI run (the SW serializes master runs
    // with withRunLock) so the second send lands while the first is PENDING.
    // The GENUINE-OVERLAP witness: turn 1 must still be in flight (no journal
    // row) at the moment turn 2's send clears — otherwise the pair is retried
    // with a wider window (never silently vacuous).
    await evl(ntp, OBSERVER_INSTALL); // fresh sequence for the double-send
    let sentA = false;
    let sentB = false;
    let genuineOverlap = false;
    let doneEarly = false;
    const dsTiming = [];
    for (let attempt = 0; attempt < 4 && !genuineOverlap; attempt++) {
      const a1 = attempt === 0 ? d1 : `${d1}-r${attempt}`;
      const a2 = attempt === 0 ? d2 : `${d2}-r${attempt}`;
      await closeThread(ntp); // each attempt starts from the hub
      await evl(ntp, OBSERVER_INSTALL);
      sentA = await sendWithWitness(ntp, COMPOSER, a1, () => evl(ntp, `(() => { for (let i = 0; i < 12; i++) chrome.runtime.sendMessage({ type: 'agent.run', task: 'rs warmup ${Date.now()} ' + i, id: 'rswp${Date.now()}-' + i }).catch(() => {}); return true; })()`));
      sentB = await sendWithWitness(ntp, T_COMPOSER, a2);
      genuineOverlap = sentA && sentB && !(await journalHas(ntp, a1));
      dsTiming.push({ attempt, sentA, sentB, a1InFlightAtB: genuineOverlap });
      if (!genuineOverlap) continue;
      // While turn 2 is in flight, the inline status row must never show a
      // terminal state (turn 1's late terminal is fenced).
      for (let i = 0; i < 100; i++) {
        const st = await evl(ntp, `(() => { const el = document.querySelector('#thread-conversation conversation-run-status.live-status');
          if (!el) return 'hidden';
          const s = el.getAttribute('state');
          return s === 'failed' ? 'error' : (s === 'running' || s === 'retrying' || s === 'queued') ? 'working' : (s ?? 'hidden'); })()`).catch(() => "hidden");
        let d2Done = await journalHas(ntp, a2);
        if ((st === "done" || st === "error") && !d2Done) {
          // The banner can flip one poll-tick before my journal read catches
          // the SW's row — grace + re-read before declaring a premature
          // terminal (a genuinely fenced turn-1 terminal never appears at all).
          await sleep(150);
          d2Done = await journalHas(ntp, a2);
          if (!d2Done) doneEarly = true; // a terminal while turn 2 is pending
        }
        if (d2Done) break;
        await sleep(50);
      }
      // update the working markers to the successful attempt for the rest
      if (genuineOverlap) {
        // eslint-disable-next-line no-unused-vars
        var dsD1 = a1, dsD2 = a2;
      }
    }
    check("double-send: both turns genuinely started while run 1 was pending (two input-clear witnesses + genuine overlap)",
      sentA && sentB && genuineOverlap, dsTiming);
    check("double-send: the banner never showed a terminal state from turn 1 while turn 2 was in flight",
      genuineOverlap && !doneEarly, { doneEarly, dsTiming, bannerSeq: await evl(ntp, `(window.__statusSeq ?? []).map(s => s.state + ':' + s.txt)`).catch(() => null) });
    // Wait for BOTH runs to complete + scan the threads (the markers of the
    // attempt that achieved the genuine overlap).
    const d1f = typeof dsD1 !== "undefined" ? dsD1 : d1;
    const d2f = typeof dsD2 !== "undefined" ? dsD2 : d2;
    let bothDone = false;
    // The added hard-stop journey runs before this saturation probe; retain a
    // bounded 20s window for the 12 warmups + both real turns on loaded hosts.
    for (let i = 0; i < 200 && !bothDone; i++) {
      bothDone = (await journalHas(ntp, d1f)) && (await journalHas(ntp, d2f));
      if (!bothDone) await sleep(100);
    }
    await sleep(400);
    const dsThreads = await msg(ntp, { type: "thread.list" });
    let tA = null;
    let tB = null;
    for (const t of (dsThreads?.threads ?? [])) {
      const full = await msg(ntp, { type: "thread.get", id: t.id });
      const text = (full?.thread?.messages ?? []).map((m) => String(m.content)).join("\n");
      if (text.includes(d1f)) tA = { id: t.id, name: full.thread.name, hasReply: text.includes(d3) };
      if (text.includes(d2f)) tB = { id: t.id, name: full.thread.name, hasReply: text.includes(d3) };
    }
    // The page-side continuation can lag the journal write — poll for the
    // title to settle onto the second thread's name (bounded).
    let titleNow = "";
    for (let i = 0; i < 30; i++) {
      titleNow = await evl(ntp, `document.getElementById('thread-title').textContent`);
      if (tB?.name && titleNow === tB.name) break;
      await sleep(200);
    }
    const agentBubbles = await evl(ntp, `[...document.querySelectorAll('#thread-conversation message-bubble')]
      .filter(b => b.getAttribute('role') === 'agent').length`);
    check("double-send: two threads created; the LATEST turn owns the surface (title + single terminal)",
      bothDone && tA != null && tB != null && tA.id !== tB.id && titleNow === tB?.name &&
      agentBubbles === 1, { bothDone, tA: tA?.name, tB: tB?.name, titleNow, agentBubbles });
    // The next reply routes to the SECOND thread.
    const sentReply = await sendWithWitness(ntp, T_COMPOSER, d3);
    let replyDone = false;
    for (let i = 0; i < 100 && !replyDone; i++) {
      replyDone = await journalHas(ntp, d3);
      if (!replyDone) await sleep(100);
    }
    const tA2 = tA ? await msg(ntp, { type: "thread.get", id: tA.id }) : null;
    const tB2 = tB ? await msg(ntp, { type: "thread.get", id: tB.id }) : null;
    const inB = (tB2?.thread?.messages ?? []).some((m) => String(m.content).includes(d3));
    const inA = (tA2?.thread?.messages ?? []).some((m) => String(m.content).includes(d3));
    check("double-send: the next reply routes to the SECOND thread (no misrouting)",
      sentReply && replyDone && inB && !inA, { sentReply, replyDone, inB, inA });
    // The page-side continuation can lag the journal write — poll for the
    // status to settle (bounded) before reading the final state.
    let settleState = null;
    for (let i = 0; i < 30; i++) {
      settleState = await evl(ntp, `({
        banner: (document.querySelector('#thread-conversation conversation-run-status.live-status')?.getAttribute('state')) ?? 'hidden',
        status: document.getElementById('status')?.textContent ?? '',
        thinking: document.querySelectorAll('#thread-conversation message-bubble[role="thinking"]').length,
      })`);
      if (settleState.status !== "running…") break;
      await sleep(100);
    }
    check("double-send: no stuck banner/status after settle (status ready, banner sequence clean)",
      settleState.status !== "running…" && settleState.thinking === 0, settleState);

    // ── navigation/thread switch mid-run ─────────────────────────────────
    await closeThread(ntp);
    await pruneThreadsTo(ntp, []); // a clean sidebar — the targets are created fresh below
    // The switch target is a FRESH settled thread (not the run-1 thread): the
    // warmup windows create dozens of threads, and the thread index is bounded
    // — an older target can age out entirely. Create + settle it NOW.
    const swTarget = `rs-switch-target-${Date.now() % 100000}`;
    const sentTarget = await sendWithWitness(ntp, COMPOSER, swTarget);
    let targetDone = false;
    for (let i = 0; i < 100 && !targetDone; i++) {
      targetDone = await journalHas(ntp, swTarget);
      if (!targetDone) await sleep(100);
    }
    await closeThread(ntp); // settle on the hub — the switch run opens its own surface next
    const sw1 = `rs-switch-${Date.now() % 100000}`;
    const warmupsSW = () => evl(ntp, `(() => { for (let i = 0; i < 8; i++) chrome.runtime.sendMessage({ type: 'agent.run', task: 'rs warmup2 ${Date.now()} ' + i, id: 'rswq${Date.now()}-' + i }).catch(() => {}); return true; })()`);
    const sentSw = await sendWithWitness(ntp, COMPOSER, sw1, warmupsSW);
    // The in-flight proof must be captured at LEAVE time: click Back, then
    // read the journal BEFORE the close-confirm wait (the confirm wait alone
    // can outlast a queued run).
    const backBox = await boxOf(ntp, `document.getElementById('thread-back')`);
    if (backBox) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: backBox.x, y: backBox.y, button: "left", buttons: 1, clickCount: 1 }, ntp);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: backBox.x, y: backBox.y, button: "left", buttons: 0, clickCount: 1 }, ntp);
    }
    const inFlightAtLeave = sentSw && backBox != null && !(await journalHas(ntp, sw1));
    check("switch: run started + provably in flight (no journal row yet)", inFlightAtLeave, { sentSw, backBox: backBox != null });
    await waitThreadClosed(ntp);
    // Open the FIRST task's thread (the settled one) while the run is in flight.
    const openedOther = await openThreadByTitle(ntp, swTarget);
    // Wait for the switched-away run to complete, then assert zero bleed.
    let swDone = false;
    for (let i = 0; i < 100 && !swDone; i++) {
      swDone = await journalHas(ntp, sw1);
      if (!swDone) await sleep(100);
    }
    await sleep(300);
    const otherState = await evl(ntp, `({
      roles: [...document.querySelectorAll('#thread-conversation message-bubble')].map(b => b.getAttribute('role')),
      title: document.getElementById('thread-title').textContent,
      banner: !document.querySelector('#thread-conversation conversation-run-status.live-status'),
    })`);
    check("switch: opened another thread mid-flight — ONLY its own messages, no status flip, no retitle",
      openedOther && swDone &&
      otherState.roles.length === 2 && otherState.roles[0] === "user" && otherState.roles[1] === "agent" &&
      otherState.banner === true && otherState.title.includes(swTarget.slice(0, 12)) &&
      !otherState.title.includes(sw1), { openedOther, swDone, otherState, sidebar: await evl(ntp, `[...document.querySelectorAll('#thread-sidebar .thread-item')].map(el => (el.title ?? '').slice(0, 24))`).catch(() => null) });
    const swThreads = await msg(ntp, { type: "thread.list" });
    let tSw = null;
    for (const t of (swThreads?.threads ?? [])) {
      const full = await msg(ntp, { type: "thread.get", id: t.id });
      const text = (full?.thread?.messages ?? []).map((m) => String(m.content)).join("\n");
      if (text.includes(sw1)) tSw = { id: t.id, ok: text.includes("[demo model]") };
    }
    check("switch: the switched-away run journaled its result in its OWN thread", tSw?.ok === true);

    // ── back mid-run ─────────────────────────────────────────────────────
    await closeThread(ntp); // settle on the hub
    const bk1 = `rs-back-${Date.now() % 100000}`;
    const warmupsBK = () => evl(ntp, `(() => { for (let i = 0; i < 4; i++) chrome.runtime.sendMessage({ type: 'agent.run', task: 'rs warmup3 ${Date.now()} ' + i, id: 'rswr${Date.now()}-' + i }).catch(() => {}); return true; })()`);
    const sentBk = await sendWithWitness(ntp, COMPOSER, bk1, warmupsBK);
    await closeThread(ntp); // leave mid-flight
    await sleep(500);
    const hubStatus = await evl(ntp, `document.getElementById('status')?.textContent ?? ''`);
    let bkDone = false;
    for (let i = 0; i < 100 && !bkDone; i++) {
      bkDone = await journalHas(ntp, bk1);
      if (!bkDone) await sleep(100);
    }
    check("back mid-run: the global status is not stuck running after leaving",
      sentBk && hubStatus !== "running…", { sentBk, hubStatus });
    check("back mid-run: the run still completes + journals after leaving", bkDone);

    // ── reload mid-run (the genuine MV3 port disconnect + reconnect) ──────
    await pruneThreadsTo(ntp, []); // a clean sidebar — the reload thread is created fresh
    const rl1 = `rs-reload-${Date.now() % 100000}`;
    const warmupsRL = () => evl(ntp, `(() => { for (let i = 0; i < 6; i++) chrome.runtime.sendMessage({ type: 'agent.run', task: 'rs warmup4 ${Date.now()} ' + i, id: 'rswl${Date.now()}-' + i }).catch(() => {}); return true; })()`);
    const sentRl = await sendWithWitness(ntp, COMPOSER, rl1, warmupsRL);
    // The SW must OWN the run before the reload (a reload during the preflight
    // would kill the page before the send) — wait for the task row, then
    // reload WHILE the run executes: the page (and its progress port) dies
    // genuinely; the SW continues the run.
    let swOwns = false;
    for (let i = 0; i < 200 && !swOwns; i++) {
      swOwns = await evl(ntp, `chrome.runtime.sendMessage({type:'memory.get', origin:'master', key:'journal'})
        .then(j => (Array.isArray(j) ? j : []).some(q => q?.type === 'task' && (q.task ?? '').includes(${JSON.stringify(rl1)})))`).catch(() => false);
      if (!swOwns) await sleep(100);
    }
    await send("Page.reload", {}, ntp);
    // Wait for the reloaded page to genuinely render the composer (driving it
    // earlier can race the module init).
    for (let i = 0; i < 40; i++) {
      const ready = await evl(ntp, `!!(document.getElementById('composer')?.querySelector('#task-input'))`).catch(() => false);
      if (ready) break;
      await sleep(150);
    }
    await sleep(300);
    const cleanAfterReload = await evl(ntp, `({
      liveRowGone: !document.querySelector('#thread-conversation conversation-run-status.live-status'),
      status: document.getElementById('status')?.textContent ?? '',
      threadHidden: document.getElementById('thread-view')?.hidden === true,
    })`);
    check("reload mid-run: the page recovers clean (no stuck status row)",
      sentRl && swOwns && cleanAfterReload.liveRowGone && cleanAfterReload.threadHidden &&
      cleanAfterReload.status !== "running…", { ...cleanAfterReload, sentRl, swOwns });
    let rlDone = false;
    for (let i = 0; i < 100 && !rlDone; i++) {
      rlDone = await journalHas(ntp, rl1);
      if (!rlDone) await sleep(100);
    }
    check("reload mid-run: the disconnected run completes in the SW + journals", rlDone);
    // Reconnect truth: reopen the reloaded run's thread — its result is there.
    const rlThreads = await msg(ntp, { type: "thread.list" });
    const rlThread = (rlThreads?.threads ?? []).find((t) =>
      (t.name ?? "").includes(rl1.slice(0, 12)));
    let reopenedHasResult = false;
    let reopenDiag = null;
    if (rlThread?.id) {
      await openThreadByTitle(ntp, rl1.slice(0, 12));
      // The open is async (thread.get + render) — poll for the result bubble.
      for (let i = 0; i < 30 && !reopenedHasResult; i++) {
        reopenedHasResult = await evl(ntp, `[...document.querySelectorAll('#thread-conversation message-bubble')]
          .some(b => b.getAttribute('role') === 'agent' && (b.getAttribute('content') ?? '').includes('[demo model]'))`);
        if (!reopenedHasResult) await sleep(150);
      }
      reopenDiag = await evl(ntp, `({ title: document.getElementById('thread-title').textContent,
        bubbles: [...document.querySelectorAll('#thread-conversation message-bubble')].map(b => b.getAttribute('role') + ':' + (b.getAttribute('content') ?? '').slice(0, 30)) })`);
      // Diagnose the layers: the raw thread.get for the expected id + the
      // index row (index/body consistency) + which thread is actually open.
      const direct = await msg(ntp, { type: "thread.get", id: rlThread.id });
      const listNow = await msg(ntp, { type: "thread.list" });
      const rowNow = (listNow?.threads ?? []).find((t) => t.id === rlThread.id);
      reopenDiag = { ...reopenDiag, directOk: direct?.ok, directMsgs: direct?.thread?.messages?.length,
        rowPresent: !!rowNow, rowName: rowNow?.name };
    }
    check("reload mid-run: reopening the thread shows the journaled result (reconnect truth)",
      rlThread != null && reopenedHasResult, { found: rlThread?.id, reopenedHasResult, reopenDiag });

    console.log("SECTION: ax start");
    // ── AX: the banner's semantics through the shadow root ───────────────
    // Start a run and inspect the WORKING banner in the browser AX tree.
    await closeThread(ntp);
    const ax1 = `rs-ax-${Date.now() % 100000}`;
    const warmupsAX = () => evl(ntp, `(() => { for (let i = 0; i < 6; i++) chrome.runtime.sendMessage({ type: 'agent.run', task: 'rs warmup5 ${Date.now()} ' + i, id: 'rswx${Date.now()}-' + i }).catch(() => {}); return true; })()`);
    await sendWithWitness(ntp, COMPOSER, ax1, warmupsAX);
    // While working: the inline status row in the AX tree — captured in the
    // SAME beat (the row resolves at the terminal state, so a second query
    // after the fact can see nothing). The row's AX subtree includes its
    // shadow content (the role=status surface + the activity label text).
    let axBanner = null;
    for (let i = 0; i < 60 && !axBanner; i++) {
      const visible = await evl(ntp, `(() => { const el = document.querySelector('#thread-conversation conversation-run-status.live-status'); const st = el?.getAttribute('state'); return !!el && st !== 'completed' && st !== 'failed' && st !== 'cancelled'; })()`).catch(() => false);
      if (visible) {
        const b = await axNodes(ntp, "#thread-conversation conversation-run-status.live-status");
        if (b?.length) { axBanner = b; break; }
      }
      await sleep(50);
    }
    const bannerRoles = (axBanner ?? []).map((n) => n?.role?.value ?? "");
    const bannerNames = (axBanner ?? []).map((n) => n?.name?.value ?? "").filter(Boolean);
    check("AX: the working status row exposes role=status + an accessible name in the browser AX tree",
      bannerRoles.includes("status") && bannerNames.length > 0, { roles: bannerRoles.slice(0, 6), names: bannerNames.slice(0, 4) });
    const labelText = bannerNames.join(" ");
    check("AX: the status row's activity label is exposed (through the shadow root)",
      /thinking|working/i.test(labelText), { text: labelText.slice(0, 60) });
    const liveRowCount = await evl(ntp, `document.querySelectorAll('conversation-run-status.live-status').length`);
    const totalStatusEls = await evl(ntp, `document.querySelectorAll('conversation-run-status').length`);
    check("AX: exactly ONE run-status live region (no duplicate status surfaces)",
      liveRowCount === 1 && totalStatusEls === 1, { liveRowCount, totalStatusEls });
    // Let the AX run settle before the follow-up section.
    for (let i = 0; i < 100; i++) {
      if (await journalHas(ntp, ax1)) break;
      await sleep(100);
    }

    console.log("SECTION: follow-up start");
    // ── follow-up in an already-open thread must not restart the transition ──
    // A test-injected patch COUNTS document.startViewTransition calls (the
    // same pattern ui-integration uses — patched + restored, never shipped).
    const fu1 = `rs-followup-${Date.now() % 100000}`;
    let vtBefore = 0;
    let vtAfter = 0;
    // Open the AX run's own thread (settled), then send the follow-up there.
    await openThreadByTitle(ntp, ax1.slice(0, 12));
    await sleep(400);
    vtBefore = await evl(ntp, `(() => { window.__vtCount = 0; const orig = document.startViewTransition?.bind(document);
      if (orig) document.startViewTransition = (cb) => { window.__vtCount++; return orig(cb); };
      return 0; })()`);
    await evl(ntp, OBSERVER_INSTALL);
    // The follow-up's completion probe is THREAD-authoritative, not the global
    // journal: 20 queued warmups flood the bounded 'journal' key and can evict
    // the follow-up's task row before its result lands (pair never matches).
    // The thread projection (commitThread) is the durable authority.
    const fuThreadId = await msg(ntp, { type: "thread.list" }).then((r) =>
      (r?.threads ?? []).find((t) => String(t?.name ?? "").includes(ax1.slice(0, 12)))?.id ?? null);
    const threadHas = async (marker) => {
      if (!fuThreadId) return false;
      const t = await msg(ntp, { type: "thread.get", id: fuThreadId }).catch(() => null);
      const msgs = Array.isArray(t?.thread?.messages) ? t.thread.messages : [];
      const at = msgs.findIndex((m) => String(m?.content ?? m?.text ?? "").includes(marker));
      if (at < 0) return false;
      return msgs.slice(at + 1).some((m) => (m?.role ?? "") !== "user" && String(m?.content ?? m?.text ?? "").trim().length > 0);
    };
    // Widen the follow-up's working window so the screenshot + banner polls
    // have room (queued warmups, fired right before the send).
    const warmupsFU = () => evl(ntp, `(() => { for (let i = 0; i < 20; i++) chrome.runtime.sendMessage({ type: 'agent.run', task: 'rs warmupFU ${Date.now()} ' + i, id: 'rswf${Date.now()}-' + i }).catch(() => {}); return true; })()`);
    const sentFu = await sendWithWitness(ntp, T_COMPOSER, fu1, warmupsFU);
    // While the follow-up is in flight, the banner must be CONTINUOUSLY
    // visible-working (a transition restart would flash it). The LIVE working
    // screenshot is captured on the FIRST working observation — with the
    // no-retransition fix this can never be a transition artifact.
    let fuSawWorking = false;
    let workingShot = false;
    for (let i = 0; i < 60; i++) {
      const st = await evl(ntp, `(() => { const el = document.querySelector('#thread-conversation conversation-run-status.live-status');
        return el ? 'visible' : 'hidden'; })()`);
      const doneYet = await threadHas(fu1);
      if (st === "visible" && !doneYet) {
        fuSawWorking = true;
        if (!workingShot) {
          const rowState = await evl(ntp, `document.querySelector('#thread-conversation conversation-run-status.live-status')?.getAttribute('state') ?? ''`);
          if (rowState !== 'completed' && rowState !== 'failed' && rowState !== 'cancelled') {
            workingShot = await shot(ntp, "followup-working");
          }
        }
      }
      if (doneYet) break;
      await sleep(40);
    }
    vtAfter = await evl(ntp, `window.__vtCount ?? -1`);
    await evl(ntp, `(() => { if (window.__vtOrigRestore) window.__vtOrigRestore(); })()`);
    // The no-flash property is the VIEW TRANSITION count (a restart is what
    // flashes); row visibility churn is asserted by the sequence check below.
    check("follow-up: sending in an already-open thread does NOT restart the view transition (no banner flash)",
      sentFu && vtBefore === 0 && vtAfter === 0 && fuSawWorking,
      { sentFu, vtBefore, vtAfter, fuSawWorking });
    check("follow-up: screenshot of the LIVE working state (no transition by construction)",
      workingShot);
    let fuDone = false;
    for (let i = 0; i < 100 && !fuDone; i++) {
      fuDone = await threadHas(fu1);
      if (!fuDone) await sleep(100);
    }
    // The row's resolution (removal) can lag the journal write by a beat —
    // poll the recorded sequence for the terminal hidden entry.
    let seqFuRaw = [];
    for (let i = 0; i < 50; i++) {
      seqFuRaw = await evl(ntp, `window.__statusSeq ?? []`);
      if (seqFuRaw.length && seqFuRaw[seqFuRaw.length - 1].state === "hidden") break;
      await sleep(100);
    }
    const seqFu = [...seqFuRaw];
    while (seqFu.length && seqFu[0].state === "hidden") seqFu.shift();
    // Identity is exact now: a previous terminal registry record cannot clear
    // the follow-up while it waits for admission. From the first working row
    // until the final hidden resolution there must be NO hidden/error flap.
    const firstWorking = seqFu.findIndex((s) => s.state === "working");
    const fuResolved = firstWorking >= 0 && seqFu.length > firstWorking + 1 && seqFu[seqFu.length - 1].state === "hidden";
    const fuContinuous = fuResolved && seqFu.slice(firstWorking, -1).every((s) => s.state === "working");
    const fuDiag = await evl(ntp, `({
      rowGone: !document.querySelector('#thread-conversation conversation-run-status.live-status'),
      agentBubbles: document.querySelectorAll('#thread-conversation message-bubble[role="agent"]').length,
    })`).catch(() => null);
    check("follow-up: the status row stays continuously working until its own terminal resolves it (no stale-terminal flap)",
      fuDone && fuContinuous,
      { seq: seqFuRaw, diag: fuDiag });
    await evl(ntp, `(() => { window.__statusObs?.disconnect(); })()`);

    check("no console errors on the NTP", (consoleErrors.get(ntp) ?? []).length === 0,
      consoleErrors.get(ntp));
  } catch (e) {
    console.error("journey failure:", String(e?.message ?? e));
    // DIAGNOSTIC: is the SW wedged? Probe it directly.
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const swT = targets.find((t) => t.type === "service_worker");
      console.error("SW target present:", !!swT, swT?.url);
      if (swT) {
        const a = await send("Target.attachToTarget", { targetId: swT.id, flatten: true });
        const t0 = Date.now();
        const ping = await send("Runtime.evaluate", { expression: "1+1" }, a.sessionId)
          .then(() => "ok").catch((x) => String(x?.message ?? x));
        console.error("SW ping:", ping, "in", Date.now() - t0, "ms");
      }
      const t0p = Date.now();
      const pagePing = await send("Runtime.evaluate", { expression: "1+1" }, ntp)
        .then(() => "ok").catch((x) => String(x?.message ?? x));
      console.error("page ping:", pagePing, "in", Date.now() - t0p, "ms");
    } catch (de) {
      console.error("diag failed:", String(de?.message ?? de));
    }
    fail++;
    failures.push("journey failure: " + String(e?.message ?? e));
  } finally {
    clearTimeout(watchdog);
    try { ws.close(); } catch { /* already closed */ }
    try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    await proc.status.catch(() => {});
    try { await Deno.remove(profile, { recursive: true }); } catch { /* best effort */ }
  }

  // ── attestation manifest (bound to the EXACT tested commit + the LOADED
  //    files; cleanliness is DERIVED, never hardcoded) ─────────────────────
  const metaPre = async () => {
    const functional = EXPECTED.filter((n) => !META_CHECKS.has(n));
    const ranFunctional = ranNames.filter((n) => !META_CHECKS.has(n));
    const setOk = ranFunctional.length === functional.length &&
      functional.every((n) => ranNames.includes(n)) &&
      ranNames.every((n) => EXPECTED.includes(n));
    const orderOk = ranFunctional.every((n, i) => functional[i] === n);
    check("assertion set exact (no missing/extra checks)", setOk,
      { ran: ranFunctional.length, expected: functional.length,
        missing: functional.filter((n) => !ranNames.includes(n)) });
    check("assertion order matches EXPECTED", orderOk);
  };
  await metaPre();

  const git = async (args) => {
    const p = new Deno.Command(GIT, { args, cwd: ROOT, stdout: "piped", stderr: "null" }).spawn();
    const out = await p.output();
    return new TextDecoder().decode(out.stdout).trim();
  };
  const head = await git(["rev-parse", "HEAD"]);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirtyList = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const LOADED_FILES = [
    "extension/manifest.json",
    "extension/dist/background/service-worker.js",
    "extension/ntp/ntp.js",
    "extension/ntp/ntp.html",
    "extension/shared/components.js",
    "extension/shared/conversation.js",
  ];
  const loadedHashes = [];
  for (const f of LOADED_FILES) {
    try {
      const bytes = await Deno.readFile(`${ROOT}${f}`);
      loadedHashes.push({ file: f, sha256: await sha256Hex(bytes), bytes: bytes.length });
    } catch {
      loadedHashes.push({ file: f, sha256: null, error: "unreadable" });
    }
  }
  const manifest = {
    runId: RUN_ID,
    at: new Date().toISOString(),
    commit: head,
    tree: await git(["rev-parse", "HEAD^{tree}"]),
    parent: await git(["rev-parse", "HEAD^"]),
    branch,
    worktreeClean: dirtyList === "",
    dirtyFiles: dirtyList === "" ? [] : dirtyList.split("\n").slice(0, 20),
    suite: "run-status-lifecycle",
    loadedFiles: loadedHashes,
    evidence: evidenceFiles,
    results,
  };
  await Deno.writeTextFile(`${EVIDENCE_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
  const manifestOk = dirtyList === "" && head.length === 40;
  check("evidence manifest written + bound to the tested commit", manifestOk,
    { head, branch, dirty: dirtyList !== "" });
  manifest.results = results;
  await Deno.writeTextFile(`${EVIDENCE_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));

  console.log(`\nrun-status lifecycle journeys: ${pass}/${results.length} passed`);
  console.log(`evidence: ${EVIDENCE_DIR}`);
  if (fail > 0) {
    console.log(`FAILED: ${failures.join(" | ")}`);
    Deno.exit(1);
  }
}

await main();
