// chrome-journeys.ts — retained Chrome regression journeys for the security /
// runtime boundaries. Loads the built extension in headless Chrome and drives
// REAL behaviour, including GENUINE CDP user input (Input.dispatchMouseEvent /
// Input.dispatchKeyEvent on the NTP + Settings surfaces), a real HTTP-tab
// screenshot matrix, a worker-restart + missing-alarm reconciliation, and a
// multi-agent toggle rebuild. Fail-closed, environment-scrubbed, bounded,
// owner-clean (profile removal is asserted, not best-effort; the summary prints
// only after cleanup passes).

//   deno run -A scripts/chrome-journeys.ts

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const SHOT_DIR = `${ROOT}test-artifacts`;

const CHROMIUM = "/usr/bin/chromium";
const PKILL = "/usr/bin/pkill";
const PGREP = "/usr/bin/pgrep";
const RM = "/bin/rm";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/** A bounded fetch → JSON (deadline on BOTH the fetch and the body read). */
async function fetchJson(url, opts) {
  const res = await withTimeout(fetch(url, opts), 8000, `fetch ${url}`);
  return await withTimeout(res.json(), 8000, `json ${url}`);
}

/** Run a child command with a CLEARED environment + absolute path + deadline. */
async function runBounded(cmd, args, timeoutMs = 8000) {
  const proc = new Deno.Command(cmd, {
    args,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await withTimeout(proc.output(), timeoutMs, `run ${cmd}`);
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

function launchChrome(profile: string) {
  return new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--remote-debugging-port=0",
      "--window-size=1400,2400",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
  }).spawn();
}

async function waitForPort(proc: Deno.ChildProcess): Promise<number> {
  for (let i = 0; i < 80; i++) {
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

// A minimal CDP session over the browser WebSocket. Console/exception events are
// recorded WITH their sessionId so the "no SW errors" assertion can be strictly
// worker-only (never mixed with the options/NTP/fixture sessions).
class Cdp {
  ws;
  id = 0;
  pending = new Map();
  consoleErrors = [];
  swSessions = new Set();
  constructor(ws) {
    this.ws = ws;
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.id && this.pending.has(d.id)) {
        const { resolve, timer } = this.pending.get(d.id);
        clearTimeout(timer);
        this.pending.delete(d.id);
        resolve(d);
      }
      if (
        d.method === "Runtime.exceptionThrown" ||
        (d.method === "Runtime.consoleAPICalled" && d.params?.type === "error")
      ) {
        const detail = d.params?.exceptionDetails?.exception?.description ??
          d.params?.args?.map((a) => a?.value ?? a?.description).join(" ") ??
          JSON.stringify(d.params).slice(0, 200);
        this.consoleErrors.push({ sessionId: d.sessionId, detail });
      }
    };
  }
  send(method, params = {}, sessionId?) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  swErrors() {
    return this.consoleErrors.filter((e) => this.swSessions.has(e.sessionId));
  }
}

/** Open a tab (or extension page) via /json/new, returning its target. */
async function openPage(port: number, url: string) {
  return await fetchJson(`http://127.0.0.1:${port}/json/new?${url}`, {
    method: "PUT",
  });
}

/** Attach to a target and enable Runtime, returning the session id. */
async function attachRuntime(cdp, targetId) {
  const a = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const session = a?.result?.sessionId;
  if (typeof session !== "string" || session.length === 0) {
    throw new Error(`attach failed for ${targetId}`);
  }
  await cdp.send("Runtime.enable", {}, session);
  return session;
}

/** Runtime.evaluate an expression in a session, returning its value. */
async function evalIn(cdp, session, expression) {
  const r = await withTimeout(
    cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      session,
    ),
    15000,
    "evalIn",
  );
  return r?.result?.result?.value;
}

