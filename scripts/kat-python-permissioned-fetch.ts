// scripts/kat-python-permissioned-fetch.ts — Python's network access is
// permissioned, anonymous, unlaunderable, revocable and RECORDED
// (bead chrome-agent-platform-4p7j.2, stage S0.5).
//
// S0 removed the Pyodide worker's ambient network globals. This harness proves
// the capability that replaced them behaves as promised, in a real loaded
// extension, driven through the product's own surfaces: the grant is made by
// clicking in Settings, and the request is made by model-shaped Python going
// through the python.execute route.
//
// WHY A LOCAL SERVER BEHIND A PUBLIC-LOOKING NAME. The policy refuses loopback
// and private addresses outright (SSRF is the first thing a network proxy in a
// browser extension has to not be). A test server on 127.0.0.1 would therefore
// be refused by design and could never prove the ALLOWED path. So Chrome is
// launched with --host-resolver-rules mapping two ordinary-looking hostnames to
// the local server: the URL's host is public-shaped, which is what the policy
// reads, while the bytes come from this process. That is exactly the DNS
// caveat lib/fetch-policy.js documents ("DNS rebinding of a listed public
// hostname is NOT covered here") — used deliberately here as a test seam, and
// worth knowing is not a defence.
//
//   deno run -A scripts/kat-python-permissioned-fetch.ts

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 900)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const GRANTED_HOST = "cap-kat-granted.test";
const OTHER_HOST = "cap-kat-elsewhere.test";
const GRANTED_ORIGIN = `http://${GRANTED_HOST}`;

