// kat-recent-activity.ts — owner-bug KAT: "Recent activity" must be LIVE (a run
// landing while the NTP is open appears without a reload) and tool-call
// params/results must render STRUCTURED (tree blocks, truncation, copy) —
// never raw JSON blobs.
//
// Falsification: the live-update checks FAIL against the pre-fix build (proven
// by scripts/repro-recent-activity.ts: 0 rows live, 6 only after reload); the
// structured-detail checks fail against the old <pre>-only detail (no .tt-row
// nodes, no show-more).
//
//   deno run -A scripts/kat-recent-activity.ts [extension-dir] [out-dir]

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `/tmp/kat-recent-activity-${Date.now()}`;
const CHROMIUM = "/usr/bin/chromium";
const PORT = 9462;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

await Deno.mkdir(OUT, { recursive: true });

const proc = new Deno.Command(CHROMIUM, {
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    `--user-data-dir=${OUT}/profile`, "about:blank"],
  stdout: "null", stderr: "piped",
}).spawn();

const wsUrl = await new Promise<string>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no devtools url")), 20000);
  (async () => { for (;;) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); const j = await r.json(); clearTimeout(t); resolve(j.webSocketDebuggerUrl); return; } catch { await sleep(300); } } })();
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
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
const shot = async (name: string, sessionId: string) => {
  const j = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
  if (j.result?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(j.result.data), (c) => c.charCodeAt(0)));
};

