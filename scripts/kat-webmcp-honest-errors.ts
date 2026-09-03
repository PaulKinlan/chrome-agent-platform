// kat-webmcp-honest-errors.ts — live-browser KAT for chrome-agent-platform-ajcc:
// a site tool that fails must fail HONESTLY. Drives the REAL production path
// (build → fixture server → extension → hub discover gesture → tab picker →
// enrollment → tools.invoke) against fixtures/webmcp-errors.html and asserts:
//   1. happy_echo round-trips (the success path is byte-identical);
//   2. a handler throwing new DOMException(msg, "QuotaExceededError") surfaces
//      the NAME and the MESSAGE EXCERPT to the caller, with errorDetail
//      carrying phase/realm/origin (stamped by the content-script);
//   3. a BARE DOMException is reported as exactly that — no invented detail;
//   4. a plain TypeError surfaces its name + message;
//   5. credential SHAPES inside a page error message stay redacted even while
//      the cause is surfaced (the round-30 protection is preserved);
//   6. a non-cloneable RESULT fails honestly with phase
//      "result-serialization" — pre-fix the bridge's postMessage DataCloneError
//      was mislabeled as a handler failure ("tool failed (DOMException:
//      DataCloneError)"); the phase is now distinguishable.
// Pre-fix every one of 2-6 is RED (the bridge carried only "tool failed
// (DOMException: UnknownError)"); post-fix all are GREEN — that revert/run
// pair is the falsification gate for this bead.
//
//   deno run -A scripts/kat-webmcp-honest-errors.ts [<out-dir>]

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const OUT = Deno.args[0] ?? `${ROOT}.cache/kat-webmcp-honest-errors`;
const PAGE_ORIGIN = "http://127.0.0.1:8934";
const ERRORS_URL = `${PAGE_ORIGIN}/errors`;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 800)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// 0. Fresh build (the SW bundle + content scripts must match the sources
//    under test) + the fixture server.
const build = new Deno.Command("node", { args: [`${ROOT}build.mjs`], stdout: "null", stderr: "null", cwd: ROOT }).spawn();
const buildStatus = await build.status;
check("build succeeded (dist matches sources)", buildStatus.success);

const fixture = new Deno.Command("deno", {
  args: ["run", "-A", `${ROOT}fixtures/webmcp-server.ts`],
  stdout: "null", stderr: "null", cwd: ROOT,
}).spawn();
const fixtureUp = await (async () => {
  for (let i = 0; i < 40; i++) {
    const ok = await fetch(`${ERRORS_URL}`).then((r) => r.ok).catch(() => false);
    if (ok) return true;
    await sleep(250);
  }
  return false;
})();
check("fixture server answers on 127.0.0.1:8934 (/errors)", fixtureUp);

// Headless Chrome does not settle the JIT scripting grant — the variant
// pregrants scripting+tabs (the webmcp-acceptance.ts headless pattern).
const VARIANT = `/tmp/cap-kat-honest-errors-${Date.now()}`;
{
  const cp = new Deno.Command("cp", { args: ["-r", EXT + "/.", VARIANT] }).spawn();
  await cp.status;
  const mf = JSON.parse(await Deno.readTextFile(`${VARIANT}/manifest.json`));
  mf.permissions = [...new Set([...(mf.permissions ?? []), "scripting", "tabs"])];
  mf.optional_permissions = (mf.optional_permissions ?? []).filter((p: string) => p !== "scripting" && p !== "tabs");
  await Deno.writeTextFile(`${VARIANT}/manifest.json`, JSON.stringify(mf, null, 2) + "\n");
}

const profile = `${ROOT}.cache/kat-webmcp-honest-errors-${Date.now()}`;
const { proc, wsUrl } = await launchChrome({
  binary: "/usr/bin/chromium",
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${VARIANT}`, `--load-extension=${VARIANT}`,
    "--remote-allow-origins=*", "--window-size=1400,1200",
    `--user-data-dir=${profile}`, "about:blank"],
});

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = () => r(null); ws.onerror = j; });
let id = 0; const pending = new Map<string, (v: any) => void>();
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
const evalIn = async (sid: string, expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r?.result?.exceptionDetails) return { __exception: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
  return r?.result?.result?.value;
};
const until = async (fn: () => Promise<any>, ms: number, step = 400) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
};
const clickSelector = async (sid: string, expr: string) => {
  const box = await evalIn(sid, `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
  if (!box || typeof box.x !== "number") return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 }, sid);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 }, sid);
  return true;
};

const evidence: Record<string, unknown> = {};