// ── the origin the grant will point at ───────────────────────────────────────
// It records what it was actually sent, because the interesting assertion is
// not "the response arrived" but "no cookie arrived with it".
const seen: { path: string; cookie: string | null; auth: string | null; method: string }[] = [];
const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
  const url = new URL(req.url);
  seen.push({
    path: url.pathname,
    cookie: req.headers.get("cookie"),
    auth: req.headers.get("authorization"),
    method: req.method,
  });
  if (url.pathname === "/set-cookie") {
    return new Response("<html><body>cookie set</body></html>", {
      headers: { "content-type": "text/html", "set-cookie": "kat_session=owner-secret; Path=/" },
    });
  }
  if (url.pathname === "/redirect") {
    return new Response(null, { status: 302, headers: { location: `http://${OTHER_HOST}/ok` } });
  }
  if (url.pathname === "/echo") {
    return new Response(JSON.stringify({ ok: true, cookie: req.headers.get("cookie") }), {
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("granted-origin-payload", { headers: { "content-type": "text/plain" } });
});
const port = (server.addr as Deno.NetAddr).port;

const profile = chromeProfileDir("kat-python-permissioned-fetch");
const { proc, wsUrl } = await launchChrome({
  binary: "/usr/bin/chromium",
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--host-resolver-rules=MAP ${GRANTED_HOST} 127.0.0.1:${port},MAP ${OTHER_HOST} 127.0.0.1:${port}`,
    "--remote-allow-origins=*", `--user-data-dir=${profile}`, "about:blank",
  ],
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.onopen = r);
let id = 0;
const pending = new Map<string, (v: unknown) => void>();
const send = (method: string, params: unknown = {}, sessionId?: string) =>
  new Promise<any>((res) => {
    const mid = ++id;
    pending.set(String(mid), res as (v: unknown) => void);
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
ws.onmessage = (m) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};

try {
  const sw = await waitForServiceWorker((m, p) => send(m, p), { timeoutMs: 20000 });
  check("extension service worker present", Boolean(sw));
  const extId = new URL(sw.url).host;

  const openPage = async (url: string) => {
    const page = await send("Target.createTarget", { url });
    const sess = (await send("Target.attachToTarget", { targetId: page.result.targetId, flatten: true })).result?.sessionId;
    await send("Runtime.enable", {}, sess);
    return sess as string;
  };
  const evaluate = async (sess: string, expression: string) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sess);
    return r?.result?.result?.value;
  };

  // The owner's browser holds a session cookie for the origin about to be
  // granted — the confused-deputy setup. A proxied request must not carry it.
  const cookieSess = await openPage(`${GRANTED_ORIGIN}/set-cookie`);
  await sleep(600);
  const cookieHere = await evaluate(cookieSess, "document.cookie");
  check("the owner's browser holds a session cookie for the granted origin",
    String(cookieHere ?? "").includes("kat_session"), cookieHere);

  // ── Python runs from a real extension page, as the product does ────────────
  const hub = await openPage(`chrome-extension://${extId}/ntp/ntp.html`);
  await sleep(2500);
  const runPython = async (code: string) => {
    const expr = `(async()=>{const r=await chrome.runtime.sendMessage({type:"python.execute",code:${JSON.stringify(code)},stdin:""});return JSON.stringify(r);})()`;
    const raw = await evaluate(hub, expr);
    try { return JSON.parse(String(raw)); } catch { return { ok: false, error: String(raw ?? "no response") }; }
  };

  const baseline = await runPython(`print("python-ok")`);
  check("python still runs", baseline?.ok === true && String(baseline.stdout ?? "").includes("python-ok"), baseline);

  const capThere = await runPython(`import cap\nprint("cap:", callable(cap.fetch))`);
  check("the cap module is importable and cap.fetch is callable",
    String(capThere?.stdout ?? "").includes("cap: True"), capThere);

  // ── BEFORE the grant: refused, and the refusal is recorded ────────────────
  const FETCH_OK = `
import cap
try:
    r = await cap.fetch("${GRANTED_ORIGIN}/ok")
    print("STATUS:", r.status)
    print("BODY:", r.text)
except cap.NetworkRefused as e:
    # NOT truncated: the assertion below is that the refusal TEACHES, and the
    # part that teaches ("… the owner adds <origin> in Settings → …") is at the
    # end. The first cut of this harness clipped it at 220 characters and then
    # reported the product had lost it.
    print("REFUSED:", str(e))
except Exception as e:
    print("ERROR:", type(e).__name__, str(e)[:220])
`;
  const before = await runPython(FETCH_OK);
  const beforeOut = String(before?.stdout ?? "");
  check("an UNGRANTED origin is refused", beforeOut.startsWith("REFUSED:"), beforeOut.slice(0, 300));
  check("the refusal names the origin and how to grant it",
    beforeOut.includes(GRANTED_ORIGIN) && /Settings/.test(beforeOut), beforeOut.slice(0, 300));
  check("nothing reached the server before the grant",
    seen.filter((r) => r.path === "/ok").length === 0, seen);
  const beforeRecords = Array.isArray(before?.network) ? before.network : [];
  check("the REFUSAL is recorded in the run's network records",
    beforeRecords.length === 1 && beforeRecords[0].refused === true && beforeRecords[0].ok === false, beforeRecords);

  // A caught exception must not erase the record — the SW holds the pen.
  const swallowed = await runPython(`
import cap
try:
    await cap.fetch("${GRANTED_ORIGIN}/ok")
except Exception:
    pass
print("said nothing")
`);
  const swallowedRecords = Array.isArray(swallowed?.network) ? swallowed.network : [];
  check("a program that CATCHES the refusal and prints nothing still leaves the record",
    swallowedRecords.length === 1 && swallowedRecords[0].refused === true, swallowed);

  // ── the grant is made by clicking in Settings ─────────────────────────────
  const options = await openPage(`chrome-extension://${extId}/options/options.html#permissions`);
  await sleep(2500);
  const wired = await evaluate(options, `!!document.querySelector("#python-net-add")`);
  check("Settings → Permissions shows the Python network access surface", wired === true, wired);
  const emptyCopy = await evaluate(options, `document.querySelector("#python-net-list")?.textContent ?? ""`);
  check("with nothing granted the panel says so plainly",
    /cannot reach anything/i.test(String(emptyCopy ?? "")), emptyCopy);

  const granted = await evaluate(options, `(async()=>{
    const input = document.querySelector("#python-net-origin");
    input.value = ${JSON.stringify(GRANTED_ORIGIN)};
    document.querySelector("#python-net-add").click();
    await new Promise(r=>setTimeout(r,1200));
    return document.querySelector("#python-net-list")?.textContent ?? "";
  })()`);
  check("clicking Allow in Settings adds the origin to the list",
    String(granted ?? "").includes(GRANTED_ORIGIN), granted);
  const hasRemove = await evaluate(options, `!!document.querySelector('.python-net-row button')`);
  check("the granted row carries a Remove control", hasRemove === true, hasRemove);

  // ── AFTER the grant: it works, anonymously, and is recorded ───────────────
  const after = await runPython(FETCH_OK);
  const afterOut = String(after?.stdout ?? "");
  check("a GRANTED origin returns a real response",
    afterOut.includes("STATUS: 200") && afterOut.includes("granted-origin-payload"), afterOut.slice(0, 300));
  const afterRecords = Array.isArray(after?.network) ? after.network : [];
  check("the successful request is recorded with method, url, status and size",
    afterRecords.length === 1 && afterRecords[0].ok === true && afterRecords[0].status === 200 &&
    afterRecords[0].method === "GET" && afterRecords[0].bytes > 0 &&
    typeof afterRecords[0].ms === "number", afterRecords);

  const okHits = seen.filter((r) => r.path === "/ok");
  check("the request actually left the browser and reached the origin", okHits.length === 1, seen);
  check("the request was ANONYMOUS — the owner's cookie was NOT attached",
    okHits.length === 1 && !okHits[0].cookie, okHits);

  // A caller cannot re-authenticate it by hand either.
  const headerTry = await runPython(`
import cap
r = await cap.fetch("${GRANTED_ORIGIN}/echo", headers={"Cookie": "kat_session=owner-secret", "Authorization": "Bearer owner"})
print("BODY:", r.text)
`);
  const echoHits = seen.filter((r) => r.path === "/echo");
  check("caller-set Cookie/Authorization headers never reach the origin",
    echoHits.length === 1 && !echoHits[0].cookie && !echoHits[0].auth, { echoHits, headerTry });

  // ── the boundaries a grant does NOT move ─────────────────────────────────
  const redirected = await runPython(`
import cap
try:
    r = await cap.fetch("${GRANTED_ORIGIN}/redirect")
    print("FOLLOWED:", r.status, r.url)
except Exception as e:
    print("STOPPED:", str(e)[:220])
`);
  const redirectOut = String(redirected?.stdout ?? "");
  check("a granted origin redirecting elsewhere does NOT complete",
    redirectOut.startsWith("STOPPED:") && !redirectOut.includes("FOLLOWED"), redirectOut.slice(0, 300));
  check("the ungranted redirect target was never reached",
    seen.filter((r) => r.path === "/ok").length === 1, seen.map((r) => r.path));

  const otherOrigin = await runPython(`
import cap
try:
    await cap.fetch("http://${OTHER_HOST}/ok")
    print("REACHED")
except Exception as e:
    print("REFUSED:", str(e)[:160])
`);
  check("granting one origin grants only that origin",
    String(otherOrigin?.stdout ?? "").startsWith("REFUSED:"), otherOrigin);

  const loopback = await runPython(`
import cap
try:
    await cap.fetch("http://127.0.0.1:${port}/ok")
    print("REACHED")
except Exception as e:
    print("REFUSED:", str(e)[:160])
`);
  check("a loopback address is refused even though the same server answers it",
    String(loopback?.stdout ?? "").includes("REFUSED"), loopback);

  const writeMethod = await runPython(`
import cap
try:
    await cap.fetch("${GRANTED_ORIGIN}/ok", method="DELETE")
    print("ALLOWED")
except Exception as e:
    print("REFUSED:", str(e)[:160])
`);
  check("a grant to read is not a grant to write (DELETE refused)",
    String(writeMethod?.stdout ?? "").startsWith("REFUSED:"), writeMethod);

  const ambient = await runPython(`
import js
try:
    await js.fetch("${GRANTED_ORIGIN}/ok")
    print("AMBIENT REACHED")
except Exception as e:
    print("AMBIENT BLOCKED:", str(e)[:120])
`);
  check("granting an origin does NOT restore the ambient globals S0 removed",
    String(ambient?.stdout ?? "").startsWith("AMBIENT BLOCKED:"), ambient);

  const httpLib = await runPython(`
try:
    import requests
    print("IMPORTED")
except ImportError as e:
    print("GUARD:", str(e)[:200])
`);
  const libOut = String(httpLib?.stdout ?? "");
  check("importing requests teaches cap.fetch instead of dead-ending",
    libOut.startsWith("GUARD:") && libOut.includes("cap.fetch"), libOut.slice(0, 260));

  // ── revocation ────────────────────────────────────────────────────────────
  const removedText = await evaluate(options, `(async()=>{
    document.querySelector('.python-net-row button').click();
    await new Promise(r=>setTimeout(r,1200));
    return document.querySelector("#python-net-list")?.textContent ?? "";
  })()`);
  check("Remove takes the origin off the list",
    !String(removedText ?? "").includes(GRANTED_ORIGIN), removedText);

  const afterRevoke = await runPython(FETCH_OK);
  check("after Remove the origin is refused again, immediately",
    String(afterRevoke?.stdout ?? "").startsWith("REFUSED:"), afterRevoke);
  check("and nothing further reached the origin",
    seen.filter((r) => r.path === "/ok").length === 1, seen.map((r) => r.path));
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  try { await proc.status; } catch { /* reaped */ }
  await server.shutdown().catch(() => {});
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
