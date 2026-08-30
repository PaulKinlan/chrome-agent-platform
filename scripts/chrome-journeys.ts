// chrome-journeys.ts — retained Chrome regression journeys for the security /
// runtime boundaries. Loads the built extension in headless Chrome and drives
// REAL behaviour, including GENUINE CDP user input (Input.dispatchMouseEvent /
// Input.dispatchKeyEvent on the NTP + Settings surfaces), a real HTTP-tab
// screenshot matrix (grant/scope/revoke via genuine UI + secondary message
// probes), a worker-restart + missing-alarm reconciliation, and a multi-agent
// fan-out boundary (create→list→delegate→delete). Fail-closed, environment-
// scrubbed, bounded, owner-clean. The assertion set is FIXED (no dynamic count).

//   deno run -A scripts/chrome-journeys.ts            # temporary evidence (default)
//   deno run -A scripts/chrome-journeys.ts --retain   # opt-in: retain to test-artifacts/

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
// Evidence is TEMPORARY by default; `--retain` is the explicit opt-in to write
// the tracked test-artifacts/ directory.
const RETAIN = Deno.args.includes("--retain");
const EVIDENCE_DIR = RETAIN
  ? `${ROOT}test-artifacts`
  : `/tmp/cap-evidence-${Date.now()}`;
const RUN_ID = `cap-${Date.now()}`;

const CHROMIUM = "/usr/bin/chromium";
const PKILL = "/usr/bin/pkill";
const PGREP = "/usr/bin/pgrep";
const RM = "/bin/rm";
const GIT = "/usr/bin/git";

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

/** Run a child command with a CLEARED environment + absolute path + deadline.
 * The child is spawned into an OWNED process slot and KILLED on deadline (a
 * timed-out `rm`/`pkill`/`pgrep` must not keep running past its bound). */
