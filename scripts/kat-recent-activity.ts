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

import { launchChrome } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? durableDir(`kat-recent-activity-${Date.now()}`);
const CHROMIUM = "/usr/bin/chromium";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

await Deno.mkdir(OUT, { recursive: true });

// Kernel-assigned debugging port, read back from THIS Chrome by the shared
// launcher — a named port can silently attach to another lane's browser
// (CAP-FB-20260829-FIXED-DEBUG-PORTS-01).
const { proc, wsUrl, port } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${OUT}/profile`, "about:blank"],
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
  // The hub send opens the THREAD view — the hub is COVERED, so the refresh
  // is deferred (P1-a contract) and flushed exactly once on return. Let the
  // run settle, return to the hub, then the run must appear WITHOUT a reload.
  await sleep(6000);
  const aCover = await uiEval(`document.getElementById("thread-view")?.hidden === false`);
  if (aCover) await uiEval(`document.getElementById("thread-back")?.click()`);
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

  // ── G. In-flight coalescing (P1-b): rapid refreshes never overlap _load ─
  const coalesce = await uiEval(`(async () => {
    const host = document.querySelector("#run-log activity-explorer");
    let loads = 0, concurrent = 0, maxConcurrent = 0;
    const orig = host._load.bind(host);
    host._load = async () => {
      loads += 1; concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
      try { return await orig(); } finally { concurrent -= 1; }
    };
    await Promise.all([host.refresh(), host.refresh(), host.refresh(), host.refresh(), host.refresh()]);
    // settle any trailing refresh the guard queued
    await new Promise((r) => setTimeout(r, 3000));
    return { loads, maxConcurrent };
  })()`);
  check("coalescing: 5 rapid refreshes never overlap (one in flight + trailing)", coalesce.maxConcurrent === 1 && coalesce.loads >= 1 && coalesce.loads <= 2, coalesce);

  // ── F. Hidden-hub deferral (P1-a): covered activity is deferred, not dropped ─
  await uiEval(`document.getElementById("open-directory")?.click()`);
  let covered = false;
  for (let i = 0; i < 20 && !covered; i++) {
    covered = await uiEval(`document.getElementById("view")?.hidden === false`);
    if (!covered) await sleep(500);
  }
  check("deferral precondition: the directory overlay covers the hub", covered === true, { covered });
  await uiEval(`(async () => {
    document.getElementById("composer")?.dispatchEvent(new CustomEvent("send", { detail: { text: "kat: covered deferral probe", attachments: [] }, bubbles: true }));
    return "sent";
  })()`);
  // The hub send opens the THREAD view (replacing the directory overlay — the
  // hub stays covered, just by a different surface). Let the run settle while
  // covered; the deferral-probe row must NOT render yet.
  await sleep(8000);
  const coverState = await uiEval(`({ view: document.getElementById("view")?.hidden === false, thread: document.getElementById("thread-view")?.hidden === false })`);
  const whileCovered = await uiEval(`(() => {
    const root = document.querySelector("#run-log activity-explorer")?.shadowRoot;
    return { texts: root ? [...root.querySelectorAll(".aex-text")].map((n) => n.textContent) : [] };
  })()`);
  check("deferral: covered activity does NOT render while the hub is covered", !whileCovered.texts?.some((t: any) => t.includes("kat: covered deferral probe")), { ...whileCovered, coverState });
  // Return to the hub through WHICHEVER surface is covering it.
  if (coverState.thread) await uiEval(`document.getElementById("thread-back")?.click()`);
  if (!coverState.thread && coverState.view) await uiEval(`document.getElementById("view-back")?.click()`);
  let afterReturn = await explorerState();
  const retDeadline = Date.now() + 15000;
  while (Date.now() < retDeadline && !afterReturn.texts?.some((t: any) => t.includes("kat: covered deferral probe"))) {
    await sleep(1000);
    afterReturn = await explorerState();
  }
  check("deferral: returning to the hub FLUSHES the deferred activity (no reload)", afterReturn.texts?.some((t: any) => t.includes("kat: covered deferral probe")), { ...afterReturn, coverState });
  await shot("03-deferred-flush", ui);

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
      { ts: Date.now() - 3, source: "master", agentLabel: "hub", type: "tool-call", id: "t9", callId: "c9", tool: "http_request", args: JSON.stringify({ url: "https://api.example.com", apiKey: "sk-live-KATSECRET-dont-paint-918273645" }) },
      // P1 (round-3): tool-RESULT secret probes — a bare JSON-string result and
      // a WRAPPED (modelContent double-encoded) result, both carrying secrets.
      { ts: Date.now() - 4, source: "master", agentLabel: "hub", type: "tool-result", id: "t10", callId: "c10", tool: "http_request", result: JSON.stringify({ status: "ok", apiKey: "sk-live-KATRESULT-dont-paint-564738291" }) },
      { ts: Date.now() - 5, source: "master", agentLabel: "hub", type: "tool-result", id: "t11", callId: "c11", tool: "http_request", result: JSON.stringify({ modelContent: JSON.stringify({ count: 3, apiKey: "sk-live-KATWRAPPED-dont-paint-102938475" }) }) },
      // P1 (round-4): a NESTED string leaf (Bearer inside a plain value), a
      // BARE credential shape with no keyword context, and a DOUBLE-encoded
      // envelope — all three survived round-3 redaction (falsification).
      { ts: Date.now() - 6, source: "master", agentLabel: "hub", type: "tool-result", id: "t12", callId: "c12", tool: "http_request", result: JSON.stringify({ message: "Bearer sk-live-KATNESTED-dont-paint-111111111" }) },
      { ts: Date.now() - 7, source: "master", agentLabel: "hub", type: "tool-result", id: "t13", callId: "c13", tool: "http_request", result: "fetch ok: sk-live-KATBARE-dont-paint-222222222 key AKIAKATBAREKEYS0000X" },
      { ts: Date.now() - 8, source: "master", agentLabel: "hub", type: "tool-result", id: "t14", callId: "c14", tool: "http_request", result: JSON.stringify({ modelContent: JSON.stringify({ modelContent: JSON.stringify({ apiKey: "sk-live-KATDEEP-dont-paint-333333333" }) }) }) },
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

  // ── E. Secret redaction (P1-d): a historical entry with an apiKey-shaped
  //        value renders + copies REDACTED (falsification: pre-revise code
  //        paints + copies the raw secret). ────────────────────────────────
  const redaction = await uiEval(`(async () => {
    const SECRET = "sk-live-KATSECRET-dont-paint-918273645";
    const host = document.querySelector("#run-log activity-explorer");
    const root = host.shadowRoot;
    const entries = [...root.querySelectorAll("details.aex-entry")];
    const secretEntry = entries.find((d) => d.dataset.ekey?.startsWith("tool-call:t9"));
    if (!secretEntry) return { missing: true, keys: entries.map((d) => d.dataset.ekey) };
    secretEntry.open = true;
    const summaryText = secretEntry.querySelector(".aex-text")?.textContent ?? "";
    const treeText = [...secretEntry.querySelectorAll(".tt-val")].map((n) => n.textContent).join(" ");
    // The COPY path: stub the clipboard, click the root container's copy-json.
    const captured = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: (t) => { captured.push(t); return Promise.resolve(); } }, configurable: true });
    const copyJson = [...secretEntry.querySelectorAll(".tt-copy")].find((b) => b.dataset.copy === "json");
    copyJson?.click();
    await new Promise((r) => setTimeout(r, 300));
    const copied = captured.join(" ");
    return {
      summaryLeaks: summaryText.includes(SECRET),
      treeLeaks: treeText.includes(SECRET),
      treeRedacted: treeText.includes("[REDACTED]"),
      copied,
      copyLeaks: copied.includes(SECRET),
      copyRedacted: copied.includes("[REDACTED]"),
    };
  })()`);
  check("redaction: the summary line never paints the secret", redaction.summaryLeaks === false, redaction);
  check("redaction: the detail tree renders [REDACTED], never the secret", redaction.treeLeaks === false && redaction.treeRedacted === true, redaction);
  check("redaction: the tree COPY is redacted too", redaction.copyLeaks === false && redaction.copyRedacted === true, redaction);
  await shot("04-redaction", ui);

  // ── E2. Tool-RESULT redaction (round-3 P1): a secret in a RESULT must never
  //         paint in the collapsed-row summary, the detail tree, or the tree
  //         COPY — for a bare JSON-string result AND a wrapped (modelContent
  //         double-encoded) result. Falsification: pre-fix code paints both.
  const resultRedaction = await uiEval(`(async () => {
    const SECRET = "sk-live-KATRESULT-dont-paint-564738291";
    const WSECRET = "sk-live-KATWRAPPED-dont-paint-102938475";
    const root = document.querySelector("#run-log activity-explorer")?.shadowRoot;
    const entries = [...root.querySelectorAll("details.aex-entry")];
    const probe = async (prefix, secret) => {
      const entry = entries.find((d) => d.dataset.ekey?.startsWith(prefix));
      if (!entry) return { missing: true, keys: entries.map((d) => d.dataset.ekey) };
      entry.open = true;
      const summaryText = entry.querySelector(".aex-text")?.textContent ?? "";
      const treeText = [...entry.querySelectorAll(".tt-val")].map((n) => n.textContent).join(" ");
      const captured = [];
      Object.defineProperty(navigator, "clipboard", { value: { writeText: (t) => { captured.push(t); return Promise.resolve(); } }, configurable: true });
      const copyJson = [...entry.querySelectorAll(".tt-copy")].find((b) => b.dataset.copy === "json");
      copyJson?.click();
      await new Promise((r) => setTimeout(r, 300));
      const copied = captured.join(" ");
      return { summaryLeaks: summaryText.includes(secret), summaryRedacted: summaryText.includes("[REDACTED]"),
               treeLeaks: treeText.includes(secret), treeRedacted: treeText.includes("[REDACTED]"),
               copyLeaks: copied.includes(secret), copyRedacted: copied.includes("[REDACTED]") };
    };
    return { bare: await probe("tool-result:t10", SECRET), wrapped: await probe("tool-result:t11", WSECRET) };
  })()`);
  check("result-redaction: bare JSON-string result — summary paints no secret", resultRedaction.bare?.summaryLeaks === false && resultRedaction.bare?.summaryRedacted === true, resultRedaction.bare);
  check("result-redaction: bare JSON-string result — tree + copy are redacted", resultRedaction.bare?.treeLeaks === false && resultRedaction.bare?.treeRedacted === true && resultRedaction.bare?.copyLeaks === false && resultRedaction.bare?.copyRedacted === true, resultRedaction.bare);
  check("result-redaction: wrapped modelContent result — summary paints no secret", resultRedaction.wrapped?.summaryLeaks === false && resultRedaction.wrapped?.summaryRedacted === true, resultRedaction.wrapped);
  check("result-redaction: wrapped modelContent result — tree + copy render the redacted decoded view", resultRedaction.wrapped?.treeLeaks === false && resultRedaction.wrapped?.treeRedacted === true && resultRedaction.wrapped?.copyLeaks === false && resultRedaction.wrapped?.copyRedacted === true, resultRedaction.wrapped);
  await shot("05-result-redaction", ui);

  // ── E3. Round-4 shapes: nested string leaf, BARE credential shapes (no
  //         keyword context), double-encoded envelope — the whole entry
  //         (summary + detail, any renderer) must never contain the secret.
  const r4 = await uiEval(`(async () => {
    const root = document.querySelector("#run-log activity-explorer")?.shadowRoot;
    const entries = [...root.querySelectorAll("details.aex-entry")];
    const probe = (prefix, secrets) => {
      const entry = entries.find((d) => d.dataset.ekey?.startsWith(prefix));
      if (!entry) return { missing: true };
      entry.open = true;
      const text = entry.textContent ?? "";
      return { leaks: secrets.filter((s) => text.includes(s)), redacted: text.includes("[REDACTED]") };
    };
    return {
      nested: probe("tool-result:t12", ["KATNESTED-dont-paint-111111111"]),
      bare: probe("tool-result:t13", ["KATBARE-dont-paint-222222222", "AKIAKATBAREKEYS0000X"]),
      deep: probe("tool-result:t14", ["KATDEEP-dont-paint-333333333"]),
    };
  })()`);
  check("r4-redaction: nested Bearer leaf never paints", r4.nested?.leaks?.length === 0 && r4.nested?.redacted === true, r4.nested);
  check("r4-redaction: bare sk-/AKIA shapes never paint", r4.bare?.leaks?.length === 0 && r4.bare?.redacted === true, r4.bare);
  check("r4-redaction: double-encoded envelope's deepest secret never paints", r4.deep?.leaks?.length === 0 && r4.deep?.redacted === true, r4.deep);

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