try {
  // 1. Extension service worker + errors fixture tab + hub.
  const sw = await waitForServiceWorker((m, p) => send(m, p), { timeoutMs: 20000 });
  check("extension service worker present", !!sw);
  const extId = new URL(sw.url).host;

  const eT = await send("Target.createTarget", { url: ERRORS_URL });
  const esess = (await send("Target.attachToTarget", { targetId: eT.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, esess);
  const fixtureLoaded = await until(() => evalIn(esess, `document.getElementById("msg")?.textContent === "errors fixture loaded" ? true : null`), 15000);
  check("errors fixture loaded", fixtureLoaded === true);

  const nT = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  const ns = (await send("Target.attachToTarget", { targetId: nT.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, ns);
  await sleep(1600);
  await send("Target.activateTarget", { targetId: nT.result.targetId });

  // 2. Enroll the errors fixture through the REAL picker.
  const discoverClicked = await clickSelector(ns, `document.getElementById("discover-page")`);
  check("hub: clicked Discover this page via a real click", discoverClicked);
  const rowClicked = await until(async () => {
    const has = await evalIn(ns, `(() => {
      const dlg = document.querySelector("agent-dialog");
      if (!dlg) return null;
      const rows = [...dlg.querySelectorAll("capability-row")];
      return rows.find((r) => r.getAttribute("description") === ${JSON.stringify(PAGE_ORIGIN)}) ? true : null;
    })()`);
    if (!has) return null;
    return await clickSelector(ns, `(() => {
      const dlg = document.querySelector("agent-dialog");
      const rows = [...dlg.querySelectorAll("capability-row")];
      const row = rows.find((r) => r.getAttribute("description") === ${JSON.stringify(PAGE_ORIGIN)});
      return row?.shadowRoot?.querySelector("button.run") ?? null;
    })()`) ? true : null;
  }, 30000);
  check("hub: picked the errors fixture tab via a real click", rowClicked === true);
  const enrolled = await until(async () => {
    const list = await evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.list" })`);
    return Array.isArray(list) && list.includes(PAGE_ORIGIN) ? list : null;
  }, 20000);
  check("the errors fixture origin is enrolled", !!enrolled, enrolled);

  const invoke = (name: string, args: unknown = {}) =>
    evalIn(ns, `chrome.runtime.sendMessage({ type: "tools.invoke", origin: ${JSON.stringify(PAGE_ORIGIN)}, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} })`);

  // 3. The directory must carry the fixture tools before invocation.
  const dirReady = await until(async () => {
    const r = await invoke("happy_echo", { query: "warm" });
    return r && !(typeof r?.error === "string" && r.error.includes("no such tool")) ? true : null;
  }, 30000);
  check("the directory carries the errors-fixture tools", dirReady === true, dirReady);

  // 4. Happy path — the success round-trip is untouched.
  const happy = await invoke("happy_echo", { query: "round-trip" });
  evidence.happy = happy;
  check("happy path: happy_echo round-trips { echo } unchanged",
    happy?.ok === true && happy?.result?.echo === "round-trip", happy);

  // 5. A specific DOMException — name + message excerpt + stamped detail.
  const named = await invoke("fail_named");
  evidence.fail_named = named;
  check("fail_named: the error NAMES the real DOMException (QuotaExceededError)",
    typeof named?.error === "string" && named.error.includes("QuotaExceededError"), named?.error);
  check("fail_named: the error carries the page's message excerpt (search index quota exceeded)",
    typeof named?.error === "string" && named.error.includes("search index quota exceeded"), named?.error);
  check("fail_named: errorDetail stamps realm=main, the fixture origin, phase=dispatch, pageControlled",
    named?.errorDetail?.realm === "main" &&
    named?.errorDetail?.origin === PAGE_ORIGIN &&
    named?.errorDetail?.phase === "dispatch" &&
    named?.errorDetail?.pageControlled === true &&
    named?.errorDetail?.name === "QuotaExceededError" &&
    // A DOMException has NO .stack in Chrome (verified) — the channel is a
    // string either way; the TypeError check below proves it carries one
    // when the browser provides it.
    typeof named?.errorDetail?.stack === "string",
    named?.errorDetail);

  // 6. A bare DOMException — say exactly that, never invent detail.
  const bare = await invoke("fail_bare");
  evidence.fail_bare = bare;
  check("fail_bare: a messageless DOMException is reported as exactly that",
    typeof bare?.error === "string" && bare.error.includes("no message") && bare.error.includes("DOMException"),
    bare?.error);

  // 7. A plain TypeError — the common real-page failure shape.
  const te = await invoke("fail_typeerror");
  evidence.fail_typeerror = te;
  check("fail_typeerror: TypeError name + message excerpt surface",
    typeof te?.error === "string" && te.error.includes("TypeError") && te.error.includes("documents"),
    te?.error);
  check("fail_typeerror: the stack channel carries the page-side frames when the browser provides them",
    typeof te?.errorDetail?.stack === "string" && te.errorDetail.stack.includes("/errors"),
    String(te?.errorDetail?.stack ?? "").slice(0, 200));

  // 8b. The ajcc review-P1 redaction-parity cases: keyword-adjacent
  //     assignments and userinfo URLs must not leak either.
  const kwToken = await invoke("fail_kw_assignment");
  evidence.fail_kw_assignment = kwToken;
  check("fail_kw_assignment: keyword-assigned token is masked, the cause still surfaces",
    typeof kwToken?.error === "string" &&
    !kwToken.error.includes("hunter2hunter2") &&
    kwToken.error.includes("token=[REDACTED]") &&
    kwToken.error.includes("upstream rejected"),
    kwToken?.error);
  const kwPass = await invoke("fail_kw_password");
  evidence.fail_kw_password = kwPass;
  check("fail_kw_password: keyword-assigned password is masked, surrounding prose intact",
    typeof kwPass?.error === "string" &&
    !kwPass.error.includes("hunter2") &&
    kwPass.error.includes("password=[REDACTED]") &&
    kwPass.error.includes("retry later"),
    kwPass?.error);
  const userinfo = await invoke("fail_userinfo_url");
  evidence.fail_userinfo_url = userinfo;
  check("fail_userinfo_url: userinfo password masked AND query and fragment stripped",
    typeof userinfo?.error === "string" &&
    !userinfo.error.includes("hunter2") &&
    userinfo.error.includes("[REDACTED]@") &&
    !userinfo.error.includes("y=1") &&
    !userinfo.error.includes("#frag") &&
    userinfo.error.includes("…[query redacted]") &&
    userinfo.error.includes("401"),
    userinfo?.error);
  check("P1 cases: errorDetail messages carry no leaked value either",
    ![kwToken, kwPass, userinfo].some((r) =>
      String(r?.errorDetail?.message ?? "").includes("hunter2") ||
      String(r?.errorDetail?.stack ?? "").includes("hunter2")),
    [kwToken?.errorDetail?.message, kwPass?.errorDetail?.message, userinfo?.errorDetail?.message]);
  // 8. Credential shapes in a page error stay redacted (round-30 preserved).
  const leaky = await invoke("fail_leaky");
  evidence.fail_leaky = leaky;
  check("fail_leaky: the cause surfaces but the credential shape is redacted",
    typeof leaky?.error === "string" &&
    !leaky.error.includes("sk-live-abcdef123456") &&
    leaky.error.includes("[REDACTED]") &&
    leaky.error.includes("request to"),
    leaky?.error);
  check("fail_leaky: errorDetail message/stack carry no credential shape either",
    typeof leaky?.errorDetail?.message === "string" &&
    !leaky.errorDetail.message.includes("sk-live-abcdef123456") &&
    !String(leaky?.errorDetail?.stack ?? "").includes("sk-live-abcdef123456"),
    leaky?.errorDetail);

  // 9. A non-cloneable result fails FAST and honestly — never the 15s timeout.
  const t0 = Date.now();
  const nc = await invoke("return_noncloneable");
  const ncMs = Date.now() - t0;
  evidence.return_noncloneable = { result: nc, elapsedMs: ncMs };
  check("return_noncloneable: honest serialization failure (not the 15s timeout)",
    nc?.ok === false &&
    typeof nc?.error === "string" &&
    nc.error.includes("could not cross the bridge") &&
    !nc.error.includes("timed out") &&
    nc?.errorDetail?.phase === "result-serialization",
    { error: nc?.error, phase: nc?.errorDetail?.phase });
  check("return_noncloneable: the honest failure arrives well before the 15s timeout", ncMs < 12000, { ncMs });

  await Deno.writeTextFile(`${OUT}/honest-errors-evidence.json`, JSON.stringify({
    ts: new Date().toISOString(), bead: "chrome-agent-platform-ajcc", evidence,
  }, null, 2) + "\n");
} finally {
  try { fixture.kill("SIGKILL"); } catch { /* already dead */ }
  try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  try { await proc.status; } catch { /* reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
  await Deno.remove(VARIANT, { recursive: true }).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
