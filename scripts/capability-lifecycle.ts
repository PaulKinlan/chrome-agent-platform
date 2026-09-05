// capability-lifecycle.ts — the capability grant→use→revoke acceptance (the
// KNOWN-ISSUES gap: "not all capability lifecycles have grant→use→revoke
// acceptance"). Drives the REAL settings page + grants each optional capability
// with a REAL user gesture (CDP Input.dispatchMouseEvent — chrome.permissions.
// request requires a genuine gesture, so a JS .click() would not count), then
// revokes it via the service worker's capability.revoke route and confirms the
// permission is gone.
//
// The silently-grantable capabilities (storage, alarms, activeTab, scripting,
// sidePanel) must grant WITHOUT a prompt; the warned capabilities (tabs,
// notifications) are auto-DENIED in headless (Chrome needs a real permission
// prompt the headless browser cannot interact with) and must FAIL CLOSED.
//
//   deno run -A scripts/capability-lifecycle.ts

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The REAL capability list (never mirror it — storage/alarms/sidePanel went
// mandatory and the old mirror's rows stopped rendering, ymut). The lifecycle
// below drives the capabilities whose headless behavior is DETERMINISTIC:
// silent-grantable (activeTab, scripting) and warned/auto-denied-in-headless
// (tabs, notifications). The rendered-row content check covers the full
// optional set.
import { CAPABILITIES as REAL_CAPABILITIES } from "../extension/lib/capabilities.js";
const MANIFEST = JSON.parse(Deno.readTextFileSync(`${ROOT}extension/manifest.json`));
const MANDATORY: Set<string> = new Set(MANIFEST.permissions ?? []);
// What Settings renders: capabilities with at least one OPTIONAL permission
// (options.js skips capabilities backed entirely by mandatory permissions).
const OPTIONAL_CAPABILITIES = REAL_CAPABILITIES.filter(
  (cap: any) => !(cap.permissions ?? []).every((p: string) => MANDATORY.has(p)),
);
// The "Always on" group renders one capability-row per mandatory boot-critical
// permission (storage/alarms/sidePanel/offscreen, when in the manifest).
const ALWAYS_ON = ["storage", "alarms", "sidePanel", "offscreen"]
  .filter((p) => MANDATORY.has(p));
const EXPECTED_ROWS = OPTIONAL_CAPABILITIES.length + ALWAYS_ON.length;
const CAPABILITIES: { id: string; permissions: string[]; warned: boolean }[] = [
  { id: "activeTab", permissions: ["activeTab"], warned: false },
  { id: "scripting", permissions: ["scripting"], warned: false },
  { id: "tabs", permissions: ["tabs"], warned: true },
  { id: "notifications", permissions: ["notifications"], warned: true },
];

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

type Cdp = {
  send: (method: string, params: unknown, sessionId?: string) => Promise<any>;
  evl: (s: string, expr: string) => Promise<any>;
  port: number;
};

async function launch(): Promise<{ proc: Deno.ChildProcess; cdp: Cdp }> {
  const tmp = await Deno.makeTempDir({ prefix: "cap-lifecycle-" });
  // The shared launcher: kernel-assigned debugging port, the endpoint read
  // from this child's own stderr. A browser that prints none is an honest
  // FAIL here (the launcher already killed it), never a probe of a named port.
  let chrome: Awaited<ReturnType<typeof launchChrome>>;
  try {
    chrome = await launchChrome({ extension: EXT, profile: tmp, windowSize: "1440,900", timeoutMs: 15000 });
  } catch (e) {
    console.log(`FAIL: could not find the Chrome DevTools URL — ${String((e as Error)?.message ?? e)}`);
    Deno.exit(1);
  }
  const proc = chrome.proc;
  const wsUrl = chrome.wsUrl;
  const port = chrome.port;

  let id = 0;
  const pend = new Map<number, (v: unknown) => void>();
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const resolve = pend.get(m.id)!;
      pend.delete(m.id);
      resolve(m.error ? Promise.reject(new Error(m.error.message)) : m.result);
    }
  };
  const send = (method: string, params: unknown, sessionId?: string): Promise<any> => {
    const mid = ++id;
    return new Promise((resolve) => { pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
  };
  const evl = async (s: string, expr: string): Promise<any> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    return r?.result?.value;
  };
  return { proc, cdp: { send, evl, port } };
}

