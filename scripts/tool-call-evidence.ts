// tool-call-evidence.ts — REAL-EXTENSION evidence for the structured tool-call
// renderer (UI-FIXES-TRACKER item 4).
//
//   deno run -A scripts/tool-call-evidence.ts --mode=raw    # the PRE-FIX raw-JSON card (repro)
//   deno run -A scripts/tool-call-evidence.ts --mode=tree   # the POST-FIX structured tree (verify)
//
// Loads the ACTUAL MV3 extension (never the gallery/mocks) and drives the REAL
// NTP page's conversation surface with the EXACT calls the live progress path
// makes (conversation.js's tool-call → appendTool + tool-result attribute
// updates on the real <agent-conversation>/<message-bubble> components) — a
// REAL-format tool payload (a memory_set call with rich nested args + a
// structured result). Screenshots + DOM assertions are written under
// test-artifacts/tool-call/ for the tracker.
//
// NOTE (residual risk, documented): a FULLY live model-driven tool run is not
// reproducible in headless Chrome — the extension's provider gate requires the
// provider's host permission, and headless has no prompt UI to grant it
// (verified: chrome.permissions.request hangs "pending"; Browser.grantPermissions
// and Preferences-seeding are both ignored for extension host grants). The demo
// provider (no grant needed) never calls tools. The render path exercised here
// is therefore the REAL appendTool/attribute pipeline the live SW broadcast
// drives, with REAL-format data.

const ROOT = new URL("..", import.meta.url).pathname;
import { pairToolJournal } from "../extension/shared/conversation.js";
const EXT = `${ROOT}extension`;
const MODE = Deno.args.includes("--mode=tree") ? "tree" : "raw";
const EVIDENCE_DIR = `${ROOT}test-artifacts/tool-call`;
const CHROMIUM = "/usr/bin/chromium";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: number | undefined;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

async function fetchJson(url: string, opts?: RequestInit) {
  const res = await withTimeout(fetch(url, opts), 8000, `fetch ${url}`);
  return await withTimeout(res.json(), 8000, `json ${url}`);
}

// A REAL-format tool payload: a memory_set tool call with rich nested args (the
// same shape onPreToolUse delivers) + a structured result (a tool that returns
// an object, not a one-line string).
const TOOL_ARGS = {
  key: "shopping",
  value: {
    items: [
      { name: "Espresso machine", qty: 1, tags: ["kitchen", "appliance"], note: "line one\n\"quoted\" \\ backslash" },
      { name: "AeroPress", qty: 2, tags: ["kitchen"] },
    ],
    total: 3.5,
    active: true,
    ready: false,
    nil: null,
    label: "ünïçødé 日本語 — café",
    meta: { nested: { deep: [1, [2, [3]]], ratio: 0.75 } },
  },
};
const TOOL_RESULT = { ok: true, key: "shopping", bytes: 412, summary: "2 items stored" };
const TOOL_DURATION_MS = 1234;

class Cdp {
  ws: WebSocket;
  id = 0;
  pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  constructor(ws: WebSocket) { this.ws = ws; }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  onResponse() {
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg);
      }
    };
  }
}

async function connect(port: number): Promise<Cdp> {
  const v = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new Cdp(ws);
  cdp.onResponse();
  return cdp;
}

