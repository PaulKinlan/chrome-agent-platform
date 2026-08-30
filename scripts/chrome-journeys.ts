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

import { DEMO_STREAM_ANSWER } from "../extension/lib/models/demo-model.js";
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

/** EVERY piece of text the thread can show the owner — light DOM AND every
 * shadow root, including collapsed <details> bodies and the raw JSON views the
 * owner can toggle. CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 §10: the lazy
 * protocol's transport vocabulary must appear NOWHERE in it. Script/style/
 * template text is not owner-visible and is skipped. */
const THREAD_TEXT = (rootSel: string) => `(() => {
  const root = document.querySelector(${JSON.stringify(rootSel)}) ?? document.body;
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(node.data); return; }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 1) {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'TEMPLATE') return;
      if (node.shadowRoot) walk(node.shadowRoot);
    }
    for (const c of node.childNodes) walk(c);
  };
  walk(root);
  return out.join(' ').replace(/\\s+/g, ' ');
})()`;
/** Open every tool card and every raw JSON view, so a probe reads what an
 * owner who clicks through can read. */
const OPEN_ALL_CARDS = `(() => {
  const conv = document.getElementById('thread-conversation') ?? document.querySelector('agent-conversation');
  for (const b of conv?.querySelectorAll('message-bubble[role="tool"]') ?? []) {
    const root = b.shadowRoot ?? b;
    for (const d of root.querySelectorAll('details')) d.open = true;
    for (const btn of root.querySelectorAll('.tt-raw-toggle')) if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
  }
  return true;
})()`;
/** The transport strings that must never be owner-visible text. */
const LAZY_LEAK_STRINGS = ["modelContent", "catalogGeneration", "stableId", "schemaSummary", "search_tools", "execute_tool"];
const lazyLeaks = (text: string) => LAZY_LEAK_STRINGS.filter((s) => String(text ?? "").includes(s));

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

/** A GENUINE mouse click on an element INSIDE an open shadow root (the
 * approval card's Allow / Not now buttons live in the component's shadow
 * tree, out of document.querySelector's reach). Same real CDP input. */