try {
  let sw: any = null;
  for (let i = 0; i < 30 && !sw; i++) {
    const { result: { targetInfos } } = await cdp("Target.getTargets");
    sw = targetInfos.find((t: any) => t.type === "service_worker");
    if (!sw) await sleep(500);
  }
  if (!sw) throw new Error("no service worker target");
  const extId = new URL(sw.url).host;

  const { result: { targetId } } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  await sleep(3000);
  const { result: { targetInfos: t2 } } = await cdp("Target.getTargets");
  const page = t2.find((t: any) => t.url.includes("ntp.html"));
  const { result: { sessionId: ui } } = await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await cdp("Page.enable", {}, ui);
  const uiEval = (expr: string) => evaluate(expr, ui);

  const explorerState = () => uiEval(`(() => {
    const host = document.querySelector("#run-log activity-explorer");
    if (!host) return { mounted: false };
    const root = host.shadowRoot;
    return {
      mounted: true,
      rows: root ? root.querySelectorAll(".aex-entry").length : -1,
      texts: root ? [...root.querySelectorAll(".aex-text")].map((n) => n.textContent).slice(0, 5) : [],
      empty: root?.querySelector(".aex-empty")?.textContent ?? null,
    };
  })()`);

  // ── A. Live updates (the owner's bug) ──────────────────────────────────
  const baseline = await explorerState();
  check("explorer mounts on the NTP", baseline.mounted === true, baseline);

  await uiEval(`(async () => {
    document.getElementById("composer")?.dispatchEvent(new CustomEvent("send", { detail: { text: "kat: recent activity live probe", attachments: [] }, bubbles: true }));
    return "sent";
  })()`);
  // The run settles (provider failure on a fresh profile still journals the
  // task + error), journal writes land fire-and-forget, the debounced live
  // refresh follows. Poll up to 20s for the section to update WITHOUT reload.
  let live = await explorerState();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && live.rows === 0) { await sleep(1000); live = await explorerState(); }
  check("LIVE: the run appears in Recent activity WITHOUT a reload", live.rows > 0, live);
  check("LIVE: the row names the task", live.texts?.some((t: string) => t.includes("kat: recent activity live probe")), live.texts);
  await shot("01-live-activity", ui);

  // ── B. Persistence across reload ───────────────────────────────────────
  await cdp("Page.reload", {}, ui);
  await sleep(3500);
  const reloaded = await explorerState();
  check("persistence: activity survives an NTP reload", reloaded.rows > 0, reloaded);

  // ── C. Structured params/response rendering (seeded entries drive the
  //        REAL component — the gallery path — for the deterministic shapes
  //        a provider-less profile cannot produce) ────────────────────────
  await uiEval(`(() => {
    const host = document.querySelector("#run-log activity-explorer");
    const big = "stack frame\\n".repeat(300) + "TAIL-MARKER";
    host.entries = [
      { ts: Date.now(), source: "master", agentLabel: "hub", type: "tool-call", id: "t1", callId: "c1", tool: "read_page", args: JSON.stringify({ url: "https://example.com", selector: "article", options: { depth: 2, include: ["a", "b"] } }) },
      { ts: Date.now() - 1, source: "master", agentLabel: "hub", type: "tool-result", id: "t1", callId: "c1", tool: "read_page", result: JSON.stringify({ ok: true, title: "Example", links: [{ href: "/a" }, { href: "/b" }] }) },
      { ts: Date.now() - 2, source: "master", agentLabel: "hub", type: "error", id: "e1", error: "boom", stack: big },
    ];
    return "seeded";
  })()`);
  await sleep(800);
  const structured = await uiEval(`(() => {
    const host = document.querySelector("#run-log activity-explorer");
    const root = host.shadowRoot;
    const entries = [...root.querySelectorAll("details.aex-entry")];
    const callEntry = entries.find((d) => d.dataset.ekey?.startsWith("tool-call:"));
    const errEntry = entries.find((d) => d.dataset.ekey?.startsWith("error:"));
    if (!callEntry || !errEntry) return { missing: true, keys: entries.map((d) => d.dataset.ekey) };
    callEntry.open = true; errEntry.open = true;
    const callTreeRows = callEntry.querySelectorAll(".tt-row").length;
    const callRawPre = !!callEntry.querySelector(":scope > pre.aex-detail");
    const callCopyBtns = callEntry.querySelectorAll(".tt-copy").length;
    const errPre = errEntry.querySelector(".aex-detail");
    const errText = errPre?.textContent ?? "";
    const more = errEntry.querySelector(".aex-plain-more");
    const moreLabel = more?.textContent ?? null;
    if (more) more.click();
    const errFull = errEntry.querySelector(".aex-detail")?.textContent ?? "";
    return {
      callTreeRows, callRawPre, callCopyBtns,
      errTruncated: errText.length < 2100 && errText.includes("…"),
      errHidesTail: !errText.includes("TAIL-MARKER"),
      moreLabel,
      errRevealed: errFull.includes("TAIL-MARKER"),
      errCopyBtn: !!errEntry.querySelector(".aex-plain-copy"),
    };
  })()`);
  check("params render STRUCTURED (tree rows, not a raw <pre>)", structured.callTreeRows > 3 && structured.callRawPre === false, structured);
  check("tree rows carry copy buttons", structured.callCopyBtns > 0, structured);
  check(">2KiB plain detail truncates with an ellipsis, tail hidden", structured.errTruncated === true && structured.errHidesTail === true, structured);
  check("show-more reveals the full payload", structured.errRevealed === true, structured);
  check("plain block carries a copy button", structured.errCopyBtn === true, structured);
  await shot("02-structured-detail", ui);

  // ── D. Seeded refresh() is a no-op (gallery owns its data) ────────────
  const seededRefresh = await uiEval(`(async () => {
    const host = document.querySelector("#run-log activity-explorer");
    const before = host.shadowRoot.querySelectorAll(".aex-entry").length;
    await host.refresh();
    return { before, after: host.shadowRoot.querySelectorAll(".aex-entry").length, seeded: !!host._seeded };
  })()`);
  check("refresh() on seeded (gallery) data never clobbers it", seededRefresh.seeded === true && seededRefresh.after === seededRefresh.before, seededRefresh);
} finally {
  try { proc.kill(); } catch { /* best effort */ }
}

console.log(`KAT recent-activity: ${pass} passed, ${fail} failed — evidence in ${OUT}`);
if (fail > 0) Deno.exit(1);