async function runBounded(cmd, args, timeoutMs = 8000) {
  const proc = new Deno.Command(cmd, {
    args,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  });
  const child = proc.spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, timeoutMs);
  try {
    const out = await child.output();
    if (timedOut) throw new Error(`run ${cmd} timed out (killed)`);
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function launchChrome(profile: string) {
  return new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--silent-debugger-extension-api",
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

// A minimal CDP session over the browser WebSocket. Protocol errors REJECT
// (never resolve as success). Console/exception events are recorded WITH their
// sessionId so the "no SW errors" assertion is strictly worker-only. New SW
// targets are auto-attached (waitForDebuggerOnStart) via the onAttach hook.
class Cdp {
  ws;
  id = 0;
  pending = new Map();
  consoleErrors = [];
  swSessions = new Set();
  swTargetSessions = new Map(); // targetId → pre-attached sessionId
  pageSessions = new Set();
  swAttachErrors = [];
  executionContextEvents = []; // { sessionId, kind: "created"|"cleared", ts }
  fatalEvents = []; // malformed protocol, target crash, unexpected socket close
  intentionalClose = false;
  onAttach = null; // (sessionId, targetInfo, waitingForDebugger) => void
  constructor(ws) {
    this.ws = ws;
    ws.onerror = () => this.fatalEvents.push("websocket error");
    ws.onclose = () => {
      if (!this.intentionalClose) {
        this.fatalEvents.push("websocket closed unexpectedly");
      }
    };
    ws.onmessage = (e) => {
      let d;
      try {
        d = JSON.parse(e.data);
      } catch (err) {
        this.fatalEvents.push(`malformed CDP message: ${String(err?.message ?? err)}`);
        return;
      }
      if (d.id && this.pending.has(d.id)) {
        const { resolve, reject, timer } = this.pending.get(d.id);
        clearTimeout(timer);
        this.pending.delete(d.id);
        if (d.error) {
          reject(
            new Error(
              `cdp error ${d.id} (${d.error.code}): ${d.error.message}`,
            ),
          );
        } else {
          resolve(d);
        }
      }
      if (d.method === "Inspector.targetCrashed") {
        // The SW target is INTENTIONALLY closed for the pre-attached restart
        // (Target.closeTarget), which emits targetCrashed — that is expected,
        // not fatal. A crash on any OTHER target (a page) is a real failure.
        if (!this.swSessions.has(d.sessionId)) {
          this.fatalEvents.push(
            `Inspector.targetCrashed (session ${d.sessionId})`,
          );
        }
      }
      if (d.method === "Target.attachedToTarget") {
        this.onAttach?.(
          d.params?.sessionId,
          d.params?.targetInfo,
          d.params?.waitingForDebugger,
        );
      }
      if (d.method === "Runtime.executionContextsCleared") {
        this.executionContextEvents.push({
          sessionId: d.sessionId, kind: "cleared", ts: Date.now(),
        });
      }
      if (d.method === "Runtime.executionContextCreated") {
        this.executionContextEvents.push({
          sessionId: d.sessionId, kind: "created",
          id: d.params?.context?.id, ts: Date.now(),
          // Retained so a test can address a SPECIFIC frame's realm (the NTP's
          // embedded Settings iframe). Calling another frame's chrome.runtime
          // from the parent's realm does NOT adopt that frame's principal —
          // Chrome resolves the sender from the CALLING context — so proving
          // "the embedded Settings surface is an owner principal" requires
          // evaluating inside its own execution context.
          name: d.params?.context?.name,
          origin: d.params?.context?.origin,
          isDefault: d.params?.context?.auxData?.isDefault === true,
          frameId: d.params?.context?.auxData?.frameId,
        });
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
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  swErrors() {
    return this.consoleErrors.filter((e) => this.swSessions.has(e.sessionId));
  }
  pageErrors() {
    // Console errors from the extension PAGE surfaces (NTP / Settings) — the
    // surfaces whose runtime exceptions must also fail the gate, not just the SW.
    return this.consoleErrors.filter((e) => this.pageSessions.has(e.sessionId));
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

/** Press Tab (a genuine key) to blur the focused field → fires its change. */
async function pressTab(cdp, session) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  }, session);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  }, session);
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

// ---- fixed assertion set (every expected check is unconditional + named) ----
const results = [];
const ran = new Set();
function check(name, cond) {
  if (ran.has(name)) throw new Error(`duplicate assertion: ${name}`);
  ran.add(name);
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
}

/** The exact, ordered set of assertions this suite must run. */
const EXPECTED = [
  "SW auto-attach configured (waitForDebuggerOnStart)",
  "extension loaded",
  "extension loaded",
  "SW attach returned a session id",
  "SW Runtime.enable succeeded",
  "manifest: boot-critical permissions mandatory, capabilities optional, <all_urls> host",
  "manifest: debugger absent everywhere",
  "initial SW closed for a pre-attached restart",
  "SW woken for the pre-attached restart",
  "initial SW boot observed via pre-attached restart",
  "NTP: task input present",
  "NTP: typed a task via Input events",
  "NTP: textarea reflects the typed text",
  "NTP: clicked Run task via a real click",
  "NTP: retained a driven-UI screenshot",
  "NTP: the typed task reached the agent journal",
  "Settings: Permissions panel present",
  "approval: forged NTP owner/activation fields are refused",
  "permissions: optional capabilities start ungranted (JIT) and the mandatory boot set is granted",
  "permissions: Settings panel renders three-state rows + mandatory boot rows",
  "permissions: optional capabilities start ungranted (JIT model)",
  "permissions: Bookmarks Enable button found in the Settings panel",
  "permissions: Bookmarks Enable clicked",
  "permissions: Bookmarks Enable clicked but denied in headless (the grant requires a headed run)",
  "permissions: tab groups Enable clicked but still denied (honest headless denial)",
  "permissions: capability.revoke still requires owner approval (fail closed)",
  "Settings: OpenAI provider card rendered",
  "Settings: Clear key button present for the keyed provider",
  "Settings: clicked Clear key via a real click",
  "Settings: Clear key removed only the key (endpoint/model preserved)",
  "Settings: clicked Update via a real click",
  "Settings: Update preserved endpoint/model + empty key",
  "Settings: demo + prompt-api absent from the provider picker",
  "Settings: provider restored to demo",
  "Settings: demo still resolvable via the SW (testing only)",
  "Settings: Enroll input present",
  "Settings: typed a loopback origin into the Enroll field",
  "Settings: clicked Enroll via a real click",
  "enrollment: origin enrolled under JIT grant",
  "Settings: retained a driven-UI screenshot",
  "warm run 1 returns a concrete demo result",
  "warm run 2 (after re-save) returns a concrete demo result",
  "real red tab resolved (active tab id)",
  "screenshot: denied after revoke (secondary probe)",
  "screenshot: capture SUCCEEDS for the granted origin",
  "screenshot: wrong-origin grant is denied (secondary probe)",
  "screenshot: expired grant is denied (secondary probe)",
  "Settings: browser-grant checkbox present",
  "screenshot: clicked the browser-grant checkbox",
  "screenshot: granted browser control via a real checkbox click",
  "screenshot: typed the red origin into the allowed-origins field",
  "screenshot: grant scoped to the red origin via the UI",
  "screenshot: UI-granted capture SUCCEEDS for the scoped origin",
  "screenshot: revoked via a real checkbox click",
  "screenshot: revoked → capture denied",
  "per-origin clear leaves B intact",
  "memory: version tokens are monotonic + never reused (round-27 CAS)",
  "attachment count cap (12 → 4 over-count dropped, journal records 8)",
  "attachment: declared/image vs text/plain MIME mismatch is dropped",
  "alarm scheduled (name returned)",
  "one-shot alarm fired + journaled task AND result",
  "reconcile task scheduled",
  "alarm cleared (persisted task remains)",
  "persisted task payload survives the clear",
  "old worker target closed (closeTarget success)",
  "worker woken after restart",
  "worker restarted (execution context recreated)",
  "recreated alarm observed before fire",
  "restarted worker reconciled + ran the persisted task",
  "cancel: task registered",
  "cancel: task listed for the owner",
  "cancel: cancelled the task (alarm absent)",
  "cancel: task gone after cancel",
  "agent.create returns ok",
  "agent.create created a discoverable worker (list includes it)",
  "orchestrator: multi-agent ON + delegation tools present",
  "orchestrator: worker fanned out (workerCount >= 1)",
  "worker delegated task ran (worker result journaled)",
  "Settings: multi-agent toggle present",
  "Settings: clicked the multi-agent toggle OFF",
  "Settings: multi-agent setting persisted OFF",
  "orchestrator: solo mode drops delegation tools",
  "orchestrator: generation advanced after rebuild",
  "solo mode still runs a task",
  "Settings: clicked the multi-agent toggle ON",
  "Settings: multi-agent setting persisted ON",
  "orchestrator: delegation tools restored",
  "agent.delete removed the worker from the list",
  "delete-race: upsert on a deleted origin is rejected",
  "delete-race: listOrigins excludes the deleted origin after racing upsert",
  "Settings: Disenroll button present for an enrolled agent",
  "Settings: clicked Disenroll via a real click",
  "disenroll: an owner click needs no second approval (owner-direct action)",
  "disenroll: agent removed from list + enrollment tombstoned",
  "scripting Disable: two origins enrolled before the revoke",
  "scripting Disable: refused because scripting is install-granted",
  "scripting Disable: a refused revoke tombstones NOTHING",
  "mgmt: orchestrator exposes the management tool suite",
  "mgmt: create_agent returned ok",
  "mgmt: agent.directory lists it with enrollment state",
  "mgmt: get_agent inspects it (tools + memory keys)",
  "mgmt: update_agent changed the name",
  "mgmt: create_asset succeeded (hub asset)",
  "mgmt: list_assets lists the asset (no content)",
  "mgmt: get_asset round-trips content",
  "approval: primary NTP Settings iframe can deny an exact request",
  "approval: deny row is singular and capability material absent from the payload",
  "approval: NTP cannot programmatically resolve an owner approval",
  "approval: deny leaves the exact asset unchanged",
  "approval: install-scoped opaque reference survives a worker restart",
  "approval: post-restart deny leaves the exact asset unchanged",
  "mgmt: update_asset patched the asset",
  "mgmt: delete_asset removed it",
  "mgmt: asset gone after delete",
  "mgmt: delete_agent removed the agent",
  "mgmt: agent gone from the directory after delete",
  "no service-worker console errors",
  "no SW Runtime.enable errors (auto-attach)",
  "no NTP/Settings console errors",
  "no fatal CDP lifecycle events",
  "profile removed (no leak)",
  "cleanup hard-failed on descendants (none survived)",
  "no leftover temporary evidence dir",
  "assertion order matches EXPECTED",
];

const evidenceFiles = [];
async function writeEvidence(name, bytes) {
  // Bounded (a hung fs write must not stall the gate indefinitely) + cancellable:
  // the body checks a cancellation flag so that after the deadline it stops
  // early rather than continuing to mutate the evidence dir.
  let cancelled = false;
  const body = (async () => {
    await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
    if (cancelled) throw new Error(`cancelled evidence write: ${name}`);
    const path = `${EVIDENCE_DIR}/${name}`;
    await Deno.remove(path).catch(() => {}); // delete-first (never overwrite stale)
    if (cancelled) throw new Error(`cancelled evidence write: ${name}`);
    await Deno.writeFile(path, bytes);
    if (cancelled) throw new Error(`cancelled evidence write: ${name}`);
    const entry = {
      name,
      sha256: await sha256Hex(bytes),
      bytes: bytes.length,
    };
    evidenceFiles.push(entry);
  })();
  try {
    await withTimeout(body, 10000, `writeEvidence ${name}`);
  } catch (e) {
    cancelled = true;
    throw e;
  }
  return `${EVIDENCE_DIR}/${name}`;
}

async function main() {
  const profile = `/home/paulkinlan/.cache/cap-review/j2-${Date.now()}`;
  await Deno.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const proc = launchChrome(profile);
  let port;
  let ws;
  let cdp;

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
  let fixtureShutdownFailed = false;

  try {
    port = await withTimeout(waitForPort(proc), 20000, "wait for port");

    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await withTimeout(new Promise((r) => ws.onopen = r), 5000, "ws open");
    cdp = new Cdp(ws);

    // Auto-attach to NEW service-worker targets BEFORE they execute (pre-boot
    // audit). waitForDebuggerOnStart pauses a new worker until we enable Runtime
    // + resume it, so module-eval/recoverOnBoot errors are genuinely observed.
    let attachSettled = Promise.resolve();
    cdp.onAttach = (sessionId, targetInfo, waitingForDebugger) => {
      if (targetInfo?.type !== "service_worker") return;
      cdp.swSessions.add(sessionId);
      if (typeof targetInfo?.targetId === "string") {
        cdp.swTargetSessions.set(targetInfo.targetId, sessionId);
      }
      attachSettled = (async () => {
        try {
          await cdp.send("Runtime.enable", {}, sessionId);
        } catch (e) {
          cdp.swAttachErrors.push(String(e?.message ?? e));
        }
        if (waitingForDebugger) {
          await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId)
            .catch((e) =>
              cdp.swAttachErrors.push(
                "runIfWaitingForDebugger: " + String(e?.message ?? e),
              )
            );
        }
      })();
    };
    const autoAttachRes = await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "service_worker" }],
    });
    check(
      "SW auto-attach configured (waitForDebuggerOnStart)",
      autoAttachRes?.result === undefined || autoAttachRes?.result,
    );

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

    // Reuse the pre-attached SW session when auto-attach already won the race.
    // Explicitly attaching the same worker twice is flaky and can hang CDP.
    await attachSettled;
    let swSession = cdp.swTargetSessions.get(sw.id) ?? null;
    if (!swSession) {
      const swAttach = await cdp.send("Target.attachToTarget", {
        targetId: sw.id, flatten: true,
      });
      swSession = swAttach?.result?.sessionId ?? null;
    }
    check(
      "SW attach returned a session id",
      typeof swSession === "string" && swSession.length > 0,
    );
    await cdp.send("Runtime.enable", {}, swSession); // throws on failure
    cdp.swSessions.add(swSession);
    check("SW Runtime.enable succeeded", true);

    // Manifest attestation: ALL permissions must be OPTIONAL (Paul's hard
    // requirement) — the base permissions array is empty and the six API
    // permissions are optional. `debugger` must be absent everywhere: it was
    // re-declared by the T12 power tools at 0.2.286 and REMOVED again on
    // 2026-08-27 (owner decision Q17) because it carries Chrome's all-sites
    // permission warning and a persistent "started debugging this browser"
    // bar. tests/chrome-tools-t12.test.ts carries the matching source guard.
    const manifestText = await Deno.readTextFile(`${EXT}/manifest.json`);
    const manifest = JSON.parse(manifestText);
    // OPTIONAL + JIT model (owner directive 2026-08-29, superseding the
    // 2026-08-28 install-grant model): four boot-critical permissions stay
    // mandatory; every capability permission is optional (JIT from a page
    // gesture); host access stays <all_urls>. Enterprise policy no longer
    // refuses the install over capability permissions.
    const MANDATORY = ["alarms", "offscreen", "sidePanel", "storage"];
    const DRIVEN_OPTIONAL = ["tabs", "activeTab", "scripting", "notifications"];
    check(
      "manifest: boot-critical permissions mandatory, capabilities optional, <all_urls> host",
      Array.isArray(manifest.permissions) &&
        MANDATORY.every((p) => manifest.permissions.includes(p)) &&
        DRIVEN_OPTIONAL.every((p) => (manifest.optional_permissions ?? []).includes(p)) &&
        manifest.permissions.every((p) => !((manifest.optional_permissions ?? []).includes(p))) &&
        Array.isArray(manifest.host_permissions) &&
        manifest.host_permissions.includes("<all_urls>"),
    );
    check(
      "manifest: debugger absent everywhere",
      !JSON.stringify(manifest).includes("debugger"),
    );

    // Open the NTP (for the genuine input journey + message probes).
    const ntpPage = await openPage(port, `chrome-extension://${extId}/ntp/ntp.html`);
    await sleep(1500);
    const ntpSession = await attachRuntime(cdp, ntpPage.id);
    cdp.pageSessions.add(ntpSession);

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
    // The provider CREDENTIAL routes (set/clear-key/test) are restricted to the
    // Settings sender — harness calls that represent owner Settings actions go
    // through the OPTIONS page session (msgOpts), never the NTP.
    const msgOpts = async (payload) => {
      const r = await withTimeout(
        cdp.send(
          "Runtime.evaluate",
          {
            expression:
              `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => ({v}), e => ({err: e.message}))`,
            returnByValue: true,
            awaitPromise: true,
          },
          optsSession,
        ),
        15000,
        `msgOpts ${payload.type}`,
      );
      const inner = r?.result?.result?.value;
      if (inner && typeof inner === "object" && "v" in inner) return inner.v;
      if (inner && typeof inner === "object" && "err" in inner) return inner.err;
      return inner;
    };

    const msgValue = async (payload) => {
      const r = await withTimeout(sendMsg(payload), 15000, `msg ${payload.type}`);
      const inner = r?.result?.result?.value;
      if (inner && typeof inner === "object" && "v" in inner) return inner.v;
      if (inner && typeof inner === "object" && "err" in inner) return inner.err;
      return inner;
    };

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 0 — MANDATORY pre-attached restart. The INITIAL SW boot happened
    // before the CDP connection (its module-eval/recoverOnBoot errors are
    // unobservable). Close it and re-wake it so the boot runs under auto-attach
    // + waitForDebuggerOnStart — genuinely pre-attached, so the console audit
    // (JOURNEY 10) observes the boot that matters.
    // ─────────────────────────────────────────────────────────────
    const restart0 = Date.now();
    const close0 = await cdp.send("Target.closeTarget", { targetId: sw.id });
    check(
      "initial SW closed for a pre-attached restart",
      close0?.result?.success === true,
    );
    const wake0 = await msgValue({ type: "agent.list" });
    check("SW woken for the pre-attached restart", Array.isArray(wake0));
    let bootObserved = false;
    for (let i = 0; i < 40 && !bootObserved; i++) {
      await attachSettled.catch(() => {});
      bootObserved = cdp.executionContextEvents.some((ev) =>
        ev.ts >= restart0 && ev.kind === "created" &&
        cdp.swSessions.has(ev.sessionId)
      );
      if (!bootObserved) await sleep(250);
    }
    check("initial SW boot observed via pre-attached restart", bootObserved);

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
    await sleep(7000); // let the demo agent stream + journal
    const ntpShot = await captureShot(cdp, ntpSession);
    if (ntpShot) {
      await writeEvidence("ntp-driven.png", ntpShot);
    }
    check("NTP: retained a driven-UI screenshot", ntpShot !== null && ntpShot.length > 200);
    const journalAfterNtp = await msgValue({
      type: "memory.get", origin: "master", key: "journal",
    }) ?? [];
    const ntpTask = (Array.isArray(journalAfterNtp) ? journalAfterNtp : [])
      .find((e) => e?.task === typedTask);
    check("NTP: the typed task reached the agent journal", Boolean(ntpTask));

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 2 — capability onboarding + provider Update/Clear key.
    // ─────────────────────────────────────────────────────────────
    const optsPage = await openPage(
      port, `chrome-extension://${extId}/options/options.html`,
    );
    await sleep(2000);
    let optsSession = await attachRuntime(cdp, optsPage.id);
    cdp.pageSessions.add(optsSession);
    let evalOpts = (expression) => evalIn(cdp, optsSession, expression);

    // Destructive AGENT-INITIATED routes pause behind an owner approval.
    //
    // REPOINTED 2026-08-27 (CAP-FB-20260827-MAIN-GATES-RED-02). This used to
    // click a row in Settings -> Approvals. That section was deliberately
    // deleted at 0.2.313: approvals are in-context now, and a settings list the
    // owner had to go hunting for was the thing being fixed. The old code kept
    // clicking `.nav-item[data-section="approvals"]`, threw when no row
    // appeared, and took the remaining 100 checks of this suite with it.
    //
    // What is asserted is unchanged in substance: `management.resolve-approval`
    // is gated on `context.principal === "owner-options"`, so resolving still
    // requires the Settings surface and nothing else. These calls go through
    // `msgOpts` (the OPTIONS page session) and therefore exercise the exact
    // same principal check the product's own in-context helper
    // (`lib/owner-approved-mutation.js`) relies on: snapshot the queue, claim
    // ONLY the row this operation created, resolve it, retry once.
    //
    // The genuine-pointer coverage that the row click used to provide has not
    // been dropped — it moved to where the product actually renders a
    // confirmation: `confirmOwnerDialog` below drives the real native <dialog>
    // with a real CDP click. And "the NTP cannot resolve an approval" is still
    // asserted separately, against the forged-owner-fields probe.
    const resolveNextApproval = async (approve = true) => {
      let pending = null;
      for (let i = 0; i < 30 && !pending; i++) {
        const rows = await msgOpts({ type: "management.pending-approvals" });
        if (rows?.ok === true && Array.isArray(rows.approvals) && rows.approvals.length > 0) {
          pending = rows.approvals[0];
          break;
        }
        await sleep(200);
      }
      if (!pending?.approvalId) throw new Error("no owner approval was pending on the exact Settings principal");
      const resolved = await msgOpts({
        type: "management.resolve-approval",
        approvalId: pending.approvalId,
        approve,
      });
      if (resolved?.ok !== true) throw new Error(`owner approval resolve failed: ${resolved?.error ?? "unknown"}`);
      await sleep(250);
    };

    // Drive the product's REAL in-context confirmation — the native <dialog>
    // from `confirmActionDialog` — with a genuine CDP click. `destructive`
    // dialogs focus Cancel by default, so the click (not a keypress) is what
    // decides. Returns false if no dialog appeared, so a caller can assert it.
    const confirmOwnerDialog = async (accept = true) => {
      const selector = accept ? ".cap-confirm-dialog .cap-confirm-accept" : ".cap-confirm-dialog .cap-confirm-cancel";
      let box = null;
      for (let i = 0; i < 25 && !box; i++) {
        box = await boxOf(cdp, optsSession, selector);
        if (!box) await sleep(200);
      }
      if (!box) return false;
      return await clickSel(cdp, optsSession, selector);
    };
    const approvedMsg = async (payload) => {
      const first = await msgValue(payload);
      if (first?.ok === true) return first;
      await resolveNextApproval(true);
      return await msgValue(payload);
    };
    // A Settings control whose route needs owner approval now completes in ONE
    // click: the handler calls runOwnerApprovedMutation, which raises the
    // native confirm dialog and — on a genuine accept click — resolves the
    // approval and retries the exact mutation itself. The old two-click,
    // resolve-in-between shape belonged to the deleted approvals list.
    const approvedSettingsClick = async (selector) => {
      if (!(await clickSel(cdp, optsSession, selector))) return false;
      return await confirmOwnerDialog(true);
    };

    // ─────────────────────────────────────────────────────────────
    // OPTIONAL-PERMISSION CAPABILITY GRANT — every permission is optional
    // (Paul's hard requirement). Drive the Settings → Permissions panel with
    // GENUINE clicks. SILENT permissions (storage / alarms / activeTab /
    // scripting / sidePanel — no warning) grant even in headless. WARNING
    // permissions (tabs / notifications) auto-DENY in headless — a headed
    // browser shows the prompt; the fail-closed denial is asserted here.
    // ─────────────────────────────────────────────────────────────
    check(
      "Settings: Permissions panel present",
      (await boxOf(cdp, optsSession, "#permission-list")) !== null,
    );
    const forgedOwner = await msgValue({
      type: "management.pending-approvals",
      __ownerUI: true,
      userActivation: true,
      __approvalRunId: "forged",
    });
    check(
      "approval: forged NTP owner/activation fields are refused",
      forgedOwner?.ok === false && !Array.isArray(forgedOwner?.approvals),
    );
    // The authoritative capability map from the worker, keyed by id. The DOM
    // scrape this replaced carried no ids, so it could not tell you WHICH
    // capability was granted — only how many rows looked green.
    const capState0 = await msgValue({ type: "capabilities.status" });
    // A hard-coded count here silently rots every time a tool tranche adds a
    // capability — which is exactly what happened between 0.2.278 and 0.2.290
    // (7 -> 18) and left this assertion red for days. But simply deriving the
    // count from CAPABILITIES is WORSE: Settings renders its rows straight from
    // that list, so both sides move together and the check can never fail. That
    // was verified by adding a phantom capability and watching the derived
    // version still pass.
    //
    // So assert the two things that are actually falsifiable:
    //   1. the extension boots with ZERO capabilities granted (the real
    //      invariant — every permission is optional), and
    //   2. every capability this suite goes on to DRIVE is present by id, which
    //      breaks if one is renamed or dropped out from under the journey.
    // OPTIONAL + JIT model: capabilities are NOT granted at install — the
    // journey drives the grant through genuine page-gesture requests and
    // asserts the honest denial when they are absent.
    const drivenCapabilities = [
      "storage", "alarms", "activeTab", "scripting", "sidePanel", "tabs", "notifications",
    ];
    // INSTALL-GRANTED MODEL. There is no enable/disable journey any more:
    // Settings renders a read-only diagnostic of what the install granted, so
    // the old checks drove `.grant-perm` / `.revoke-perm` controls that no
    // longer exist.
    //
    // Deliberately NOT derived from the product's own capability list — that
    // was tried before and made the check tautological, because Settings
    // renders its rows from the same list so both sides move together. The
    // driven ids are named literally so dropping or renaming one breaks this.
    check(
      "permissions: optional capabilities start ungranted (JIT) and the mandatory boot set is granted",
      capState0 !== null && typeof capState0 === "object" &&
        capState0["storage"] === true && capState0["alarms"] === true &&
        drivenCapabilities.filter((id) => id !== "storage" && id !== "alarms" && id !== "sidePanel")
          .every((id) => capState0[id] === false),
    );
    // The Settings panel is the JIT request surface: real per-capability rows
    // with three honest states (granted / requestable with Enable /
    // platform-unavailable) plus the fixed mandatory boot rows.
    const permPanel = await evalOpts(`(async () => {
      for (let i = 0; i < 80; i++) {
        if (document.querySelectorAll('#permission-list .perm-row').length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      return {
        rows: document.querySelectorAll('#permission-list .perm-row').length,
        enableButtons: document.querySelectorAll('#permission-list button').length,
        states: document.querySelectorAll('#permission-list .perm-state').length,
        mandatoryRows: [...document.querySelectorAll('#permission-list .perm-state')].filter(
          (el) => el.textContent?.includes("Granted at install")
        ).length,
        listExists: !!document.getElementById("permission-list"),
        capCount: (typeof CAPABILITIES !== "undefined") ? CAPABILITIES.length : "undef",
        renderError: window.__permRenderError ?? null,
      };
    })()`);
    if (permPanel?.rows === 0) console.log("[debug] permPanel:", JSON.stringify(permPanel));
    check(
      "permissions: Settings panel renders three-state rows + mandatory boot rows",
      permPanel?.rows > 0 && permPanel?.enableButtons > 0 && permPanel?.states === permPanel?.rows &&
        permPanel?.mandatoryRows >= 3,
    );

    // tabs + notifications are OPTIONAL now — verified NOT granted at boot.
    const warningCaps = await evalOpts(`Promise.all(
      ["tabs", "notifications"].map((p) => chrome.permissions.contains({ permissions: [p] }))
    )`);
    check(
      "permissions: optional capabilities start ungranted (JIT model)",
      Array.isArray(warningCaps) && warningCaps.length === 2 &&
        warningCaps.every((granted) => granted === false),
    );

    // ── JIT grant/deny/retry/revoke journey ──────────────────────────────
    // The Settings panel's Enable buttons call requestCapability(cap.id)
    // which performs chrome.permissions.request from the page gesture.

    // Helper: find and click the Enable button for a capability by its label.
    const clickEnable = async (label) => {
      // NO awaitPromise: the click is sync (dispatches the request), so the
      // evaluate returns immediately. The grant state is polled separately
      // via chrome.permissions.contains.
      return await evalOpts(`(() => {
        const rows = [...document.querySelectorAll('#permission-list .perm-row')];
        const row = rows.find((r) => r.querySelector('.perm-name')?.textContent === ${JSON.stringify(label)});
        if (!row) return { ok: false, reason: "row not found" };
        const btn = row.querySelector("button");
        if (!btn) return { ok: false, reason: "no button" };
        btn.click();
        return { ok: true };
      })()`);
    };

    // SILENT capability: bookmarks — Enable click requests from the page
    // gesture and Chrome grants it (no warning dialog for bookmarks).
    const bmRow = await evalOpts(`(() => {
      const rows = [...document.querySelectorAll('#permission-list .perm-row')];
      return rows.find((r) => r.querySelector('.perm-name')?.textContent === 'Bookmarks') ?? null;
    })()`);
    check("permissions: Bookmarks Enable button found in the Settings panel", bmRow !== null);
    const bmClick = await clickEnable("Bookmarks");
    check("permissions: Bookmarks Enable clicked", bmClick?.ok === true);
    // Headless auto-denies chrome.permissions.request — the honest outcome.
    const bmGranted = await evalOpts(`chrome.permissions.contains({ permissions: ["bookmarks"] })`);
    check("permissions: Bookmarks Enable clicked but denied in headless (the grant requires a headed run)", bmGranted === false);
    // Tab groups also denies in headless — the honest denial.
    const tgClick = await clickEnable("Tab groups");
    const tgAfter = await evalOpts(`chrome.permissions.contains({ permissions: ["tabGroups"] })`);
    check(
      "permissions: tab groups Enable clicked but still denied (honest headless denial)",
      tgClick?.ok === true && tgAfter === false,
    );

    await msgOpts({
      type: "provider.set",
      config: {
        provider: "openai",
        baseURL: "https://custom.invalid/v1",
        apiKey: "placeholder-key",
        model: "model-one",
      },
    });

    // The revoke ROUTE still exists in the worker even though no UI reaches it.
    // Its security property is what survives from the deleted Disable journey:
    // it must never act without owner approval. (chrome.permissions.remove only
    // works on optional permissions, so revocation is unreachable now — this
    // pins the gate, not the effect.)
    const revokeUnapproved = await msgOpts({ type: "capability.revoke", id: "storage" });
    check(
      "permissions: capability.revoke still requires owner approval (fail closed)",
      revokeUnapproved?.ok === false &&
        String(revokeUnapproved?.error ?? "").toLowerCase().includes("approval"),
    );

    // Re-open the Settings page so renderProviders picks up the openai config
    // set above (the first page rendered while the provider was still demo, so
    // its Clear-key button was absent — the options page does not live-update on
    // SW-side config changes).
    const optsPageReload = await openPage(
      port, `chrome-extension://${extId}/options/options.html`,
    );
    await sleep(2000);
    optsSession = await attachRuntime(cdp, optsPageReload.id);
    cdp.pageSessions.add(optsSession);
    evalOpts = (expression) => evalIn(cdp, optsSession, expression);

    let openaiCard = null;
    for (let i = 0; i < 20 && !openaiCard; i++) {
      // Side-tabs: select OpenAI's tab first — its editor panel is hidden
      // until selected, and boxOf needs a VISIBLE box.
      await evalIn(cdp, optsSession,
        `document.querySelector('#provider-tab-openai')?.click(); true`).catch(() => {});
      await sleep(100);
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
    check(
      "Settings: clicked Clear key via a real click",
      await clickSel(cdp, optsSession, `.provider-card[data-provider="openai"] .clear-key`),
    );
    await sleep(500);
    const afterClear = await evalOpts(`chrome.runtime.sendMessage({ type: "provider.get" })`);
    check(
      "Settings: Clear key removed only the key (endpoint/model preserved)",
      afterClear?.provider === "openai" &&
        afterClear?.apiKey === "" &&
        afterClear?.baseURL === "https://custom.invalid/v1" &&
        afterClear?.model === "model-one",
    );

    check(
      "Settings: clicked Update via a real click",
      await clickSel(cdp, optsSession, `.provider-card[data-provider="openai"] .set-default`),
    );
    await sleep(500);
    const afterUpdate = await evalOpts(`chrome.runtime.sendMessage({ type: "provider.get" })`);
    check(
      "Settings: Update preserved endpoint/model + empty key",
      afterUpdate?.provider === "openai" &&
        afterUpdate?.apiKey === "" &&
        afterUpdate?.baseURL === "https://custom.invalid/v1" &&
        afterUpdate?.model === "model-one",
    );
    // The demo + prompt-api providers are no longer in the SETTINGS PICKER
    // (Paul 2026-08-17: the Prompt API is internal-only; the demo is testing-only),
    // but they remain resolvable through the service worker for the tests. Verify
    // BOTH: the picker omits them AND the SW still resolves demo.
    check(
      "Settings: demo + prompt-api absent from the provider picker",
      (await evalIn(cdp, optsSession, `document.querySelectorAll('.provider-card[data-provider="demo"], .provider-card[data-provider="prompt-api"]').length`)) === 0,
    );
    await msgOpts({ type: "provider.set", config: { provider: "demo", apiKey: "", baseURL: "", model: "" } });
    await sleep(300);
    const demoCfg = await evalOpts(`chrome.runtime.sendMessage({ type: "provider.get" })`);
    check("Settings: provider restored to demo", demoCfg?.provider === "demo" && !demoCfg?.baseURL);
    check(
      "Settings: demo still resolvable via the SW (testing only)",
      demoCfg?.provider === "demo",
    );

    // ─────────────────────────────────────────────────────────────
    // ENROLLMENT — genuine owner gesture: type a loopback origin + click Enroll.
    // Headless auto-denies the optional host-permission prompt, so the origin
    // must NOT be enrolled (fail closed). A headed browser would grant it; the
    // deny path is what is observable here and proves enrollment is NOT claimed
    // without the permission (the round-13 acceptance).
    // ─────────────────────────────────────────────────────────────
    const enrollOrigin = "https://enroll.example";
    check(
      "Settings: Enroll input present",
      (await boxOf(cdp, optsSession, "#enroll-origin")) !== null,
    );
    check(
      "Settings: typed a loopback origin into the Enroll field",
      await typeInto(cdp, optsSession, "#enroll-origin", enrollOrigin),
    );
    check(
      "Settings: clicked Enroll via a real click",
      await clickSel(cdp, optsSession, "#enroll-btn"),
    );
    await sleep(1500); // let the (denied) permission request settle
    const enrolledAfterDeny = await msgValue({ type: "agent.list" });
    // Under the install-granted model host access is already present, so the
    // old fail-closed deny path is unreachable and the POSITIVE path is what is
    // observable: a genuine owner Enroll click now enrols the origin. The
    // property that enrolment is never claimed without host access is still
    // covered — `<all_urls>` is asserted in the manifest check above, and the
    // wrong-origin/expired-grant probes below still exercise refusal.
    check(
      "enrollment: origin enrolled under JIT grant",
      Array.isArray(enrolledAfterDeny) &&
        enrolledAfterDeny.includes(enrollOrigin),
    );

    const optsShot = await captureShot(cdp, optsSession);
    if (optsShot) {
      await writeEvidence("options-driven.png", optsShot);
    }
    check("Settings: retained a driven-UI screenshot", optsShot !== null && optsShot.length > 200);

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
    // JOURNEY 4 — screenshot matrix. Owner grant/scope/revoke is driven via the
    // genuine Settings UI; wrong-origin + expiry remain SECONDARY message probes.
    // ─────────────────────────────────────────────────────────────
    const redPage = await openPage(port, RED_URL);
    await sleep(2000);
    // Activate the red tab so it is the ACTIVE tab — captureVisibleTab (under
    // the silent activeTab permission) captures the active tab, and its url is
    // then visible to chrome.tabs.query({active:true}).
    await cdp.send("Target.activateTarget", { targetId: redPage.id });
    await sleep(500);
    const redTab = await evalOpts(
      `chrome.tabs.query({ active: true, currentWindow: true }).then(t => t[0] ?? null)`,
    );
    const redTabId = redTab?.id ?? null;
    // The active tab resolves by id (its URL is hidden until a headed browser
    // grants the `tabs` permission or `activeTab` is granted FOR this tab —
    // neither is grantable in headless). Resolving the id is enough to drive the
    // capture journey; the capture itself is asserted fail-closed below.
    check(
      "real red tab resolved (active tab id)",
      typeof redTabId === "number",
    );

    // (a) revoked → capture denied (secondary probe).
    await msgValue({ type: "browser-control.set", granted: false });
    const revokedShot = await msgValue({ type: "capture.tab", tabId: redTabId });
    check(
      "screenshot: denied after revoke (secondary probe)",
      revokedShot?.error !== undefined || revokedShot?.ok === false,
    );
    // (b) grant the EXACT origin (message probe). Capture is asserted FAIL-
    // CLOSED: in headless there is NO grantable permission that authorizes
    // captureVisibleTab of an arbitrary tab (activeTab is transient + tied to
    // the tab active at the granting gesture; `tabs`/host permissions auto-deny;
    // debugger cannot be optional). Success is a HEADED-browser path (the user
    // invokes the extension on the page they are viewing).
    await msgValue({
      type: "browser-control.set",
      origins: [RED_ORIGIN],
      expiryMs: 60000,
    });
    const allowedShot = await msgValue({ type: "capture.tab", tabId: redTabId });
    // Previously asserted fail-closed because no grantable permission
    // authorized capturing an arbitrary tab in headless. With `<all_urls>`
    // install-granted that path is now genuinely available, so the meaningful
    // assertion is that the GRANTED origin captures. Refusal is still covered
    // by the wrong-origin, expired-grant and post-revoke probes below, which
    // are what actually protect the browser-control scoping.
    check(
      "screenshot: capture SUCCEEDS for the granted origin",
      allowedShot?.error === undefined && typeof allowedShot?.screenshot === "string" &&
        allowedShot.screenshot.length > 0,
    );
    // (c) wrong-origin (secondary probe).
    await msgValue({
      type: "browser-control.set",
      origins: ["http://127.0.0.1:1"],
      expiryMs: 60000,
    });
    const wrongShot = await msgValue({ type: "capture.tab", tabId: redTabId });
    check(
      "screenshot: wrong-origin grant is denied (secondary probe)",
      wrongShot?.error !== undefined || wrongShot?.ok === false,
    );
    // (d) expiry (secondary probe).
    await msgValue({
      type: "browser-control.set",
      origins: [RED_ORIGIN],
      expiryMs: 1,
    });
    await sleep(120);
    const expiredShot = await msgValue({ type: "capture.tab", tabId: redTabId });
    check(
      "screenshot: expired grant is denied (secondary probe)",
      expiredShot?.error !== undefined || expiredShot?.ok === false,
    );

    // ─────────────────────────────────────────────────────────────
    // GENUINE UI grant: checkbox click + origin textarea typing (the primary
    // owner-grant acceptance), then revoke via a genuine checkbox click.
    // ─────────────────────────────────────────────────────────────
    check(
      "Settings: browser-grant checkbox present",
      (await boxOf(cdp, optsSession, "#browser-grant")) !== null,
    );
    check(
      "screenshot: clicked the browser-grant checkbox",
      await clickSel(cdp, optsSession, "#browser-grant"),
    );
    await sleep(400);
    const grantAfterClick = await msgValue({ type: "browser-control.get" });
    check(
      "screenshot: granted browser control via a real checkbox click",
      grantAfterClick?.active === true,
    );
    // Type the red origin into the allowed-origins field (a genuine text edit).
    check(
      "screenshot: typed the red origin into the allowed-origins field",
      await typeInto(cdp, optsSession, "#grant-origin-list", RED_ORIGIN),
    );
    await pressTab(cdp, optsSession); // blur → fires the change handler (scopes)
    await sleep(500);
    const scopedGrant = await msgValue({ type: "browser-control.get" });
    check(
      "screenshot: grant scoped to the red origin via the UI",
      scopedGrant?.scope === "origins" &&
        Array.isArray(scopedGrant?.origins) &&
        scopedGrant.origins.includes(RED_ORIGIN),
    );
    const uiGrantShot = await msgValue({ type: "capture.tab", tabId: redTabId });
    // The UI grant flow (checkbox + scoped origin) is genuinely driven above;
    // capture itself is asserted FAIL-CLOSED in headless (same reason as the
    // message probe — activeTab cannot authorize an arbitrary tab without a
    // headed-browser invocation on that tab).
    check(
      "screenshot: UI-granted capture SUCCEEDS for the scoped origin",
      uiGrantShot?.error === undefined && typeof uiGrantShot?.screenshot === "string" &&
        uiGrantShot.screenshot.length > 0,
    );
    // Revoke via a genuine checkbox click (uncheck).
    check(
      "screenshot: revoked via a real checkbox click",
      await clickSel(cdp, optsSession, "#browser-grant"),
    );
    await sleep(400);
    const afterUiRevoke = await msgValue({ type: "capture.tab", tabId: redTabId });
    check(
      "screenshot: revoked → capture denied",
      afterUiRevoke?.error !== undefined || afterUiRevoke?.ok === false,
    );

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
    // JOURNEY 5b — version-token monotonicity (round-27 CAS blocker).
    // ─────────────────────────────────────────────────────────────
    // `memory.set` returns the durable version token for the write (the round-27
    // fix). Two writes of the SAME value must bump the version — never reuse it —
    // so an identical-value ABA is distinguishable. Driven through the real SW
    // message route (not a unit-test fake).
    const ver1 = await msgValue({
      type: "memory.set", origin: "master", key: "version-token-probe", value: "same",
    });
    const ver2 = await msgValue({
      type: "memory.set", origin: "master", key: "version-token-probe", value: "same",
    });
    check(
      "memory: version tokens are monotonic + never reused (round-27 CAS)",
      typeof ver1 === "number" &&
        typeof ver2 === "number" &&
        ver1 > 0 &&
        ver2 > ver1,
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
    const journal = await msgValue({ type: "memory.get", origin: "master", key: "journal" }) ?? [];
    const attachTask = (Array.isArray(journal) ? journal : [])
      .find((e) => e?.type === "task" && e?.task === "attach");
    check(
      "attachment count cap (12 → 4 over-count dropped, journal records 8)",
      droppedOver.length === 4 && attachTask?.attachmentCount === 8,
    );
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
      // A background/scheduled agent journals to its OWN OPFS (not the master's).
      const j2 = await msgValue({ type: "memory.get", origin: `background:${sched.name}`, key: "journal" }) ?? [];
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
    // JOURNEY 8 — worker restart + missing-alarm reconciliation (fail-closed).
    // ─────────────────────────────────────────────────────────────
    const recTask = "reconcile-after-restart";
    const rec = await msgValue({
      type: "register-task",
      task: { task: recTask, delayMs: 10000 },
    });
    check("reconcile task scheduled", typeof rec?.name === "string");
    if (rec?.name) {
      // Clear the alarm (LEAVING the persisted task). chrome.alarms.clear
      // returns a Promise<boolean> — require the REAL true (never map to true).
      const cleared = await evalOpts(
        `chrome.alarms.clear(${JSON.stringify(rec.name)})`,
      );
      check("alarm cleared (persisted task remains)", cleared === true);
      const persisted = await evalOpts(
        `chrome.storage.local.get('cap:scheduledTasks').then(s => s['cap:scheduledTasks']?.[${JSON.stringify(rec.name)}]?.task ?? null)`,
      );
      check("persisted task payload survives the clear", persisted === recTask);
      // Close the SW target (success checked) — this restarts the worker.
      const closeRes = await cdp.send("Target.closeTarget", { targetId: sw.id });
      check(
        "old worker target closed (closeTarget success)",
        closeRes?.result?.success === true,
      );
      // Wake the worker (this recreates the SW's execution context, auto-attached
      // + paused + resumed). A genuine restart is proven by the SW's execution
      // context being recreated (Runtime.executionContextsCleared/Created) — the
      // MV3 SW DevTools TARGET id is stable across stop/start, so a "different
      // target" is NOT a valid proxy; the recreated JS context is.
      const restartT0 = Date.now();
      const wake = await msgValue({ type: "agent.list" });
      check("worker woken after restart", Array.isArray(wake));
      let restarted = false;
      for (let i = 0; i < 40 && !restarted; i++) {
        await attachSettled.catch(() => {});
        restarted = cdp.executionContextEvents.some((ev) =>
          ev.ts >= restartT0 && ev.kind === "created" &&
          cdp.swSessions.has(ev.sessionId)
        );
        if (!restarted) await sleep(250);
      }
      check(
        "worker restarted (execution context recreated)",
        restarted,
      );
      await sleep(1500); // let recoverOnBoot reconcile the missing alarm
      const recreatedAlarms = await evalOpts(
        `chrome.alarms.getAll().then(a => a.map(x => x.name))`,
      );
      check(
        "recreated alarm observed before fire",
        Array.isArray(recreatedAlarms) && recreatedAlarms.includes(rec.name),
      );
      // Wait for the recreated alarm to fire (original at = now + 10000ms).
      await sleep(9000);
      const j3 = await msgValue({ type: "memory.get", origin: `background:${rec.name}`, key: "journal" }) ?? [];
      const arr3 = Array.isArray(j3) ? j3 : [];
      const recTaskEntry = arr3.find((e) => e?.type === "task" && e?.task === recTask && e?.scheduled === true);
      const recResultEntry = arr3.find((e) => e?.type === "result" && e?.id === rec.name);
      check(
        "restarted worker reconciled + ran the persisted task",
        Boolean(recTaskEntry) && Boolean(recResultEntry),
      );
    }

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 8b — owner task list + cancel (the fail-closed cancel path — an
    // alarm still armed — is unit-tested; this exercises the owner-visible list
    // + the success-path cancel E2E, the round-24 cancel-fail-open blocker).
    // ─────────────────────────────────────────────────────────────
    const cancelTask = "cancel-me";
    const ct = await msgValue({
      type: "register-task",
      task: { task: cancelTask, delayMs: 120000 },
    });
    check("cancel: task registered", typeof ct?.name === "string");
    if (ct?.name) {
      const listed = await msgValue({ type: "task.list" });
      check(
        "cancel: task listed for the owner",
        Array.isArray(listed?.tasks) &&
          listed.tasks.some((t) => t.name === ct.name),
      );
      const cancelRes = await msgValue({ type: "task.cancel", name: ct.name });
      check(
        "cancel: cancelled the task (alarm absent)",
        cancelRes?.ok === true && cancelRes?.cancelled === true,
      );
      const after = await msgValue({ type: "task.list" });
      check(
        "cancel: task gone after cancel",
        Array.isArray(after?.tasks) &&
          !after.tasks.some((t) => t.name === ct.name),
      );
    }

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 9 — multi-agent fan-out: create→list→delegate→delete.
    // ─────────────────────────────────────────────────────────────
    const created = await msgValue({
      type: "agent.create",
      origin: "https://worker.example",
      name: "worker",
    });
    check("agent.create returns ok", created?.ok === true);
    const listed = await msgValue({ type: "agent.list" });
    check(
      "agent.create created a discoverable worker (list includes it)",
      Array.isArray(listed) && listed.includes("https://worker.example"),
    );
    // Give the worker a distinct tool so it's a behaviorally distinct agent.
    await msgValue({
      type: "tools.upsert",
      origin: "https://worker.example",
      tools: [{
        name: "greet",
        description: "greet the worker",
        inputSchema: { type: "object", properties: {}, required: [] },
      }],
    });
    const orchOn = await msgValue({ type: "agent.orchestrator" });
    check(
      "orchestrator: multi-agent ON + delegation tools present",
      orchOn?.multiAgent === true &&
        Array.isArray(orchOn?.delegationTools) &&
        orchOn.delegationTools.includes("delegate_task"),
    );
    check(
      "orchestrator: worker fanned out (workerCount >= 1)",
      (orchOn?.workerCount ?? 0) >= 1 &&
        Array.isArray(orchOn?.workerOrigins) &&
        orchOn.workerOrigins.includes("https://worker.example"),
    );
    // EXECUTE a real delegated worker task (not just verify the map): the worker
    // agent actually runs and its result is journaled to the worker's OWN
    // per-origin memory — the honest proof of fan-out.
    const delegated = await msgValue({
      type: "agent.delegate",
      origin: "https://worker.example",
      task: "greet the worker",
    });
    const workerJournal = await msgValue({
      type: "memory.get", origin: "https://worker.example", key: "journal",
    }) ?? [];
    const workerResult = (Array.isArray(workerJournal) ? workerJournal : [])
      .find((e) => e?.type === "delegated-result" && e?.task === "greet the worker");
    check(
      "worker delegated task ran (worker result journaled)",
      delegated?.ok === true &&
        typeof delegated?.result === "string" && delegated.result.length > 0 &&
        Boolean(workerResult) && typeof workerResult.result === "string",
    );
    // Toggle OFF via a genuine checkbox click → delegation tools disappear + the
    // rebuild generation advances (the observable fan-out boundary).
    check(
      "Settings: multi-agent toggle present",
      (await boxOf(cdp, optsSession, "#multi-agent")) !== null,
    );
    check(
      "Settings: clicked the multi-agent toggle OFF",
      await clickSel(cdp, optsSession, "#multi-agent"),
    );
    await sleep(500);
    const offState = await evalOpts(
      `chrome.storage.local.get('cap:multiAgent').then(s => s['cap:multiAgent'])`,
    );
    check("Settings: multi-agent setting persisted OFF", offState === false);
    const orchOff = await msgValue({ type: "agent.orchestrator" });
    check(
      "orchestrator: solo mode drops delegation tools",
      orchOff?.multiAgent === false &&
        Array.isArray(orchOff?.delegationTools) &&
        orchOff.delegationTools.length === 0,
    );
    check(
      "orchestrator: generation advanced after rebuild",
      typeof orchOn?.generation === "number" &&
        typeof orchOff?.generation === "number" &&
        orchOff.generation > orchOn.generation,
    );
    const solo = await msgValue({ type: "agent.run", task: "solo ping" });
    check("solo mode still runs a task", concrete(solo));
    // Toggle back ON → delegation tools return.
    check(
      "Settings: clicked the multi-agent toggle ON",
      await clickSel(cdp, optsSession, "#multi-agent"),
    );
    await sleep(500);
    const onState = await evalOpts(
      `chrome.storage.local.get('cap:multiAgent').then(s => s['cap:multiAgent'])`,
    );
    check("Settings: multi-agent setting persisted ON", onState === true);
    const orchOn2 = await msgValue({ type: "agent.orchestrator" });
    check(
      "orchestrator: delegation tools restored",
      orchOn2?.multiAgent === true &&
        Array.isArray(orchOn2?.delegationTools) &&
        orchOn2.delegationTools.includes("delegate_task"),
    );
    // Delete the worker → the list + fan-out shrink.
    await approvedMsg({ type: "agent.delete", origin: "https://worker.example" });
    const listedAfter = await msgValue({ type: "agent.list" });
    check(
      "agent.delete removed the worker from the list",
      Array.isArray(listedAfter) && !listedAfter.includes("https://worker.example"),
    );
    // ─────────────────────────────────────────────────────────────
    // DELETE-RACE regression (round-13 blocker): a racing upsert from a
    // still-running bridge must NOT resurrect the tombstoned worker. The upsert
    // is rejected (isEnrolled false under the origin lock) and listOrigins —
    // derived from authoritative enrollment state, not OPFS dir existence —
    // still excludes it.
    // ─────────────────────────────────────────────────────────────
    const raceUpsert = await msgValue({
      type: "tools.upsert",
      origin: "https://worker.example",
      tools: [{
        name: "zombie",
        description: "zombie tool",
        inputSchema: { type: "object", properties: {}, required: [] },
      }],
    });
    check(
      "delete-race: upsert on a deleted origin is rejected",
      raceUpsert?.ok === false || raceUpsert?.error !== undefined,
    );
    const listedAfterRace = await msgValue({ type: "agent.list" });
    check(
      "delete-race: listOrigins excludes the deleted origin after racing upsert",
      Array.isArray(listedAfterRace) &&
        !listedAfterRace.includes("https://worker.example"),
    );

    // ─────────────────────────────────────────────────────────────
    // DISENROLL UI — create a SECOND agent, open a fresh Settings page (so
    // renderData lists it), and drive the Disenroll button with genuine input.
    // The authoritative agent.delete route is what the button calls.
    // ─────────────────────────────────────────────────────────────
    await msgValue({ type: "agent.create", origin: "https://disenroll.example", name: "disenroll" });
    const optsPage2 = await openPage(
      port, `chrome-extension://${extId}/options/options.html`,
    );
    await sleep(2000);
    const optsSession2 = await attachRuntime(cdp, optsPage2.id);
    cdp.pageSessions.add(optsSession2);
    let disenrollBtn = null;
    for (let i = 0; i < 20 && !disenrollBtn; i++) {
      disenrollBtn = await boxOf(cdp, optsSession2, ".origin-row .disenroll-origin");
      if (!disenrollBtn) await sleep(250);
    }
    check(
      "Settings: Disenroll button present for an enrolled agent",
      disenrollBtn !== null,
    );
    // `agent.delete` is an OWNER-DIRECT action (CAP-FB-20260823-ARTIFACT-DELETE-PERMISSION-01):
    // the owner's own click in a browser-attested extension UI document IS the
    // approval, so one click removes the Site Agent and nothing waits on a
    // hidden Settings decision. This step used to click, resolve a pending
    // approval, then click again; that expectation is stale.
    const disenrollRequested = await clickSel(cdp, optsSession2, ".origin-row .disenroll-origin");
    check(
      "Settings: clicked Disenroll via a real click",
      disenrollRequested,
    );
    await sleep(600);
    // Assert the owner-direct policy POSITIVELY rather than just dropping the
    // old assertion: a genuine owner click must leave NO pending approval
    // behind. A regression that started queueing one would strand the owner
    // waiting on a decision they already made.
    // Read the pending list from the OWNER surface, not from NTP: the
    // management routes are restricted to the exact Settings sender, so asking
    // from the hub returns a refusal rather than an empty list.
    const pendingAfterDisenroll = await evalIn(
      cdp, optsSession2,
      `chrome.runtime.sendMessage({type:'management.pending-approvals'}).then(
         v => JSON.stringify({ok: v?.ok === true, actions: (v?.approvals ?? []).map(a => a?.action ?? null)}),
         e => JSON.stringify({ok:false, err:String(e?.message ?? e)}))`,
    );
    let disenrollPending = null;
    try { disenrollPending = JSON.parse(pendingAfterDisenroll); } catch { /* reported below */ }
    check(
      "disenroll: an owner click needs no second approval (owner-direct action)",
      disenrollPending?.ok === true &&
        Array.isArray(disenrollPending.actions) &&
        !disenrollPending.actions.includes("agent.delete"),
      pendingAfterDisenroll,
    );
    const afterDisenroll = await msgValue({ type: "agent.list" });
    check(
      "disenroll: agent removed from list + enrollment tombstoned",
      Array.isArray(afterDisenroll) &&
        !afterDisenroll.includes("https://disenroll.example"),
    );

    // ─────────────────────────────────────────────────────────────
    // MULTI-ORIGIN SCRIPTING DISABLE (round-21 blocker 2): revoking scripting
    // must tombstone EVERY enrolled origin with NO lost update. The old code ran
    // disenrollOriginLocked CONCURRENTLY (Promise.allSettled) under the global
    // enrollment lock, so two origins reused the same generation and one
    // tombstone overwrote the other (a two-origin probe lost A's tombstone).
    // Create two origins, disable scripting, and assert BOTH are gone from the
    // authoritative enrollment list.
    // ─────────────────────────────────────────────────────────────
    await msgValue({ type: "agent.create", origin: "https://script-disable-a.example", name: "a" });
    await msgValue({ type: "agent.create", origin: "https://script-disable-b.example", name: "b" });
    const preDisable = await msgValue({ type: "agent.list" });
    check(
      "scripting Disable: two origins enrolled before the revoke",
      Array.isArray(preDisable) &&
        preDisable.includes("https://script-disable-a.example") &&
        preDisable.includes("https://script-disable-b.example"),
    );
    // Under the install-granted model `scripting` is a REQUIRED manifest
    // permission, so Chrome can never remove it. The revoke is refused up
    // front — and the property that matters is that a refusal destroys
    // NOTHING. Previously the route tombstoned every enrolled origin first and
    // only then discovered the removal could not commit, so an operation that
    // could never succeed still took the origins' authority with it.
    const revokeScripting = await approvedMsg({ type: "capability.revoke", id: "scripting" });
    check(
      "scripting Disable: refused because scripting is install-granted",
      revokeScripting?.ok === false && revokeScripting?.required === true &&
        revokeScripting?.revoked === false,
    );
    const postDisable = await msgValue({ type: "agent.list" });
    check(
      "scripting Disable: a refused revoke tombstones NOTHING",
      Array.isArray(postDisable) &&
        postDisable.includes("https://script-disable-a.example") &&
        postDisable.includes("https://script-disable-b.example"),
    );

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 9c — the master management tool suite (create_agent → get_agent →
    // update_agent → assets → delete_agent). The hub agent's management tools
    // (lib/management-tools.js) are thin wrappers over THESE routes, so proving
    // the routes work proves the tools are wired. The orchestrator also exposes
    // the fixed management-tool names via `agent.orchestrator`.
    // ─────────────────────────────────────────────────────────────
    const orchMgmt = await msgValue({ type: "agent.orchestrator" });
    check(
      "mgmt: orchestrator exposes the management tool suite",
      Array.isArray(orchMgmt?.managementTools) &&
        orchMgmt.managementTools.includes("create_agent") &&
        orchMgmt.managementTools.includes("create_asset") &&
        orchMgmt.managementTools.includes("list_agents"),
    );
    const mgmtCreated = await msgValue({
      type: "agent.create", origin: "https://mgmt.example", name: "mgmt-worker",
    });
    check("mgmt: create_agent returned ok", mgmtCreated?.ok === true);
    const dir = await msgValue({ type: "agent.directory" });
    const dirEntry = (Array.isArray(dir?.agents) ? dir.agents : [])
      .find((a) => a?.origin === "https://mgmt.example");
    check(
      "mgmt: agent.directory lists it with enrollment state",
      dirEntry != null && dirEntry.enrolled === true,
    );
    const gotAgent = await msgValue({ type: "agent.get", origin: "https://mgmt.example" });
    check(
      "mgmt: get_agent inspects it (tools + memory keys)",
      gotAgent?.ok === true &&
        gotAgent.agent?.enrolled === true &&
        Array.isArray(gotAgent.agent?.memoryKeys),
    );
    const updated = await approvedMsg({
      type: "agent.update", origin: "https://mgmt.example", name: "renamed-worker",
    });
    check(
      "mgmt: update_agent changed the name",
      updated?.ok === true && updated.agent?.name === "renamed-worker",
    );
    // The artifacts system (create → list → get → update → delete).
    const asset = await msgValue({
      type: "asset.create", origin: "master", assetType: "html",
      name: "generated page", content: "<h1>hello</h1>",
    });
    check(
      "mgmt: create_asset succeeded (hub asset)",
      asset?.ok === true && typeof asset.asset?.id === "string",
    );
    const assetId = asset?.asset?.id;
    const assetList = await msgValue({ type: "asset.list", origin: "master" });
    check(
      "mgmt: list_assets lists the asset (no content)",
      Array.isArray(assetList?.assets) &&
        assetList.assets.some((a) => a.id === assetId && !("content" in a)),
    );
    const assetGet = await msgValue({ type: "asset.get", origin: "master", id: assetId });
    check(
      "mgmt: get_asset round-trips content",
      assetGet?.ok === true && assetGet.asset?.content === "<h1>hello</h1>",
    );

    // The PRIMARY Settings entry is the NTP's embedded options iframe. Drive
    // its navigation and Deny button with genuine CDP clicks (Runtime.evaluate
    // is used only for coordinate discovery/assertions).
    const iframeDeniedRequest = await msgValue({
      type: "asset.update", origin: "master", id: assetId, name: "must-not-apply",
    });
    // Keep this acceptance focused on owner input/authority rather than a
    // concurrent ViewTransition lifecycle; reduced-motion is a supported
    // production mode and makes the overlay state deterministic.
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    }, ntpSession);
    await clickSel(cdp, ntpSession, "#open-settings");
    const clickInSettingsFrame = async (selector) => {
      let point = null;
      for (let i = 0; i < 30 && !point; i++) {
        point = await evalIn(cdp, ntpSession, `(() => {
          // CAP-FB-20260828-PANEL-DOC-RETENTION-01: panel frames are pooled per
          // path (ntp.js panelFrameFor) — address the Settings frame by path.
          const frame = document.querySelector('iframe[data-panel-path="options/options.html"]');
          const el = frame?.contentDocument?.querySelector(${JSON.stringify(selector)});
          if (!frame || !el) return null;
          const fr = frame.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return null;
          return {x: fr.left + r.left + r.width / 2, y: fr.top + r.top + r.height / 2};
        })()`);
        if (!point) await sleep(200);
      }
      if (!point) return false;
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, ntpSession);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, ntpSession);
      return true;
    };
    // REPOINTED 2026-08-27: the Settings -> Approvals list this used to click
    // was deleted at 0.2.313. The property under test is unchanged and still
    // worth asserting — the Settings surface EMBEDDED IN THE NTP is a genuine
    // owner-options principal and can deny, while the NTP top frame cannot
    // (asserted separately, below, against the forged-resolve probe).
    //
    // The deny is issued through the EMBEDDED FRAME's own chrome.runtime, so
    // the SW's `context.principal === "owner-options"` check is what decides.
    // Reaching into the frame's realm is the point: if the embedded Settings
    // document were NOT treated as an owner surface, this would fail closed.
    // Address the embedded Settings frame's OWN main-world execution context.
    const settingsFrameId = await evalIn(cdp, ntpSession, `(() => {
      // CAP-FB-20260828-PANEL-DOC-RETENTION-01: pooled panel frame selector.
      const frame = document.querySelector('iframe[data-panel-path="options/options.html"]');
      return frame && frame.contentDocument ? "present" : null;
    })()`);
    const frameTree = await cdp.send("Page.getFrameTree", {}, ntpSession);
    const settingsFrame = (frameTree?.result?.frameTree?.childFrames ?? [])
      .find((f) => String(f?.frame?.url ?? "").includes("options/options.html"));
    const settingsCtx = cdp.executionContextEvents
      .filter((e) => e.kind === "created" && e.sessionId === ntpSession && e.isDefault &&
        e.frameId === settingsFrame?.frame?.id)
      .pop();
    const iframeNav = settingsFrameId === "present" && !!settingsCtx?.id;
    let iframeDeny = false;
    if (iframeNav) {
      const denied = await withTimeout(
        cdp.send("Runtime.evaluate", {
          expression: `(async () => {
            const pending = await chrome.runtime.sendMessage({ type: "management.pending-approvals" });
            const id = pending?.approvals?.[0]?.approvalId;
            if (!id) return false;
            const out = await chrome.runtime.sendMessage({ type: "management.resolve-approval", approvalId: id, approve: false });
            return out?.ok === true && out?.decision === "denied";
          })()`,
          contextId: settingsCtx.id,
          returnByValue: true,
          awaitPromise: true,
        }, ntpSession),
        15000,
        "iframe approval deny",
      );
      iframeDeny = denied?.result?.result?.value === true;
    }
    await sleep(250);
    const iframeAfter = await msgValue({ type: "asset.get", origin: "master", id: assetId });
    const iframeShot = await captureShot(cdp, ntpSession).catch(() => null);
    if (iframeShot) await writeEvidence("approval-iframe-denied.png", iframeShot);
    const iframePass = iframeDeniedRequest?.ok === false && iframeNav && iframeDeny &&
      iframeAfter?.ok === true && iframeAfter.asset?.name === "generated page";
    check(
      "approval: primary NTP Settings iframe can deny an exact request",
      iframePass,
      { request: iframeDeniedRequest, iframeNav, iframeDeny, assetName: iframeAfter?.asset?.name },
    );
    await clickSel(cdp, ntpSession, "#view-back").catch(() => false);

    // Exact correlated DENY: one request → one row; neither the raw target,
    // asset id, digest nor approval id is present in the DOM. A genuine Deny
    // click removes that exact tuple and the mutation never runs.
    // `asset.delete` became an OWNER-DIRECT action
    // (CAP-FB-20260823-ARTIFACT-DELETE-PERMISSION-01), so an owner surface's own
    // delete no longer queues an approval and cannot exercise the deny path.
    // `asset.update` is still gated and drives the identical request → single
    // row → deny → mutation-never-ran flow, so the coverage is unchanged.
    const denyRequest = await msgValue({ type: "asset.update", origin: "master", id: assetId, name: "deny-must-not-apply" });
    await sleep(250);
    // REPOINTED 2026-08-27: this used to scrape #approval-list's DOM. That list
    // is gone, but the property it protected is not — and asserting it on the
    // PAYLOAD is strictly stronger than asserting it on one rendering of the
    // payload: whatever surface renders an approval (an in-context card, a
    // dialog, a future one) can only show what the SW hands it. One request
    // must produce exactly one row, and that row must disclose no capability
    // material — not the asset id, not the approval id, not a digest, not the
    // raw target.
    const denyRows = await msgOpts({ type: "management.pending-approvals" });
    const denyList = Array.isArray(denyRows?.approvals) ? denyRows.approvals : [];
    const denyPayload = JSON.stringify(denyList);
    const denyRow = denyList[0] ?? {};
    // The row carries exactly four fields — approvalId, action, targetRef, at.
    // approvalId is REQUIRED (the surface must be able to resolve the row it
    // created) and is the one capability value the old DOM assertion checked
    // was never rendered as an attribute; here it must be present but opaque.
    // Everything that would let a caller reconstruct the target — the asset
    // id, a digest, the raw `asset:master` target string — must be absent, and
    // targetRef must be the 32-char install-scoped opaque reference.
    const denyDom = {
      count: denyList.length,
      fields: Object.keys(denyRow).sort().join(","),
      opaqueRef: typeof denyRow.targetRef === "string" && denyRow.targetRef.length === 32,
      hasApprovalId: typeof denyRow.approvalId === "string" && denyRow.approvalId.length > 0,
      text: denyPayload,
    };
    const captureApprovalEvidence = async (name) => {
      await cdp.send("Page.bringToFront", {}, optsSession).catch(() => {});
      let shot = null;
      for (let i = 0; i < 3 && !shot; i++) {
        shot = await captureShot(cdp, optsSession).catch(() => null);
        if (!shot) await sleep(250);
      }
      if (!shot) throw new Error(`approval evidence capture failed: ${name}`);
      await writeEvidence(name, shot);
      return shot;
    };
    await captureApprovalEvidence("approval-deny-pending.png");
    check(
      "approval: deny row is singular and capability material absent from the payload",
      denyRequest?.ok === false && denyDom.count === 1 &&
        denyDom.fields === "action,approvalId,at,targetRef" &&
        denyDom.hasApprovalId && denyDom.opaqueRef &&
        !String(denyDom.text).includes(assetId) &&
        !String(denyDom.text).includes("digest") &&
        !String(denyDom.text).includes("asset:master"),
      denyDom,
    );
    // Assertion-only retrieval from the exact owner surface: the identifier is
    // then replayed from NTP with every old body bypass flag. The SW must still
    // reject because sender authority is a separate browser-derived context.
    const pendingForForgery = await evalOpts(`chrome.runtime.sendMessage({type:'management.pending-approvals'}).then(v => v.approvals?.[0]?.approvalId || '')`);
    const forgedResolve = await msgValue({
      type: "management.resolve-approval",
      approvalId: pendingForForgery,
      approve: true,
      __ownerUI: true,
      userActivation: true,
    });
    check(
      "approval: NTP cannot programmatically resolve an owner approval",
      forgedResolve?.ok === false,
    );
    await resolveNextApproval(false);
    await captureApprovalEvidence("approval-deny-resolved.png");
    const afterDeniedDelete = await msgValue({ type: "asset.get", origin: "master", id: assetId });
    check(
      "approval: deny leaves the exact asset unchanged",
      afterDeniedDelete?.ok === true &&
        afterDeniedDelete.asset?.content === "<h1>hello</h1>" &&
        afterDeniedDelete.asset?.name !== "deny-must-not-apply",
    );

    // Stable install-scoped target reference across an actual MV3 worker
    // restart. Pending/granted capabilities are intentionally worker-ephemeral
    // (restart fails closed); the private OPFS HMAC key remains install-scoped.
    await msgValue({ type: "asset.update", origin: "master", id: assetId, name: "restart-must-not-apply" });
    await sleep(250);
    const refBeforeRestart = await evalOpts(`chrome.runtime.sendMessage({type:'management.pending-approvals'}).then(v => v.approvals?.[0]?.targetRef || '')`);
    const targetsForApprovalRestart = await cdp.send("Target.getTargets");
    const approvalWorker = targetsForApprovalRestart?.result?.targetInfos?.find((t) => t.type === "service_worker" && t.url.includes(extId));
    if (!approvalWorker?.targetId) throw new Error("approval worker target missing before restart");
    await cdp.send("Target.closeTarget", { targetId: approvalWorker.targetId });
    await sleep(300);
    let approvalWake = null;
    for (let i = 0; i < 10 && !approvalWake; i++) {
      approvalWake = await msgValue({ type: "asset.list", origin: "master" }).catch(() => null);
      if (!approvalWake) await sleep(200);
    }
    await msgValue({ type: "asset.update", origin: "master", id: assetId, name: "restart-must-not-apply" });
    await sleep(250);
    const refAfterRestart = await evalOpts(`chrome.runtime.sendMessage({type:'management.pending-approvals'}).then(v => v.approvals?.[0]?.targetRef || '')`);
    check(
      "approval: install-scoped opaque reference survives a worker restart",
      typeof refBeforeRestart === "string" && refBeforeRestart.length === 32 && refAfterRestart === refBeforeRestart,
    );
    await resolveNextApproval(false);
    const afterRestartDeny = await msgValue({ type: "asset.get", origin: "master", id: assetId });
    check(
      "approval: post-restart deny leaves the exact asset unchanged",
      afterRestartDeny?.ok === true &&
        afterRestartDeny.asset?.content === "<h1>hello</h1>" &&
        afterRestartDeny.asset?.name !== "restart-must-not-apply",
    );

    const assetUpdate = await approvedMsg({
      type: "asset.update", origin: "master", id: assetId, name: "final page",
    });
    check(
      "mgmt: update_asset patched the asset",
      assetUpdate?.ok === true && assetUpdate.asset?.name === "final page",
    );
    const assetDel = await approvedMsg({ type: "asset.delete", origin: "master", id: assetId });
    check("mgmt: delete_asset removed it", assetDel?.ok === true);
    const assetAfter = await msgValue({ type: "asset.list", origin: "master" });
    check(
      "mgmt: asset gone after delete",
      Array.isArray(assetAfter?.assets) &&
        !assetAfter.assets.some((a) => a.id === assetId),
    );
    const mgmtDel = await approvedMsg({ type: "agent.delete", origin: "https://mgmt.example" });
    check("mgmt: delete_agent removed the agent", mgmtDel?.ok === true);
    const dirAfter = await msgValue({ type: "agent.directory" });
    check(
      "mgmt: agent gone from the directory after delete",
      Array.isArray(dirAfter?.agents) &&
        !dirAfter.agents.some((a) => a?.origin === "https://mgmt.example"),
    );

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 10 — service-worker console audit (strictly worker-only).
    // ─────────────────────────────────────────────────────────────
    for (const e of cdp.swErrors()) {
      console.log(`SW console error: ${e.detail}`);
    }
    check("no service-worker console errors", cdp.swErrors().length === 0);
    check("no SW Runtime.enable errors (auto-attach)", cdp.swAttachErrors.length === 0);
    for (const e of cdp.pageErrors()) {
      console.log(`page console error: ${e.detail}`);
    }
    check("no NTP/Settings console errors", cdp.pageErrors().length === 0);
    for (const f of cdp.fatalEvents) {
      console.log(`fatal CDP event: ${f}`);
    }
    check("no fatal CDP lifecycle events", cdp.fatalEvents.length === 0);

    cdp.intentionalClose = true;
    ws.close();
    await withTimeout(fixture.shutdown(), 8000, "fixture.shutdown").catch((e) => {
      // A hung/failed fixture shutdown is a real resource leak — FAIL the gate
      // (the round-16 finding: fixture shutdown failure was logged but non-fatal).
      fixtureShutdownFailed = true;
      console.error("fixture.shutdown failed:", String(e?.message ?? e));
    });
  } catch (e) {
    console.error("journey failure:", String(e?.message ?? e));
    try {
      await withTimeout(fixture.shutdown(), 8000, "fixture.shutdown").catch(
        () => {
          fixtureShutdownFailed = true;
        },
      );
    } catch { /* ignore */ }
    try {
      cdp && (cdp.intentionalClose = true);
      ws?.close();
    } catch { /* ignore */ }
  } finally {
    // ─────────────────────────────────────────────────────────────
    // Owner-clean shutdown (fail-closed, bounded, environment-scrubbed).
    // ─────────────────────────────────────────────────────────────
    let removed = false;
    let clean = true;
    try {
      await killChromiumTree(proc, profile);
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

    // Temporary (non-retained) evidence is caller-owned temp output and must NOT
    // be left behind. Retained runs write to test-artifacts/ (kept + committed).
    let tempEvidenceGone = true;
    if (!RETAIN) {
      await runBounded(RM, ["-rf", EVIDENCE_DIR]).catch(() => {});
      tempEvidenceGone = !(await Deno.stat(EVIDENCE_DIR).then(() => true).catch(
        () => false,
      ));
    }
    check("no leftover temporary evidence dir", tempEvidenceGone);

    // Fixed assertion set: every expected check ran exactly once (no missing,
    // no extra) AND in the EXPECTED order. This is the invariant that prevents
    // a silent count shrink or a reordered gate.
    const META_CHECKS = new Set([
      "assertion set exact (no missing/extra checks)",
      "assertion order matches EXPECTED",
    ]);
    const FINAL_CHECK = "assertion set exact (no missing/extra checks)";
    const missing = EXPECTED.filter((n) => !META_CHECKS.has(n) && !ran.has(n));
    const extra = [...ran].filter((n) => !EXPECTED.includes(n));
    for (const n of missing) {
      console.log(`FAIL: ${n} (not reached)`);
      results.push({ name: n, pass: false });
    }
    for (const n of extra) {
      console.log(`EXTRA assertion (should be in EXPECTED): ${n}`);
    }
    check(FINAL_CHECK, missing.length === 0 && extra.length === 0);

    // Order check: the checks that RAN must appear in the exact EXPECTED order
    // (a reordered suite is a gate failure, not just a different summary).
    const ranNames = [...ran].filter((n) => !META_CHECKS.has(n));
    const expectedOrdered = EXPECTED.filter((n) => !META_CHECKS.has(n));
    const orderOk = ranNames.length === expectedOrdered.length &&
      ranNames.every((n, i) => n === expectedOrdered[i]);
    if (!orderOk) {
      for (let i = 0; i < Math.max(ranNames.length, expectedOrdered.length); i++) {
        if (ranNames[i] !== expectedOrdered[i]) {
          console.log(
            `ORDER mismatch @${i}: ran=${JSON.stringify(ranNames[i])} expected=${JSON.stringify(expectedOrdered[i])}`,
          );
          break;
        }
      }
    }
    check("assertion order matches EXPECTED", orderOk);

    const failed = results.filter((r) => !r.pass).length;
    console.log(
      `\nchrome journeys: ${results.length - failed}/${results.length} passed`,
    );

    // Evidence manifest (RETAIN only, fatal): the SOURCE commit the evidence
    // attests + the evidence files' hashes + the named checks. A tracked manifest
    // can never contain the hash of the commit that contains IT (that commit is
    // created AFTER the run), so we model `testedSourceCommit` (the HEAD at run
    // time — i.e. the exact source the evidence exercised) explicitly, and record
    // worktree cleanliness. A failed git lookup or manifest write is FATAL.
    let manifestOk = true;
    if (RETAIN) {
      try {
        let testedSourceCommit = null;
        const g = new Deno.Command(GIT, {
          args: ["rev-parse", "HEAD"],
          stdout: "piped",
          stderr: "piped",
          clearEnv: true,
        }).outputSync();
        if (g.code !== 0) {
          throw new Error(
            `git rev-parse failed (exit ${g.code}) — cannot attest source`,
          );
        }
        testedSourceCommit = new TextDecoder().decode(g.stdout).trim();
        if (!/^[0-9a-f]{40}$/.test(testedSourceCommit)) {
          throw new Error(
            `git rev-parse returned a non-commit (${testedSourceCommit})`,
          );
        }
        // Worktree cleanliness (excluding test-artifacts/, which this run is
        // about to write). A dirty tree beyond that is recorded, not fatal.
        const st = new Deno.Command(GIT, {
          args: ["status", "--porcelain"],
          stdout: "piped",
          clearEnv: true,
        }).outputSync();
        const dirty = (st.code === 0
          ? new TextDecoder().decode(st.stdout)
          : "").split("\n").filter((l) =>
            l && !l.slice(3).startsWith("test-artifacts/")
          );
        // A dirty SOURCE tree (beyond the test-artifacts/ this run writes) makes
        // the retained evidence unattestable — FAIL the retained run rather than
        // record dirtiness and continue (the round-16 finding: dirty source state
        // was recorded, not fatal).
        if (dirty.length > 0) {
          throw new Error(
            `source tree is dirty (${dirty.length} file(s)) — commit or stash before retaining evidence`,
          );
        }
        const manifest = {
          testedSourceCommit,
          evidenceCommitNote:
            "committed AFTER this run — a tracked manifest cannot contain its own commit hash",
          worktreeClean: dirty.length === 0,
          worktreeDirtyFiles: dirty.slice(0, 20),
          runId: RUN_ID,
          retain: RETAIN,
          ts: new Date().toISOString(),
          evidenceDir: EVIDENCE_DIR,
          passed: results.length - failed,
          failed,
          checks: results.map((r) => ({ name: r.name, pass: r.pass })),
          files: evidenceFiles,
        };
        await withTimeout(
          Deno.writeFile(
            `${EVIDENCE_DIR}/manifest.json`,
            new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
          ),
          10000,
          "write retained manifest.json",
        );
      } catch (e) {
        manifestOk = false;
        console.error("manifest write failed (fatal):", String(e?.message ?? e));
      }
    }

    Deno.exit(
      failed > 0 || !removed || !clean || !tempEvidenceGone || !manifestOk ||
          fixtureShutdownFailed
        ? 1
        : 0,
    );
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
  // NOTE: the match pattern must NOT start with "-" (pgrep/pkill would parse
  // a leading "--user-data-dir=…" as an OPTION and exit 2 — a syntax error that
  // the old code silently treated as "no process remains"). Matching the
  // substring without the leading dashes is equivalent (the chromium argv still
  // contains the full "--user-data-dir=…" token).
  const match = `user-data-dir=${profile}`;
  await runBounded(PKILL, ["-9", "-f", match]).catch(() => {});
  // Bounded wait for the full tree to disappear — HARD FAIL if any remain.
  // Distinguish a REAL "no process found" (pgrep exit code 1) from a pgrep
  // FAILURE (spawn/permission/timeout error): a failed pgrep must NOT be read
  // as "clean" (that was the fail-open path where a broken pgrep meant "no
  // descendants survived").
  for (let i = 0; i < 20; i++) {
    let out;
    try {
      out = await runBounded(PGREP, ["-f", match]);
    } catch (e) {
      throw new Error(
        `pgrep failed (${e?.message ?? e}) — cannot confirm cleanup`,
      );
    }
    if (out.code === 1) return; // pgrep found nothing → no matching process
    if (out.code !== 0) {
      throw new Error(`pgrep exited ${out.code} — cannot confirm cleanup`);
    }
    await sleep(250);
  }
  throw new Error("chromium descendants survived cleanup");
}

await main();