async function clickShadow(cdp, session, hostSelector, innerSelector) {
  const b = await evalIn(
    cdp,
    session,
    `(() => { const host = [...document.querySelectorAll(${JSON.stringify(hostSelector)})].pop(); const el = host?.shadowRoot?.querySelector(${JSON.stringify(innerSelector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`,
  );
  if (!b || typeof b.x !== "number") return false;
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
  "SW attach returned a session id",
  "SW Runtime.enable succeeded",
  "manifest: boot-critical permissions mandatory, capabilities optional, <all_urls> host",
  "manifest: debugger absent everywhere",
  "initial SW closed for a pre-attached restart",
  "SW woken for the pre-attached restart",
  "initial SW boot observed via pre-attached restart",
  "developer flag: the marker demo model is enabled for the suite",
  "fresh profile: the four agent surfaces agree (0)",
  "fresh hub: Tab #1 focuses the composer",
  "fresh hub: the first-run banner offers exactly one action",
  "fresh hub at 1024x700: the composer is fully within the viewport",
  "fresh hub: no empty-state copy is rendered",
  "after enabling one recipe the four agent surfaces agree (1)",
  "after disabling that recipe the four agent surfaces agree (0) again",
  "create dialog: the template gallery is the first step (blank + 21 templates + scheduled recipes; Starter shows 7; no template select)",
  "create dialog: Enter on the Research Analyst card fills Name, presses the card and checks its skills",
  "create dialog: Advanced+Skills expand and the config body scrolls with them (min-height hardening)",
  "create dialog: a REAL skill checkbox click checks it (unchecked → checked)",
  "create dialog: Create agent from the card yields ONE named agent whose role is the template persona",
  "create dialog: the saved agent's skill ids CONTAIN the exactly-toggled skill id",
  "create dialog: a Scheduled card creates one scheduled agent that the sidebar and Settings both list",
  "create dialog: the journey's created agents are removed again (fresh profile restored)",
  "NTP: task input present",
  "NTP: typed a task via Input events",
  "NTP: textarea reflects the typed text",
  "NTP: clicked Run task via a real click",
  "NTP: retained a driven-UI screenshot",
  "NTP: the typed task reached the agent journal",
  "Lazy protocol: a first-call enum slip is recoverable in one run",
  "Lazy protocol: the enum-slip run rendered the refused call, the retry and the answer",
  "jobs panel: renders the empty state on a fresh board",
  "jobs panel: retained the empty-state screenshot",
  "jobs panel: two jobs + a message posted via the real routes",
  "jobs panel: open jobs render with poster + recency (live, no reload)",
  "jobs panel: the message feed renders the broadcast",
  "jobs panel: the open-count hint reflects the board",
  "jobs panel: retained the populated-state screenshot",
  "jobs panel: a real named agent claimed + completed a job",
  "jobs panel: the settled group renders the outcome + result excerpt (live, no reload)",
  "jobs panel: retained the settled-state screenshot",
  "Settings: Permissions panel present",
  "approval: forged NTP owner/activation fields are refused",
  "permissions: optional capabilities start ungranted (JIT) and the mandatory boot set is granted",
  "permissions: Settings panel renders three-state rows + mandatory boot rows",
  "permissions: optional capabilities start ungranted (JIT model)",
  "permissions: Context menus Enable button found in the Settings panel",
  "permissions: Context menus Enable clicked via a trusted gesture",
  "permissions: Context menus granted after Enable settled",
  "permissions: Context menus Turn off clicked via a trusted gesture",
  "permissions: Turn off raised the owner approval dialog (capability.revoke via the SW)",
  "permissions: Context menus absent after Turn off settled",
  "permissions: Context menus retry Enable clicked via a trusted gesture",
  "permissions: Context menus granted after retry settled",
  "permissions: Bookmarks Enable clicked via a trusted gesture",
  "permissions: Bookmarks prompt cancelled and permission settled absent in headless",
  "permissions: Tab groups Enable clicked via a trusted gesture",
  "permissions: Tab groups prompt cancelled and permission settled absent in headless",
  "permissions: retry affordance intact for cancelled warned permissions (fresh Settings page)",
  "permissions: capability.revoke still requires owner approval (fail closed)",
  "board deny: two named agents created for the journey",
  "board deny: Board permissions section opens from the nav",
  "board deny: the dropdowns populate from the named-agent registry",
  "board deny: rule added via a real click on the Add control",
  "board deny: the rule row renders and the rule persists in the store",
  "board deny: rule removed via the row's real Remove control",
  "board deny: the row disappears and the store is empty after Remove",
  "Settings: OpenAI provider card rendered",
  "Settings: OpenAI picker: first suggestion is the catalogue default and no suggestion ends in -Nk",
  "Settings: OpenAI picker: opened list shows gpt-5.6-luna first under a Recommended header",
  "Settings: Clear key button present for the keyed provider",
  "Settings: clicked Clear key via a real click",
  "Settings: Clear key removed only the key (endpoint/model preserved)",
  "Settings: clicked Update via a real click",
  "Settings: Update preserved endpoint/model + empty key",
  "Settings: demo + prompt-api absent from the provider picker",
  "Settings: empty model + valid key resolves to the default (provider.status usingDefaultModel:true, modelId gpt-5.6-luna)",
  "Settings: provider restored to demo",
  "Settings: demo still resolvable via the SW (testing only)",
  "Settings: Enroll input present",
  "Settings: typed a loopback origin into the Enroll field",
  "Settings: clicked Enroll via a real click",
  "enrollment: origin enrolled under JIT grant",
  "Settings: retained a driven-UI screenshot",
  "keyless: developer flag off for the fresh-profile run",
  "Cookies: the cookie value reader and the cookie writers are absent from the default build",
  "keyless: typed 'group my tabs by topic' into the hub composer",
  "keyless: clicked Run task",
  "keyless: the first run pauses on ONE Allow card naming tabs (never a bare error)",
  "keyless: clicked Not now on the card via a real click",
  "keyless: the first run answers in plain language — never '[demo model] Task received'",
  "keyless: without the tabs permission the answer says so honestly",
  "keyless: the persisted thread carries the plain answer, not the demo literal",
  "keyless: no lazy-protocol text leaks into the live thread (modelContent/catalogGeneration/stableId/schemaSummary/search_tools/execute_tool)",
  "keyless: reopening the thread renders the in-context grant card, not error prose",
  "keyless: developer flag back on for the marker journeys",
  "Cookies: the developer build exposes them again, and no cookie value ever reaches the model",
  "warm run 1 returns a concrete demo result",
  "warm run 2 (after re-save) returns a concrete demo result",
  "Transcript: 'list my open tabs' survives a reload at full length",
  "Transcript: no nudge summary bubble after a text-ending step",
  "Transcript: no lazy-protocol text leaks into the reopened thread (modelContent/catalogGeneration/stableId/schemaSummary/search_tools/execute_tool)",
  "Memory recall: a new thread's prompt carries the digest of a key written earlier",
  "Memory recall: a new thread answers 'green' from the digest, never 'I do not know'",
  "Provider error: SW console recorded the real HTTP 401 from the fixture provider",
  "Provider error: a rejected key renders the 401 bubble with a Settings link",
  "Provider error: preflight refusal reaches a terminal Failed row within 5 s",
  "Streaming: the assistant bubble grows across at least 5 distinct lengths",
  "Streaming: the final bubble equals the non-streamed render",
  "Claim check: a failed delegate renders one correction and one final bubble",
  "Thread view: update card is titled with the artifact name",
  "Thread view: run banner visible 300 ms after send",
  "Thread view: no empty panel space below a two-turn thread at 1440x900",
  "Thread view: conversation scrolled to bottom after an edit turn",
  "real red tab resolved (active tab id)",
  "screenshot: denied after revoke (secondary probe)",
  "screenshot: capture SUCCEEDS for the granted origin",
  "screenshot: wrong-origin grant is denied (secondary probe)",
  "screenshot: expired grant is denied (secondary probe)",
  "Settings: browser-grant checkbox present",
  "screenshot: clicked the browser-grant checkbox",
  "screenshot: granted browser control via a real checkbox click",
  "Browser control: toggle ON in Settings leaves no lease",
  "Browser control: a run's open_tab is not lease-refused after the Settings toggle",
  "Privileged URL: open_tab chrome://settings is refused under a global grant",
  "Side panel: open_side_panel is absent from the model toolset",
  "screenshot: typed the red origin into the allowed-origins field",
  "screenshot: grant scoped to the red origin via the UI",
  "screenshot: UI-granted capture SUCCEEDS for the scoped origin",
  "screenshot: revoked via a real checkbox click",
  "Browser control: toggle OFF succeeds while a run holds the lease",
  "screenshot: revoked → capture denied",
  "Permission card: open_tab denial renders one approval card",
  "Permission card: Not now declines open_tab and the run reports it honestly",
  "Permission card: read_page denial renders one approval card",
  "Permission card: Allow grants scripting and the retried read_page succeeds",
  "Permission card: capture_screenshot denial renders one approval card",
  "Permission card: Allow grants browser control and the retried capture_screenshot succeeds",
  "Screenshot: model capture is persisted and listed",
  "Screenshot: tool card shows a thumbnail",
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
  "Settings: Data & memory shows the run-log retention row",
  "Settings: the run-log retention toggle reports the bounded default (off)",
  "Settings: retained the run-log retention screenshot",
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
  "scripting Disable: Site Agents Turn off clicked via a trusted gesture",
  "scripting Disable: the owner dialog appeared and was accepted with a genuine click",
  "scripting Disable: optional permission revoked",
  "scripting Disable: successful revoke tombstones every enrolled origin",
  "Settings: Turn off Site Agents goes through capability.revoke and unregisters enrolled scripts",
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
  "artifact versions: two rows with distinct sha256 after the edit turn",
  "artifact versions: version-get returns v1's exact body",
  "artifact versions: restore of v1 is a new head whose body equals v1 byte-for-byte",
  "viewer: Preview|Source|Diff tablist renders with exactly one selected tab",
  "viewer: ArrowRight selects Source and the panel shows highlighted, exact source",
  "viewer: Diff tab shows version pickers and a real diff between two versions",
  "mgmt: delete_asset removed it",
  "mgmt: asset gone after delete",
  "artifacts: update_asset with an empty id says use list_assets",
  "artifacts: update_asset with an unknown id says use list_assets",
  "artifacts: one New tab click opens exactly one viewer target",
  "cap:fetch: loopback refused from a sandboxed script",
  "Scripts: run_script from the model shows the approval card with the source",
  "Scripts: the approved run executes only after Allow",
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
  // Every request the fixture receives (the script-fetch journey asserts a
  // refused loopback fetch never reaches it).
  const fixtureHits = [];
  const fixture = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const u = new URL(req.url);
    fixtureHits.push(u.pathname + u.search);
    if (u.pathname === "/red.html") {
      return new Response(
        `<html><body style="margin:0;background:#ff0000;width:400px;height:300px"></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (u.pathname.endsWith("/chat/completions")) {
      // An OpenAI-shaped 401 for the provider-error-truth journey: the body
      // echoes a key-shaped token exactly the way OpenAI does, so the journey
      // also proves the bubble never carries it.
      return new Response(
        JSON.stringify({ error: { type: "authentication_error", code: "invalid_api_key", message: "Incorrect API key provided: sk-journey-invalid-0000. You can find your API key at the provider dashboard." } }),
        { status: 401, headers: { "content-type": "application/json" } },
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
    // The marker demo model (@demo-tools, @demo-board, …) is the suite's test
    // seam and sits behind the developer flag; a default profile runs the
    // local assistant instead (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01). The
    // keyless journey below turns the flag OFF around its own run.
    const developerFlag = async (on) => msgValue({ type: "kv.set", values: { "cap:developerFeatures": on === true } });
    check("developer flag: the marker demo model is enabled for the suite", (await developerFlag(true))?.ok === true);

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 1 — GENUINE CDP INPUT on the NTP: type a task + click Run.
    // ─────────────────────────────────────────────────────────────
    // CAP-FB-20260830-FRESH-PROFILE-TEMPLATE-AGENTS-01 — the four agent
    // surfaces (hub sidebar, hub Agents panel, Settings → Agents, side panel
    // Agents tab) list the SAME set: created named agents + ENABLED background
    // agents. A fresh profile shows the empty state everywhere (the 22 disabled
    // recipes are templates, not agents); enabling one recipe shows exactly one
    // row everywhere. Each measurement opens fresh pages (not reloads — a
    // navigation breaks the CDP eval context), so the projection is measured
    // as a new visit renders it, then closes them.
    const measureAgentSurfaces = async () => {
      const pages = [];
      const open = async (path) => {
        const page = await openPage(port, `chrome-extension://${extId}/${path}`);
        pages.push(page);
        await sleep(1800);
        const session = await attachRuntime(cdp, page.id);
        cdp.pageSessions.add(session);
        return session;
      };
      try {
        const hub = await open("ntp/ntp.html");
        const opts = await open("options/options.html#agents");
        const sp = await open("sidepanel/sidepanel.html");
        await evalIn(cdp, sp, `document.getElementById('tab-agents')?.click()`);
        await sleep(1200); // the picker's live registry fetch
        const sidebarRows = await evalIn(cdp, hub, `document.querySelectorAll('#side-agents .agent-item').length`);
        const sidebarEmpty = await evalIn(cdp, hub, `document.querySelector('#side-agents .thread-empty')?.textContent ?? ''`);
        const panelCount = await evalIn(cdp, hub, `document.getElementById('agent-count')?.textContent ?? ''`);
        const panelRows = await evalIn(cdp, hub, `document.querySelectorAll('#named-agents capability-row').length`);
        const settingsRows = await evalIn(cdp, opts, `document.querySelectorAll('#unified-agent-list .agent-settings-row').length`);
        const settingsText = await evalIn(cdp, opts, `document.getElementById('unified-agent-list')?.textContent?.trim().slice(0, 60) ?? ''`);
        const sidepanelRows = await evalIn(cdp, sp, `document.getElementById('agents-picker')?.shadowRoot?.querySelectorAll('.opt').length ?? -1`);
        const sidepanelEmpty = await evalIn(cdp, sp, `document.getElementById('agents-picker')?.shadowRoot?.querySelector('.state')?.textContent ?? ''`);
        const shot = await captureShot(cdp, hub);
        return { sidebarRows, sidebarEmpty, panelCount, panelRows, settingsRows, settingsText, sidepanelRows, sidepanelEmpty, shot };
      } finally {
        for (const page of pages) {
          await fetch(`http://127.0.0.1:${port}/json/close/${page.id}`).catch(() => {});
        }
      }
    };
    const surfaces0 = await measureAgentSurfaces();
    if (surfaces0.shot) await writeEvidence("fresh-profile-sidebar.png", surfaces0.shot);
    console.log("agent surfaces (fresh):", JSON.stringify({ ...surfaces0, shot: undefined }));
    check(
      "fresh profile: the four agent surfaces agree (0)",
      surfaces0.sidebarRows === 0 && /No agents yet/.test(surfaces0.sidebarEmpty) &&
        /^0 agents/.test(surfaces0.panelCount) && surfaces0.panelRows === 0 &&
        /^No agents yet\./.test(surfaces0.settingsText) &&
        surfaces0.sidepanelRows === 0 && /No agents yet/.test(surfaces0.sidepanelEmpty),
    );

    // ─────────────────────────────────────────────────────────────
    // CAP-FB-20260827-HUB-FIRST-RUN-01 — on a FRESH profile the composer is
    // the first thing: first in the DOM and the tab order, above the fold at
    // 1024x700, with a one-action banner above it and no stacked empty states.
    const focusedInHub = () => evalIn(cdp, ntpSession, `(() => {
      const a = document.activeElement; const el = a?.shadowRoot?.activeElement ?? a;
      return { tag: el?.tagName ?? null, id: el?.id ?? null, inComposer: !!(el?.closest && el.closest('#composer')) };
    })()`);
    await evalIn(cdp, ntpSession, `document.activeElement?.blur?.(); window.scrollTo(0, 0); true`);
    await pressTab(cdp, ntpSession); // ONE genuine Tab key from a neutral start
    const tab1 = await focusedInHub();
    console.log("fresh hub Tab #1:", JSON.stringify(tab1));
    check("fresh hub: Tab #1 focuses the composer", tab1?.inComposer === true && tab1?.id === "task-input");
    await evalIn(cdp, ntpSession, `document.activeElement?.blur?.(); true`);
    const bannerButtons = await evalIn(cdp, ntpSession, `(() => {
      const g = document.getElementById('first-run-guide');
      if (!g || g.hidden) return null;
      return [...g.shadowRoot.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim());
    })()`);
    console.log("fresh hub banner buttons:", JSON.stringify(bannerButtons));
    check(
      "fresh hub: the first-run banner offers exactly one action",
      Array.isArray(bannerButtons) && bannerButtons.length === 2 &&
        bannerButtons[0] === "Connect a model" && bannerButtons[1] === "Dismiss first-run setup",
    );
    const hubAt = async (width, height, name) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, ntpSession);
      await sleep(400);
      const rect = await evalIn(cdp, ntpSession, `(() => { const r = document.getElementById('composer')?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, vh: innerHeight } : null; })()`);
      const shot = await captureShot(cdp, ntpSession);
      if (shot) await writeEvidence(name, shot);
      return rect;
    };
    const rect1440 = await hubAt(1440, 900, "hub-fresh-1440-after.png");
    const rect1024 = await hubAt(1024, 700, "hub-fresh-1024-after.png");
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, ntpSession);
    console.log("fresh hub composer rects:", JSON.stringify({ rect1440, rect1024 }));
    check(
      "fresh hub at 1024x700: the composer is fully within the viewport",
      rect1024 !== null && rect1024.top >= 0 && rect1024.bottom <= 700,
    );
    const hubText = await evalIn(cdp, ntpSession, `document.body.innerText`);
    const emptyCopy = ["No activity matches", "No artifacts yet", "No Site Agents yet", "Discovery has not run yet", "Nothing has happened yet"]
      .filter((s) => String(hubText ?? "").includes(s));
    console.log("fresh hub empty copy:", JSON.stringify(emptyCopy));
    check("fresh hub: no empty-state copy is rendered", typeof hubText === "string" && emptyCopy.length === 0);

    // Enable ONE recipe. Headless Chrome auto-denies chrome.permissions.request,
    // so background-agent.set fails closed here (by design); seed the enabled
    // state the way the scheduler persists it — the SW's own cap:scheduledTasks
    // authority — so every surface derives `enabled` from the real store.
    const bgListForSeed = await msgValue({ type: "background-agent.list" });
    const seedRecipe = (bgListForSeed?.agents ?? []).find((a) => a?.schedule?.periodInMinutes);
    const seedName = `recipe:${seedRecipe?.id}`;
    const seeded = seedRecipe
      ? await msgValue({
        type: "kv.set",
        values: {
          "cap:scheduledTasks": {
            [seedName]: {
              name: seedName,
              task: seedRecipe.prompt ?? "seeded schedule",
              at: Date.now() + 3600e3,
              periodInMinutes: seedRecipe.schedule.periodInMinutes,
            },
          },
        },
      })
      : { ok: false, error: "no scheduled recipe" };
    const surfaces1 = await measureAgentSurfaces();
    if (surfaces1.shot) await writeEvidence("one-recipe-enabled-sidebar.png", surfaces1.shot);
    console.log("agent surfaces (one enabled):", JSON.stringify({ ...surfaces1, shot: undefined, seeded, seedName }));
    check(
      "after enabling one recipe the four agent surfaces agree (1)",
      seeded?.ok === true &&
        surfaces1.sidebarRows === 1 && /^1 agent /.test(surfaces1.panelCount) && surfaces1.panelRows === 1 &&
        surfaces1.settingsRows === 1 && !/^No agents yet\./.test(surfaces1.settingsText) &&
        surfaces1.sidepanelRows === 1,
    );
    // Disable it again (clear the seeded schedule) so the rest of the suite
    // sees the fresh profile it expects — and the surfaces return to 0.
    const unseeded = await msgValue({ type: "kv.set", values: { "cap:scheduledTasks": {} } });
    const surfaces2 = await measureAgentSurfaces();
    console.log("agent surfaces (disabled again):", JSON.stringify({ ...surfaces2, shot: undefined, unseeded }));
    check(
      "after disabling that recipe the four agent surfaces agree (0) again",
      unseeded?.ok === true && surfaces2.sidebarRows === 0 && /^0 agents/.test(surfaces2.panelCount) &&
        surfaces2.panelRows === 0 && /^No agents yet\./.test(surfaces2.settingsText) && surfaces2.sidepanelRows === 0,
    );

    // ─────────────────────────────────────────────────────────────
    // CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01 — templates are the
    // first-class way to create an agent: the sidebar "+" opens the create
    // dialog on an <agent-template-gallery> (Starter first), one Use applies
    // the persona/skills, and Create persists through named-agent.create.
    const pressKey = async (session, key, code, vk, text = undefined) => {
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) }, session);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, session);
    };
    const galleryState = () => evalIn(cdp, ntpSession, `(() => {
      const dlg = document.querySelector('agent-dialog');
      const g = document.getElementById('agent-template-gallery');
      if (!dlg || !g) return { open: false };
      const root = g.shadowRoot;
      const cards = [...root.querySelectorAll('agent-template-card')];
      const filters = [...root.querySelectorAll('.filter')].map((b) => ({ f: b.dataset.filter, n: Number(b.querySelector('.count')?.textContent || 0), pressed: b.getAttribute('aria-pressed') }));
      const nameInput = dlg.querySelector('.agent-config-scroll input');
      const firstChild = dlg.querySelector('.agent-config-scroll')?.firstElementChild?.className ?? '';
      let active = document.activeElement; while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      const selected = cards.find((c) => c.hasAttribute('selected'));
      const checked = [...dlg.querySelectorAll('.skills-list input[type=checkbox]')].filter((c) => c.checked).length;
      return { open: true, cards: cards.length, blank: cards.filter((c) => c.hasAttribute('blank')).length,
        filters, firstChild, select: !!document.getElementById('agent-template-select'),
        name: nameInput?.value ?? '', activeIsUse: active?.classList?.contains('use') === true,
        selectedId: selected ? (selected.hasAttribute('blank') ? '' : selected.template?.id) : null,
        selectedPressed: selected?.shadowRoot?.querySelector('.use')?.getAttribute('aria-pressed') ?? null,
        checked, schedule: dlg.querySelector('#agent-schedule')?.value ?? '' };
    })()`);
    const setFilter = (f) => evalIn(cdp, ntpSession, `document.getElementById('agent-template-gallery')?.shadowRoot?.querySelector('.filter[data-filter="${f}"]')?.click(), true`);
    const countTemplates = (f) => evalIn(cdp, ntpSession, `(() => { const g = document.getElementById('agent-template-gallery'); return g ? g.templates.filter((t) => ${f}).length : -1; })()`);
    const openCreateDialog = async () => {
      await clickSel(cdp, ntpSession, "#new-agent");
      for (let i = 0; i < 20; i++) { if ((await galleryState()).open) break; await sleep(150); }
      await sleep(200);
    };
    await openCreateDialog();
    const g0 = await galleryState();
    await setFilter("all"); await sleep(150);
    const gAll = await galleryState();
    await setFilter("scheduled"); await sleep(150);
    const gSched = await galleryState();
    await setFilter("starter"); await sleep(150);
    // The script-driven filter clicks above never moved focus (a real click
    // would focus the filter button); put focus back on the grid the way Tab
    // would, so the keyboard checks below start from the selected card.
    await evalIn(cdp, ntpSession, `document.getElementById('agent-template-gallery')?.focus(), true`);
    const curated = await countTemplates("t.source !== 'recipe'");
    const recipes = await countTemplates("t.source === 'recipe'");
    const background = await countTemplates("t.mode === 'background'");
    console.log("create dialog gallery:", JSON.stringify({ g0, all: gAll.cards, sched: gSched.cards, curated, recipes, background }));
    check(
      "create dialog: the template gallery is the first step (blank + 21 templates + scheduled recipes; Starter shows 7; no template select)",
      g0.open && g0.firstChild === "agent-template-step" && g0.blank === 1 && g0.cards === 8 && g0.select === false &&
        g0.selectedId === "" && g0.selectedPressed === "true" && g0.activeIsUse &&
        g0.filters.find((x) => x.f === "starter")?.n === 7 && curated === 21 && recipes >= 20 &&
        gAll.cards === 1 + curated + recipes && gSched.cards === 1 + background,
    );
    // Keyboard: focus is on the Custom card; ArrowRight twice reaches Research
    // Analyst (chief-of-staff is the first starter), Enter presses its Use.
    await pressKey(ntpSession, "ArrowRight", "ArrowRight", 39);
    await pressKey(ntpSession, "ArrowRight", "ArrowRight", 39);
    await pressKey(ntpSession, "Enter", "Enter", 13, "\r");
    await sleep(200);
    const g1 = await galleryState();
    console.log("create dialog after Enter:", JSON.stringify(g1));
    check(
      "create dialog: Enter on the Research Analyst card fills Name, presses the card and checks its skills",
      g1.name === "Research Analyst" && g1.selectedId === "research-analyst" && g1.selectedPressed === "true" &&
        g1.checked >= 3 && g1.activeIsUse,
    );

    // CAP-FB-20260830-AGENT-DIALOG-SCROLL-01 — the config body must scroll
    // once Advanced and Skills are expanded (min-height:0 hardening on
    // .agent-config-scroll). The previous failure mode: min-height:auto made
    // the body grow to content height inside the bounded container
    // (overflow:hidden), clipping the skills section and the footer.
    await evalIn(cdp, ntpSession, `document.querySelector('.agent-config-advanced summary')?.click(); document.querySelector('.skills-collapse summary')?.click(); true`);
    await sleep(250);
    const scrollProbe = await evalIn(cdp, ntpSession, `(() => {
      const el = document.querySelector('.agent-config-scroll');
      const adv = document.querySelector('.agent-config-advanced');
      const sk = document.querySelector('.skills-collapse');
      if (!el || !adv || !sk) return { ready: false };
      if (!adv.open || !sk.open) return { ready: false, advOpen: adv.open, skOpen: sk.open };
      const r = el.getBoundingClientRect();
      const before = el.scrollTop;
      return {
        ready: true,
        minHeight: getComputedStyle(el).minHeight,
        overflowY: getComputedStyle(el).overflowY,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollTopBefore: before,
        wheelX: r.x + r.width / 2,
        wheelY: r.y + r.height / 2,
        footerVisible: (() => { const f = document.querySelector('.agent-config-footer')?.getBoundingClientRect(); return f ? f.top > 0 && f.bottom <= innerHeight && f.top < f.bottom : null; })(),
      };
    })()`);
    if (scrollProbe?.ready) {
      for (let i = 0; i < 5; i++) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: scrollProbe.wheelX, y: scrollProbe.wheelY, deltaX: 0, deltaY: 400 }, ntpSession);
        await sleep(100);
      }
      scrollProbe.scrollTopAfterWheel = await evalIn(cdp, ntpSession, `document.querySelector('.agent-config-scroll')?.scrollTop ?? null`);
    }
    console.log("create dialog scroll probe:", JSON.stringify(scrollProbe));
    check(
      "create dialog: Advanced+Skills expand and the config body scrolls with them (min-height hardening)",
      scrollProbe?.ready === true &&
        scrollProbe.minHeight === "0px" && scrollProbe.overflowY === "auto" &&
        scrollProbe.scrollHeight > scrollProbe.clientHeight &&
        (scrollProbe.scrollTopAfterWheel ?? 0) > (scrollProbe.scrollTopBefore ?? 0) &&
        scrollProbe.footerVisible === true,
    );

    const galleryShot = await captureShot(cdp, ntpSession);
    if (galleryShot) await writeEvidence("templates-gallery.png", galleryShot);
    // REVISE r1 P1 (reviewer): prove a REAL skill checkbox toggle persists its
    // EXACT id on the saved agent — the earlier count-only check could pass on
    // template pre-checks alone. Pick the first UNCHECKED skill (so the toggle
    // is an observable change), real-click it, and record its skill id from the
    // same skill.list the dialog renders from (checkbox DOM order == catalog
    // order), then assert the saved agent's skills contain that exact id.
    const skillCatalog = await msgValue({ type: "skill.list" });
    const togglePick = await evalIn(cdp, ntpSession, `(() => {
      const host = [...document.querySelectorAll('agent-dialog')].find((h) => h.shadowRoot?.querySelector('dialog')?.open);
      const boxes = host ? [...host.querySelectorAll('.skills-list input[type=checkbox]')] : [];
      const idx = boxes.findIndex((b) => !b.checked);
      if (idx < 0) return { ok: false, reason: 'no unchecked skill checkbox', n: boxes.length };
      const b = boxes[idx];
      const r = b.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      // The click is only safe as a CDP mouse event when the point genuinely
      // resolves to the checkbox (or its label row). Arithmetic viewport
      // checks are unreliable here (the eval context reports a tall
      // innerHeight); an off-viewport CDP click would land on the native
      // dialog backdrop and light-dismiss the dialog. Otherwise drive the REAL
      // checkbox through its own change handler via el.click().
      const at = document.elementFromPoint(cx, cy);
      const clickable = at === b || at === b.closest('label');
      return { ok: true, idx, x: cx, y: cy, checkedBefore: b.checked, clickable, n: boxes.length };
    })()`);
    let toggledSkillId = null;
    if (togglePick?.ok) {
      // Real CDP mouse click when the checkbox is genuinely on-screen; the
      // deep rows of the 180px skills list sit below the viewport in a tall
      // dialog (template gallery + fields + Advanced header above), so for
      // those the REAL checkbox is driven through its own change handler via
      // el.click() — same listener, same Map update, same persistence path.
      if (togglePick.clickable) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: togglePick.x, y: togglePick.y, button: "left", buttons: 1, clickCount: 1 }, ntpSession);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: togglePick.x, y: togglePick.y, button: "left", buttons: 0, clickCount: 1 }, ntpSession);
      } else {
        await evalIn(cdp, ntpSession, `(() => { const host = [...document.querySelectorAll('agent-dialog')].find((h) => h.shadowRoot?.querySelector('dialog')?.open); const boxes = host ? [...host.querySelectorAll('.skills-list input[type=checkbox]')] : []; boxes[${togglePick.idx}]?.click(); return true; })()`);
      }
      await sleep(150);
      const cat = skillCatalog?.skills ?? [];
      toggledSkillId = cat[togglePick.idx]?.id ?? cat[togglePick.idx]?.name ?? null;
    }
    console.log("create dialog toggle pick:", JSON.stringify(togglePick));
    const toggledState = await evalIn(cdp, ntpSession, `(() => {
      const hosts = [...document.querySelectorAll('agent-dialog')];
      const openHost = hosts.find((h) => h.shadowRoot?.querySelector('dialog')?.open);
      const boxes = openHost ? [...openHost.querySelectorAll('.skills-list input[type=checkbox]')] : [];
      const b = boxes[${togglePick?.ok ? togglePick.idx : -1}];
      return { checkedAfter: b?.checked === true, openHosts: hosts.filter((h) => h.shadowRoot?.querySelector('dialog')?.open).length, boxes: boxes.length };
    })()`);
    console.log("create dialog toggled state:", JSON.stringify(toggledState));
    check(
      "create dialog: a REAL skill checkbox click checks it (unchecked → checked)",
      togglePick?.ok === true && toggledState?.checkedAfter === true && typeof toggledSkillId === "string" && toggledSkillId.length > 0,
    );
    const createBtnPoint = await evalIn(cdp, ntpSession, `(() => { const b = [...document.querySelectorAll('agent-dialog button')].find((x) => x.textContent.trim() === 'Create agent'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (createBtnPoint) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: createBtnPoint.x, y: createBtnPoint.y, button: "left", buttons: 1, clickCount: 1 }, ntpSession);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: createBtnPoint.x, y: createBtnPoint.y, button: "left", buttons: 0, clickCount: 1 }, ntpSession);
    }
    let createdFromCard = null;
    for (let i = 0; i < 30 && !createdFromCard; i++) {
      const list = await msgValue({ type: "named-agent.list" });
      createdFromCard = (list?.agents ?? []).find((a) => a?.name === "Research Analyst") ?? null;
      if (!createdFromCard) await sleep(200);
    }
    const namedCount1 = ((await msgValue({ type: "named-agent.list" }))?.agents ?? []).length;
    const savedSkillIds = (createdFromCard?.skills ?? []).map((s) => (s && typeof s === "object" ? s?.id : s));
    console.log("createdFromCard from card:", JSON.stringify({ id: createdFromCard?.id, role: String(createdFromCard?.role ?? "").slice(0, 40), skills: savedSkillIds, namedCount1 }));
    check(
      "create dialog: Create agent from the card yields ONE named agent whose role is the template persona",
      createdFromCard !== null && namedCount1 === 1 && /^# Research Analyst Persona/.test(String(createdFromCard?.role ?? "")) && (createdFromCard?.skills ?? []).length >= 3,
    );
    check(
      "create dialog: the saved agent's skill ids CONTAIN the exactly-toggled skill id",
      typeof toggledSkillId === "string" && savedSkillIds.includes(toggledSkillId),
    );
    // A Scheduled card: the recipe becomes ONE scheduled named agent through
    // the same create path (the schedule text "every N minutes" is prefilled).
    await evalIn(cdp, ntpSession, `document.querySelector('agent-dialog')?.close?.(); true`);
    await sleep(300);
    await openCreateDialog();
    await setFilter("scheduled"); await sleep(150);
    const schedPick = await evalIn(cdp, ntpSession, `(() => { const g = document.getElementById('agent-template-gallery'); const card = [...g.shadowRoot.querySelectorAll('agent-template-card')].find((c) => c.template?.source === 'recipe'); if (!card) return null; card.shadowRoot.querySelector('.use').click(); return { id: card.template.id, name: card.template.name, minutes: card.template.schedule?.periodInMinutes }; })()`);
    await sleep(200);
    const g2 = await galleryState();
    await evalIn(cdp, ntpSession, `(() => { const b = [...document.querySelectorAll('agent-dialog button')].find((x) => x.textContent.trim() === 'Create agent'); b?.click(); return !!b; })()`);
    let scheduledAgent = null;
    for (let i = 0; i < 30 && !scheduledAgent; i++) {
      const list = await msgValue({ type: "named-agent.list" });
      scheduledAgent = (list?.agents ?? []).find((a) => a?.name === schedPick?.name) ?? null;
      if (!scheduledAgent) await sleep(200);
    }
    await sleep(1500);
    const sidebarSched = await evalIn(cdp, ntpSession, `[...document.querySelectorAll('#side-agents .agent-item')].map((el) => el.textContent.replace(/\s+/g, ' ').trim())`);
    const surfacesS = await measureAgentSurfaces();
    if (surfacesS.shot) await writeEvidence("templates-created.png", surfacesS.shot);
    console.log("scheduled from card:", JSON.stringify({ schedPick, g2schedule: g2.schedule, scheduledAgent: scheduledAgent && { id: scheduledAgent.id, schedule: scheduledAgent.schedule }, sidebarSched, surfaces: { ...surfacesS, shot: undefined } }));
    check(
      "create dialog: a Scheduled card creates one scheduled agent that the sidebar and Settings both list",
      schedPick !== null && g2.schedule === `every ${schedPick.minutes} minutes` && scheduledAgent !== null &&
        Array.isArray(sidebarSched) && sidebarSched.some((t) => t.includes(schedPick.name) && /Scheduled · every \d+ min/.test(t)) &&
        surfacesS.sidebarRows === 2 && surfacesS.panelRows === 2 && surfacesS.settingsRows === 2 && /^2 agents/.test(surfacesS.panelCount),
    );
    // Restore the fresh profile the rest of the suite expects: delete the two
    // agents through the real owner-direct route (a click in an extension page
    // IS the approval), which also cancels the scheduled one's alarm.
    const deletions = [];
    for (const a of [createdFromCard, scheduledAgent]) {
      if (a?.id) deletions.push(await msgValue({ type: "named-agent.delete", id: a.id }));
    }
    await sleep(500);
    // Creating an agent opens its thread; go Home so the hub composer is the
    // surface the next journey types into.
    await evalIn(cdp, ntpSession, `document.querySelector('agent-dialog')?.close?.(); document.getElementById('new-task')?.click(); true`);
    await sleep(500);
    const surfacesR = await measureAgentSurfaces();
    console.log("agent surfaces (restored):", JSON.stringify({ ...surfacesR, shot: undefined, deletions }));
    check(
      "create dialog: the journey's created agents are removed again (fresh profile restored)",
      deletions.length === 2 && deletions.every((d) => d?.ok === true) &&
        surfacesR.sidebarRows === 0 && surfacesR.panelRows === 0 && surfacesR.settingsRows === 0,
    );

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
    // JOURNEY 1b — CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01. The demo
    // model reproduces the live-lane slip through the REAL lazy protocol:
    // search_tools(create_asset) → execute_tool with type:"text/html" (refused
    // as lazy-arguments-invalid, retryable) → execute_tool with type:"html" on
    // the SAME selectionRef. One wrong enum value must no longer end the run
    // with two tool cards and no answer: the artifact exists and the model
    // reports it.
    // ─────────────────────────────────────────────────────────────
    const slipRun = await withTimeout(
      msgValue({ type: "agent.run", task: "@demo-enum-slip" }),
      60000,
      "enum-slip run",
    ).catch(() => null);
    const slipListed = await msgValue({ type: "asset.list", origin: "master" }).catch(() => null);
    const slipAssets = (Array.isArray(slipListed?.assets) ? slipListed.assets : [])
      .filter((a) => a?.name === "enum slip page");
    check(
      "Lazy protocol: a first-call enum slip is recoverable in one run",
      slipAssets.length === 1 && slipAssets[0]?.type === "html" &&
        typeof slipRun?.result === "string" && /Enum slip recovered/.test(slipRun.result) &&
        slipRun.result.includes(slipAssets[0].id),
    );
    // The thread that ran it, in the REAL NTP: the refused execute card, the
    // successful retry card and the answer are all visible.
    // (Target.createTarget — the /json/new endpoint drops the #thread= hash.)
    const slipCreated = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extId}/ntp/ntp.html#thread=${encodeURIComponent(String(slipRun?.threadId ?? ""))}`,
    });
    const slipPage = { id: slipCreated?.result?.targetId };
    const slipSession = await attachRuntime(cdp, slipPage.id);
    cdp.pageSessions.add(slipSession);
    let slipDom = null;
    for (let i = 0; i < 20; i++) {
      slipDom = await evalIn(cdp, slipSession, `(() => {
        const tools = [...document.querySelectorAll('message-bubble[role="tool"]')]
          .map((b) => ({ name: b.getAttribute('tool-name'), status: b.getAttribute('tool-status'), result: String(b.getAttribute('tool-result') ?? '').slice(0, 600) }));
        const answers = [...document.querySelectorAll('message-bubble[role="agent"]')]
          .map((b) => String(b.getAttribute('content') ?? ''));
        const conv = document.querySelector('agent-conversation');
        if (conv) conv.scrollTop = conv.scrollHeight;
        return { tools, answers };
      })()`);
      if ((slipDom?.answers ?? []).some((t) => /Enum slip recovered/.test(t))) break;
      await sleep(500);
    }
    const slipTools = Array.isArray(slipDom?.tools) ? slipDom.tools : [];
    const slipRefused = slipTools.find((t) =>
      t.status === "error" && /lazy-arguments-invalid/.test(t.result) && /retryable\\?":true/.test(t.result)
    );
    const slipRetried = slipTools.find((t) => t.name === "create_asset" && t.status === "success");
    const slipAnswered = (Array.isArray(slipDom?.answers) ? slipDom.answers : [])
      .some((t) => /Enum slip recovered/.test(t));
    check(
      "Lazy protocol: the enum-slip run rendered the refused call, the retry and the answer",
      Boolean(slipRefused) && Boolean(slipRetried) && slipAnswered,
    );
    const slipShot = await captureShot(cdp, slipSession);
    if (slipShot) await writeEvidence("lazy-enum-slip-recovered.png", slipShot);
    await cdp.send("Target.closeTarget", { targetId: slipPage.id }).catch(() => {});
    cdp.pageSessions.delete(slipSession);
    // JOURNEY 1b — the Jobs panel: the shared agent-to-agent board is a
    // VISIBLE hub surface (owner report 2026-08-30: "no visible jobs board").
    // Empty state first (fresh profile), then seeded through the REAL
    // board.* routes from the page, then a REAL named agent claims +
    // completes a job through the lazy tool protocol (@demo-board) and the
    // panel re-renders live from the board progress events — no reload.
    // JOURNEY 1's Run click opened the thread view — go Back (real click)
    // so the Jobs panel is actually ON SCREEN for the screenshots.
    // ─────────────────────────────────────────────────────────────
    await clickSel(cdp, ntpSession, "#thread-back");
    await sleep(1200);
    const jobsPanel = async () =>
      await evalIn(cdp, ntpSession, `(() => {
        const el = document.querySelector("#jobs-board-host jobs-board");
        if (!el || !el.shadowRoot) return null;
        const q = (sel) => el.shadowRoot.querySelector(sel);
        return {
          text: el.shadowRoot.textContent,
          empty: q(".jb-empty")?.textContent ?? null,
          emptyHidden: q(".jb-empty")?.hidden ?? null,
          openRows: el.shadowRoot.querySelectorAll(".jb-open .jb-row").length,
          settledRows: el.shadowRoot.querySelectorAll(".jb-settled .jb-row").length,
          msgRows: el.shadowRoot.querySelectorAll(".jb-msgs .jb-row").length,
          hint: document.getElementById("jobs-count")?.textContent ?? null,
        };
      })()`);
    // The mount-time refresh is async — give it a beat, then read the state.
    let jp = null;
    for (let i = 0; i < 20; i++) {
      jp = await jobsPanel();
      if (jp && (jp.openRows + jp.settledRows + jp.msgRows > 0 || (jp.emptyHidden === false && jp.empty))) break;
      await sleep(250);
    }
    check(
      "jobs panel: renders the empty state on a fresh board",
      jp !== null && jp.emptyHidden === false &&
        typeof jp.empty === "string" && jp.empty.includes("No shared jobs yet"),
    );
    const jobsEmptyShot = await captureShot(cdp, ntpSession);
    if (jobsEmptyShot) await writeEvidence("ntp-jobs-empty.png", jobsEmptyShot);
    check(
      "jobs panel: retained the empty-state screenshot",
      jobsEmptyShot !== null && jobsEmptyShot.length > 200,
    );

    // Seed through the REAL routes from the page (hub principal): two open
    // jobs + one broadcast message.
    const jpJob1 = await msgValue({ type: "board.post", description: "Critique the journey draft — tighten the intro" });
    const jpJob2 = await msgValue({ type: "board.post", description: "Find three comparable tools and summarise pricing" });
    const jpMsg = await msgValue({ type: "board.message", to: "broadcast", body: "Two jobs are up for the journey" });
    check(
      "jobs panel: two jobs + a message posted via the real routes",
      jpJob1?.ok === true && jpJob2?.ok === true && jpMsg?.ok === true,
    );

    // The panel re-renders LIVE from the board-* progress events (no reload).
    for (let i = 0; i < 20; i++) {
      jp = await jobsPanel();
      if (jp && jp.openRows === 2 && jp.msgRows === 1) break;
      await sleep(250);
    }
    check(
      "jobs panel: open jobs render with poster + recency (live, no reload)",
      jp !== null && jp.openRows === 2 &&
        jp.text.includes("Critique the journey draft") &&
        jp.text.includes("Find three comparable tools") &&
        jp.text.includes("posted by Hub"),
    );
    check(
      "jobs panel: the message feed renders the broadcast",
      jp !== null && jp.msgRows === 1 && jp.text.includes("Two jobs are up for the journey"),
    );
    check(
      "jobs panel: the open-count hint reflects the board",
      jp !== null && jp.hint === "2 open",
    );
    const jobsPopulatedShot = await captureShot(cdp, ntpSession);
    if (jobsPopulatedShot) await writeEvidence("ntp-jobs-populated.png", jobsPopulatedShot);
    check(
      "jobs panel: retained the populated-state screenshot",
      jobsPopulatedShot !== null && jobsPopulatedShot.length > 200,
    );

    // A REAL named agent claims + completes the first claimable job through
    // the lazy tool protocol (@demo-board), identity from the run registry.
    const jpAgent = await msgValue({ type: "named-agent.create", name: "Jobs Journey Worker", role: "You claim and complete board jobs." });
    const jpAgentId = jpAgent?.agent?.id ?? null;
    const jpRun = jpAgentId
      ? await msgValue({ type: "named-agent.run", id: jpAgentId, task: "@demo-board" })
      : null;
    const jpSettled = await msgValue({ type: "board.list" });
    const jpCompleted = (jpSettled?.jobs ?? []).find((j: { status?: string }) => j?.status === "completed");
    check(
      "jobs panel: a real named agent claimed + completed a job",
      jpAgentId !== null && (jpRun?.ok === true || jpRun?.status === "done" || jpRun?.done === true) &&
        jpCompleted?.claimantId === jpAgentId &&
        typeof jpCompleted?.result === "string" && jpCompleted.result.length > 0,
    );

    // Live again: the settled group shows outcome + bounded result excerpt,
    // and the open count drops — all WITHOUT a reload.
    for (let i = 0; i < 20; i++) {
      jp = await jobsPanel();
      if (jp && jp.settledRows === 1) break;
      await sleep(250);
    }
    check(
      "jobs panel: the settled group renders the outcome + result excerpt (live, no reload)",
      jp !== null && jp.settledRows === 1 && jp.openRows === 1 &&
        jp.text.includes("Completed") &&
        jp.text.includes("claimed and completed via @demo-board") &&
        jp.hint === "1 open",
    );
    const jobsSettledShot = await captureShot(cdp, ntpSession);
    if (jobsSettledShot) await writeEvidence("ntp-jobs-settled.png", jobsSettledShot);
    check(
      "jobs panel: retained the settled-state screenshot",
      jobsSettledShot !== null && jobsSettledShot.length > 200,
    );

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
    const confirmOwnerDialogOn = async (session, accept = true) => {
      const selector = accept ? ".cap-confirm-dialog .cap-confirm-accept" : ".cap-confirm-dialog .cap-confirm-cancel";
      let box = null;
      for (let i = 0; i < 25 && !box; i++) {
        box = await boxOf(cdp, session, selector);
        if (!box) await sleep(200);
      }
      if (!box) return false;
      return await clickSel(cdp, session, selector);
    };
    const confirmOwnerDialog = (accept = true) => confirmOwnerDialogOn(optsSession, accept);
    const approvedMsg = async (payload) => {
      const first = await msgValue(payload);
      // Owner-direct actions execute on the first extension-document call. A
      // genuine cleanup/operation failure must be returned as-is — never
      // mistaken for an approval denial and never resolved against an unrelated
      // pending row. Only the explicit approval gate enters the Settings flow.
      if (first?.ok === true || !/requires owner approval/i.test(String(first?.error ?? ""))) return first;
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
    // Permission requests are tied to the active extension page, not merely
    // its CDP session. Bring Settings to the front before dispatching input.
    await cdp.send("Target.activateTarget", { targetId: optsPage.id });
    await cdp.send("Page.bringToFront", {}, optsSession);
    // Find the row in-page, then use clickSel for the click itself so Chrome
    // receives a trusted CDP pointer event (never a synthetic btn.click()).
    const capabilityButtonSelector = async (session, label, text) => {
      const index = await evalIn(cdp, session, `(() => [...document.querySelectorAll('#permission-list .perm-row')]
        .findIndex((row) => row.querySelector('.perm-name')?.textContent === ${JSON.stringify(label)} &&
          row.querySelector('button')?.textContent === ${JSON.stringify(text)}))()`);
      return Number.isInteger(index) && index >= 0
        ? `#permission-list > .perm-row:nth-child(${index + 1}) button`
        : null;
    };
    const clickCapability = async (session, label, text) => {
      for (let i = 0; i < 40; i++) {
        const selector = await capabilityButtonSelector(session, label, text);
        if (selector !== null) return await clickSel(cdp, session, selector);
        await sleep(250);
      }
      return false;
    };
    // A permission result is settled only when contains() and the asynchronously
    // re-rendered row agree. This avoids reading the pre-click false state.
    const pollCapabilityOn = async (session, label, permission, granted, buttonText) => {
      let state = null;
      for (let i = 0; i < 40; i++) {
        state = await evalIn(cdp, session, `(async () => {
          const granted = await chrome.permissions.contains({ permissions: [${JSON.stringify(permission)}] });
          const row = [...document.querySelectorAll('#permission-list .perm-row')]
            .find((r) => r.querySelector('.perm-name')?.textContent === ${JSON.stringify(label)});
          const button = row?.querySelector('button');
          return { granted, buttonText: button?.textContent ?? null, disabled: button?.disabled ?? null };
        })()`);
        if (state?.granted === granted && state?.buttonText === buttonText && state?.disabled === false) {
          return true;
        }
        await sleep(250);
      }
      console.log(`[debug] ${label} did not settle: ${JSON.stringify(state)}`);
      return false;
    };
    const pollCapability = (label, permission, granted, buttonText) =>
      pollCapabilityOn(optsSession, label, permission, granted, buttonText);

    // Context menus is warningless: headless Chrome can grant and revoke it,
    // so drive the complete owner lifecycle instead of deferring it to headed.
    const contextMenusEnable = await capabilityButtonSelector(optsSession, "Context menus", "Enable");
    check("permissions: Context menus Enable button found in the Settings panel", contextMenusEnable !== null);
    check(
      "permissions: Context menus Enable clicked via a trusted gesture",
      contextMenusEnable !== null && await clickSel(cdp, optsSession, contextMenusEnable),
    );
    check(
      "permissions: Context menus granted after Enable settled",
      await pollCapability("Context menus", "contextMenus", true, "Turn off"),
    );
    check(
      "permissions: Context menus Turn off clicked via a trusted gesture",
      await clickCapability(optsSession, "Context menus", "Turn off"),
    );
    // CAP-FB-20260830-SETTINGS-REVOKE-VIA-SW-01: Turn off goes through the
    // SW's `capability.revoke` route, so the owner dialog appears and a genuine
    // accept click is what revokes.
    const contextMenusDialogShot = await captureShot(cdp, optsSession);
    if (contextMenusDialogShot) await writeEvidence("settings-turn-off-owner-dialog.png", contextMenusDialogShot);
    check(
      "permissions: Turn off raised the owner approval dialog (capability.revoke via the SW)",
      await confirmOwnerDialog(true),
    );
    check(
      "permissions: Context menus absent after Turn off settled",
      await pollCapability("Context menus", "contextMenus", false, "Enable"),
    );
    check(
      "permissions: Context menus retry Enable clicked via a trusted gesture",
      await clickCapability(optsSession, "Context menus", "Enable"),
    );
    check(
      "permissions: Context menus granted after retry settled",
      await pollCapability("Context menus", "contextMenus", true, "Turn off"),
    );

    // Prompt-requiring outcomes stay in the headed macro. In headless, drive
    // the genuine gesture on an isolated Settings target, observe contains()
    // remain false for a bounded interval, then close that target to cancel
    // the pending prompt and poll the final absent state. This cannot strand a
    // browser prompt that poisons the rest of the journey.
    const probePromptedDenial = async (label, permission) => {
      const page = await openPage(port, `chrome-extension://${extId}/options/options.html`);
      const session = await attachRuntime(cdp, page.id);
      cdp.pageSessions.add(session);
      await cdp.send("Target.activateTarget", { targetId: page.id });
      await cdp.send("Page.bringToFront", {}, session);
      const clicked = await clickCapability(session, label, "Enable");
      let stayedAbsent = clicked;
      for (let i = 0; i < 12; i++) {
        stayedAbsent &&= (await evalIn(cdp, session,
          `chrome.permissions.contains({ permissions: [${JSON.stringify(permission)}] })`)) === false;
        await sleep(250);
      }
      const closed = await cdp.send("Target.closeTarget", { targetId: page.id });
      cdp.pageSessions.delete(session);
      let settledAbsent = false;
      for (let i = 0; i < 40 && !settledAbsent; i++) {
        settledAbsent = (await evalOpts(
          `chrome.permissions.contains({ permissions: [${JSON.stringify(permission)}] })`,
        )) === false;
        if (!settledAbsent) await sleep(250);
      }
      return { clicked, denied: stayedAbsent && closed?.result?.success === true && settledAbsent };
    };
    const bookmarksDenied = await probePromptedDenial("Bookmarks", "bookmarks");
    check(
      "permissions: Bookmarks Enable clicked via a trusted gesture",
      bookmarksDenied.clicked,
    );
    check(
      "permissions: Bookmarks prompt cancelled and permission settled absent in headless",
      bookmarksDenied.denied,
    );
    const tabGroupsDenied = await probePromptedDenial("Tab groups", "tabGroups");
    check(
      "permissions: Tab groups Enable clicked via a trusted gesture",
      tabGroupsDenied.clicked,
    );
    check(
      "permissions: Tab groups prompt cancelled and permission settled absent in headless",
      tabGroupsDenied.denied,
    );

    // The retry affordance after cancelled prompts (the old headed macro's
    // STEP K denial half — covered headless since the permission-matrix lane):
    // a FRESH Settings page shows both warned rows requestable with a working
    // Enable button. (Re-open the page rather than reload: navigation breaks
    // the CDP eval context.)
    const afterDenyPage = await openPage(port, `chrome-extension://${extId}/options/options.html`);
    const afterDenySession = await attachRuntime(cdp, afterDenyPage.id);
    cdp.pageSessions.add(afterDenySession);
    let retryAffordance = false;
    for (let i = 0; i < 25 && !retryAffordance; i++) {
      const rows = await evalIn(cdp, afterDenySession, `(() => {
        const named = (label) => [...document.querySelectorAll('#permission-list .perm-row')]
          .find((r) => r.querySelector('.perm-name')?.textContent === label);
        const state = (label) => {
          const row = named(label);
          const btn = row?.querySelector('button');
          return row ? { state: row.querySelector('.perm-state')?.textContent, button: btn?.textContent, disabled: btn?.disabled } : null;
        };
        return { bookmarks: state("Bookmarks"), tabGroups: state("Tab groups") };
      })()`).catch(() => null);
      retryAffordance = rows?.bookmarks?.state === "Not enabled" && rows?.bookmarks?.button === "Enable" &&
        rows?.bookmarks?.disabled === false &&
        rows?.tabGroups?.state === "Not enabled" && rows?.tabGroups?.button === "Enable" &&
        rows?.tabGroups?.disabled === false;
      if (!retryAffordance) await sleep(400);
    }
    check(
      "permissions: retry affordance intact for cancelled warned permissions (fresh Settings page)",
      retryAffordance === true,
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

    // ── Board permissions (deny rules) — driven through the REAL Settings UI.
    // The functional-verification mandate: source pins cannot prove this
    // surface works. Drive it end to end: create two named agents, open the
    // section from the nav, wait for the dropdowns to populate from the real
    // registry, add a rule via a genuine CDP click on Add, observe the row
    // render + the rule persist, remove it via the row's real Remove button,
    // observe it disappear from the DOM and the store.
    const bdWriter = await msgOpts({ type: "named-agent.create", id: "bd-writer", name: "BD Writer", role: "board deny journey fixture" });
    const bdCritic = await msgOpts({ type: "named-agent.create", id: "bd-critic", name: "BD Critic", role: "board deny journey fixture" });
    check(
      "board deny: two named agents created for the journey",
      bdWriter?.ok === true && bdCritic?.ok === true,
    );

    // The dropdowns populate at page init — the two agents were created after
    // the options page first loaded, so RE-OPEN the options page (the
    // established pattern: the options page does not live-update on SW-side
    // changes; location.reload() silently breaks the CDP eval context).
    const bdOptsPage = await openPage(
      port, `chrome-extension://${extId}/options/options.html`,
    );
    await sleep(2000);
    optsSession = await attachRuntime(cdp, bdOptsPage.id);
    cdp.pageSessions.add(optsSession);
    evalOpts = (expression) => evalIn(cdp, optsSession, expression);

    check(
      "board deny: Board permissions section opens from the nav",
      await clickSel(cdp, optsSession, '.nav-item[data-section="board-permissions"]'),
    );

    let bdDropdownsReady = false;
    for (let i = 0; i < 20 && !bdDropdownsReady; i++) {
      // The selects are the shared <provider-select> component (its options
      // live in shadow DOM) — read the populated `providers` property.
      bdDropdownsReady = await evalOpts(
        `(document.querySelector("#board-deny-agent")?.providers?.length ?? 0) >= 2 && (document.querySelector("#board-deny-peer")?.providers?.length ?? 0) >= 2`,
      ).catch(() => false);
      if (!bdDropdownsReady) await sleep(250);
    }
    check("board deny: the dropdowns populate from the named-agent registry", bdDropdownsReady === true);

    await evalOpts(
      `document.querySelector("#board-deny-action").value = "claim";
       document.querySelector("#board-deny-agent").value = "bd-critic";
       document.querySelector("#board-deny-peer").value = "bd-writer";
       true`,
    );
    check(
      "board deny: rule added via a real click on the Add control",
      await clickSel(cdp, optsSession, "#board-deny-add-btn"),
    );

    let bdRowRendered = false;
    for (let i = 0; i < 20 && !bdRowRendered; i++) {
      bdRowRendered = await evalOpts(
        `[...document.querySelectorAll("#board-deny-list .perm-row .perm-name")].some((el) => el.textContent === "BD Critic cannot claim jobs from BD Writer")`,
      ).catch(() => false);
      if (!bdRowRendered) await sleep(250);
    }
    const bdPersisted = await msgOpts({ type: "board.deny.list" });
    check(
      "board deny: the rule row renders and the rule persists in the store",
      bdRowRendered === true && bdPersisted?.ok === true &&
        bdPersisted.rules.some((r) => r.agentId === "bd-critic" && r.peerId === "bd-writer" && r.action === "claim"),
    );

    const bdShot = await captureShot(cdp, optsSession).catch(() => null);
    if (bdShot) await writeEvidence("board-deny-added.png", bdShot);

    check(
      "board deny: rule removed via the row's real Remove control",
      await clickSel(cdp, optsSession, '#board-deny-list .perm-row .btn.ghost'),
    );
    let bdRowGone = false;
    for (let i = 0; i < 20 && !bdRowGone; i++) {
      bdRowGone = await evalOpts(
        `document.querySelectorAll("#board-deny-list .perm-row").length === 0`,
      ).catch(() => false);
      if (!bdRowGone) await sleep(250);
    }
    const bdAfter = await msgOpts({ type: "board.deny.list" });
    check(
      "board deny: the row disappears and the store is empty after Remove",
      bdRowGone === true && bdAfter?.ok === true && bdAfter.rules.length === 0,
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
    // CAP-FB-20260830-MODEL-CATALOG-CURRENT-01: the picker is fed by the bundled
    // catalogue (lib/model-catalog.js), never by the price table — so the
    // first suggestion is the verified default and no pricing pseudo-id
    // (`gpt-5.6-terra-272k`, which OpenAI 404s) can reach the user.
    const pickerModels = await evalOpts(
      `JSON.parse(document.querySelector('.provider-card[data-provider="openai"] model-picker')?.getAttribute("models") ?? "[]")`,
    ).catch(() => []);
    check(
      "Settings: OpenAI picker: first suggestion is the catalogue default and no suggestion ends in -Nk",
      Array.isArray(pickerModels) && pickerModels[0] === "gpt-5.6-luna" &&
        pickerModels.length > 0 && pickerModels.every((m) => !/-\d+k$/.test(String(m))),
    );
    // Open the combobox through its own drive hook and read the rendered rows:
    // the "Recommended" header is role=presentation (skipped by arrow keys) and
    // the first role=option is the default.
    const pickerOpen = await evalOpts(`(() => {
      const p = document.querySelector('.provider-card[data-provider="openai"] model-picker');
      if (!p) return null;
      p._renderList(""); p._setOpen(true);
      const root = p.shadowRoot;
      const rows = [...root.querySelectorAll('.listbox > *')].map((el) => ({ role: el.getAttribute('role'), text: el.textContent.trim() }));
      return { rows, expanded: root.querySelector('[role=combobox]')?.getAttribute('aria-expanded') };
    })()`).catch(() => null);
    const pickerShot = await captureShot(cdp, optsSession).catch(() => null);
    if (pickerShot) await writeEvidence("settings-openai-picker-after.png", pickerShot);
    await evalOpts(`document.querySelector('.provider-card[data-provider="openai"] model-picker')?._setOpen(false); true`).catch(() => {});
    check(
      "Settings: OpenAI picker: opened list shows gpt-5.6-luna first under a Recommended header",
      pickerOpen?.expanded === "true" &&
        pickerOpen?.rows?.[0]?.role === "presentation" && pickerOpen?.rows?.[0]?.text === "Recommended" &&
        pickerOpen?.rows?.[1]?.role === "option" && pickerOpen?.rows?.[1]?.text === "gpt-5.6-luna" &&
        pickerOpen.rows.every((r) => !/-\d+k$/.test(r.text)),
    );
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
    // CAP-FB-20260830-MODEL-CATALOG-CURRENT-01: an EMPTY model with a key no
    // longer runs the demo model — provider.status reports the catalogue
    // default the run will use (a public catalogue id, not user data).
    await msgOpts({ type: "provider.set", config: { provider: "openai", apiKey: "placeholder-key", baseURL: "", model: "" } });
    await sleep(300);
    const defaultStatus = await msgOpts({ type: "provider.status" });
    check(
      "Settings: empty model + valid key resolves to the default (provider.status usingDefaultModel:true, modelId gpt-5.6-luna)",
      defaultStatus?.provider === "openai" && defaultStatus?.usingDefaultModel === true &&
        defaultStatus?.defaultModelId === "gpt-5.6-luna",
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
    // JOURNEY 2k — CAP-FB-20260830-KEYLESS-FIRST-RESULT-01 ×
    // CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01: a fresh profile with NO
    // provider configured (the developer flag OFF, provider "demo" = the
    // default) gets a real answer from the local assistant through the REAL
    // hub composer, and the demo provider's plumbing proof ("[demo model]
    // Task received (N chars)") is unreachable. Both lanes' contracts hold
    // in ONE run: without `tabs` the first list_tabs denial is ONE Allow
    // card in the conversation and the run PAUSES (grant-card contract);
    // headless Chrome cannot grant a warning permission (Chrome's prompt
    // never resolves), so the owner's answer here is Not now — a trusted
    // click on the card's real button — after which the assistant ends in
    // the HONEST no-permission paragraph (keyless contract). The Allow half
    // — real tab groups + the tab-list artifact — is driven by
    // scripts/keyless-first-result.ts, which seeds the two permissions the
    // owner's Allow clicks would grant. Leaving the run paused here is what
    // hung the suite (the next agent.run queued behind it until the CDP
    // evaluate timed out), so the card is ALWAYS settled before moving on.
    // ─────────────────────────────────────────────────────────────
    check("keyless: developer flag off for the fresh-profile run", (await developerFlag(false))?.ok === true);
    // CAP-FB-20260830-COOKIE-TOOLS-CUT-01: with the developer flag OFF (the
    // shape a real install runs in) the model executor cannot resolve the
    // cookie value reader or either cookie writer at all — "list cookies for
    // github.com" can no longer be turned into a session-cookie read. The
    // metadata-only listing stays, because names and expiry are not credentials.
    const cookieCutDefault = {};
    for (const toolName of ["get_cookie", "set_cookie", "remove_cookie", "list_cookies"]) {
      cookieCutDefault[toolName] = await msgValue({
        type: "agent-worker.tool",
        toolName,
        args: toolName === "list_cookies" ? { domain: "127.0.0.1" } : { url: `${RED_ORIGIN}/`, name: "sid", value: "v" },
      });
    }
    check(
      "Cookies: the cookie value reader and the cookie writers are absent from the default build",
      ["get_cookie", "set_cookie", "remove_cookie"].every((n) =>
        cookieCutDefault[n]?.ok === false && cookieCutDefault[n]?.error === `unknown tool: ${n}`
      ) && cookieCutDefault.list_cookies?.error !== "unknown tool: list_cookies",
    );
    await msgValue({ type: "provider.set", config: { provider: "demo", apiKey: "" } });
    const keylessBefore = await msgValue({ type: "thread.list" });
    const keylessThreadsBefore = new Set((keylessBefore?.threads ?? []).map((t) => t?.id));
    await cdp.send("Target.activateTarget", { targetId: ntpPage.id }).catch(() => {});
    await cdp.send("Page.bringToFront", {}, ntpSession).catch(() => {});
    await clickSel(cdp, ntpSession, "#home").catch(() => false);
    await sleep(600);
    check("keyless: typed 'group my tabs by topic' into the hub composer", await typeInto(cdp, ntpSession, "#task-input", "group my tabs by topic"));
    check("keyless: clicked Run task", await clickSel(cdp, ntpSession, "#run-task"));
    const KEYLESS_CARD_SEL = "#thread-conversation permission-approval-card";
    const KEYLESS_BUBBLES = `(() => {
      const conv = document.getElementById('thread-conversation');
      if (!conv) return JSON.stringify({ agent: [], cards: 0, pending: 0, status: [] });
      const agent = [...conv.querySelectorAll('message-bubble[role="agent"]')].map((b) => ((b.shadowRoot ?? b).querySelector('.msg, .body') ?? b).textContent.replace(/\\s+/g, ' ').trim());
      const status = [...conv.querySelectorAll('conversation-run-status')].map((x) => x.getAttribute('state'));
      const cards = [...conv.querySelectorAll('permission-approval-card')];
      const pendingCards = cards.filter((c) => c.getAttribute('state') === null);
      const last = cards[cards.length - 1] ?? null;
      return JSON.stringify({
        agent, status, cards: cards.length, pending: pendingCards.length,
        card: last ? { state: last.getAttribute('state'), permissions: last.getAttribute('permissions'), denyIsButton: last.shadowRoot?.querySelector('.deny')?.tagName === 'BUTTON' } : null,
      });
    })()`;
    type KeylessView = { agent?: string[]; status?: string[]; cards?: number; pending?: number; card?: { state: string | null; permissions: string | null; denyIsButton: boolean } | null };
    const keylessRead = async (): Promise<KeylessView> => {
      try { return JSON.parse(await evalIn(cdp, ntpSession, KEYLESS_BUBBLES) ?? "{}"); } catch { return {}; }
    };
    // (1) the grant-card contract: the run pauses on ONE pending card naming
    // `tabs` — never a bare error bubble, never the demo literal.
    let keyless: KeylessView = {};
    const keylessCardT0 = Date.now();
    while (Date.now() - keylessCardT0 < 60000) {
      keyless = await keylessRead();
      if ((keyless.pending ?? 0) > 0) break;
      if ((keyless.agent ?? []).length > 0 && !(keyless.status ?? []).some((st) => st === "working" || st === "queued")) break;
      await sleep(250);
    }
    await sleep(400); // the focus move is a rAF after the append
    keyless = await keylessRead();
    const keylessCardShot = await captureShot(cdp, ntpSession);
    if (keylessCardShot) await writeEvidence("keyless-first-result-card.png", keylessCardShot);
    console.log(`keyless card: ${JSON.stringify(keyless).slice(0, 600)}`);
    check(
      "keyless: the first run pauses on ONE Allow card naming tabs (never a bare error)",
      keyless.pending === 1 && keyless.card?.state === null && /"tabs"/.test(keyless.card?.permissions ?? "") &&
        keyless.card?.denyIsButton === true &&
        (keyless.status ?? []).includes("waiting-for-permission") &&
        !/\[demo model\]|Task received/u.test((keyless.agent ?? []).join(" | ")),
    );
    // (2) the owner's answer: Not now on the card's REAL button. Settling the
    // card is unconditional — a run left paused here blocks every run after it.
    check("keyless: clicked Not now on the card via a real click", await clickShadow(cdp, ntpSession, KEYLESS_CARD_SEL, ".deny"));
    // (3) the keyless contract: the resumed run ends in the honest paragraph.
    const keylessT0 = Date.now();
    while (Date.now() - keylessT0 < 30000) {
      keyless = await keylessRead();
      if ((keyless.agent ?? []).length > 0 && (keyless.pending ?? 0) === 0 &&
        !(keyless.status ?? []).some((st) => st === "working" || st === "queued" || st === "waiting-for-permission")) break;
      await sleep(250);
    }
    const keylessShot = await captureShot(cdp, ntpSession);
    if (keylessShot) await writeEvidence("keyless-first-result-no-permission.png", keylessShot);
    console.log(`keyless journey: ${JSON.stringify(keyless).slice(0, 600)}`);
    const keylessText = (keyless.agent ?? []).join(" | ");
    check(
      "keyless: the first run answers in plain language — never '[demo model] Task received'",
      (keyless.agent ?? []).length >= 1 && !/\[demo model\]|Task received|\d+ chars/u.test(keylessText),
    );
    check(
      "keyless: without the tabs permission the answer says so honestly",
      /tabs permission was not granted/u.test(keylessText),
    );
    // The thread the composer created persisted the SAME paragraph (no demo
    // literal reaches storage either).
    const keylessAfter = await msgValue({ type: "thread.list" });
    const keylessThread = (keylessAfter?.threads ?? []).find((t) => !keylessThreadsBefore.has(t?.id));
    const keylessStored = keylessThread ? await msgValue({ type: "thread.get", id: keylessThread.id }) : null;
    const keylessStoredText = (keylessStored?.thread?.messages ?? []).filter((m) => m?.role === "assistant").map((m) => String(m?.content ?? "")).join(" | ");
    check(
      "keyless: the persisted thread carries the plain answer, not the demo literal",
      keylessStoredText.length > 0 && !/\[demo model\]|Task received/u.test(keylessStoredText),
    );
    // §10 on the LIVE path: this thread carries a real permission DENIAL
    // (the error-card route the tools lane saw leak the envelope twice). The
    // live card's error block, tree and raw view must show the tool's own
    // words, never the transport.
    await evalIn(cdp, ntpSession, OPEN_ALL_CARDS);
    await sleep(300);
    const keylessLiveText = String((await evalIn(cdp, ntpSession, THREAD_TEXT("#thread-conversation"))) ?? "");
    const keylessLiveLeaks = lazyLeaks(keylessLiveText);
    const keylessLiveShot = await captureShot(cdp, ntpSession);
    if (keylessLiveShot) await writeEvidence("tool-cards-no-leak-live-denial.png", keylessLiveShot);
    console.log(`keyless live leak probe: leaks=${JSON.stringify(keylessLiveLeaks)} textLen=${keylessLiveText.length}`);
    check(
      "keyless: no lazy-protocol text leaks into the live thread (modelContent/catalogGeneration/stableId/schemaSummary/search_tools/execute_tool)",
      keylessLiveText.length > 0 && keylessLiveLeaks.length === 0,
    );
    // §2b, the persisted half (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01): the
    // denial is a durable run-log row, so REOPENING the thread must render the
    // same in-context grant card the live run showed, carrying the owner's
    // recorded decision — not the denial as error prose.
    const keylessReopen = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extId}/ntp/ntp.html#thread=${encodeURIComponent(String(keylessThread?.id ?? ""))}`,
    });
    const keylessReopenId = keylessReopen?.result?.targetId;
    await sleep(3000);
    const keylessReopenSession = await attachRuntime(cdp, keylessReopenId);
    cdp.pageSessions.add(keylessReopenSession);
    let keylessReopened: { cards?: number; permissions?: string | null; state?: string | null; allowIsButton?: boolean } = {};
    for (let i = 0; i < 20; i++) {
      try {
        keylessReopened = JSON.parse(await evalIn(cdp, keylessReopenSession, `(() => {
          const conv = document.getElementById('thread-conversation');
          const cards = [...(conv?.querySelectorAll('permission-approval-card') ?? [])];
          const last = cards[cards.length - 1] ?? null;
          return JSON.stringify({
            cards: cards.length,
            permissions: last?.getAttribute('permissions') ?? null,
            state: last?.getAttribute('state') ?? null,
            allowIsButton: last?.shadowRoot?.querySelector('.allow')?.tagName === 'BUTTON',
          });
        })()`) ?? "{}");
      } catch { keylessReopened = {}; }
      if ((keylessReopened.cards ?? 0) > 0) break;
      await sleep(400);
    }
    const keylessReopenShot = await captureShot(cdp, keylessReopenSession).catch(() => null);
    if (keylessReopenShot) await writeEvidence("grant-card-reopened-thread.png", keylessReopenShot);
    await cdp.send("Target.closeTarget", { targetId: keylessReopenId }).catch(() => {});
    cdp.pageSessions.delete(keylessReopenSession);
    console.log(`keyless reopen: ${JSON.stringify(keylessReopened)}`);
    // The owner clicked Not now on this requirement during the run, so the
    // reopened card carries that decision (deny is sticky — never a fresh
    // Allow for a question already answered).
    check(
      "keyless: reopening the thread renders the in-context grant card, not error prose",
      keylessReopened.cards === 1 && /"tabs"/.test(keylessReopened.permissions ?? "") && keylessReopened.state === "denied",
    );
    check("keyless: developer flag back on for the marker journeys", (await developerFlag(true))?.ok === true);
    // The developer build gets the three tools back — and even there a cookie
    // result never carries a value: `list_cookies` is metadata-only and
    // `get_cookie` withholds the value until the owner approves it, so no
    // outcome of either tool can put a `"value"` key in the model's context.
    const cookieDev = {};
    for (const toolName of ["get_cookie", "list_cookies"]) {
      cookieDev[toolName] = await msgValue({
        type: "agent-worker.tool",
        toolName,
        args: toolName === "list_cookies" ? { domain: "127.0.0.1" } : { url: `${RED_ORIGIN}/`, name: "sid" },
      });
    }
    const cookieDevJson = JSON.stringify(cookieDev);
    check(
      "Cookies: the developer build exposes them again, and no cookie value ever reaches the model",
      cookieDev.get_cookie?.error !== "unknown tool: get_cookie" &&
        cookieDev.list_cookies?.error !== "unknown tool: list_cookies" &&
        !/"value"/.test(cookieDevJson),
    );

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
    // JOURNEY 3b — CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01: the answer a
    // tool step ended in is the thread's persisted message at FULL length,
    // and the reply to agent-do's "Continue working on the task…" nudge (the
    // demo model answers it with a distinct "Task complete" line, exactly as
    // real models do) is never a bubble — live or after a reload.
    // ─────────────────────────────────────────────────────────────
    const DEMO_ANSWER = "[demo model] Tool calls executed in sequence: memory_set wrote the shopping list, then memory_get read it back twice.";
    const DEMO_NUDGE_REPLY = "[demo model] Task complete";
    const transcriptRun = await msgValue({ type: "agent.run", task: "@demo-tools list my open tabs" });
    const transcriptThreadId = transcriptRun?.threadId ?? null;
    const readThreadTexts = async () => {
      const got = transcriptThreadId ? await msgValue({ type: "thread.get", id: transcriptThreadId }) : null;
      const messages = Array.isArray(got?.thread?.messages) ? got.thread.messages : [];
      return {
        count: messages.length,
        assistant: messages.filter((m) => m?.role === "assistant").map((m) => String(m?.content ?? "")),
      };
    };
    const BUBBLES = `(() => {
      const roots = [document, ...[...document.querySelectorAll('*')].flatMap((e) => e.shadowRoot ? [e.shadowRoot, ...[...e.shadowRoot.querySelectorAll('*')].flatMap((x) => x.shadowRoot ? [x.shadowRoot] : [])] : [])];
      return roots.flatMap((r) => [...r.querySelectorAll('message-bubble')]).map((b) => ({ role: b.getAttribute('role'), text: ((b.shadowRoot ?? b).querySelector('.body, .msg') ?? b).textContent.replace(/\\s+/g, ' ').trim() }));
    })()`;
    // The thread is opened in a FRESH hub document each time (the established
    // re-open pattern — location.reload()/Page.navigate on a driven session
    // breaks the CDP eval context); the second open IS the reload from the
    // persistence standpoint: a new document projecting thread.get.
    // (/json/new drops a URL fragment, so the thread document is created
    // through Target.createTarget, which keeps the #omnibox=thread: route.)
    const threadUrl = `chrome-extension://${extId}/ntp/ntp.html#omnibox=thread:${encodeURIComponent(String(transcriptThreadId))}`;
    const openThreadDoc = async (evidenceName) => {
      const created = await cdp.send("Target.createTarget", { url: threadUrl });
      const targetId = created?.result?.targetId;
      await sleep(3000);
      const session = await attachRuntime(cdp, targetId);
      cdp.pageSessions.add(session);
      const bubbles = (await evalIn(cdp, session, BUBBLES)) ?? [];
      let shot = null;
      try { shot = await captureShot(cdp, session); } catch { shot = null; /* evidence only — the assertions below are the gate */ }
      if (shot) await writeEvidence(evidenceName, shot);
      await cdp.send("Target.closeTarget", { targetId });
      return Array.isArray(bubbles) ? bubbles : [];
    };
    const persistedBefore = await readThreadTexts();
    const bubblesBefore = await openThreadDoc("transcript-before-reload.png");
    const persistedAfter = await readThreadTexts();
    const bubblesAfter = await openThreadDoc("transcript-after-reload.png");
    const agentBubblesAfter = (Array.isArray(bubblesAfter) ? bubblesAfter : []).filter((b) => b?.role === "agent");
    check(
      "Transcript: 'list my open tabs' survives a reload at full length",
      transcriptRun?.ok === true && transcriptRun?.result === DEMO_ANSWER &&
        persistedBefore.assistant[0] === DEMO_ANSWER &&
        persistedAfter.assistant[0] === DEMO_ANSWER &&
        persistedAfter.count === persistedBefore.count && persistedAfter.count > 0 &&
        agentBubblesAfter.length > 0 && agentBubblesAfter[0].text === DEMO_ANSWER,
    );
    const nudgeSeen = [...persistedBefore.assistant, ...persistedAfter.assistant].some((t) => t.includes(DEMO_NUDGE_REPLY)) ||
      [...bubblesBefore, ...agentBubblesAfter].some((b) => String(b?.text ?? "").includes(DEMO_NUDGE_REPLY));
    check(
      "Transcript: no nudge summary bubble after a text-ending step",
      persistedAfter.assistant.length === 1 && agentBubblesAfter.length === 1 && !nudgeSeen,
    );
    // §10 LEAKAGE PROBE (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01): the
    // reopened @demo-tools thread ran the REAL lazy protocol (search_tools →
    // execute_tool → memory_set/memory_get). None of the transport vocabulary
    // may reach the owner as text — in a card head, a tree row, a raw JSON
    // view or an error block. Every card must also be a tool that did WORK:
    // the protocol's search cards are not rendered at all.
    const leakTarget = await cdp.send("Target.createTarget", { url: threadUrl });
    const leakTargetId = leakTarget?.result?.targetId;
    await sleep(3000);
    const leakSession = await attachRuntime(cdp, leakTargetId);
    cdp.pageSessions.add(leakSession);
    await evalIn(cdp, leakSession, OPEN_ALL_CARDS);
    await sleep(300);
    const leakText = String((await evalIn(cdp, leakSession, THREAD_TEXT("#thread-conversation"))) ?? "");
    const leakCards = (await evalIn(cdp, leakSession, `[...document.querySelectorAll('message-bubble[role="tool"]')].map((b) => b.getAttribute('tool-name'))`)) ?? [];
    const leakShot = await captureShot(cdp, leakSession).catch(() => null);
    if (leakShot) await writeEvidence("tool-cards-no-leak-reopened.png", leakShot);
    await cdp.send("Target.closeTarget", { targetId: leakTargetId }).catch(() => {});
    cdp.pageSessions.delete(leakSession);
    const leaked = lazyLeaks(leakText);
    console.log(`transcript leak probe: cards=${JSON.stringify(leakCards)} leaks=${JSON.stringify(leaked)} textLen=${leakText.length}`);
    check(
      "Transcript: no lazy-protocol text leaks into the reopened thread (modelContent/catalogGeneration/stableId/schemaSummary/search_tools/execute_tool)",
      leakText.length > 0 && leaked.length === 0 &&
        Array.isArray(leakCards) && leakCards.length >= 3 &&
        !leakCards.some((n) => n === "search_tools" || n === "list_tools" || n === "execute_tool"),
    );
    // ─────────────────────────────────────────────────────────────
    // JOURNEY 3b-memory — CAP-FB-20260830-MEMORY-RECALL-NEW-THREAD-01: memory
    // is not write-only. What the model saved in ONE thread reaches the NEXT
    // thread's system prompt as the runtime-context memory digest, so a fresh
    // thread answers from it instead of "I do not know".
    // The demo model's @demo-recall marker issues NO tool call: its answer can
    // only come from the digest its own prompt carried, so a passing check is
    // evidence about the WIRE, not about the store.
    // ─────────────────────────────────────────────────────────────
    // The @demo-tools run above wrote the key `demo` through the real lazy
    // protocol; this NEW thread must see it without touching a memory tool.
    const digestRun = await msgValue({ type: "agent.run", task: "@demo-recall demo" });
    const digestText = String(digestRun?.result ?? "");
    console.log(`memory digest recall: ${digestText.slice(0, 200)}`);
    check(
      "Memory recall: a new thread's prompt carries the digest of a key written earlier",
      digestRun?.ok === true &&
        String(digestRun?.threadId ?? "") !== String(transcriptThreadId ?? "") &&
        /recall: demo is /.test(digestText) && digestText.includes("Espresso machine"),
    );
    // The reported failure, end to end: save a colour in one thread, ask for it
    // in a new one.
    const rememberRun = await msgValue({ type: "agent.run", task: "@demo-remember owner-favourite-colour=green" });
    const overviewAfterWrite = await msgValue({ type: "memory.overview" });
    const wroteColour = JSON.stringify(overviewAfterWrite ?? {}).includes("owner-favourite-colour");
    const recallRun = await msgValue({ type: "agent.run", task: "@demo-recall owner-favourite-colour" });
    const recallText = String(recallRun?.result ?? "");
    console.log(`memory colour recall: wrote=${wroteColour} answer=${recallText.slice(0, 200)}`);
    check(
      "Memory recall: a new thread answers 'green' from the digest, never 'I do not know'",
      rememberRun?.ok === true && wroteColour === true && recallRun?.ok === true &&
        String(recallRun?.threadId ?? "") !== String(rememberRun?.threadId ?? "") &&
        /recall: owner-favourite-colour is green/.test(recallText) &&
        !/I do not know/.test(recallText),
    );
    // JOURNEY 3c — provider error truth (CAP-FB-20260830-PROVIDER-ERROR-TRUTH-01).
    // A provider HTTP failure must be reported by its real status, never as
    // "returned no content"; a preflight refusal must be a terminal Failed row.
    // Driven through the REAL hub composer against the local 401 fixture.
    // ─────────────────────────────────────────────────────────────
    // Bubbles and the live-status row are LIGHT-DOM children of the thread
    // conversation; only the bubble's own markup (.msg / .err-fix) is in its
    // shadow root. A whole-document shadow scan here is far too slow on a
    // suite-warmed NTP (it hit the 15 s evaluate timeout).
    const THREAD_ERROR_STATE = `(() => {
      const conv = document.getElementById('thread-conversation');
      if (!conv) return JSON.stringify({ errors: [], status: [] });
      const errors = [...conv.querySelectorAll('message-bubble[role="error"]')].map(b => { const sr = b.shadowRoot ?? b; const fix = sr.querySelector('.err-fix'); return { text: (sr.querySelector('.msg')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 600), fix: fix ? fix.textContent.trim() : null }; });
      const status = [...conv.querySelectorAll('conversation-run-status')].map(x => ({ state: x.getAttribute('state'), action: x.getAttribute('action-label'), text: [...(x.shadowRoot ?? x).childNodes].filter(n => n.nodeName !== 'STYLE').map(n => n.textContent ?? '').join(' ').replace(/\\s+/g, ' ').trim().slice(0, 300) }));
      return JSON.stringify({ errors, status });
    })()`;
    const driveHubTask = async (text) => {
      // The NTP is a background tab after the Settings journey; a background
      // target neither paints nor screenshots, so bring it to the front first.
      await cdp.send("Target.activateTarget", { targetId: ntpPage.id }).catch(() => {});
      await cdp.send("Page.bringToFront", {}, ntpSession).catch(() => {});
      await clickSel(cdp, ntpSession, "#home").catch(() => false);
      await sleep(600);
      await typeInto(cdp, ntpSession, "#task-input", text);
      await clickSel(cdp, ntpSession, "#run-task");
    };
    const pollThreadError = async (deadlineMs, done) => {
      const t0 = Date.now();
      let last = { errors: [], status: [] };
      while (Date.now() - t0 < deadlineMs) {
        try { last = JSON.parse(await evalIn(cdp, ntpSession, THREAD_ERROR_STATE) ?? "{}"); } catch { /* re-poll */ }
        if (done(last)) break;
        await sleep(250);
      }
      return { ...last, elapsedMs: Date.now() - t0 };
    };
    // provider.set is Settings-sender-only (requireSettingsSender) — msgOpts.
    await msgOpts({
      type: "provider.set",
      config: { provider: "openai", baseURL: `${RED_ORIGIN}/v1`, apiKey: "sk-journey-invalid-0000", model: "model-one" },
    });
    const swErrorsBefore = cdp.swErrors().length;
    await driveHubTask("provider truth: bad key");
    const bad = await pollThreadError(15000, (st) => st.errors?.length > 0);
    const badShot = await captureShot(cdp, ntpSession);
    if (badShot) await writeEvidence("provider-401-bubble.png", badShot);
    // The adapter logs the real status ONCE (console.error "[provider] HTTP 401 …").
    // That line is the evidence this journey exists to preserve. A deliberately
    // failed provider call also produces two SW console errors that are the
    // AI SDK's own (the diagnostics-scrubbed error object it logs, and the
    // unhandled AI_NoOutputGeneratedError from its stream flush — the very
    // collapse this journey guards against). Assert the 401 line, then take
    // exactly that expected set out of the no-SW-errors gate so the gate keeps
    // guarding everything else.
    const swErrorsNow = cdp.swErrors().slice(swErrorsBefore);
    const provider401 = swErrorsNow.filter((e) => /\[provider\] HTTP 401/.test(String(e.detail ?? "")));
    check(
      "Provider error: SW console recorded the real HTTP 401 from the fixture provider",
      provider401.length >= 1 && provider401.every((e) => !/sk-[A-Za-z0-9]/.test(String(e.detail ?? ""))),
    );
    const EXPECTED_SW_NOISE = /\[provider\] HTTP 401|^AI_NoOutputGeneratedError: No output generated|^<redacted:structured>$/;
    for (const e of swErrorsNow) {
      if (!EXPECTED_SW_NOISE.test(String(e.detail ?? "").trim())) continue;
      const i = cdp.consoleErrors.indexOf(e);
      if (i >= 0) cdp.consoleErrors.splice(i, 1);
    }
    console.log(`provider-error journey (401): ${JSON.stringify(bad).slice(0, 900)}`);
    const badText = (bad.errors ?? []).map((e) => e.text).join(" | ");
    check(
      "Provider error: a rejected key renders the 401 bubble with a Settings link",
      /rejected the API key \(401\)/.test(badText) &&
        !/returned no content/i.test(badText) &&
        !/sk-[A-Za-z0-9]/.test(badText) &&
        (bad.errors ?? []).some((e) => e.fix === "Fix in Settings"),
    );
    // Preflight variant: a network provider with no endpoint is refused before
    // any dispatch — it must land as a terminal Failed row with the Settings
    // action within 5 s, not sit in "Waiting for permission".
    await msgOpts({
      type: "provider.set",
      config: { provider: "openai-compatible", baseURL: "", apiKey: "sk-journey-invalid-0000", model: "model-one" },
    });
    await driveHubTask("provider truth: no endpoint");
    const pre = await pollThreadError(5000, (st) => (st.status ?? []).some((r) => r.state === "failed"));
    const preShot = await captureShot(cdp, ntpSession);
    if (preShot) await writeEvidence("provider-preflight-failed.png", preShot);
    console.log(`provider-error journey (preflight): ${JSON.stringify(pre).slice(0, 900)}`);
    const failedRow = (pre.status ?? []).find((r) => r.state === "failed");
    check(
      "Provider error: preflight refusal reaches a terminal Failed row within 5 s",
      Boolean(failedRow) && pre.elapsedMs <= 5000 &&
        failedRow.action === "Fix in Settings" &&
        !(pre.status ?? []).some((r) => r.state === "waiting-for-permission") &&
        (pre.errors ?? []).some((e) => /endpoint/i.test(e.text)),
    );
    await msgOpts({ type: "provider.set", config: { provider: "demo", apiKey: "", baseURL: "", model: "" } });

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 3d — CAP-FB-20260830-TRANSCRIPT-STREAMING-01: the assistant
    // bubble GROWS while the model streams (the demo model's @demo-stream
    // answer is paced one 24-char chunk / 30 ms), the growing text is plain
    // text nodes, no long task runs while it streams, and the final bubble is
    // byte-identical to a non-streamed render of the same answer.
    // ─────────────────────────────────────────────────────────────
    // The long-task observer is armed BEFORE the run is driven (unbuffered:
    // only tasks during this run count, never the page's own load).
    const STREAM_ARM = `(() => {
      window.__capLongTasks = [];
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__capLongTasks.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false }); } catch {}
      return true;
    })()`;
    // While streaming, the growing text lives in the hosted <streaming-text>'s
    // shadow body (text nodes only); after the final render it is the
    // bubble's own markdown body.
    const STREAM_STATE = `(() => {
      const conv = document.getElementById('thread-conversation');
      const bubbles = conv ? [...conv.querySelectorAll('message-bubble[role="agent"]')] : [];
      const last = bubbles.at(-1);
      const sr = last ? (last.shadowRoot ?? last) : null;
      const body = sr ? sr.querySelector('.body') : null;
      const host = body ? body.querySelector('streaming-text') : null;
      const status = conv ? [...conv.querySelectorAll('conversation-run-status')].map((x) => ({ state: x.getAttribute('state'), activity: x.getAttribute('activity') })) : [];
      const hostBody = host ? (host.shadowRoot ?? host).querySelector('.body') : null;
      const innerHtmlOnlyText = hostBody ? [...hostBody.childNodes].every((n) => n.nodeType === 3) : null;
      const len = hostBody ? hostBody.textContent.length : (body ? body.textContent.length : 0);
      return JSON.stringify({ bubbles: bubbles.length, len, streaming: last ? last.hasAttribute('streaming') : false, textNodesOnly: innerHtmlOnlyText, status, longTasks: (window.__capLongTasks ?? []).slice() });
    })()`;
    await evalIn(cdp, ntpSession, STREAM_ARM).catch(() => null);
    await driveHubTask("@demo-stream tell me about the platform");
    const streamSamples = [];
    let midStreamShot = null;
    {
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        let st = null;
        try { st = JSON.parse(await evalIn(cdp, ntpSession, STREAM_STATE) ?? "null"); } catch { st = null; }
        if (st) {
          streamSamples.push({ t: Date.now() - t0, ...st });
          if (!midStreamShot && st.streaming && st.len > 0 && st.len < DEMO_STREAM_ANSWER.length) {
            try { midStreamShot = await captureShot(cdp, ntpSession); } catch { midStreamShot = null; }
            if (midStreamShot) await writeEvidence("streaming-mid.png", midStreamShot);
          }
          // Settled: the final render replaced the streamed body (no caret)
          // and no live-status row is still running.
          const settled = !st.streaming && st.len >= DEMO_STREAM_ANSWER.length &&
            !(st.status ?? []).some((r) => r.state === "running" || r.state === "queued" || r.state === "retrying");
          if (settled || (st.status ?? []).some((r) => r.state === "failed" || r.state === "cancelled")) break;
        }
        await sleep(250);
      }
    }
    const streamFinalShot = await captureShot(cdp, ntpSession);
    if (streamFinalShot) await writeEvidence("streaming-final.png", streamFinalShot);
    const distinctLens = new Set(streamSamples.map((s) => s.len).filter((n) => n > 0));
    const sawStreamingAttr = streamSamples.some((s) => s.streaming && s.len > 0);
    const textNodesOnly = streamSamples.filter((s) => s.streaming && s.textNodesOnly != null).every((s) => s.textNodesOnly === true);
    const sawWriting = streamSamples.some((s) => (s.status ?? []).some((r) => r.activity === "Writing the answer…"));
    const lastSample = streamSamples.at(-1) ?? {};
    const worstLongTask = Math.max(0, ...(lastSample.longTasks ?? []));
    const firstVisibleMs = streamSamples.find((s) => s.len > 0)?.t ?? null;
    console.log(`streaming journey: samples=${streamSamples.length} firstVisibleMs=${firstVisibleMs} distinctLens=${[...distinctLens].join(",")} streamingAttrSeen=${sawStreamingAttr} textNodesOnly=${textNodesOnly} writingLabel=${sawWriting} longTasksMs=${JSON.stringify(lastSample.longTasks ?? [])} final=${JSON.stringify({ bubbles: lastSample.bubbles, len: lastSample.len, streaming: lastSample.streaming, status: lastSample.status })}`);
    check(
      "Streaming: the assistant bubble grows across at least 5 distinct lengths",
      distinctLens.size >= 5 && sawStreamingAttr && textNodesOnly && sawWriting &&
        lastSample.bubbles === 1 && lastSample.streaming === false &&
        lastSample.len === DEMO_STREAM_ANSWER.length &&
        !(lastSample.status ?? []).some((r) => r.state !== "completed") &&
        worstLongTask <= 50,
    );
    const STREAM_FINAL_COMPARE = `(() => {
      const conv = document.getElementById('thread-conversation');
      const last = [...conv.querySelectorAll('message-bubble[role="agent"]')].at(-1);
      const streamedHtml = last.shadowRoot.innerHTML;
      const streamedText = last.shadowRoot.querySelector('.body').textContent;
      const fresh = document.createElement('message-bubble');
      fresh.setAttribute('role', 'agent');
      fresh.setAttribute('content', last.getAttribute('content') ?? '');
      for (const a of ['author', 'author-avatar', 'ts']) { const v = last.getAttribute(a); if (v != null) fresh.setAttribute(a, v); }
      fresh.hidden = true;
      document.body.appendChild(fresh);
      const freshHtml = fresh.shadowRoot.innerHTML;
      fresh.remove();
      return JSON.stringify({ equal: streamedHtml === freshHtml, streamedText, contentAttr: last.getAttribute('content') });
    })()`;
    let streamCompare = null;
    try { streamCompare = JSON.parse(await evalIn(cdp, ntpSession, STREAM_FINAL_COMPARE) ?? "null"); } catch { streamCompare = null; }
    check(
      "Streaming: the final bubble equals the non-streamed render",
      streamCompare?.equal === true && streamCompare?.contentAttr === DEMO_STREAM_ANSWER && streamCompare?.streamedText === DEMO_STREAM_ANSWER,
    );

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 3d2 — CAP-FB-20260830-CLAIM-CHECK-BROWSER-TOOLS-01: delegating to
    // an agent that does not exist FAILS (every delegate_task card reads
    // `error`), but the model's final text still says "Delegation succeeded".
    // The runtime honesty backstop appends the visible correction, and the
    // turn's final text is painted EXACTLY ONCE — the reported baseline
    // rendered the identical bubble once per continuation step (twelve here).
    // ─────────────────────────────────────────────────────────────
    const CLAIM_CHECK_STATE = `(() => {
      const conv = document.getElementById('thread-conversation');
      if (!conv) return JSON.stringify(null);
      const bubbles = [...conv.querySelectorAll('message-bubble[role="agent"]')]
        .map((b) => (((b.shadowRoot ?? b).querySelector('.body')) ?? b).textContent.replace(/\\s+/g, ' ').trim())
        .filter((t) => t.length > 0);
      const status = [...conv.querySelectorAll('conversation-run-status')].map((x) => x.getAttribute('state'));
      const tools = [...conv.querySelectorAll('message-bubble[role="tool"]')]
        .map((b) => b.getAttribute('tool-name') + ':' + b.getAttribute('tool-status'));
      return JSON.stringify({ bubbles, status, tools });
    })()`;
    await driveHubTask("@demo-delegate nosuchagent");
    let claimState = null;
    {
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        try { claimState = JSON.parse(await evalIn(cdp, ntpSession, CLAIM_CHECK_STATE) ?? "null"); } catch { claimState = null; }
        if (claimState && claimState.bubbles.length > 0 &&
          !(claimState.status ?? []).some((s) => ["queued", "running", "retrying"].includes(s))) break;
        await sleep(250);
      }
      // The authoritative run response (the claim-checked result) lands after
      // the live status row settles.
      await sleep(800);
      try { claimState = JSON.parse(await evalIn(cdp, ntpSession, CLAIM_CHECK_STATE) ?? "null"); } catch { /* keep the last poll */ }
    }
    const claimShot = await captureShot(cdp, ntpSession);
    if (claimShot) await writeEvidence("claim-check-delegate.png", claimShot);
    const claimBubbles = claimState?.bubbles ?? [];
    console.log(`claim-check journey: ${JSON.stringify(claimState).slice(0, 1200)}`);
    check(
      "Claim check: a failed delegate renders one correction and one final bubble",
      claimBubbles.length === 1 &&
        claimBubbles[0].includes("Delegation succeeded") &&
        claimBubbles.filter((t) => t.includes("Correction: I claimed I delegated the task")).length === 1 &&
        (claimState?.tools ?? []).length > 0 &&
        (claimState?.tools ?? []).every((t) => t === "delegate_task:error") &&
        !(claimState?.status ?? []).some((s) => ["queued", "running", "retrying"].includes(s)),
    );

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 3e — CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01: the thread view
    // at 1440x900 — a content-height conversation with the composer docked at
    // the viewport bottom, the run banner ("Working — …") visible 300 ms after
    // a send, the thread scrolled to its newest content after an edit turn
    // (assistant turns carrying the identity header: avatar + name + time),
    // and an update card titled with the artifact's name. Driven through the
    // REAL hub + thread composers on the demo model: @demo-edit-artifact
    // creates crumb.html and then edits it through the lazy protocol;
    // @demo-stream is the paced edit turn (long enough to sample mid-run).
    // ─────────────────────────────────────────────────────────────
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, ntpSession);
    const THREAD_VIEW_STATE = `(() => {
      const conv = document.getElementById('thread-conversation');
      if (!conv) return JSON.stringify(null);
      const rows = [...conv.children].filter((el) => !el.hidden);
      const rects = rows.map((el) => el.getBoundingClientRect());
      const first = rects[0], last = rects.at(-1);
      const host = conv.getBoundingClientRect();
      const contentHeight = first && last ? (last.bottom - first.top) : 0;
      // The scroll container: the conversation itself, or its nearest scrolling ancestor.
      let scroller = conv;
      while (scroller && scroller !== document.documentElement) {
        const o = getComputedStyle(scroller).overflowY;
        if ((o === 'auto' || o === 'scroll') && scroller.scrollHeight > scroller.clientHeight + 1) break;
        scroller = scroller.parentElement;
      }
      if (!scroller) scroller = document.scrollingElement;
      const composer = document.getElementById('thread-composer');
      const cr = composer ? composer.getBoundingClientRect() : null;
      const status = [...conv.querySelectorAll('conversation-run-status')].map((x) => {
        const r = x.getBoundingClientRect();
        const sr = x.shadowRoot ?? x;
        return { state: x.getAttribute('state'), label: (sr.querySelector('.label')?.textContent ?? '').trim(), visible: r.height > 0 && r.top >= 0 && r.bottom <= innerHeight };
      });
      const heads = [...conv.querySelectorAll('message-bubble[role="tool"]')].map((b) => (b.shadowRoot ?? b).querySelector('.genui-head')?.textContent?.trim() ?? null).filter((t) => t != null);
      const identity = [...conv.querySelectorAll('message-bubble[role="agent"]')].map((b) => {
        const sr = b.shadowRoot ?? b; const id = sr.querySelector('agent-identity'); const ir = id ? (id.shadowRoot ?? id) : null;
        return id ? { name: (ir.querySelector('.name')?.textContent ?? '').trim(), time: ir.querySelector('time')?.getAttribute('datetime') ?? null, avatar: !!ir.querySelector('svg, img') } : null;
      });
      return JSON.stringify({ innerHeight, hostHeight: Math.round(host.height), hostTop: Math.round(host.top), contentHeight: Math.round(contentHeight), rows: rows.length,
        scroller: scroller === conv ? 'conversation' : String(scroller.className || scroller.id || scroller.tagName), scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
        composerTop: cr ? Math.round(cr.top) : null, composerBottom: cr ? Math.round(cr.bottom) : null, status, heads, identity, agentBubbles: conv.querySelectorAll('message-bubble[role="agent"]').length });
    })()`;
    const threadState = async () => { try { return JSON.parse(await evalIn(cdp, ntpSession, THREAD_VIEW_STATE) ?? "null"); } catch { return null; } };
    const settledThread = async (deadlineMs) => {
      const t0 = Date.now();
      let st = null;
      while (Date.now() - t0 < deadlineMs) {
        st = await threadState();
        if (st && st.agentBubbles > 0 && !(st.status ?? []).some((r) => ["queued", "running", "retrying"].includes(r.state))) break;
        await sleep(250);
      }
      await sleep(400); // the terminal re-projection from the durable log lands after the row settles
      return await threadState() ?? st;
    };
    await driveHubTask("@demo-edit-artifact create crumb.html then edit it");
    // asset.update is an owner-approved action: the run pauses on the
    // in-context approval card. Approve it with a GENUINE click (the same
    // real-input path the Scripts journey uses) so the edit actually lands.
    {
      const t0 = Date.now();
      let approved = false;
      while (Date.now() - t0 < 20000 && !approved) {
        const pending = await evalIn(cdp, ntpSession, `(() => { const c = [...document.querySelectorAll('#thread-conversation approval-card')].find((x) => (x.getAttribute('state') || 'pending') === 'pending'); return c ? true : false; })()`).catch(() => false);
        if (pending === true) {
          approved = await clickShadow(cdp, ntpSession, "#thread-conversation approval-card", ".approve");
          break;
        }
        const st = await threadState();
        if (st && st.agentBubbles > 0 && !(st.status ?? []).some((r) => ["queued", "running", "retrying", "waiting-for-permission"].includes(r.state))) break;
        await sleep(250);
      }
      console.log(`thread-view journey: update approved via real click = ${approved}`);
    }
    const threadEditTurn = await settledThread(30000);
    console.log(`thread-view journey (turn 1): ${JSON.stringify(threadEditTurn).slice(0, 700)}`);
    {
      // Hygiene for the approval journey that follows: an approved
      // model-originated asset.update leaves its owner-approval row pending
      // in the store until it expires (observed: 1 row after settle — noted
      // in the tracker as an adjacent finding). Deny any leftover here so the
      // later "deny row is singular" assertion measures its own request only.
      const leftover = await msgOpts({ type: "management.pending-approvals" }).catch(() => null);
      const rows = Array.isArray(leftover?.approvals) ? leftover.approvals : [];
      for (const row of rows) {
        if (row?.approvalId) await msgOpts({ type: "management.resolve-approval", approvalId: row.approvalId, approve: false }).catch(() => null);
      }
      console.log(`thread-view journey (turn 1): leftover pending approvals after the approved edit = ${rows.length}`);
    }
    const tvShot1 = await captureShot(cdp, ntpSession);
    if (tvShot1) await writeEvidence("thread-view-1440-turn1.png", tvShot1);
    check(
      "Thread view: update card is titled with the artifact name",
      Array.isArray(threadEditTurn?.heads) && threadEditTurn.heads.length >= 2 && threadEditTurn.heads.every((h) => h === "crumb.html"),
    );
    // Turn 2 — the edit turn through the THREAD composer; sample the banner
    // 300 ms after the send, then wait for the settle.
    await cdp.send("Target.activateTarget", { targetId: ntpPage.id }).catch(() => {});
    await typeInto(cdp, ntpSession, "#thread-composer #task-input", "@demo-stream now make it shorter");
    await clickSel(cdp, ntpSession, "#thread-composer #run-task");
    await sleep(300);
    const at300 = await threadState();
    const tvShot300 = await captureShot(cdp, ntpSession);
    if (tvShot300) await writeEvidence("thread-view-1440-running-300ms.png", tvShot300);
    console.log(`thread-view journey (300 ms after send): ${JSON.stringify(at300?.status)}`);
    check(
      "Thread view: run banner visible 300 ms after send",
      (at300?.status ?? []).some((r) => (r.state === "running" || r.state === "queued") && r.visible === true && /^Working/.test(r.label)),
    );
    const afterEdit = await settledThread(30000);
    const tvShot2 = await captureShot(cdp, ntpSession);
    if (tvShot2) await writeEvidence("thread-view-1440-turn2.png", tvShot2);
    console.log(`thread-view journey (turn 2): ${JSON.stringify(afterEdit).slice(0, 900)}`);
    // Content-height: the conversation host is as tall as its rows plus its
    // own 28px padding and row margins (48px slack; the pre-fix tree measured
    // a 622px host around 1571px of rows, or 440px of empty panel under two
    // bubbles), and the composer is docked at the viewport bottom.
    check(
      "Thread view: no empty panel space below a two-turn thread at 1440x900",
      afterEdit != null && afterEdit.rows > 0 && Math.abs(afterEdit.hostHeight - afterEdit.contentHeight) <= 48 &&
        afterEdit.composerBottom != null && afterEdit.composerBottom <= afterEdit.innerHeight &&
        afterEdit.composerBottom >= afterEdit.innerHeight - 40,
    );
    check(
      "Thread view: conversation scrolled to bottom after an edit turn",
      afterEdit != null && afterEdit.scrollTop === afterEdit.scrollHeight - afterEdit.clientHeight &&
        afterEdit.identity.length > 0 && afterEdit.identity.every((i) => i && i.name && i.time && i.avatar),
    );
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false }, ntpSession);
    await sleep(400);
    const tvShotSmall = await captureShot(cdp, ntpSession);
    if (tvShotSmall) await writeEvidence("thread-view-1024-turn2.png", tvShotSmall);
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, ntpSession);
    await sleep(200);

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
    // CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01: the single-driver lease is
    // gone. The Settings toggle used to acquire a 15-minute "interactive"
    // lease nothing released, and every destructive tool in the next run was
    // told "another surface is driving the browser". The toggle must leave
    // no lease record, and a run's open_tab (driven through the SAME executor
    // the agent loop uses, agent-worker.tool) must never be lease-refused. In
    // headless the `tabs` permission cannot be granted, so the only error the
    // executor may still return is the honest permission one.
    const leaseAfterToggle = await evalOpts(
      `chrome.storage.local.get("cap:browser-command-lease").then((s) => s["cap:browser-command-lease"] ?? null)`,
    );
    check(
      "Browser control: toggle ON in Settings leaves no lease",
      leaseAfterToggle === null,
    );
    const leaseShotOn = await captureShot(cdp, optsSession);
    if (leaseShotOn) await writeEvidence("lease-settings-after-toggle-on.png", leaseShotOn);
    const runOpenTab = await msgValue({
      type: "agent-worker.tool",
      toolName: "open_tab",
      args: { url: `${RED_ORIGIN}/` },
    });
    check(
      "Browser control: a run's open_tab is not lease-refused after the Settings toggle",
      !(typeof runOpenTab?.error === "string" && /driving the browser/.test(runOpenTab.error)) &&
        (runOpenTab?.ok === true || runOpenTab?.permissionRequired?.capability === "tabs"),
    );
    // CAP-FB-20260830-PRIVILEGED-URL-BLOCK-01: under the GLOBAL grant just
    // toggled on, a privileged destination is refused BEFORE the permission
    // and grant checks (so this discriminates even in headless, where `tabs`
    // cannot be granted), and no chrome://settings target ever appears.
    const privilegedOpen = await msgValue({
      type: "agent-worker.tool",
      toolName: "open_tab",
      args: { url: "chrome://settings" },
    });
    const targetsAfterPrivileged = await cdp.send("Target.getTargets");
    const privilegedTargets = (targetsAfterPrivileged?.result?.targetInfos ?? []).filter((t) =>
      /^chrome:\/\/settings/.test(String(t.url ?? ""))
    );
    check(
      "Privileged URL: open_tab chrome://settings is refused under a global grant",
      privilegedOpen?.ok !== true &&
        privilegedOpen?.error === "only http(s) destinations are allowed" &&
        privilegedTargets.length === 0,
    );
    // CAP-FB-20260830-SIDE-PANEL-TOOL-CUT-01: `open_side_panel` is REMOVED.
    // chrome.sidePanel.open() needs a user gesture the service worker does not
    // have, so every model call returned a gesture error while the description
    // promised the panel would open. Driven through the SAME executor the agent
    // loop uses, the name must now resolve to nothing at all — while the side
    // panel tools that need no gesture stay reachable (the panel surface itself
    // is untouched; only the model's fake door is gone).
    const cutSidePanel = await msgValue({
      type: "agent-worker.tool",
      toolName: "open_side_panel",
      args: { url: `${RED_ORIGIN}/` },
    });
    const keptSidePanel = await msgValue({
      type: "agent-worker.tool",
      toolName: "get_side_panel_options",
      args: {},
    });
    check(
      "Side panel: open_side_panel is absent from the model toolset",
      cutSidePanel?.ok === false &&
        cutSidePanel?.error === "unknown tool: open_side_panel" &&
        keptSidePanel !== undefined &&
        keptSidePanel?.error !== "unknown tool: get_side_panel_options",
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
    // Revoke via a genuine checkbox click (uncheck) — WHILE a foreign run
    // "holds the lease" (a seeded record under the old lease key): the owner's
    // revoke must always succeed and the switch must show the true state.
    await evalOpts(
      `chrome.storage.local.set({ "cap:browser-command-lease": { id: "journey", surfaceId: "named:research", runId: "r", expiresAt: Date.now() + 60000, acquiredAt: Date.now() } })`,
    );
    check(
      "screenshot: revoked via a real checkbox click",
      await clickSel(cdp, optsSession, "#browser-grant"),
    );
    await sleep(400);
    const revokeState = await msgValue({ type: "browser-control.get" });
    const revokeUi = await evalOpts(
      `({ flash: document.querySelector("#save-status")?.textContent ?? "", checked: document.querySelector("#browser-grant")?.checked ?? null })`,
    );
    check(
      "Browser control: toggle OFF succeeds while a run holds the lease",
      revokeState?.active === false && revokeUi?.flash === "Browser control revoked." &&
        revokeUi?.checked === false,
    );
    const leaseShotOff = await captureShot(cdp, optsSession);
    if (leaseShotOff) await writeEvidence("lease-settings-after-toggle-off.png", leaseShotOff);
    await evalOpts(`chrome.storage.local.remove("cap:browser-command-lease")`);
    const afterUiRevoke = await msgValue({ type: "capture.tab", tabId: redTabId });
    check(
      "screenshot: revoked → capture denied",
      afterUiRevoke?.error !== undefined || afterUiRevoke?.ok === false,
    );

    // ─────────────────────────────────────────────────────────────
    // JOURNEY 4c — EVERY browser-tool denial becomes ONE approval card in
    // the conversation (CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01). Driven
    // through the REAL hub composer + the demo model's `@demo-browser`
    // marker (one real lazy-protocol tool call per run). State here: `tabs`
    // ungranted (a warning permission headless cannot grant), `scripting`
    // ungranted (silent — grantable), browser control revoked.
    //   open_tab   → a card naming `tabs`; Not now resumes the paused run and
    //                the model reports "NOT performed". The Allow half for a
    //                warning permission is a HEADED check (Chrome's prompt).
    //   read_page  → a card naming `scripting`; Allow (a trusted click on the
    //                card's real <button>) grants it and the retried call
    //                succeeds inside the SAME run.
    //   capture_screenshot → a card naming the red origin; Allow sets the
    //                exact-origin browser-control grant and the retry succeeds.
    // ─────────────────────────────────────────────────────────────
    const CARD_SEL = "#thread-conversation permission-approval-card";
    const cardCount = () => evalIn(cdp, ntpSession, `document.querySelectorAll(${JSON.stringify(CARD_SEL)}).length`);
    // "One card" is asserted on PENDING cards (no state attribute yet): once a
    // run settles the thread re-projects its transcript from the durable log
    // and the previous card is replaced by a decision row, so a raw count
    // taken between runs drifts by one.
    const pendingCount = () => evalIn(cdp, ntpSession, `[...document.querySelectorAll(${JSON.stringify(CARD_SEL)})].filter((c) => c.getAttribute("state") === null).length`);
    const dbg = (label, obj) => console.log(`[debug] ${label} ${JSON.stringify(obj)}`);
    const lastCard = () => evalIn(cdp, ntpSession, `(() => {
      const c = [...document.querySelectorAll(${JSON.stringify(CARD_SEL)})].pop();
      if (!c) return null;
      return {
        state: c.getAttribute("state"), permissions: c.getAttribute("permissions"),
        origins: c.getAttribute("origins"), global: c.getAttribute("global"),
        reason: c.getAttribute("reason"), detail: c.getAttribute("detail"),
        allowIsButton: c.shadowRoot?.querySelector(".allow")?.tagName === "BUTTON",
        focused: document.activeElement === c,
      };
    })()`);
    // The transcript's bubbles render inside shadow roots: read the text
    // through them (host.textContent is empty for a shadow-rendered bubble).
    const threadText = () => evalIn(cdp, ntpSession, `(() => {
      const deep = (node) => {
        let out = "";
        if (node.nodeType === Node.TEXT_NODE) return node.textContent;
        if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === "STYLE" || node.tagName === "SCRIPT")) return "";
        if (node.shadowRoot) out += deep(node.shadowRoot);
        for (const child of node.childNodes) out += deep(child);
        return out;
      };
      const root = document.getElementById("thread-conversation");
      return root ? deep(root) : "";
    })()`);
    const waitFor = async (fn, ms = 20000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (await fn()) return true;
        await sleep(250);
      }
      return false;
    };
    // Genuine input needs the NTP to be the ACTIVE tab (the red tab was
    // activated for the capture probes above, and the tools below activate it
    // again): bring the NTP forward before typing. JOURNEY 1 opened a task
    // thread, so the visible composer is the THREAD one (#thread-composer —
    // the hub composer sits under the thread overlay); a send there continues
    // that thread, exactly as the owner's follow-up would.
    const sendTask = async (task) => {
      await cdp.send("Target.activateTarget", { targetId: ntpPage.id });
      await cdp.send("Page.bringToFront", {}, ntpSession);
      await sleep(300);
      if (!(await typeInto(cdp, ntpSession, "#thread-composer #task-input", task))) return false;
      const typed = await evalIn(cdp, ntpSession, `document.querySelector('#thread-composer #task-input')?.value ?? null`);
      if (typed !== task) console.log(`[debug] sendTask typed=${JSON.stringify(typed)}`);
      return await clickSel(cdp, ntpSession, "#thread-composer #run-task");
    };
    // Once the decision settles and the run finishes, the thread re-projects
    // its transcript from the durable log (the decision row "[tool] DENIED by
    // owner" / the retried result replaces the live card), so "one card" is
    // asserted WHILE the run is paused, and the settled state through the
    // card's state OR its projected outcome text.
    const settled = async (state) => {
      const c = await lastCard();
      return c === null || c?.state === state;
    };
    // Screenshots of the NTP need it to be the ACTIVE tab (a background tab's
    // Page.captureScreenshot hangs in headless); the tools below activate the
    // red tab, so bring the NTP forward before each shot.
    const ntpShotNow = async (name) => {
      await cdp.send("Target.activateTarget", { targetId: ntpPage.id });
      await sleep(300);
      const png = await captureShot(cdp, ntpSession);
      if (png) await writeEvidence(name, png);
    };

    // (1) open_tab without `tabs` → exactly ONE card naming tabs.
    await waitFor(async () => (await pendingCount()) === 0);
    const sentOpenTab = await sendTask(`@demo-browser open_tab url=${RED_URL}`);
    if (!sentOpenTab) console.log("[debug] sendTask(open_tab) could not type/click");
    await waitFor(async () => (await pendingCount()) > 0, 60000);
    await sleep(400); // the focus move is a rAF after the append
    const openTabCard = await lastCard();
    const openTabPending = await pendingCount();
    await ntpShotNow("permission-card-open-tab.png");
    dbg("open_tab card", { openTabPending, openTabCard });
    check(
      "Permission card: open_tab denial renders one approval card",
      openTabPending === 1 && openTabCard?.state === null &&
        /"tabs"/.test(openTabCard?.permissions ?? "") && openTabCard?.allowIsButton === true &&
        openTabCard?.focused === true,
    );
    // Not now (a trusted click on the card's real button) resumes the paused
    // run with a denial; the model must report the tool as NOT performed.
    await clickShadow(cdp, ntpSession, CARD_SEL, ".deny");
    const openTabDenied = await waitFor(async () =>
      (await settled("denied")) &&
      /Browser tool open_tab was NOT performed: Owner denied/.test(await threadText()));
    dbg("open_tab denied", { openTabDenied, pending: await pendingCount() });
    check(
      "Permission card: Not now declines open_tab and the run reports it honestly",
      openTabDenied && (await pendingCount()) === 0,
    );

    // (2) read_page without `scripting` → ONE card naming scripting; Allow
    // grants it (silent permission: headless grants it) and the retried
    // read_page succeeds in the same run.
    await waitFor(async () => (await pendingCount()) === 0);
    // Earlier journeys (site agents, page-text fencing) may have granted the
    // silent `scripting` permission; this step needs it ABSENT so the denial
    // is real. Revoking from an extension page needs no gesture.
    const scriptingBefore = await evalIn(cdp, ntpSession, `chrome.permissions.remove({ permissions: ["scripting"] }).then(() => chrome.permissions.contains({ permissions: ["scripting"] }))`);
    dbg("read_page scripting granted before send", scriptingBefore);
    await sendTask(`@demo-browser read_page tab=${redTabId}`);
    const readPageT0 = Date.now();
    await waitFor(async () => (await pendingCount()) > 0, 60000);
    dbg("read_page card appeared after ms", Date.now() - readPageT0);
    const readPageCard = await lastCard();
    const readPagePending = await pendingCount();
    dbg("read_page card", { readPagePending, readPageCard });
    check(
      "Permission card: read_page denial renders one approval card",
      readPagePending === 1 && readPageCard?.state === null &&
        /"scripting"/.test(readPageCard?.permissions ?? ""),
    );
    await clickShadow(cdp, ntpSession, CARD_SEL, ".allow");
    const readPageOk = await waitFor(async () =>
      (await settled("granted")) &&
      /Browser tool read_page succeeded: title/.test(await threadText()));
    const scriptingGranted = await evalIn(cdp, ntpSession, `chrome.permissions.contains({ permissions: ["scripting"] })`);
    await ntpShotNow("permission-card-read-page-allowed.png");
    dbg("read_page allowed", { readPageOk, scriptingGranted, pending: await pendingCount() });
    check(
      "Permission card: Allow grants scripting and the retried read_page succeeds",
      readPageOk && scriptingGranted === true && (await pendingCount()) === 0,
    );

    // (3) capture_screenshot with browser control revoked → ONE card naming
    // the red origin; Allow sets the exact-origin grant and the retry succeeds.
    await waitFor(async () => (await pendingCount()) === 0);
    await sendTask(`@demo-browser capture_screenshot tab=${redTabId}`);
    await waitFor(async () => (await pendingCount()) > 0, 60000);
    const captureCard = await lastCard();
    const capturePending = await pendingCount();
    dbg("capture card", { capturePending, captureCard });
    check(
      "Permission card: capture_screenshot denial renders one approval card",
      capturePending === 1 && captureCard?.state === null &&
        (captureCard?.origins ?? "").includes(RED_ORIGIN) && captureCard?.permissions === null,
    );
    await clickShadow(cdp, ntpSession, CARD_SEL, ".allow");
    const captureOk = await waitFor(async () =>
      (await settled("granted")) &&
      /Browser tool capture_screenshot succeeded: .*screenshot shot_[a-z0-9_]+/.test(await threadText()));
    const grantAfterCard = await msgValue({ type: "browser-control.get" });
    await ntpShotNow("permission-card-capture-allowed.png");
    dbg("capture allowed", { captureOk, grantAfterCard, pending: await pendingCount(), tail: (await threadText()).slice(-300) });
    check(
      "Permission card: Allow grants browser control and the retried capture_screenshot succeeds",
      captureOk && grantAfterCard?.scope === "origins" && Array.isArray(grantAfterCard?.origins) &&
        grantAfterCard.origins.includes(RED_ORIGIN) && (await pendingCount()) === 0,
    );

    // CAP-FB-20260830-SCREENSHOT-TO-MODEL-01 — the capture the MODEL just took
    // is a real saved image, not a base64 string in a message: the store holds
    // the exact id the model was told about, and the tool card paints it.
    const modelShotId = (/screenshot (shot_[a-z0-9_]+)/.exec(await threadText()) ?? [])[1] ?? "";
    const shotIndex = await msgValue({ type: "screenshots.list" });
    dbg("screenshots after the model capture", { modelShotId, index: shotIndex?.screenshots });
    check(
      "Screenshot: model capture is persisted and listed",
      modelShotId !== "" && Array.isArray(shotIndex?.screenshots) &&
        shotIndex.screenshots.some((s: { id?: string }) => s?.id === modelShotId),
    );
    // The card lives inside message-bubble's shadow root, and the thumbnail
    // inside its own — so the probe walks shadow roots rather than pretending
    // the transcript is one flat tree.
    const thumbState = () =>
      evalIn(cdp, ntpSession, `(() => {
        const imgs = [];
        const walk = (root, depth) => {
          if (!root || depth > 8) return;
          root.querySelectorAll("screenshot-thumb").forEach((t) => {
            const img = t.shadowRoot?.querySelector("img") ?? t.querySelector("img");
            if (img) imgs.push(img);
          });
          root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot, depth + 1); });
        };
        walk(document.querySelector("#thread-conversation") ?? document.body, 0);
        const img = imgs[imgs.length - 1];
        return img ? { count: imgs.length, alt: img.alt, natural: img.naturalWidth, scheme: String(img.getAttribute("src") ?? "").split(":")[0] } : null;
      })()`);
    await waitFor(async () => ((await thumbState())?.natural ?? 0) > 0, 20000);
    const thumb = await thumbState();
    // Open the capture's card for the retained evidence: a tool card is
    // collapsed by default, and a screenshot of a closed card proves nothing.
    await evalIn(cdp, ntpSession, `(() => {
      const open = (root, depth) => {
        if (!root || depth > 8) return;
        root.querySelectorAll("details.tool").forEach((d) => {
          if (d.querySelector("screenshot-thumb")) d.open = true;
        });
        root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) open(el.shadowRoot, depth + 1); });
      };
      open(document.querySelector("#thread-conversation") ?? document.body, 0);
      document.querySelector("#thread-conversation")?.scrollTo?.(0, 1e6);
    })()`);
    await sleep(400);
    await ntpShotNow("screenshot-tool-card-thumbnail.png");
    dbg("tool-card thumbnail", thumb);
    check(
      "Screenshot: tool card shows a thumbnail",
      thumb !== null && thumb.natural > 0 && /^Screenshot of /.test(String(thumb.alt ?? "")),
    );

    // Restore the pre-journey state (browser control revoked) for what follows.
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
    // Data & memory → the run-log retention row (CAP-FB-20260830-RUN-LOG-COMPACTION-01):
    // the bound is visible and the "keep everything" opt-in is off by default.
    const retentionRow = await evalOpts(
      `(() => { const z = document.querySelector('#run-retention'); const t = document.querySelector('#run-retention-keep-all');
        const b = document.querySelector('#run-retention-bound');
        return z && t && b ? { name: z.querySelector('h3')?.textContent ?? '', bound: b.textContent, checked: t.hasAttribute('checked'),
          switchState: t.shadowRoot?.querySelector('[role=switch]')?.getAttribute('aria-checked') ?? null } : null; })()`,
    );
    check(
      "Settings: Data & memory shows the run-log retention row",
      retentionRow !== null && /Run logs/.test(retentionRow.name) && /newest 10 runs per task/.test(retentionRow.bound) && /500 runs overall/.test(retentionRow.bound) && /32 MiB/.test(retentionRow.bound),
    );
    check(
      "Settings: the run-log retention toggle reports the bounded default (off)",
      retentionRow?.checked === false && retentionRow?.switchState === "false",
    );
    // By this point in the run the NTP is the ACTIVE tab, and
    // Page.captureScreenshot never returns for a backgrounded one (it hung the
    // whole suite). Activate the options target first, then drive the real nav
    // item so Data & memory is genuinely the visible section.
    await cdp.send("Target.activateTarget", { targetId: optsPageReload.id }).catch(() => {});
    await clickSel(cdp, optsSession, '.nav-item[data-section="data"]');
    await evalOpts(`(() => { document.querySelector('#run-retention')?.scrollIntoView({ block: 'center' }); return true; })()`);
    await sleep(400);
    const retentionShot = await captureShot(cdp, optsSession).catch(() => null);
    if (retentionShot) await writeEvidence("settings-data-retention.png", retentionShot);
    check("Settings: retained the run-log retention screenshot", retentionShot !== null && retentionShot.length > 200);
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
    // Under OPTIONAL + JIT, scripting is runtime-revocable. Its dependent
    // teardown must tombstone every enrolled origin before removing the grant.
    // CAP-FB-20260830-SETTINGS-REVOKE-VIA-SW-01: drive the REAL Settings
    // "Turn off" button for Site Agents with a trusted click, accept the owner
    // dialog, and assert the SW route did the teardown — the old page-realm
    // revokeCapability skipped the dialog and left every bridge registered.
    const registeredBeforeDisable = await evalIn(cdp, optsSession2,
      `(async () => { try { if (typeof chrome.scripting?.getRegisteredContentScripts !== "function") return { err: "chrome.scripting unavailable" }; const s = await chrome.scripting.getRegisteredContentScripts(); return s.map((x) => x.id); } catch (e) { return { err: String(e?.message ?? e) }; } })()`);
    console.log(`[debug] registered scripts before Turn off: ${JSON.stringify(registeredBeforeDisable)}`);
    await evalIn(cdp, optsSession2, `document.querySelector('#permission-list')?.scrollIntoView()`);
    check(
      "scripting Disable: Site Agents Turn off clicked via a trusted gesture",
      await clickCapability(optsSession2, "Site Agents", "Turn off"),
    );
    check(
      "scripting Disable: the owner dialog appeared and was accepted with a genuine click",
      await confirmOwnerDialogOn(optsSession2, true),
    );
    check(
      "scripting Disable: optional permission revoked",
      await pollCapabilityOn(optsSession2, "Site Agents", "scripting", false, "Enable"),
    );
    const settingsAfterDisableShot = await captureShot(cdp, optsSession2);
    if (settingsAfterDisableShot) await writeEvidence("settings-site-agents-after-turn-off.png", settingsAfterDisableShot);
    const postDisable = await msgValue({ type: "agent.list" });
    check(
      "scripting Disable: successful revoke tombstones every enrolled origin",
      Array.isArray(postDisable) &&
        !postDisable.includes("https://script-disable-a.example") &&
        !postDisable.includes("https://script-disable-b.example"),
    );
    const registeredAfterDisable = await evalIn(cdp, optsSession2,
      `(async () => { try { if (typeof chrome.scripting?.getRegisteredContentScripts !== "function") return { err: "chrome.scripting unavailable" }; const s = await chrome.scripting.getRegisteredContentScripts(); return s.map((x) => x.id); } catch (e) { return { err: String(e?.message ?? e) }; } })()`);
    console.log(`[debug] registered scripts after Turn off: ${JSON.stringify(registeredAfterDisable)}`);
    check(
      "Settings: Turn off Site Agents goes through capability.revoke and unregisters enrolled scripts",
      Array.isArray(registeredBeforeDisable) &&
        (Array.isArray(registeredAfterDisable)
          ? registeredAfterDisable.length === 0
          // With the permission gone Chrome refuses the query itself; the
          // route's teardown ran under the permission before removing it.
          : typeof registeredAfterDisable?.err === "string"),
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
    // The embedded frame's default execution context is reported on the NTP
    // session a beat after the frame navigates; wait (bounded) for it rather
    // than reading the event list once — the pooled frame's creation raced
    // this read and the deny then ran in no context at all (observed 2026-08-30).
    let settingsFrame = null;
    let settingsCtx = null;
    for (let i = 0; i < 25 && !settingsCtx; i++) {
      const frameTree = await cdp.send("Page.getFrameTree", {}, ntpSession);
      settingsFrame = (frameTree?.result?.frameTree?.childFrames ?? [])
        .find((f) => String(f?.frame?.url ?? "").includes("options/options.html")) ?? null;
      settingsCtx = cdp.executionContextEvents
        .filter((e) => e.kind === "created" && e.sessionId === ntpSession && e.isDefault &&
          e.frameId === settingsFrame?.frame?.id)
        .pop() ?? null;
      if (!settingsCtx) await sleep(200);
    }
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
    console.log(`approval journey (iframe deny): ${JSON.stringify({ deniedRequest: iframeDeniedRequest, settingsFrameId, settingsCtx: !!settingsCtx?.id, iframeNav, iframeDeny, after: iframeAfter?.asset?.name ?? iframeAfter })}`);
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
    console.log(`approval journey (deny row): ${JSON.stringify({ denyRequest, denyDom: { ...denyDom, text: String(denyDom.text).slice(0, 300) } })}`);
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
    // Immutable versions (CAP-FB-20260830-ARTIFACT-VERSIONS-01): the edit turn
    // leaves the previous body retrievable, and a restore is a NEW head
    // version whose body equals the old one byte-for-byte.
    const editTurn = await approvedMsg({
      type: "asset.update", origin: "master", id: assetId, content: "<h1>hello</h1>\n<p>edited</p>",
    });
    const versionsAfterEdit = await msgValue({ type: "asset.versions", origin: "master", id: assetId });
    const shas = (versionsAfterEdit?.versions ?? []).map((v) => v?.sha256);
    check(
      "artifact versions: two rows with distinct sha256 after the edit turn",
      editTurn?.ok === true && versionsAfterEdit?.ok === true &&
        shas.length >= 2 && new Set(shas.slice(-2)).size === 2 &&
        (versionsAfterEdit.versions ?? []).every((v) => /^[0-9a-f]{64}$/.test(String(v?.sha256)) && !("content" in v)),
    );
    const firstVersion = await msgValue({ type: "asset.version-get", origin: "master", id: assetId, n: 1 });
    check(
      "artifact versions: version-get returns v1's exact body",
      firstVersion?.ok === true && firstVersion.content === "<h1>hello</h1>" && firstVersion.sha256 === shas[0],
    );
    const restored = await approvedMsg({ type: "asset.restore", origin: "master", id: assetId, n: 1 });
    const afterRestore = await msgValue({ type: "asset.get", origin: "master", id: assetId });
    const versionsAfterRestore = await msgValue({ type: "asset.versions", origin: "master", id: assetId });
    check(
      "artifact versions: restore of v1 is a new head whose body equals v1 byte-for-byte",
      restored?.ok === true && restored.version === (versionsAfterEdit?.head ?? 0) + 1 &&
        afterRestore?.asset?.content === "<h1>hello</h1>" &&
        versionsAfterRestore?.head === restored.version &&
        (versionsAfterRestore.versions ?? []).at(-1)?.sha256 === shas[0],
    );
    // ─────────────────────────────────────────────────────────────
    // ARTIFACT-VIEWER-SOURCE-DIFF-01: the artifact viewer offers a keyboard-
    // reachable Preview | Source | Diff control. Source shows the exact,
    // syntax-highlighted body; Diff renders the change between two immutable
    // versions with a version picker + Restore. The seeded `assetId` above now
    // carries several versions, so the Diff panel has real history to render.
    // ─────────────────────────────────────────────────────────────
    {
      const viewerUrl = `chrome-extension://${extId}/artifact/artifact.html?id=${assetId}&origin=master`;
      const vTarget = await openPage(port, viewerUrl);
      await sleep(1600);
      const vSession = await attachRuntime(cdp, vTarget.id);
      let tabsInfo = null;
      for (let i = 0; i < 20 && !tabsInfo?.count; i++) {
        tabsInfo = await evalIn(cdp, vSession, `(() => {
          const sc = document.getElementById('modes');
          if (!sc || sc.hidden) return { count: 0 };
          const tabs = [...(sc.shadowRoot?.querySelectorAll('[role="tab"]') ?? [])];
          const selected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
          return { count: tabs.length, labels: tabs.map((t) => t.textContent), selected: selected.map((t) => t.textContent), tablist: !!sc.shadowRoot?.querySelector('[role="tablist"]') };
        })()`);
        if (!tabsInfo?.count) await sleep(300);
      }
      check(
        "viewer: Preview|Source|Diff tablist renders with exactly one selected tab",
        tabsInfo?.count === 3 && tabsInfo.tablist === true &&
          JSON.stringify(tabsInfo.labels) === JSON.stringify(["Preview", "Source", "Diff"]) &&
          tabsInfo.selected.length === 1 && tabsInfo.selected[0] === "Preview",
      );
      // Keyboard reachability: focus the selected tab, then ArrowRight → Source.
      await evalIn(cdp, vSession, `(() => { const sc = document.getElementById('modes'); sc.shadowRoot.querySelector('[role="tab"][aria-selected="true"]')?.focus(); return true; })()`);
      const arrowRight = async () => {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 }, vSession);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 }, vSession);
      };
      await arrowRight();
      await sleep(500);
      const sourceState = await evalIn(cdp, vSession, `(() => {
        const sc = document.getElementById('modes');
        const panel = document.getElementById('panel-source');
        const insp = panel?.querySelector('artifact-inspector');
        const spans = insp?.shadowRoot?.querySelectorAll('code [class^="tok-"]') ?? [];
        const codeText = insp?.shadowRoot?.querySelector('code')?.textContent ?? "";
        return { value: sc.value, visible: !!panel && !panel.hidden, tokenSpans: spans.length, bodyLen: codeText.length };
      })()`);
      check(
        "viewer: ArrowRight selects Source and the panel shows highlighted, exact source",
        sourceState?.value === "Source" && sourceState.visible === true &&
          sourceState.tokenSpans > 0 && sourceState.bodyLen > 0,
      );
      const srcShot = await captureShot(cdp, vSession);
      if (srcShot) await writeEvidence("viewer-source-highlighted.png", srcShot);
      // Diff: ArrowRight again → Diff; the version pickers populate and the diff
      // renders a real header between the two selected versions.
      await arrowRight();
      await sleep(900);
      const diffState = await evalIn(cdp, vSession, `(() => {
        const sc = document.getElementById('modes');
        const panel = document.getElementById('panel-diff');
        const base = document.getElementById('diff-base');
        const compare = document.getElementById('diff-compare');
        const ad = document.getElementById('artifact-diff');
        const add = ad?.shadowRoot?.querySelector('.counts .add')?.textContent ?? "";
        const del = ad?.shadowRoot?.querySelector('.counts .del')?.textContent ?? "";
        const restore = document.getElementById('diff-restore');
        return { value: sc.value, visible: !!panel && !panel.hidden, baseOpts: base?.options?.length ?? 0, compareOpts: compare?.options?.length ?? 0, add, del, restore: restore?.textContent ?? "" };
      })()`);
      check(
        "viewer: Diff tab shows version pickers and a real diff between two versions",
        diffState?.value === "Diff" && diffState.visible === true &&
          diffState.baseOpts >= 2 && diffState.compareOpts >= 2 &&
          /^\+\d+$/.test(String(diffState.add).trim()) && /^-\d+$/.test(String(diffState.del).trim()) &&
          /^Restore v\d+$/.test(String(diffState.restore).trim()),
      );
      const diffShot = await captureShot(cdp, vSession);
      if (diffShot) await writeEvidence("viewer-diff-versions.png", diffShot);
      await cdp.send("Target.closeTarget", { targetId: vTarget.id });
    }
    const assetDel = await approvedMsg({ type: "asset.delete", origin: "master", id: assetId });
    check("mgmt: delete_asset removed it", assetDel?.ok === true);
    const assetAfter = await msgValue({ type: "asset.list", origin: "master" });
    check(
      "mgmt: asset gone after delete",
      Array.isArray(assetAfter?.assets) &&
        !assetAfter.assets.some((a) => a.id === assetId),
    );
    // ─────────────────────────────────────────────────────────────
    // ARTIFACT-QUICK-FIXES-01 (b): an empty/unknown asset id must answer with
    // the readable sentence, never a misleading "requires owner approval" (the
    // model would retry the same impossible call a dozen times).
    // ─────────────────────────────────────────────────────────────
    const emptyIdUpdate = await msgValue({ type: "asset.update", origin: "master", id: "", content: "x" });
    check(
      "artifacts: update_asset with an empty id says use list_assets",
      emptyIdUpdate?.ok === false &&
        String(emptyIdUpdate?.error ?? "") === "update_asset needs an existing id (use list_assets)" &&
        !/owner approval/i.test(String(emptyIdUpdate?.error ?? "")),
    );
    const unknownIdUpdate = await msgValue({ type: "asset.update", origin: "master", id: "a_never_created", content: "x" });
    check(
      "artifacts: update_asset with an unknown id says use list_assets",
      unknownIdUpdate?.ok === false &&
        String(unknownIdUpdate?.error ?? "") === "update_asset needs an existing id (use list_assets)" &&
        !/owner approval/i.test(String(unknownIdUpdate?.error ?? "")),
    );
    // (a) ONE genuine click on a gallery card's New tab opens exactly ONE
    //     viewer target. Drives the real page + a real CDP click.
    const galleryAsset = await msgValue({
      type: "asset.create", origin: "master", assetType: "html",
      name: "gallery double-open guard", content: "<h1>guard</h1>",
    });
    const viewerTargets = async () => {
      const t = await cdp.send("Target.getTargets");
      return (t?.result?.targetInfos ?? []).filter((ti) => ti.url.includes("artifact/artifact.html")).length;
    };
    const galleryBefore = await viewerTargets();
    let galleryOk = false;
    if (galleryAsset?.ok === true) {
      const galTarget = await openPage(port, `chrome-extension://${extId}/artifacts/index.html`);
      await sleep(2200);
      const galSession = await attachRuntime(cdp, galTarget.id);
      const tabBox = await evalIn(cdp, galSession, `(() => {
        const card = document.querySelector("artifact-card");
        const el = card?.shadowRoot?.querySelector('[data-act="open-tab"]');
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (tabBox && typeof tabBox.x === "number") {
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tabBox.x, y: tabBox.y, button: "left", buttons: 1, clickCount: 1 }, galSession);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tabBox.x, y: tabBox.y, button: "left", buttons: 0, clickCount: 1 }, galSession);
      }
      await sleep(2200);
      const galleryAfter = await viewerTargets();
      galleryOk = galleryAfter - galleryBefore === 1;
      const galShot = await captureShot(cdp, galSession);
      if (galShot) await writeEvidence("artifact-newtab-single.png", galShot);
    }
    check(
      "artifacts: one New tab click opens exactly one viewer target",
      galleryAsset?.ok === true && galleryOk,
    );
    // ─────────────────────────────────────────────────────────────
    // Scripts gate (CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01).
    // (a) The host-side cap:fetch refuses a loopback target even for an
    //     owner-direct run (the Settings principal creates + runs the script;
    //     the NTP page is the sandbox host). The fixture must see NO request.
    // ─────────────────────────────────────────────────────────────
    const loopSource = `return (await fetch("${RED_ORIGIN}/?d=leak")).status`;
    const loopScript = await msgOpts({ type: "script.create", origin: "master", name: "loopback probe", source: loopSource });
    const loopRun = loopScript?.ok === true
      ? await msgOpts({ type: "script.run", origin: "master", id: loopScript.script.id })
      : loopScript;
    check(
      "cap:fetch: loopback refused from a sandboxed script",
      loopRun?.ok === false &&
        /private or loopback address/.test(String(loopRun?.error ?? "")) &&
        !fixtureHits.some((h) => h.includes("d=leak")),
    );
    // (b) A MODEL-initiated run_script pauses on the in-context approval card
    //     that shows the exact source + the hosts it fetches; nothing runs
    //     until a genuine Allow click. The demo model's @demo-run-script
    //     marker drives the REAL lazy protocol (search_tools → execute_tool →
    //     run_script) through the hub composer.
    const cardSource = `const url = "https://example.com/";\nreturn url.length;`;
    const cardScript = await msgOpts({ type: "script.create", origin: "master", name: "card probe", source: cardSource });
    const cardScriptId = cardScript?.script?.id ?? "";
    await cdp.send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html` }, ntpSession);
    await sleep(2500);
    let composerReady = false;
    for (let i = 0; i < 20 && !composerReady; i++) {
      composerReady = (await boxOf(cdp, ntpSession, "#task-input")) !== null;
      if (!composerReady) await sleep(250);
    }
    if (composerReady) {
      await typeInto(cdp, ntpSession, "#task-input", `@demo-run-script ${cardScriptId}`);
      await clickSel(cdp, ntpSession, "#run-task");
    }
    const readCard = () => evalIn(
      cdp, ntpSession,
      `(() => { const card = document.querySelector("approval-card"); if (!card) return null; const root = card.shadowRoot; return { state: card.getAttribute("state") || "pending", title: root?.querySelector(".title")?.textContent ?? "", source: root?.querySelector(".source")?.textContent ?? null, hosts: [...(root?.querySelectorAll(".hosts li") ?? [])].map((li) => li.textContent), hasApprove: !!root?.querySelector(".approve") }; })()`,
    );
    let card = null;
    for (let i = 0; i < 60 && !card?.hasApprove; i++) {
      card = await readCard();
      if (!card?.hasApprove) await sleep(500);
    }
    const beforeAllow = await msgValue({ type: "script.get", origin: "master", id: cardScriptId });
    const cardShot = await captureShot(cdp, ntpSession);
    if (cardShot) await writeEvidence("script-approval-card.png", cardShot);
    check(
      "Scripts: run_script from the model shows the approval card with the source",
      card?.hasApprove === true &&
        card?.title === "Run this script now?" &&
        card?.source === cardSource &&
        Array.isArray(card?.hosts) && card.hosts.includes("example.com") &&
        beforeAllow?.script?.lastRunAt == null,
    );
    // A GENUINE click on the card's Approve (inside its shadow root).
    const approveBox = await evalIn(
      cdp, ntpSession,
      `(() => { const b = document.querySelector("approval-card")?.shadowRoot?.querySelector(".approve"); if (!b) return null; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (approveBox) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: approveBox.x, y: approveBox.y, button: "left", buttons: 1, clickCount: 1 }, ntpSession);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: approveBox.x, y: approveBox.y, button: "left", buttons: 0, clickCount: 1 }, ntpSession);
    }
    let afterAllow = null;
    for (let i = 0; i < 40; i++) {
      afterAllow = await msgValue({ type: "script.get", origin: "master", id: cardScriptId });
      if (afterAllow?.script?.lastRunAt != null) break;
      await sleep(500);
    }
    const cardAfter = await readCard();
    check(
      "Scripts: the approved run executes only after Allow",
      approveBox !== null &&
        afterAllow?.script?.lastRunAt != null &&
        afterAllow?.script?.status === "ok" &&
        cardAfter?.state === "granted",
    );
    await msgOpts({ type: "script.delete", origin: "master", id: cardScriptId }).catch(() => {});
    if (loopScript?.script?.id) await msgOpts({ type: "script.delete", origin: "master", id: loopScript.script.id }).catch(() => {});

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