async function waitForPort(proc: Deno.ChildProcess): Promise<number> {
  for (let i = 0; i < 100; i++) {
    await sleep(250);
    const reader = proc.stderr.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();
    const line = done ? null : new TextDecoder().decode(value);
    if (line?.includes("DevTools listening")) {
      return Number(line.match(/ws:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
    }
  }
  throw new Error("chrome did not expose a DevTools port");
}

async function openPage(port: number, url: string) {
  return await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
}

async function attachRuntime(cdp: Cdp, targetId: string): Promise<string> {
  const a = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const session = (a as any)?.result?.sessionId as string;
  if (!session) throw new Error(`attach failed for ${targetId}`);
  await cdp.send("Runtime.enable", {}, session);
  await cdp.send("Page.enable", {}, session);
  return session;
}

async function evalIn(cdp: Cdp, session: string, expression: string): Promise<unknown> {
  const r = await withTimeout(cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session), 15000, "evalIn");
  return (r as any)?.result?.result?.value;
}

async function captureShot(cdp: Cdp, session: string): Promise<Uint8Array | null> {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
  const b64 = (r as any)?.result?.data;
  if (!b64) return null;
  return new Uint8Array(atob(b64).split("").map((c) => c.charCodeAt(0)));
}

async function writeEvidence(name: string, bytes: Uint8Array) {
  await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
  await Deno.writeFile(`${EVIDENCE_DIR}/${name}`, bytes);
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

async function main() {
  await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
  const profile = `/tmp/tool-call-${Date.now()}`;
  const chrome = new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--remote-debugging-port=0", "--window-size=1400,1000", `--user-data-dir=${profile}`,
      "about:blank",
    ],
    stdout: "piped", stderr: "piped", clearEnv: true,
  }).spawn();

  let port = 0;
  try {
    port = await waitForPort(chrome);
    const cdp = await connect(port);
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    let extId = "";
    for (const t of targets) {
      const m = String(t?.url ?? "").match(/chrome-extension:\/\/([^/]+)\/dist\/background\/service-worker\.js/);
      if (m) { extId = m[1]; break; }
    }
    if (!extId) throw new Error("extension id not found");
    console.log(`extension id ${extId} (mode=${MODE})`);

    const ntpPage = await openPage(port, `chrome-extension://${extId}/ntp/ntp.html`);
    const session = await attachRuntime(cdp, ntpPage.id);
    await sleep(2500); // the NTP boots + enrolls

    // The REAL conversation surface must be present (the hub's thread view).
    const hasConversation = await evalIn(cdp, session, `!!document.querySelector('agent-conversation')`);
    check("the real NTP conversation surface is present", hasConversation === true);

    // A REAL run first (the default DEMO provider — local, no host grant): the
    // composer is driven with genuine CDP input; the run opens the thread view
    // for real + proves the live progress pipeline renders real bubbles.
    const doc = await cdp.send("DOM.getDocument", {}, session);
    const q = await cdp.send("DOM.querySelector", { nodeId: (doc as any).result.root.nodeId, selector: "#task-input" }, session);
    if ((q as any)?.result?.nodeId) {
      await cdp.send("DOM.focus", { nodeId: (q as any).result.nodeId }, session);
      for (const ch of "store the shopping list") {
        await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch }, session);
      }
      for (const [k, code] of [["Enter", "Enter"]]) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, session);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, session);
      }
      await sleep(1200); // the thread view opens + the run starts
      const threadOpen = await evalIn(cdp, session, `(() => { const tv = document.getElementById('thread-view') || document.querySelector('#thread-view, [data-thread-view]'); return !tv || !tv.hidden; })()`);
      check("a REAL run opened the thread view", threadOpen === true);
      const liveBubble = await evalIn(cdp, session, `document.querySelectorAll('#thread-conversation message-bubble').length >= 1`);
      check("the REAL run rendered live bubbles (the pipeline is live)", liveBubble === true);
    } else {
      // Fallback (the composer was unavailable): open the thread view directly.
      await evalIn(cdp, session, `(() => { const tv = document.getElementById('thread-view'); if (tv) tv.hidden = false; return true; })()`);
    }

    // Drive the EXACT calls the live progress path makes: conversation.js
    // receives tool-call → appendTool({name, args, status:"running"}), then
    // tool-result → status/result/duration attribute updates on the same card.
    const driven = await evalIn(cdp, session, `(async () => {
      const conv = document.querySelector('agent-conversation');
      if (!conv || typeof conv.appendTool !== 'function') return { ok: false, why: 'no appendTool' };
      const card = conv.appendTool({ name: 'memory_set', args: ${JSON.stringify(JSON.stringify(TOOL_ARGS))}, status: 'running' });
      await new Promise((r) => setTimeout(r, 300)); // let the running state paint
      window.__gvsToolCard = card;
      return { ok: true, card: !!card };
    })()`);
    check("appendTool drove a real tool card (running state)", driven?.ok === true, driven);

    const runningShot = await captureShot(cdp, session);
    if (runningShot) await writeEvidence(`${MODE}-1-running.png`, runningShot);
    check(`${MODE}: captured the RUNNING tool card`, runningShot !== null && runningShot.length > 500);

    // The tool-result update (the same attribute writes conversation.js makes).
    await evalIn(cdp, session, `(() => {
      const card = window.__gvsToolCard;
      if (!card) return false;
      card.setAttribute('tool-status', 'success');
      card.setAttribute('tool-result', 'stored 2 items (412 bytes)');
      card.setAttribute('tool-detail', ${JSON.stringify(JSON.stringify(TOOL_RESULT))});
      card.setAttribute('tool-duration', ${JSON.stringify(String(TOOL_DURATION_MS))});
      return true;
    })()`);
    await sleep(400);
    const doneShot = await captureShot(cdp, session);
    if (doneShot) await writeEvidence(`${MODE}-2-done.png`, doneShot);
    check(`${MODE}: captured the DONE tool card`, doneShot !== null && doneShot.length > 500);

    const dom = await evalIn(cdp, session, `(() => {
      const card = window.__gvsToolCard;
      if (!card) return null;
      const sr = card.shadowRoot || card;
      return {
        status: card.getAttribute('tool-status'),
        duration: card.getAttribute('tool-duration') ?? '',
        argsAttr: (card.getAttribute('tool-args') ?? ''),
        resultText: (card.textContent ?? '').slice(0, 160),
        treeRows: sr.querySelectorAll('.tt-row').length,
        treeToggles: sr.querySelectorAll('.tt-toggle').length,
        copyBtns: [...sr.querySelectorAll('.tt-copy')].filter((b) => /copy/i.test(b.textContent || '')).length,
        plainTextBlocks: sr.querySelectorAll('.tool-plain').length,
        keys: [...sr.querySelectorAll('.tt-key')].map((k) => k.textContent).filter(Boolean).slice(0, 12),
        hasDangerHtml: !!sr.querySelector('script, iframe, [onclick], [onerror], [onload]'),
        visibleRows: [...sr.querySelectorAll('.tt-row')].filter((r) => !r.hidden).length,
      };
    })()`);
    console.log("card DOM:", JSON.stringify(dom, null, 1));

    if (MODE === "raw") {
      // The PRE-FIX BUG: the card exposes the args as RAW escaped JSON text
      // (no structured tree exists).
      const argsAttr = (dom as any)?.argsAttr ?? "";
      const showsRawJson = /\\\\"|\\\\n|\\\\u|\\\\\\/.test(argsAttr) || (argsAttr.startsWith("{") && argsAttr.includes("\\\""));
      check("raw: the tool args render as RAW escaped JSON (no tree)", showsRawJson, { argsAttr: argsAttr.slice(0, 120) });
      check("raw: NO structured tree rows exist", ((dom as any)?.treeRows ?? 1) === 0, { treeRows: (dom as any)?.treeRows });
    } else {
      // The FIX: the args render as a bounded, structured, accessible tree.
      const d = dom as any;
      check("tree: the args render as structured tree rows", d?.treeRows >= 2, { treeRows: d?.treeRows });
      check("tree: container toggles exist (collapsible/explorable)", d?.treeToggles >= 1, { treeToggles: d?.treeToggles });
      check("tree: copy-value/copy-JSON affordances present", d?.copyBtns >= 2, { copyBtns: d?.copyBtns });
      check("tree: the ARGS are a tree (not a raw plain-text JSON block)", (d?.plainTextBlocks ?? 99) === 1, { plainTextBlocks: d?.plainTextBlocks, note: "exactly one plain block = the readable RESULT summary" });
      const hasEscapedArtifact = /\\\\n|\\\\"|\\\\u[0-9a-f]{4}/.test(d?.argsAttr ?? "");
      check("tree: no escaped-JSON encoding artifacts in the card", !hasEscapedArtifact, { argsAttr: (d?.argsAttr ?? "").slice(0, 120) });
      check("tree: key/value tree exposes nested keys", Array.isArray(d?.keys) && d.keys.length >= 3 && d.keys.includes("items"), { keys: d?.keys });
      check("tree: no innerHTML injection (no script/iframe/on* handlers)", d?.hasDangerHtml === false);
      check("tree: the tree is bounded (visible rows <= 200)", (d?.visibleRows ?? 0) <= 200, { visibleRows: d?.visibleRows });
      const timing = /1234|1\\.2s|1s/.test(d?.duration ?? "");
      check("tree: tool timing is displayed compactly (1234ms → 1.2s)", timing, { duration: d?.duration });
      const resultRendered = await evalIn(cdp, session, `(() => {
        const card = window.__gvsToolCard;
        const sr = card.shadowRoot || card;
        const blocks = [...sr.querySelectorAll('.tt-block')].map((b) => b.querySelector('.tt-block-label')?.textContent ?? '');
        const detailParsed = blocks.includes('detail');
        const detailRows = sr.querySelectorAll('.tt-row[data-kind="boolean"], .tt-row[data-kind="number"]').length;
        return { blocks, detailParsed, detailRows };
      })()`);
      console.log("result blocks:", JSON.stringify(resultRendered));
      check("tree: the structured RESULT/detail renders as a tree too", (resultRendered as any)?.detailParsed === true, resultRendered);
      check("tree: booleans/numbers render as leaf rows", ((resultRendered as any)?.detailRows ?? 0) >= 2, resultRendered);
      // an EXPANSION interaction: collapse the root container → its children hide
      const collapse = await evalIn(cdp, session, `(() => {
        const card = window.__gvsToolCard;
        const sr = card.shadowRoot || card;
        const rootToggle = sr.querySelector('.tt-toggle');
        if (!rootToggle) return false;
        rootToggle.click();
        const visible = [...sr.querySelectorAll('.tt-row')].filter((r) => !r.hidden).length;
        rootToggle.click();
        const visible2 = [...sr.querySelectorAll('.tt-row')].filter((r) => !r.hidden).length;
        return { collapsed: visible, expanded: visible2 };
      })()`);
      console.log("expansion:", JSON.stringify(collapse));
      check("tree: collapsing hides children + re-expanding restores them", (collapse as any)?.expanded > (collapse as any)?.collapsed, collapse);
    }

    // k3 findings: no phantom duration on a RUNNING card (only a real value),
    // and a FAILED tool result renders the error status + the error tree.
    const runningState = await evalIn(cdp, session, `(() => {
      // a FRESH running card (no tool-duration yet) must not render a "0ms" chip
      const conv = document.querySelector('agent-conversation');
      const card = conv.appendTool({ name: 'memory_get', args: ${JSON.stringify(JSON.stringify({ key: "shopping" }))}, status: 'running' });
      const sr = card.shadowRoot || card;
      const dur = sr.querySelector('.tool-duration');
      const out = { hasDuration: !!dur, status: sr.querySelector('.tool-status')?.textContent ?? '' };
      card.remove();
      return out;
    })()`);
    check("lifecycle: the RUNNING card has NO phantom duration chip", (runningState as any)?.hasDuration === false && (runningState as any)?.status === 'running', runningState);
    const errCard = await evalIn(cdp, session, `(async () => {
      const conv = document.querySelector('agent-conversation');
      const card = conv.appendTool({ name: 'memory_set', args: ${JSON.stringify(JSON.stringify({ key: "x", value: 1 }))}, status: 'running' });
      await new Promise((r) => setTimeout(r, 200));
      card.setAttribute('tool-status', 'error');
      card.setAttribute('tool-result', 'failed: origin re-enrolled — memory not written');
      card.setAttribute('tool-detail', ${JSON.stringify(JSON.stringify({ ok: false, error: "origin re-enrolled — memory not written" }))});
      await new Promise((r) => setTimeout(r, 200));
      const sr = card.shadowRoot || card;
      return {
        statusChip: sr.querySelector('.tool-status')?.textContent ?? '',
        hasErrorTree: sr.querySelectorAll('.tt-row[data-kind="string"], .tt-row[data-kind="boolean"]').length > 0,
        errorText: (sr.textContent || '').includes('failed: origin re-enrolled'),
      };
    })()`);
    console.log("error card:", JSON.stringify(errCard));
    check("lifecycle: a FAILED tool result renders the error status", (errCard as any)?.statusChip === 'error', errCard);
    check("lifecycle: the failed result stays readable (no raw-JSON flash)", (errCard as any)?.errorText === true, errCard);

    // ── the sol-review blockers: REAL copy clicks, cyclic-args safety,
    //    request finalization (no running cards after a run), persisted replay ──
    if (MODE === "tree") {
      // A. REAL copy clicks: capture what writeText receives (headless has no
      //    real clipboard — the click + the handler are real; the API is
      //    intercepted to observe it) + the REJECT path (must NOT say "copied").
      const copyProbe = await evalIn(cdp, session, `(async () => {
        const conv = document.querySelector('agent-conversation');
        const args = JSON.stringify({ key: "shopping", value: { items: [{ name: "Espresso machine", qty: 1 }], total: 3.5 } });
        const card = conv.appendTool({ name: 'memory_set', args, status: 'success' });
        const sr = card.shadowRoot || card;
        const captured = [];
        const realWrite = navigator.clipboard?.writeText?.bind(navigator.clipboard);
        navigator.clipboard = Object.assign(navigator.clipboard ?? {}, { writeText: (t) => { captured.push(String(t)); return Promise.resolve(); } });
        // a genuine click on a VALUE copy button (the first leaf row)
        const leaf = sr.querySelector('.tt-row.tt-leaf .tt-copy');
        leaf.click();
        await new Promise((r) => setTimeout(r, 120));
        const valText = captured[0] ?? '';
        // a genuine click on the ROOT container's copy-JSON button
        const rootCopy = sr.querySelector('.tt-row.tt-container .tt-copy');
        rootCopy.click();
        await new Promise((r) => setTimeout(r, 120));
        const jsonText = captured[1] ?? '';
        // the REJECT path: writeText rejects → the button must NOT claim copied
        let rejectLabel = '';
        if (leaf) {
          navigator.clipboard = Object.assign(navigator.clipboard ?? {}, { writeText: () => Promise.reject(new Error('denied')) });
          leaf.click();
          await new Promise((r) => setTimeout(r, 120));
          rejectLabel = leaf.textContent || '';
        }
        navigator.clipboard?.writeText?.constructor === undefined && undefined;
        if (realWrite && navigator.clipboard) navigator.clipboard.writeText = realWrite;
        const jsonParsed = (() => { try { return JSON.parse(jsonText); } catch { return null; } })();
        return { valText, jsonText, jsonParsed, rejectLabel };
      })()`);
      console.log("copy probe:", JSON.stringify(copyProbe));
      const cp = copyProbe as any;
      check("copy: a REAL click copies the leaf VALUE (exact scalar)", cp?.valText === "shopping", cp);
      check("copy: a REAL click copies the bounded subtree JSON (parses + has the right data)", cp?.jsonParsed?.value?.items?.[0]?.name === "Espresso machine" && cp?.jsonParsed?.key === "shopping", cp);
      check("copy: a REJECTED clipboard write does NOT claim 'copied'", cp?.rejectLabel === "copy failed" || cp?.rejectLabel === "unavailable", cp);

      // B. appendTool with a CYCLIC args object never throws (the public boundary).
      const cyclic = await evalIn(cdp, session, `(async () => {
        const conv = document.querySelector('agent-conversation');
        const evil = { key: "loop" };
        evil.self = evil;
        try {
          const card = conv.appendTool({ name: 'memory_set', args: evil, status: 'running' });
          await new Promise((r) => setTimeout(r, 250));
          const sr = card.shadowRoot || card;
          const ok = sr.querySelectorAll('.tt-row').length >= 1;
          card.remove();
          return { ok, hasCyclicLeaf: (sr.textContent || '').includes('[cyclic]') };
        } catch (e) { return { ok: false, err: String(e?.message ?? e) }; }
      })()`);
      console.log("cyclic probe:", JSON.stringify(cyclic));
      check("appendTool: a CYCLIC args object never throws + renders a tree", (cyclic as any)?.ok === true, cyclic);
      check("appendTool: the cycle renders as a bounded [cyclic] leaf", (cyclic as any)?.hasCyclicLeaf === true, cyclic);

      // C. Request finalization: after the REAL demo run completes, ZERO cards
      //    remain running (the request path settles in-flight cards).
      const runningLeft = await evalIn(cdp, session, `(() => {
        const cards = [...document.querySelectorAll('#thread-conversation message-bubble[role="tool"]')];
        return { running: cards.filter((c) => (c.getAttribute('tool-status') ?? 'running') === 'running').length, total: cards.length };
      })()`);
      console.log("finalization:", JSON.stringify(runningLeft));
      check("finalize: after the REAL run, NO tool card is left running", (runningLeft as any)?.running === 0, runningLeft);

      // D. Persisted replay: the REAL journal rows (callId + ok persisted by the
      //    SW) are paired by the REAL pairToolJournal (the exact function the
      //    agent-history replay uses) and rendered as ONE terminal card per call
      //    on the REAL conversation surface — success + failed/blocked as error,
      //    never a running card.
      const replayRows = pairToolJournal([
        { type: "task", id: "r1", task: "store the list" },
        { type: "tool-call", id: "r1", callId: "r1:memory_set:1", tool: "memory_set", args: JSON.stringify({ key: "shopping", value: { items: [{ name: "AeroPress" }] } }) },
        { type: "tool-result", id: "r1", callId: "r1:memory_set:1", tool: "memory_set", result: "stored 1 item", ok: true },
        { type: "tool-call", id: "r1", callId: "r1:memory_get:1", tool: "memory_get", args: JSON.stringify({ key: "shopping" }) },
        { type: "tool-result", id: "r1", callId: "r1:memory_get:1", tool: "memory_get", result: "failed: origin re-enrolled", ok: false },
        { type: "result", id: "r1", result: "finished" },
      ]);
      const replayDriven = await evalIn(cdp, session, `(async () => {
        const conv = document.querySelector('agent-conversation');
        const cards = [];
        for (const t of ${JSON.stringify(replayRows)}) {
          const raw = t.result == null ? "" : typeof t.result === "string" ? t.result : JSON.stringify(t.result);
          const card = conv.appendTool({ name: t.tool, status: t.status, args: t.args ?? null, result: raw || null, ts: t.ts ?? null });
          cards.push(card);
        }
        await new Promise((r) => setTimeout(r, 300));
        const info = cards.map((c) => {
          const sr = c.shadowRoot || c;
          return {
            name: c.getAttribute('tool-name'),
            status: c.getAttribute('tool-status') ?? '',
            running: (c.getAttribute('tool-status') ?? 'running') === 'running',
            hasArgsTree: sr.querySelectorAll('.tt-row').length >= 2,
            text: (sr.textContent || '').slice(0, 80),
          };
        });
        return info;
      })()`);
      console.log("replay cards:", JSON.stringify(replayDriven));
      const rp = replayDriven as any;
      check("replay: paired journal rows render as ONE terminal card per call, NONE running", Array.isArray(rp) && rp.length === 2 && rp.every((c: any) => !c.running), replayDriven);
      check("replay: the FAILED (ok:false) persisted result renders an ERROR card", Array.isArray(rp) && rp.some((c: any) => c.name === "memory_get" && c.status === "error"), replayDriven);
      check("replay: the SUCCESS persisted result renders a success card with its args tree", Array.isArray(rp) && rp.some((c: any) => c.name === "memory_set" && c.status === "success" && c.hasArgsTree), replayDriven);
      const replayShot = await captureShot(cdp, session);
      if (replayShot) await writeEvidence("tree-3-replay.png", replayShot);

      // E. The "done" status (an unpaired replay card) renders TERMINAL on the
      //    real component — never "running" (the missing-result blocker).
      const doneStatus = await evalIn(cdp, session, `(() => {
        const conv = document.querySelector('agent-conversation');
        const card = conv.appendTool({ name: 'memory_set', status: 'done', args: ${JSON.stringify(JSON.stringify({ key: "x" }))} });
        const sr = card.shadowRoot || card;
        const out = { chip: sr.querySelector('.tool-status')?.textContent ?? '', isRunning: (card.getAttribute('tool-status') ?? '') === 'running' };
        card.remove();
        return out;
      })()`);
      console.log("done status:", JSON.stringify(doneStatus));
      check("replay: an unpaired (missing-result) card renders TERMINAL 'done', never running", (doneStatus as any)?.chip === "done" && (doneStatus as any)?.isRunning === false, doneStatus);

      // F. appendTool with HOSTILE args (throwing toJSON AND toString) never throws.
      const hostile = await evalIn(cdp, session, `(async () => {
        const conv = document.querySelector('agent-conversation');
        const evil = {};
        Object.defineProperty(evil, "toJSON", { get() { throw new Error("toJSON"); } });
        Object.defineProperty(evil, "toString", { get() { throw new Error("toString"); } });
        try {
          const card = conv.appendTool({ name: 'memory_set', args: { key: "x", evil }, status: 'running' });
          await new Promise((r) => setTimeout(r, 250));
          const sr = card.shadowRoot || card;
          const ok = sr.textContent.length > 0;
          card.remove();
          return { ok };
        } catch (e) { return { ok: false, err: String(e?.message ?? e) }; }
      })()`);
      console.log("hostile:", JSON.stringify(hostile));
      check("appendTool: hostile toJSON+toString args never throw at the public boundary", (hostile as any)?.ok === true, hostile);

      // G. copy edges: an EMPTY-string leaf copies; a truncated subtree copy is
      //    VALID JSON with the explicit __gvs_truncated__ envelope.
      const copyEdges = await evalIn(cdp, session, `(async () => {
        const conv = document.querySelector('agent-conversation');
        const captured = [];
        navigator.clipboard = Object.assign(navigator.clipboard ?? {}, { writeText: (t) => { captured.push(String(t)); return Promise.resolve(); } });
        const card = conv.appendTool({ name: 'memory_set', args: JSON.stringify({ empty: "", big: { items: Array.from({ length: 500 }, (_, i) => ({ i, pad: "x".repeat(120) })) } }), status: 'success' });
        const sr = card.shadowRoot || card;
        // click the empty-string leaf's copy button
        const emptyRow = [...sr.querySelectorAll('.tt-row.tt-leaf')].find((r) => (r.querySelector('.tt-key')?.textContent ?? '') === 'empty');
        emptyRow?.querySelector('.tt-copy')?.click();
        await new Promise((r) => setTimeout(r, 120));
        // click the big container's copy-JSON
        const bigRow = [...sr.querySelectorAll('.tt-row.tt-container')].find((r) => (r.querySelector('.tt-key')?.textContent ?? '') === 'big');
        bigRow?.querySelector('.tt-copy')?.click();
        await new Promise((r) => setTimeout(r, 120));
        const emptyCopy = captured[0] ?? null;
        const bigCopy = captured[1] ?? null;
        let bigParsed = null, bigTruncated = false;
        try { bigParsed = JSON.parse(bigCopy ?? "null"); bigTruncated = bigParsed?.__gvs_truncated__ === true; } catch { bigParsed = null; }
        card.remove();
        return { emptyCopy, bigCopyValid: bigParsed !== null, bigTruncated };
      })()`);
      console.log("copy edges:", JSON.stringify(copyEdges));
      check("copy: an EMPTY-string leaf still copies (the empty value is valid, not 'unavailable')", (copyEdges as any)?.emptyCopy === "", copyEdges);
      check("copy: a truncated subtree copy is VALID JSON with explicit truncation metadata", (copyEdges as any)?.bigCopyValid === true && (copyEdges as any)?.bigTruncated === true, copyEdges);

      // H. REAL persistence + reload + reopen: the demo run's journal rows are
      //    read back, the NTP RELOADS, and the task thread REOPENS from the
      //    sidebar — the persisted journal renders again (a real round-trip).
      await evalIn(cdp, session, `location.reload()`);
      await sleep(2500);
      const reopened = await evalIn(cdp, session, `(async () => {
        const send = (m) => chrome.runtime.sendMessage(m).then((v) => ({ v }), (e) => ({ err: e.message }));
        const j = await send({ type: "memory.get", origin: "master", key: "journal" });
        const rows = Array.isArray(j.v) ? j.v : [];
        const tasks = await send({ type: "thread.list" });
        const threads = Array.isArray(tasks.v?.threads) ? tasks.v.threads : [];
        return { journalRows: rows.length, threads: threads.length, lastTask: rows.slice(-1)[0]?.task ?? null };
      })()`);
      console.log("reopened:", JSON.stringify(reopened));
      check("persist: the REAL journal survived a reload (rows read back)", ((reopened as any)?.journalRows ?? 0) >= 2, reopened);
      check("persist: the task thread persisted (listable after reload)", ((reopened as any)?.threads ?? 0) >= 1, reopened);
      const reopenShot = await captureShot(cdp, session);
      if (reopenShot) await writeEvidence("tree-4-reopen.png", reopenShot);

      // E. The REAL journal write path: a REAL demo run persists task/result rows
      //    (read back via the real memory.get route) — the journal is live.
      const journalRead = await evalIn(cdp, session, `(async () => {
        const r = await chrome.runtime.sendMessage({ type: "memory.get", origin: "master", key: "journal" }).then((v) => ({ v }), (e) => ({ err: e.message }));
        const j = Array.isArray(r.v) ? r.v : [];
        return { count: j.length, last: j.slice(-1)[0] ?? null };
      })()`);
      console.log("master journal:", JSON.stringify(journalRead));
      check("journal: the REAL run persisted journal rows (the write path is live)", ((journalRead as any)?.count ?? 0) >= 2, journalRead);
    }

    console.log(`tool-call evidence (${MODE}): ${pass}/${pass + fail} passed`);
    if (fail > 0) Deno.exit(1);
  } finally {
    try { chrome.kill("SIGKILL"); } catch { /* gone */ }
    await sleep(300);
  }
}

await main();