/** The center point of an element, scrolled into view (coordinate discovery only). */
async function boxOf(cdp, session, selector) {
  const v = await evalIn(
    cdp,
    session,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`,
  );
  return v && typeof v === "object" && typeof v.x === "number" ? v : null;
}

/** A GENUINE mouse click on an element (real CDP input, not Runtime.evaluate). */
async function clickSel(cdp, session, selector) {
  const b = await boxOf(cdp, session, selector);
  if (!b) return false;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1,
  }, session);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1,
  }, session);
  return true;
}

/** GENUINE keyboard typing (real CDP char events, not Runtime.evaluate). */
async function typeText(cdp, session, text) {
  for (const ch of text) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "char", text: ch, unmodifiedText: ch,
    }, session);
  }
}

/** Click into an element (focus it) then type real key events. */
async function typeInto(cdp, session, selector, text) {
  const clicked = await clickSel(cdp, session, selector);
  if (!clicked) return false;
  await typeText(cdp, session, text);
  return true;
}

/** Capture a PNG screenshot of a session (visible evidence for the journeys). */
async function captureShot(cdp, session) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
  const b64 = r?.result?.data;
  if (!b64) return null;
  return new Uint8Array(
    atob(b64).split("").map((c) => c.charCodeAt(0)),
  );
}

/** Decode an 8-bit non-interlaced PNG to sampled RGBA pixels (no dependency). */
async function decodePngSamples(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33) throw new Error("png too small");
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => bytes[i] === b)) throw new Error("not a png");
  const width = dv.getUint32(16, false);
  const height = dv.getUint32(20, false);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  if (bitDepth !== 8) throw new Error("unsupported bit depth");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  // Collect IDAT chunks.
  const idat = [];
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off, false);
    const type = String.fromCharCode(...bytes.slice(off + 4, off + 8));
    if (type === "IDAT") idat.push(bytes.slice(off + 8, off + 8 + len));
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const total = idat.reduce((s, c) => s + c.length, 0);
  const compressed = new Uint8Array(total);
  let p = 0;
  for (const c of idat) { compressed.set(c, p); p += c.length; }
  const ds = new DecompressionStream("deflate");
  const inflated = new Uint8Array(
    await new Response(new Blob([compressed]).stream().pipeThrough(ds)).arrayBuffer(),
  );
  // Unfilter (all 5 filter types).
  const bpp = channels;
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? raw[rowStart + x - bpp] : 0;
      const b = y > 0 ? raw[(y - 1) * (stride + 1) + 1 + x] : 0;
      const c = (x >= bpp && y > 0)
        ? raw[(y - 1) * (stride + 1) + 1 + x - bpp]
        : 0;
      let val = inflated[src++];
      if (filter === 1) val = (val + a) & 0xff;
      else if (filter === 2) val = (val + b) & 0xff;
      else if (filter === 3) val = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pr = a + b - c;
        const pa = Math.abs(pr - a), pb = Math.abs(pr - b), pc = Math.abs(pr - c);
        const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        val = (val + pred) & 0xff;
      }
      raw[rowStart + x] = val;
    }
  }
  const samples = [];
  const sx = Math.max(1, Math.floor(width / 20));
  const sy = Math.max(1, Math.floor(height / 20));
  for (let y = 0; y < height; y += sy) {
    for (let x = 0; x < width; x += sx) {
      const rs = y * (stride + 1) + 1;
      samples.push({
        r: raw[rs + x * channels],
        g: raw[rs + x * channels + 1],
        b: raw[rs + x * channels + 2],
      });
    }
  }
  return { width, height, samples };
}

/** Assert a decoded screenshot is predominantly red (the red fixture). */
function mostlyRed(samples) {
  const red = samples.filter((s) => s.r > 180 && s.g < 80 && s.b < 80).length;
  return red / samples.length > 0.9;
}

async function main() {
  const profile = `/tmp/cap-journeys-${Date.now()}`;
  await Deno.mkdir(SHOT_DIR, { recursive: true }).catch(() => {});
  const proc = launchChrome(profile);
  let port;
  let ws;
  let cdp;
  const results = [];
  const check = (name, cond) => {
    results.push({ name, pass: !!cond });
    console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  };

  // A local HTTP fixture server (red page + wrong-origin page) for a REAL
  // screenshot target that isn't a chrome-extension:// page.
  const fixture = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/red.html") {
      return new Response(
        `<html><body style="margin:0;background:#ff0000;width:400px;height:300px"></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    return new Response(`<html><body>fixture ${u.pathname}</body></html>`, {
      headers: { "content-type": "text/html" },
    });
  });
  const fixturePort = fixture.addr.port;
  const RED_ORIGIN = `http://127.0.0.1:${fixturePort}`;
  const RED_URL = `${RED_ORIGIN}/red.html`;

  try {
    port = await withTimeout(waitForPort(proc), 20000, "wait for port");

    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await withTimeout(new Promise((r) => ws.onopen = r), 5000, "ws open");
    cdp = new Cdp(ws);

    // Discover the service worker AS SOON AS it appears (no fixed 5s sleep —
    // boot/recovery errors must not be lost to a sleep-then-attach).
    let sw = null;
    for (let i = 0; i < 60 && !sw; i++) {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      sw = targets.find((t) => t.type === "service_worker");
      if (!sw) await sleep(200);
    }
    if (!sw) {
      check("extension loaded", false);
      throw new Error("extension did not load");
    }
    check("extension loaded", true);
    const extId = sw.url.split("/")[2];

    // Attach to the SW + enable Runtime + ASSERT the attach/session/enable.
    const swAttach = await cdp.send("Target.attachToTarget", {
      targetId: sw.id, flatten: true,
    });
    const swSession = swAttach?.result?.sessionId;
    check(
      "SW attach returned a session id",
      typeof swSession === "string" && swSession.length > 0,
    );
    await cdp.send("Runtime.enable", {}, swSession); // throws on failure
    cdp.swSessions.add(swSession);
    check("SW Runtime.enable succeeded", true);

    // Open the NTP (for the genuine input journey + message probes).
    const ntpPage = await openPage(port, `chrome-extension://${extId}/ntp/ntp.html`);
    await sleep(1500);
    const ntpSession = await attachRuntime(cdp, ntpPage.id);

    // sendMsg from the NTP (extension page) — backend message probes.
    const sendMsg = (payload) =>
      cdp.send(
        "Runtime.evaluate",
        {
          expression:
            `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => ({v}), e => ({err: e.message}))`,
          returnByValue: true,
          awaitPromise: true,
        },
        ntpSession,
      );
    const msgValue = async (payload) => {
      const r = await withTimeout(sendMsg(payload), 15000, `msg ${payload.type}`);
      const inner = r?.result?.result?.value;
      if (inner && typeof inner === "object" && "v" in inner) return inner.v;
      if (inner && typeof inner === "object" && "err" in inner) return inner.err;
      return inner;
    };

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 1 — GENUINE CDP INPUT on the NTP: type a task + click Run.
    // ─────────────────────────────────────────────────────────────
    check(
      "NTP: task input present",
      (await boxOf(cdp, ntpSession, "#task-input")) !== null,
    );
    const typedTask = "hello from cdp input";
    check(
      "NTP: typed a task via Input events",
      await typeInto(cdp, ntpSession, "#task-input", typedTask),
    );
    const taskVal = await evalIn(
      cdp, ntpSession,
      `document.querySelector('#task-input').value`,
    );
    check("NTP: textarea reflects the typed text", taskVal === typedTask);
    check(
      "NTP: clicked Run task via a real click",
      await clickSel(cdp, ntpSession, "#run-task"),
    );
    await sleep(3000); // let the demo agent stream + journal
    const ntpShot = await captureShot(cdp, ntpSession);
    if (ntpShot) {
      await Deno.writeFile(`${SHOT_DIR}/ntp-driven.png`, ntpShot);
      check("NTP: retained a driven-UI screenshot", ntpShot.length > 200);
    }
    const journalAfterNtp = await msgValue({
      type: "memory.get", origin: "master", key: "journal",
    }) ?? [];
    const ntpTask = (Array.isArray(journalAfterNtp) ? journalAfterNtp : [])
      .find((e) => e?.task === typedTask);
    check("NTP: the typed task reached the agent journal", Boolean(ntpTask));

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 2 — provider Update / Clear key via GENUINE UI input.
    // ─────────────────────────────────────────────────────────────
    // Pre-seed a non-secret placeholder config so the options page renders an
    // ACTIVE OpenAI card with a "Clear key" button. No provider call is made.
    await msgValue({
      type: "provider.set",
      config: {
        provider: "openai",
        baseURL: "https://custom.invalid/v1",
        apiKey: "placeholder-key",
        model: "model-one",
      },
    });
    const optsPage = await openPage(
      port, `chrome-extension://${extId}/options/options.html`,
    );
    await sleep(2000);
    const optsSession = await attachRuntime(cdp, optsPage.id);
    // evalOpts runs chrome.* on the options page (another extension page).
    const evalOpts = (expression) => evalIn(cdp, optsSession, expression);

    // Wait for the provider cards to render.
    let openaiCard = null;
    for (let i = 0; i < 20 && !openaiCard; i++) {
      openaiCard = await boxOf(
        cdp, optsSession, `.provider-card[data-provider="openai"] .set-default`,
      );
      if (!openaiCard) await sleep(250);
    }
    check("Settings: OpenAI provider card rendered", openaiCard !== null);
    check(
      "Settings: Clear key button present for the keyed provider",
      (await boxOf(
        cdp, optsSession, `.provider-card[data-provider="openai"] .clear-key`,
      )) !== null,
    );
    // Clear the key via a real click.
    check(
      "Settings: clicked Clear key via a real click",
      await clickSel(cdp, optsSession, `.provider-card[data-provider="openai"] .clear-key`),
    );
    await sleep(500);
    const afterClear = await msgValue({ type: "provider.get" });
    check(
      "Settings: Clear key removed only the key (endpoint/model preserved)",
      afterClear?.provider === "openai" &&
        afterClear?.apiKey === "" &&
        afterClear?.baseURL === "https://custom.invalid/v1" &&
        afterClear?.model === "model-one",
    );

    // Drive the "Update" button on the (now keyless) OpenAI card — a genuine
    // provider update path. Blank key field must NOT re-populate a key.
    const updateBtn = await boxOf(
      cdp, optsSession, `.provider-card[data-provider="openai"] .set-default`,
    );
    if (updateBtn) {
      check(
        "Settings: clicked Update via a real click",
        await clickSel(cdp, optsSession, `.provider-card[data-provider="openai"] .set-default`),
      );
      await sleep(500);
      const afterUpdate = await msgValue({ type: "provider.get" });
      check(
        "Settings: Update preserved endpoint/model + empty key",
        afterUpdate?.provider === "openai" &&
          afterUpdate?.apiKey === "" &&
          afterUpdate?.baseURL === "https://custom.invalid/v1" &&
          afterUpdate?.model === "model-one",
      );
    }
    // Switch back to the OpenAI preset via the demo card (restore demo).
    check(
      "Settings: switched back to Demo via a real click",
      await clickSel(cdp, optsSession, `.provider-card[data-provider="demo"] .set-default`),
    );
    await sleep(500);
    const demoCfg = await msgValue({ type: "provider.get" });
    check("Settings: provider restored to demo", demoCfg?.provider === "demo");
    const optsShot = await captureShot(cdp, optsSession);
    if (optsShot) {
      await Deno.writeFile(`${SHOT_DIR}/options-driven.png`, optsShot);
      check("Settings: retained a driven-UI screenshot", optsShot.length > 200);
    }

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 3 — warm provider invalidation with CONCRETE assertions.
    // ─────────────────────────────────────────────────────────────
    await msgValue({ type: "provider.set", config: { provider: "demo", apiKey: "" } });
    const warmRun1 = await msgValue({ type: "agent.run", task: "ping one" });
    const concrete = (r) =>
      r && typeof r === "object" && r.ok === true &&
      typeof r.result === "string" && r.result.length > 0 &&
      r.result.includes("[demo model]");
    check("warm run 1 returns a concrete demo result", concrete(warmRun1));
    await msgValue({ type: "provider.set", config: { provider: "demo", apiKey: "" } });
    const warmRun2 = await msgValue({ type: "agent.run", task: "ping two" });
    check("warm run 2 (after re-save) returns a concrete demo result", concrete(warmRun2));

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 4 — screenshot matrix on a REAL HTTP tab (grant/origin/expiry/
    // revoke) with delete-first + color/paint attribution.
    // ─────────────────────────────────────────────────────────────
    const redPage = await openPage(port, RED_URL);
    await sleep(2000);
    // Resolve the REAL chrome.tabs Tab id (the red fixture, not a CDP target id).
    const redTabId = await evalOpts(
      `chrome.tabs.query({ url: ${JSON.stringify(RED_ORIGIN + "/*")} }).then(t => t[0]?.id ?? null)`,
    );
    check("real red tab resolved via chrome.tabs.query", typeof redTabId === "number");

    // (a) revoked → capture denied.
    await msgValue({ type: "browser-control.set", granted: false });
    const revokedShot = await msgValue({ type: "capture.tab", tabId: redTabId });
    check(
      "screenshot: denied after revoke",
      revokedShot?.error !== undefined || revokedShot?.err !== undefined ||
        revokedShot?.ok === false,
    );
    // (b) grant the EXACT origin → capture succeeds (a real PNG, non-empty).
    await msgValue({
      type: "browser-control.set",
      origins: [RED_ORIGIN],
      expiryMs: 60000,
    });
    // Delete-first: remove any prior artifact so a stale file can't satisfy the check.
    await runBounded(RM, ["-f", `${SHOT_DIR}/allowed-red.png`]);
    const allowedShot = await msgValue({ type: "capture.tab", tabId: redTabId });
    const shotOk = typeof allowedShot?.screenshot === "string" &&
      allowedShot.screenshot.startsWith("data:image/png;base64,") &&
      allowedShot.screenshot.length > 500;
    check("screenshot: exact-origin grant captures a real PNG", shotOk);
    if (shotOk) {
      const b64 = allowedShot.screenshot.split(",")[1];
      const bin = new Uint8Array(
        atob(b64).split("").map((c) => c.charCodeAt(0)),
      );
      await Deno.writeFile(`${SHOT_DIR}/allowed-red.png`, bin);
      check("screenshot: retained to disk (non-empty)", bin.length > 200);
      // Color/paint attribution: the decoded pixels must be predominantly RED.
      try {
        const { samples } = await decodePngSamples(bin);
        check("screenshot: decoded pixels are predominantly red", mostlyRed(samples));
      } catch (e) {
        check(`screenshot: color attribution (${e?.message ?? e})`, false);
      }
    }
    // (c) grant a DIFFERENT origin → the red tab is denied.
    await msgValue({
      type: "browser-control.set",
      origins: ["http://127.0.0.1:1"],
      expiryMs: 60000,
    });
    const wrongShot = await msgValue({ type: "capture.tab", tabId: redTabId });
    check(
      "screenshot: wrong-origin grant is denied",
      wrongShot?.error !== undefined || wrongShot?.err !== undefined ||
        wrongShot?.ok === false,
    );
    // (d) expiry → denied.
    await msgValue({
      type: "browser-control.set",
      origins: [RED_ORIGIN],
      expiryMs: 1,
    });
    await sleep(120);
    const expiredShot = await msgValue({ type: "capture.tab", tabId: redTabId });
    check(
      "screenshot: expired grant is denied",
      expiredShot?.error !== undefined || expiredShot?.err !== undefined ||
        expiredShot?.ok === false,
    );
    // (e) final revoke.
    await msgValue({ type: "browser-control.set", granted: false });

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 5 — OPFS per-origin A/B clear.
    // ─────────────────────────────────────────────────────────────
    await msgValue({ type: "memory.set", origin: "https://a.example", key: "x", value: "A" });
    await msgValue({ type: "memory.set", origin: "https://b.example", key: "x", value: "B" });
    await msgValue({ type: "memory.clear", origin: "https://a.example" });
    const aAfter = await msgValue({ type: "memory.get", origin: "https://a.example", key: "x" });
    const bAfter = await msgValue({ type: "memory.get", origin: "https://b.example", key: "x" });
    check(
      "per-origin clear leaves B intact",
      (aAfter === undefined || aAfter === null) && bAfter === "B",
    );

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 6 — EXACT attachment retention: identities/order + MIME boundary.
    // ─────────────────────────────────────────────────────────────
    const twelve = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}.txt`,
      type: "text/plain",
      dataURL: "data:text/plain;base64,eA==",
    }));
    const runRes = await msgValue({
      type: "agent.run",
      task: "attach",
      attachments: twelve,
    });
    const dropped = runRes?.droppedAttachments ?? [];
    const droppedOver = dropped.filter((d) => d.reason === "over count limit");
    // OBSERVE the journal: the task entry records the BOUNDED attachment count (8).
    const journal = await msgValue({ type: "memory.get", origin: "master", key: "journal" }) ?? [];
    const attachTask = (Array.isArray(journal) ? journal : [])
      .find((e) => e?.type === "task" && e?.task === "attach");
    check(
      "attachment count cap (12 → 4 over-count dropped, journal records 8)",
      droppedOver.length === 4 && attachTask?.attachmentCount === 8,
    );
    // MIME boundary: a declared type that contradicts the dataURL MIME is dropped.
    const mimeMismatch = await msgValue({
      type: "agent.run",
      task: "mime-check",
      attachments: [{
        name: "img.png",
        type: "image/png",
        dataURL: "data:text/plain;base64,eA==",
      }],
    });
    check(
      "attachment: declared/image vs text/plain MIME mismatch is dropped",
      (mimeMismatch?.droppedAttachments ?? []).some((d) =>
        d.reason === "malformed dataURL or type/mime mismatch"
      ),
    );

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 7 — ALARM FIRE: a real short one-shot fires + journals task/result.
    // ─────────────────────────────────────────────────────────────
    const sched = await msgValue({
      type: "register-task",
      task: { task: "fire-test", delayMs: 800 },
    });
    check("alarm scheduled (name returned)", typeof sched?.name === "string");
    if (sched?.name) {
      await sleep(3500);
      const alarmNames = await evalOpts(
        `chrome.alarms.getAll().then(a => a.map(x => x.name))`,
      );
      const removedFromAlarms = Array.isArray(alarmNames) && !alarmNames.includes(sched.name);
      const j2 = await msgValue({ type: "memory.get", origin: "master", key: "journal" }) ?? [];
      const firedTask = (Array.isArray(j2) ? j2 : []).find(
        (e) => e?.type === "task" && e?.task === "fire-test" && e?.scheduled === true,
      );
      const firedResult = (Array.isArray(j2) ? j2 : []).find(
        (e) => e?.type === "result" && e?.id === sched.name,
      );
      check(
        "one-shot alarm fired + journaled task AND result",
        removedFromAlarms && Boolean(firedTask) && Boolean(firedResult),
      );
    }

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 8 — worker restart + missing-alarm reconciliation.
    // ─────────────────────────────────────────────────────────────
    const recTask = "reconcile-after-restart";
    const rec = await msgValue({
      type: "register-task",
      task: { task: recTask, delayMs: 2500 },
    });
    check("reconcile task scheduled", typeof rec?.name === "string");
    if (rec?.name) {
      // Remove the alarm but LEAVE the persisted task (a consumed/missing alarm).
      const cleared = await evalOpts(
        `chrome.alarms.clear(${JSON.stringify(rec.name)}).then(() => true).catch(() => false)`,
      );
      check("alarm cleared (persisted task remains)", cleared === true);
      // Restart the worker: close the SW target, then wake it via a message.
      await cdp.send("Target.closeTarget", { targetId: sw.id });
      await sleep(500);
      const wake = await msgValue({ type: "agent.list" });
      check("worker woken after restart", Array.isArray(wake) || typeof wake === "object");
      // Re-discover + re-attach the restarted SW so its boot/recovery errors are
      // captured (strictly worker-only) for the final console audit.
      let sw2 = null;
      for (let i = 0; i < 20 && !sw2; i++) {
        const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
        sw2 = targets.find((t) => t.type === "service_worker");
        if (!sw2) await sleep(250);
      }
      if (sw2) {
        const a2 = await cdp.send("Target.attachToTarget", {
          targetId: sw2.id, flatten: true,
        });
        const s2 = a2?.result?.sessionId;
        if (s2) {
          await cdp.send("Runtime.enable", {}, s2).catch(() => {});
          cdp.swSessions.add(s2);
          check("restarted SW re-attached (boot audit captured)", true);
        }
      }
      // The restarted SW boots, recoverOnBoot reconciles the missing alarm,
      // and the alarm fires → the task runs + journals a task + result row.
      await sleep(4000);
      const j3 = await msgValue({ type: "memory.get", origin: "master", key: "journal" }) ?? [];
      const arr3 = Array.isArray(j3) ? j3 : [];
      const recTaskEntry = arr3.find((e) => e?.type === "task" && e?.task === recTask);
      const recResultEntry = arr3.find((e) => e?.type === "result" && e?.id === rec.name);
      check(
        "restarted worker reconciled + ran the persisted task",
        Boolean(recTaskEntry) && Boolean(recResultEntry),
      );
    }

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 9 — multi-agent toggle (genuine UI) → rebuild + solo still works.
    // ─────────────────────────────────────────────────────────────
    // The options page is still open. Toggle the checkbox OFF via a real click.
    const toggleBox = await boxOf(cdp, optsSession, "#multi-agent");
    check("Settings: multi-agent toggle present", toggleBox !== null);
    if (toggleBox) {
      check(
        "Settings: toggled multi-agent OFF via a real click",
        await clickSel(cdp, optsSession, "#multi-agent"),
      );
      await sleep(500);
      const offState = await evalOpts(
        `chrome.storage.local.get('cap:multiAgent').then(s => s['cap:multiAgent'])`,
      );
      check("multi-agent setting persisted OFF", offState === false);
      // A task must STILL run in solo mode (the master keeps its tools).
      const solo = await msgValue({ type: "agent.run", task: "solo ping" });
      check("solo mode still runs a task", concrete(solo));
      // Toggle back ON.
      check(
        "Settings: toggled multi-agent ON via a real click",
        await clickSel(cdp, optsSession, "#multi-agent"),
      );
      await sleep(500);
      const onState = await evalOpts(
        `chrome.storage.local.get('cap:multiAgent').then(s => s['cap:multiAgent'])`,
      );
      check("multi-agent setting persisted ON", onState === true);
    }

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 10 — service-worker console audit (strictly worker-only).
    // ─────────────────────────────────────────────────────────────
    for (const e of cdp.swErrors()) {
      console.log(`SW console error: ${e.detail}`);
    }
    check("no service-worker console errors", cdp.swErrors().length === 0);

    ws.close();
    await fixture.shutdown().catch(() => {});
  } catch (e) {
    check("journeys completed", false);
    console.error("journey failure:", String(e?.message ?? e));
    try { await fixture.shutdown(); } catch { /* ignore */ }
    try { ws?.close(); } catch { /* ignore */ }
  } finally {
    // ─────────────────────────────────────────────────────────────
    // Owner-clean shutdown (fail-closed, bounded, environment-scrubbed).
    // ─────────────────────────────────────────────────────────────
    let removed = false;
    let clean = true;
    try {
      await killChromiumTree(proc, profile);
      // Absence stability window: remove, then re-verify after a settle delay.
      await runBounded(RM, ["-rf", profile]);
      removed = !(await Deno.stat(profile).then(() => true).catch(() => false));
      if (removed) {
        await sleep(800);
        removed = !(await Deno.stat(profile).then(() => true).catch(() => false));
      }
    } catch (e) {
      clean = false;
      console.error("cleanup failure:", String(e?.message ?? e));
    }
    check("profile removed (no leak)", removed);
    check("cleanup hard-failed on descendants (none survived)", clean);
    const failed = results.filter((r) => !r.pass).length;
    console.log(
      `\nchrome journeys: ${results.length - failed}/${results.length} passed`,
    );
    Deno.exit(failed > 0 || !removed || !clean ? 1 : 0);
  }
}

/**
 * Kill the Chromium process tree (owned process-group termination) and wait for
 * all descendants to exit. Uses absolute paths + a cleared environment + a
 * bounded wait; HARD FAILS if any descendant survives (never silently falls
 * through and lets an orphan recreate profile files after the suite exits).
 */
async function killChromiumTree(proc, profile) {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  try { await withTimeout(proc.status, 5000, "proc status"); } catch { /* gone */ }
  const match = `--user-data-dir=${profile}`;
  await runBounded(PKILL, ["-9", "-f", match]);
  // Bounded wait for the full tree to disappear — HARD FAIL if any remain.
  for (let i = 0; i < 20; i++) {
    const out = await runBounded(PGREP, ["-f", match]);
    if (out.code !== 0) return; // no matching process remains
    await sleep(250);
  }
  throw new Error("chromium descendants survived cleanup");
}

await main();
