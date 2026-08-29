// kat-task-lifecycle.ts — P0 STABILIZATION contract KAT (real browser).
//
// Pins docs/TASK-LIFECYCLE-CONTRACT.md end to end against the REAL extension:
//   §2  follow-up in the open task view CONTINUES that thread — through the
//       thread composer AND the hub composer (no silent fork into a new task);
//   §2  a NEW task still starts from the explicit "+" (hub) path;
//   §3  history renders on reopen (the conversation element is non-empty);
//   §4  the title updates on every task switch (click + back traversal);
//   §7  orphaned alarms (a deleted agent's recipe:<slug> schedule) are
//       detected and cancelled by schedule.cancelOrphans.
//
//   deno run -A scripts/kat-task-lifecycle.ts <path-to-extension> [<out-dir>]

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-task-lifecycle`;
const CHROMIUM = "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 260)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.mkdir(OUT, { recursive: true });

// Kernel-assigned debugging port, read back from THIS Chrome by the shared
// launcher — a hard-coded port can silently attach to another lane's browser
// (CAP-FB-20260829-FIXED-DEBUG-PORTS-01).
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${OUT}/profile-${Date.now()}`, "about:blank"],
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
  return j.result?.result?.value ?? null;
};

try {
  const { result: { targetInfos } } = await cdp("Target.getTargets");
  const sw = targetInfos.find((t: any) => t.type === "service_worker");
  if (!sw) throw new Error("no service worker target");
  const extId = new URL(sw.url).host;
  const { result: { targetId } } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  await sleep(2500);
  const { result: { targetInfos: t2 } } = await cdp("Target.getTargets");
  const page = t2.find((t: any) => t.url.includes("ntp.html"));
  const { result: { sessionId: ui } } = await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await cdp("Runtime.enable", {}, ui);
  const uiEval = (expr: string) => evaluate(expr, ui);

  const hubSend = (text: string) => uiEval(`(async () => {
    document.getElementById("composer")?.dispatchEvent(new CustomEvent("send", { detail: { text: ${JSON.stringify(text)}, attachments: [] }, bubbles: true }));
    return "sent";
  })()`);
  const threadSend = (text: string) => uiEval(`(async () => {
    document.getElementById("thread-composer")?.dispatchEvent(new CustomEvent("send", { detail: { text: ${JSON.stringify(text)}, attachments: [] }, bubbles: true }));
    return "sent";
  })()`);
  const listThreads = async () => {
    const raw = await uiEval(`new Promise(res => chrome.runtime.sendMessage({ type: "thread.list" }, r => res(JSON.stringify(r))))`);
    try { return (JSON.parse(raw)?.threads ?? []) as any[]; } catch { return []; }
  };
  const surface = () => uiEval(`(() => {
    const conv = document.getElementById("thread-conversation");
    const root = conv?.shadowRoot ?? conv;
    return JSON.stringify({
      title: document.getElementById("thread-title")?.textContent,
      elems: root ? root.querySelectorAll("*").length : -1,
      threadViewHidden: document.getElementById("thread-view")?.hidden,
    });
  })()`);

  // ── §2: first task + thread-composer follow-up ─────────────────────────
  await hubSend("summarise all open tabs");
  await sleep(5000);
  let threads = await listThreads();
  check("contract §2: first send creates exactly one task", threads.length === 1, { n: threads.length });
  const t1 = threads[0]?.id;

  await threadSend("now translate the summaries to french");
  await sleep(5000);
  threads = await listThreads();
  check("contract §2: thread-composer follow-up does NOT create a new task", threads.length === 1, { n: threads.length });
  const t1view = await uiEval(`new Promise(res => chrome.runtime.sendMessage({ type: "thread.get", id: ${JSON.stringify(t1)} }, r => res(JSON.stringify(r?.thread?.messages?.length ?? -1))))`);
  check("contract §2: the follow-up landed in the SAME thread", Number(t1view) >= 3, { msgs: t1view });

  // ── §2 (P0 fix): hub-composer send with a task view open CONTINUES ────
  const viewState = await surface();
  check("precondition: the task view is open after the run", String(viewState).includes('"threadViewHidden":false'), viewState);
  await hubSend("and now also email me a digest");
  await sleep(5000);
  threads = await listThreads();
  check("contract §2 (P0): hub-composer send with a task open CONTINUES it (no fork)", threads.length === 1, { n: threads.length });
  const t1view2 = await uiEval(`new Promise(res => chrome.runtime.sendMessage({ type: "thread.get", id: ${JSON.stringify(t1)} }, r => res(JSON.stringify(r?.thread?.messages?.length ?? -1))))`);
  check("contract §2 (P0): the third turn is in thread1", Number(t1view2) >= 5, { msgs: t1view2 });

  // ── §2: a NEW task still starts from the explicit + path ──────────────
  await uiEval(`(async () => {
    const btn = document.getElementById("new-task");
    btn?.click();
    await new Promise(r => setTimeout(r, 500));
    return "clicked";
  })()`);
  await sleep(600);
  await hubSend("a separate task about recipes");
  await sleep(5000);
  threads = await listThreads();
  check("contract §2: the explicit + path still starts a NEW task", threads.length === 2, { n: threads.length });
  const t2id = threads.find((t: any) => t.id !== t1)?.id;

  // ── §3/§4: switching tasks — title + history ───────────────────────────
  const nameOf = (id: string) => threads.find((t: any) => t.id === id)?.name || "Task";
  const openByClick = async (id: string) => {
    await uiEval(`(async () => {
      const label = "Open task " + ${JSON.stringify(nameOf(id))};
      const target = Array.from(document.querySelectorAll('#thread-sidebar .t-open')).find(b => b.getAttribute('aria-label') === label);
      target?.click();
      await new Promise(r => setTimeout(r, 1200));
      return Boolean(target);
    })()`);
    await sleep(500);
    return surface();
  };
  const v1 = await openByClick(t1);
  check("contract §3/§4: opening task1 binds its title", String(v1).includes(JSON.stringify(nameOf(t1)).slice(1, -1)), v1);
  check("contract §3: task1 history renders (non-empty conversation)", (() => { try { return JSON.parse(v1).elems > 3; } catch { return false; } })(), v1);
  const v2 = await openByClick(t2id);
  const t2name = nameOf(t2id);
  check("contract §4: switching tasks updates the title", String(v2).includes(JSON.stringify(t2name).slice(1, -1)) && !String(v2).includes(JSON.stringify(nameOf(t1)).slice(1, -1)), { v2, expect: t2name });
  const back = await uiEval(`(async () => { history.back(); await new Promise(r => setTimeout(r, 1500)); return "back"; })()`);
  await sleep(500);
  const v3 = await surface();
  check("contract §5: BACK traversal restores task1 (title + history)", String(v3).includes(JSON.stringify(nameOf(t1)).slice(1, -1)) && (() => { try { return JSON.parse(v3).elems > 3; } catch { return false; } })(), { v3, back });

  // ── §7: orphaned alarm cleanup ──────────────────────────────────────────
  const seeded = await evaluate(`(async () => {
    // Seed an orphaned schedule directly: a recipe:<slug> task whose slug has
    // NO background recipe (the agent was deleted; the alarm survived).
    const KEY = "cap:scheduledTasks";
    const store = await new Promise(resolve => chrome.storage.local.get(KEY, res => resolve(res)));
    const tasks = store[KEY] ?? {};
    tasks["recipe:orphan-kat"] = {
      name: "recipe:orphan-kat",
      task: "orphan probe — the agent that owned me is gone",
      at: Date.now() + 60 * 60 * 1000,
      quarantined: false,
      cancelling: false,
      owner: { agentRole: "background:orphan-kat", agentSurfaceRef: "background:orphan-kat" },
    };
    await new Promise(r => chrome.storage.local.set({ [KEY]: tasks }, r));
    chrome.alarms.create("recipe:orphan-kat", { when: Date.now() + 60 * 60 * 1000 });
    return "seeded";
  })()`, (await cdp("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result.sessionId);
  check("orphan seed: schedule created", seeded === "seeded", seeded);

  const { result: { targetInfos: tt } } = await cdp("Target.getTargets");
  const sw2 = tt.find((t: any) => t.type === "service_worker");
  const { result: { sessionId: swSess } } = await cdp("Target.attachToTarget", { targetId: sw2.targetId, flatten: true });
  await cdp("Runtime.enable", {}, swSess);
  const swEval2 = (expr: string) => evaluate(expr, swSess);
  // NOTE: the SW cannot runtime-message ITSELF — route the call via the page.
  const cancelRes = await uiEval(`new Promise(res => chrome.runtime.sendMessage({ type: "schedule.cancelOrphans" }, r => res(JSON.stringify(r))))`);
  const cancelled = JSON.parse(cancelRes ?? "{}");
  check("contract §7: schedule.cancelOrphans cancels the orphaned alarm", cancelled?.ok === true && Array.isArray(cancelled?.cancelled) && cancelled.cancelled.includes("recipe:orphan-kat"), cancelRes);
  const gone = await swEval2(`(async () => {
    const KEY = "cap:scheduledTasks";
    const store = await new Promise(resolve => chrome.storage.local.get(KEY, res => resolve(res)));
    return String((store[KEY] ?? {})["recipe:orphan-kat"] === undefined);
  })()`);
  check("contract §7: the orphaned schedule is gone from the store", gone === "true", gone);

  // ── bug 7 (owner, live on 0.2.346): search_history denied with "enable
  // History in Settings" — a control that did not exist. Under the
  // install-granted model the gate can never fire. Prove it in the LIVE
  // service worker: the permission is granted, and the underlying chrome.*
  // call the tool wraps actually executes. (Reuses the sw2 attach above.)
  const histGrant = await swEval2(`chrome.permissions.contains({ permissions: ["history"] }).then(v => String(v), e => "err:" + e)`);
  check("bug 7: the history permission is install-granted in the live SW (the search_history gate can never fire)", histGrant === "true", histGrant);
  const histExec = await swEval2(`chrome.history.search({ text: "", maxResults: 1 }).then(() => "ok", e => "err:" + e)`);
  check("bug 7: chrome.history.search EXECUTES (search_history's underlying call)", histExec === "ok", histExec);
} catch (e) {
  console.error("HARNESS ERROR:", String(e).slice(0, 400));
  fail++;
} finally {
  ws.close();
  proc.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail > 0 ? 1 : 0);