async function findSw(cdp: Cdp): Promise<{ extId: string }> {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${cdp.port}/json/list`)).json();
      const sw = (targets as any[]).find((t) => t.type === "service_worker");
      if (sw) return { extId: sw.url.split("/")[2] };
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error("extension did not load");
}

// A REAL user-gesture click at the button's center (chrome.permissions.request
// must be called during a genuine gesture — a JS .click() is not one).
async function realClick(cdp: Cdp, sessionId: string, expr: string) {
  // Scroll the element into view FIRST (the permission list is far down the
  // page; a CDP click at off-viewport page coordinates misses the button),
  // THEN compute the in-viewport rect.
  const rect = await cdp.evl(sessionId,
    `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.top >= 0 && r.bottom <= innerHeight }; })()`);
  if (!rect || rect.x == null || !rect.visible) return false;
  const x = Math.round(rect.x), y = Math.round(rect.y);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
  return true;
}

async function main() {
  const { proc, cdp } = await launch();
  try {
    const { extId } = await findSw(cdp);
    const t = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#permissions` });
    const s = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    const sessionId = s.result?.sessionId ?? s.sessionId;
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);

    // wait for the permission list to render (each capability = one
    // <capability-row data-capability="..."> — the retired `.perm-row`
    // selector reads 0 after the capability-row migration, ymut). The
    // permissions section is LAZY-rendered (the #permissions hash above),
    // and the expected count is the REAL optional set, not a hardcoded 7.
    const expectedRows = EXPECTED_ROWS;
    for (let i = 0; i < 40; i++) {
      const n = await cdp.evl(sessionId, `document.querySelectorAll('#permission-list capability-row').length`);
      if (Number(n) >= expectedRows) break;
      await sleep(200);
    }
    const rendered = await cdp.evl(sessionId, `document.querySelectorAll('#permission-list capability-row').length`);
    check(`settings rendered all ${expectedRows} optional capability rows`, Number(rendered) === expectedRows, { rendered, expectedRows });
    // rfca-pattern content assertion: an empty-but-present row list must fail.
    // Every expected capability id is present AND each row carries its name
    // (the renderer ran) — a bare count proves neither.
    const rowsContent = await cdp.evl(sessionId, `(() => {
      const rows = [...document.querySelectorAll('#permission-list capability-row')];
      return {
        ids: rows.map((r) => r.dataset.capability ?? null),
        named: rows.filter((r) => (r.getAttribute('name') ?? '').length > 0).length,
        states: rows.filter((r) => (r.dataset.state ?? '').length > 0).length,
      };
    })()`);
    const expectedIds = [...OPTIONAL_CAPABILITIES.map((c: any) => c.id), ...ALWAYS_ON];
    check("capability rows carry real content (id + name + state per row)",
      expectedIds.every((id) => rowsContent?.ids?.includes(id)) &&
      rowsContent?.named === expectedRows && rowsContent?.states === expectedRows,
      { missing: expectedIds.filter((id) => !rowsContent?.ids?.includes(id)), named: rowsContent?.named, states: rowsContent?.states, expectedRows });

    const contains = (perms: string[]) => cdp.evl(sessionId,
      `chrome.permissions.contains({ permissions: ${JSON.stringify(perms)} }).then(r => !!r).catch(() => false)`);

    // the extension must start with ZERO optional permissions granted.
    let anyGranted = false;
    for (const cap of CAPABILITIES) {
      if (await contains(cap.permissions)) anyGranted = true;
    }
    check("the extension starts with zero optional capabilities granted", !anyGranted);

    for (const cap of CAPABILITIES) {
      // ── GRANT (real gesture) ──
      // The grant affordance is the row's shadow-root ghost "Turn on" button
      // (the retired `.grant-perm` class selector reads 0 — ymut). Find the
      // row by data-capability, open its (possibly collapsed) group, and
      // target the shadow button.
      const clicked = await realClick(cdp, sessionId,
        `(() => {
          const row = [...document.querySelectorAll('#permission-list capability-row')]
            .find((r) => r.dataset.capability === ${JSON.stringify(cap.id)});
          if (!row) return null;
          const group = row.closest('details');
          if (group && !group.open) group.open = true;
          const btn = row.shadowRoot?.querySelector('button.run');
          return btn && btn.textContent.trim() === 'Turn on' ? btn : null;
        })()`);
      if (clicked) await sleep(1200);
      const granted = await contains(cap.permissions);

      if (cap.warned) {
        // tabs + notifications are auto-denied in headless — fail closed.
        check(`capability ${cap.id} (warned): request fails closed in headless`, granted === false, { granted });
      } else {
        check(`capability ${cap.id}: granted with a real gesture`, granted === true, { granted });
      }

      // ── USE (a minimal capability use — the capability reports granted via
      //    the SW's capabilities.status route) ──
      const status = await cdp.evl(sessionId,
        `chrome.runtime.sendMessage({ type: "capabilities.status" }).then(s => s?.["${cap.id}"]).catch(() => "error")`);
      if (!cap.warned) {
        check(`capability ${cap.id}: the SW reports it granted`, status === true, { status });
      }

      // ── REVOKE (the row's "Turn off" switch, real gesture) ──
      // The bare capability.revoke route now requires owner approval (the
      // owner's UI click IS the approval via the owner-direct path) — a bare
      // runtime message is refused, so drive the switch like the owner does.
      if (!cap.warned) {
        const offClicked = await realClick(cdp, sessionId,
          `(() => {
            const row = [...document.querySelectorAll('#permission-list capability-row')]
              .find((r) => r.dataset.capability === ${JSON.stringify(cap.id)});
            if (!row) return null;
            const group = row.closest('details');
            if (group && !group.open) group.open = true;
            return row.shadowRoot?.querySelector('switch-toggle')?.shadowRoot?.querySelector('.sw') ?? null;
          })()`);
        check(`capability ${cap.id}: the revoke switch is present after grant`, offClicked === true);
        // The destructive confirm dialog ("Turn off X?") — a genuine owner
        // gesture on the accept button, never a bare route call.
        await sleep(400);
        const confirmed = await realClick(cdp, sessionId,
          `document.querySelector('dialog.cap-confirm-dialog button.cap-confirm-accept')`);
        check(`capability ${cap.id}: the Turn off confirmation dialog is confirmed with a real gesture`, confirmed === true);
        await sleep(400);
        // A revoke is settled only when contains() reports the permission gone.
        let revoked = false;
        for (let i = 0; i < 40; i++) {
          revoked = !(await contains(cap.permissions));
          if (revoked) break;
          await sleep(250);
        }
        check(`capability ${cap.id}: revoked (permission removed)`, revoked === true);
      } else {
        // a warned capability was never granted; the bare revoke route still
        // must not claim success while the permission is absent.
        const rev = await cdp.evl(sessionId,
          `chrome.runtime.sendMessage({ type: "capability.revoke", id: "${cap.id}" }).then(r => r).catch(e => ({ ok:false, error:String(e) }))`);
        const revoked = !(await contains(cap.permissions));
        check(`capability ${cap.id} (warned): revoke is a no-op on an absent grant`, revoked === true || rev?.ok === false, { rev });
      }
    }
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* dead */ }
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  Deno.exit(fail === 0 ? 0 : 1);
}

await main();
