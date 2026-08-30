// kat-tool-call-clarity.ts — the real-browser KAT for the tool-call clarity +
// agent-creation honesty fixes (owner-reported, live 0.2.349):
//   1. "create an agent" must perform a REAL create_named_agent tool call and
//      the agent must appear in the Agents list WITHOUT a reload (no lie).
//   2. The collapsed tool card carries a HUMAN line ("Creating agent “KAT Bot”")
//   3. The expanded card renders a structured, formatted tree — never a raw
//      single-line JSON blob.
//   4. Credential-shaped values are redacted on the live card AND in the
//      persisted journal (run logs).
// Driven with GENUINE CDP input (Input.insertText / dispatchMouseEvent) against
// the SOURCE extension; the deterministic demo provider performs the real
// lazy-protocol tool calls.
//
//   deno run -A scripts/kat-tool-call-clarity.ts [extension-dir] [out-dir]

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `/tmp/cap-tool-call-clarity-evidence-${Date.now()}`;
const CHROMIUM = "/usr/bin/chromium";
const SECRET = "sk-kat-redaction-check-123456";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 300)}`); }
}
async function fetchJson(url, opts) { const r = await fetch(url, opts); return r.json(); }

async function main() {
  await Deno.mkdir(OUT, { recursive: true });
  const profile = `${OUT}/profile`;
  const proc = new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--remote-debugging-port=0", "--remote-allow-origins=*",
      "--window-size=1400,2000", `--user-data-dir=${profile}`, "about:blank",
    ],
    stdout: "null", stderr: "piped", clearEnv: true,
  }).spawn();

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
    try { reader.releaseLock(); } catch { /* released */ }
  }
  if (!port) throw new Error("chrome did not expose a DevTools port");

  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let idc = 0;
  const pend = new Map();
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown" ||
        (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error")) {
      consoleErrors.push(String(m.params?.exceptionDetails?.exception?.description ??
        m.params?.args?.map((a) => a?.value ?? a?.description).join(" ") ?? "?").slice(0, 200));
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++idc;
      const timer = setTimeout(() => { pend.delete(mid); reject(new Error(`cdp timeout: ${method}`)); }, 30000);
      pend.set(mid, (m) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  const evl = async (session, expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r?.result?.value;
  };

  let extId = "";
  {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !extId) {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const sw = targets.find((t) => t.type === "service_worker");
      if (sw) extId = new URL(sw.url).host;
      else await sleep(500);
    }
  }
  check("extension loaded (service worker target)", !!extId, null);
  if (!extId) throw new Error("no extension service worker");

  const t = await fetchJson(`http://127.0.0.1:${port}/json/new?chrome-extension://${extId}/ntp/ntp.html`, { method: "PUT" });
  const ntp = (await send("Target.attachToTarget", { targetId: t.id, flatten: true })).sessionId;
  await send("Runtime.enable", {}, ntp);
  await send("Page.enable", {}, ntp);
  await sleep(2500);

  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" }, ntp);
    if (r?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
  };

  // Genuine input: click the composer textarea, insert the marker task, click Run.
  const boxOf = async (expr) => evl(ntp, `(() => { const el = ${expr}; if (!el) return null;
    el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 20) }; })()`);
  const clickAt = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, ntp);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, ntp);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, ntp);
  };
  const inputSel = `document.getElementById('composer')?.querySelector('#task-input')`;
  const runSel = `document.getElementById('composer')?.querySelector('#run-task')`;
  // Wait for the NTP to finish its async boot (the composer is defined late).
  {
    const deadline = Date.now() + 20000;
    let ready = false;
    let lastProbe = "";
    while (Date.now() < deadline && !ready) {
      const probe = await evl(ntp, `JSON.stringify({c: !!document.getElementById('composer'), def: !!customElements.get('agent-composer'), ti: !!document.getElementById('composer')?.querySelector('#task-input'), url: location.href, ready: document.readyState})`).catch((e) => `ERR:${String(e).slice(0,120)}`);
      lastProbe = String(probe);
      console.log("  probe:", lastProbe.slice(0, 160));
      try { ready = JSON.parse(probe).ti === true; } catch { ready = false; }
      if (!ready) await sleep(500);
    }
    check("composer mounted", ready === true, { lastProbe });
  }
  const ibox = await boxOf(inputSel);
  check("composer input present", !!ibox, null);
  if (ibox) await clickAt(ibox.x, ibox.y);
  await sleep(300);
  // the marker demo model sits behind the developer flag (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01)
  await evl(ntp, `chrome.runtime.sendMessage({ type: "kv.set", values: { "cap:developerFeatures": true } })`);
  await send("Input.insertText", { text: `@demo-create-agent name="KAT Bot" role="checks things"` }, ntp);
  await sleep(300);
  await shot("01-task-typed");
  const rbox = await boxOf(runSel);
  if (rbox) await clickAt(rbox.x, rbox.y);
  check("task submitted via genuine input", !!(ibox && rbox), null);

  // Wait for the run to settle: the KAT Bot appears in the named-agent registry.
  let agents = [];
  {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const res = await evl(ntp, `chrome.runtime.sendMessage({ type: "named-agent.list" }).catch(() => null)`);
      agents = res?.agents ?? [];
      if (agents.some((a) => a?.name === "KAT Bot")) break;
      await sleep(1500);
    }
  }
  check("the conversation created a REAL registry row (no lie)", agents.some((a) => a?.name === "KAT Bot"), { agents: agents.map((a) => a?.name) });

  // The Agents list shows it WITHOUT a reload (the live registry broadcast).
  const listed = await evl(ntp, `(() => {
    const el = document.getElementById('side-agents');
    return el ? el.textContent.includes('KAT Bot') : null; })()`);
  check("the agent appears in the Agents list WITHOUT reload", listed === true, { listed });
  await shot("02-agent-created");

  // The collapsed tool card carries the human line. Cards live inside the
  // <agent-conversation> shadow root (#thread-conversation on the task view).
  // Tool cards are <message-bubble role="tool"> elements whose shadow root
  // holds the <details class="tool"> card.
  const cardsExpr = `(() => {
    const host = document.getElementById('thread-conversation') ?? document;
    return [...host.querySelectorAll('message-bubble[role="tool"]')]
      .map((b) => b.shadowRoot?.querySelector('details.tool'))
      .filter(Boolean); })()`;
  // The card arrives with the live tool-call event and is corrected to the
  // real tool name at result time — wait for the corrected card.
  let cardState = [];
  {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      cardState = await evl(ntp, `(() => {
        const host = document.getElementById('thread-conversation') ?? document;
        const all = [...host.querySelectorAll('message-bubble[role="tool"]')]
          .map((b) => b.shadowRoot?.querySelector('details.tool'))
          .filter(Boolean);
        return all.map((c) => ({
          name: c.querySelector('.tool-name')?.textContent ?? "",
          what: c.querySelector('.tool-what')?.textContent ?? "",
          text: (c.textContent ?? "").slice(0, 2000),
        })); })()`);
      if ((cardState ?? []).some((c) => c.name === "create_named_agent")) break;
      await sleep(1000);
    }
  }
  const createCard = (cardState ?? []).find((c) => c.name === "create_named_agent" || c.what.includes("Creating agent"));
  check("collapsed card shows the human line (Creating agent “KAT Bot”)", !!createCard && createCard.what.includes("Creating agent"), { createCard: createCard ?? cardState?.slice?.(0, 3) });

  // Redaction on the LIVE cards: the planted secret must NEVER render.
  const anyLeak = (cardState ?? []).some((c) => c.text.includes(SECRET));
  check("live cards never render the credential", !anyLeak, null);

  // Expand the create card via a REAL click and verify the structured tree.
  if (createCard) {
    const idx = (cardState ?? []).indexOf(createCard);
    const sbox = await boxOf(`${cardsExpr}[${idx}]?.querySelector('summary')`);
    if (sbox) await clickAt(sbox.x, sbox.y);
    await sleep(600);
    const expanded = await evl(ntp, `(() => {
      const c = ${cardsExpr}[${idx}];
      if (!c) return null;
      return { open: c.open, rows: c.querySelectorAll('.tt-row').length,
               blob: !!c.querySelector('.tool-plain')?.textContent?.includes('{'), 
               text: (c.textContent ?? "").slice(0, 3000) }; })()`);
    check("expanded card renders a structured tree (multiple rows, not a blob)", !!expanded && expanded.open === true && expanded.rows >= 3, expanded);
    check("expanded card never renders the credential", !!expanded && !expanded.text.includes(SECRET), null);
    check("expanded card shows the redaction marker", !!expanded && /REDACTED/i.test(expanded.text), { text: expanded?.text?.slice(0, 400) });
    await shot("03-card-expanded");
  } else {
    check("expanded card renders a structured tree (multiple rows, not a blob)", false, "no create card found");
  }

  // The persisted journal (run logs) is redacted AND parseable.
  // run-log.list returns the master journal entries directly ({entries}).
  const logs = await evl(ntp, `(async () => {
    const res = await chrome.runtime.sendMessage({ type: "run-log.list" }).catch(() => null);
    return { entries: res?.entries ?? [], raw: JSON.stringify(res ?? {}).slice(0, 8000) }; })()`);
  const entries = logs?.entries ?? [];
  const toolCalls = entries.filter((e) => e?.type === "tool-call");
  const journalText = logs?.raw ?? "";
  check("the persisted journal never stores the credential", toolCalls.length > 0 && !journalText.includes(SECRET), { toolCalls: toolCalls.length });
  // The journaled tool-call args must be VALID parseable JSON (the old
  // slice-truncation corrupted them — the replay blob bug).
  let parseable = true, foundCall = false;
  for (const e of toolCalls) {
    if (typeof e.args === "string" && e.args.trim().startsWith("{")) {
      foundCall = true;
      try { JSON.parse(e.args); } catch { parseable = false; }
    }
  }
  check("journaled tool-call args are valid bounded JSON", foundCall && parseable, { foundCall, parseable });

  check("no page console errors during the journey", consoleErrors.length === 0, consoleErrors.slice(0, 3));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log("FAILURES:", failures.join(" | "));
  try { proc.kill(); } catch { /* gone */ }
  Deno.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS ERROR:", e); Deno.exit(1); });
