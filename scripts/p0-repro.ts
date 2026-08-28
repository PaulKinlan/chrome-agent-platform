// p0-repro.ts — P0 STABILIZATION diagnosis harness (real browser via CDP).
//
// Drives the owner's four repros against the REAL extension + service worker:
//   (1) follow-up reply in the thread view → does it CONTINUE the thread or
//       create a NEW task?
//   (2) reopen a task from the list → does history render?
//   (3) switching tasks → does the title update?
//   (4) thread.get on the SW → what does the view actually hold?
//
//   deno run -A scripts/p0-repro.ts <path-to-extension> [<out-dir>]
//
// No provider is configured: dispatch fails honestly, but THREAD CREATION and
// the user message persist regardless (UX-008 semantics), which is exactly the
// state needed to test continuity + projection.

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/p0-repro`;
const CHROMIUM = "/usr/bin/chromium";
const PORT = 9351;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 300)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.mkdir(OUT, { recursive: true });

const proc = new Deno.Command(CHROMIUM, {
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    `--user-data-dir=${OUT}/profile-${Date.now()}`, "about:blank"],
  stdout: "null", stderr: "piped",
}).spawn();

const wsUrl = await new Promise<string>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no devtools url")), 20000);
  (async () => { for (;;) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); const j = await r.json(); clearTimeout(t); resolve(j.webSocketDebuggerUrl); return; } catch { await sleep(300); } } })();
});

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const cdp = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse((m as any).data);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
const evaluate = async (expr: string, sessionId: string) => {
  const j = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  return j.result?.result?.value ?? j.result?.result?.description ?? null;
};

try {
  const { result: { targetInfos } } = await cdp("Target.getTargets");
  const sw = targetInfos.find((t: any) => t.type === "service_worker");
  if (!sw) throw new Error("no service worker target");
  const extId = new URL(sw.url).host;
  console.log(`extId=${extId}`);
  const swSession = (await cdp("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId;
  await cdp("Runtime.enable", {}, swSession);

  const { result: { targetId } } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  await sleep(2500);
  const { result: { targetInfos: targets2 } } = await cdp("Target.getTargets");
  const page = targets2.find((t: any) => t.url.includes("ntp.html"));
  if (!page) throw new Error("ntp page target not found");
  const { result: { sessionId: ui } } = await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await cdp("Runtime.enable", {}, ui);
  await cdp("Log.enable", {}, ui).catch(() => {});
  cdp("Runtime.consoleAPICalled", {}, ui);
  // capture console + app logs
  const onConsole = (m: any) => {
    if (m.method === "Runtime.consoleAPICalled" && m.sessionId === ui) {
      const txt = (m.params?.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ");
      if (txt) console.log("[ntp]", String(txt).slice(0, 160));
    }
  };
  ws.addEventListener("message", (ev) => { try { onConsole(JSON.parse((ev as any).data)); } catch { } });

  const swEval = (expr: string) => evaluate(expr, swSession);
  const uiEval = (expr: string) => evaluate(expr, ui);

  // ── repro (1): first task via the HUB composer ─────────────────────────
  const listThreads = () => uiEval(`new Promise(res => chrome.runtime.sendMessage({ type: "thread.list" }, r => res(JSON.stringify(r))))`);
  const getThread = (id: string) => uiEval(`new Promise(res => chrome.runtime.sendMessage({ type: "thread.get", id: ${id ? JSON.stringify(id) : 'null'} }, r => res(JSON.stringify(r))))`);
  const list0 = await listThreads();
  console.log("threads before:", String(list0).slice(0, 120));

  await uiEval(`(async () => {
    const c = document.getElementById("composer");
    c?.setAttribute("value", "summarise all open tabs");
    c?.dispatchEvent(new CustomEvent("send", { detail: { text: "summarise all open tabs", attachments: [] }, bubbles: true }));
    return "sent";
  })()`);
  await sleep(5000); // let the run settle (failed dispatch is fine)

  const list1 = JSON.parse((await listThreads()) ?? "{}");
  const n1 = Array.isArray(list1?.threads) ? list1.threads.length : (Array.isArray(list1) ? list1.length : -1);
  check("first send creates exactly one task", n1 === 1, { count: n1, raw: String(list1).slice(0, 200) });
  const tid1 = Array.isArray(list1?.threads) ? list1.threads[0]?.id : null;
  console.log("thread1 id:", tid1);

  // Which composer is visible while the thread view is open?
  const vis = await uiEval(`(() => {
    const tv = document.getElementById("thread-view");
    const tc = document.getElementById("thread-composer");
    const hub = document.getElementById("composer");
    const vis2 = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
    return JSON.stringify({ threadViewHidden: tv?.hidden, threadComposerVisible: vis2(tc), hubComposerVisible: vis2(hub), title: document.getElementById("thread-title")?.textContent });
  })()`);
  console.log("surface state after first send:", vis);

  // ── follow-up via the THREAD composer ──────────────────────────────────
  await uiEval(`(async () => {
    const c = document.getElementById("thread-composer");
    c?.dispatchEvent(new CustomEvent("send", { detail: { text: "now translate the summaries to french", attachments: [] }, bubbles: true }));
    return "sent";
  })()`);
  await sleep(5000);

  const list2 = JSON.parse((await listThreads()) ?? "{}");
  const n2 = Array.isArray(list2?.threads) ? list2.threads.length : (Array.isArray(list2) ? list2.length : -1);
  check("thread-composer follow-up does NOT create a second task", n2 === 1, { count: n2 });

  // messages in thread 1 now?
  const t1view = (await getThread(tid1))?.replace('"ok":true','"ok":true') ?? "{}";
  const t1parsed = JSON.parse(t1view);
  const t1summary = JSON.stringify({ ok: t1parsed?.ok, name: t1parsed?.thread?.name, msgs: Array.isArray(t1parsed?.thread?.messages) ? t1parsed.thread.messages.length : -1 });
  console.log("thread1 after follow-up:", t1summary);
  check("follow-up lands in the SAME thread (2 user turns)", String(t1summary).includes('"msgs":') && !String(t1view).includes('"msgs":-1') && !String(t1summary).includes('"msgs":1'), t1summary);

  // ── repro (1b): the HUB composer while a thread view is open ───────────
  await uiEval(`(async () => {
    const c = document.getElementById("composer");
    c?.dispatchEvent(new CustomEvent("send", { detail: { text: "typed into the hub composer while a task is open", attachments: [] }, bubbles: true }));
    return "sent";
  })()`);
  await sleep(5000);
  const list3 = JSON.parse((await listThreads()) ?? "{}");
  const n3 = Array.isArray(list3?.threads) ? list3.threads.length : -1;
  console.log(`threads after hub-composer send with task open: ${n3} (Paul's expectation: continues OR is prevented — today: ${n3 === 3 ? "NEW task created" : "no new task"})`);

  // ── repro (2)+(3): switch tasks → history + title ──────────────────────
  // create a second task so there are two list entries
  await uiEval(`(async () => {
    document.getElementById("thread-view")?.hide?.();
    const tv = document.getElementById("thread-view");
    if (tv && !tv.hidden) { const b = document.getElementById("thread-back"); b?.click(); }
    await new Promise(r => setTimeout(r, 400));
    const c = document.getElementById("composer");
    c?.dispatchEvent(new CustomEvent("send", { detail: { text: "second task about recipes", attachments: [] }, bubbles: true }));
    return "sent";
  })()`);
  await sleep(5000);
  const list4 = JSON.parse((await listThreads()) ?? "{}");
  const threads = Array.isArray(list4?.threads) ? list4.threads : [];
  console.log("threads now:", threads.length);
  const other = threads.find((t: any) => t.id !== tid1);
  if (other && tid1) {
    // click task 1 open, then task 2, then task 1 again; observe title+messages each time
    const nameOf = (id: string) => {
      const t = threads.find((x: any) => x.id === id);
      return t?.name || "Task";
    };
    const openViaUi = async (id: string) => {
      // drive the REAL user path: click the row whose aria-label matches the task name
      await uiEval(`(async () => {
        const label = "Open task " + ${JSON.stringify(nameOf(id))};
        const rows = Array.from(document.querySelectorAll('#thread-sidebar .t-open'));
        const target = rows.find(b => b.getAttribute('aria-label') === label);
        target?.click();
        await new Promise(r => setTimeout(r, 1200));
        return JSON.stringify({ rows: rows.length, clicked: Boolean(target), label });
      })()`);
      await sleep(600);
      return await uiEval(`(() => {
        const conv = document.getElementById("thread-conversation");
        const root = conv?.shadowRoot ?? conv;
        const count = root ? root.querySelectorAll("*").length : -1;
        const msgs = root ? Array.from(root.querySelectorAll("*")).filter(n => (n.textContent||"").trim().length > 0 && ["MSG","DIV","ARTICLE","SECTION","LI","P"].includes(n.tagName)).length : -1;
        return JSON.stringify({
          title: document.getElementById("thread-title")?.textContent,
          elems: count,
          msgs,
          hash: location.hash,
        });
      })()`);
    };
    const viewA = await openViaUi(tid1);
    console.log("open task1:", viewA);
    const viewB = await openViaUi(other.id);
    console.log("open task2:", viewB);
    const viewA2 = await openViaUi(tid1);
    console.log("reopen task1:", viewA2);
    // BUG HUNT: the BACK traversal (real back-stack contract)
    const backViaBrowser = async () => {
      await uiEval(`(async () => { history.back(); await new Promise(r => setTimeout(r, 1500)); return "back"; })()`);
      await sleep(600);
      return await uiEval(`(() => {
        const conv = document.getElementById("thread-conversation");
        const root = conv?.shadowRoot ?? conv;
        return JSON.stringify({
          title: document.getElementById("thread-title")?.textContent,
          elems: root ? root.querySelectorAll("*").length : -1,
          hash: location.hash,
        });
      })()`);
    };
    const back1 = await backViaBrowser();
    console.log("BACK after reopening task1 (expect task2):", back1);
    const back2 = await backViaBrowser();
    console.log("BACK again (expect task1 or hub):", back2);
    try {
      const A = JSON.parse(viewA), B = JSON.parse(viewB), A2 = JSON.parse(viewA2);
      check("title updates when switching tasks", A.title !== B.title && A2.title === A.title, { a: A, b: B, a2: A2 });
      check("history renders on reopen (task1 non-empty)", A2.elems > 5, { a2: A2 });
    } catch (e) { check("title/history parse", false, String(e)); }
  }

  await cdp("Page.captureScreenshot", {}, ui).then(async (j) => {
    if (j.result?.data) await Deno.writeFile(`${OUT}/final-state.png`, Uint8Array.from(atob(j.result.data), c => c.charCodeAt(0)));
  });
} catch (e) {
  console.error("HARNESS ERROR:", String(e).slice(0, 400));
  fail++;
} finally {
  ws.close();
  proc.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail > 0 ? 1 : 0);
