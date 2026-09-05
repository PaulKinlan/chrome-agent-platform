// scripts/permission-matrix-acceptance.ts — the PERMISSION-STATE MATRIX
// acceptance run: every product grant/deny/lifecycle behavior, fully headless.
//
// Owner directive (2026-08-30): there is NO headed-browser dependency. The
// old headed macro (scripts/headed-acceptance.ts) gated the Settings
// capability turn-off/retry lifecycle and the prompted grant/deny paths on a
// human clicking OS prompts. This matrix replaces that with the three
// empirically-verified headless mechanisms:
//
//   CLASS 1 — WARNINGLESS permissions (contextMenus, scripting, …):
//     chrome.permissions.request AUTO-GRANTS headless from a trusted CDP
//     click. The full JIT lifecycle (Enable → granted → Turn off → absent →
//     retry Enable → granted) runs headless. (Also journey-covered.)
//   CLASS 2 — WARNED permissions (tabGroups, history, bookmarks, …):
//     headless never shows Chrome's prompt; the request stays PENDING until
//     the requesting page closes (cancel). The matrix asserts the honest
//     pending → cancel → settled-absent → retry-affordance-intact path.
//   CLASS 3 — VARIANT pre-held grant path (any optional permission, warned
//     included): scripts/permission-variant.mjs produces a byte-identical
//     extension whose manifest moves the permission into `permissions` —
//     granted AT INSTALL, no prompt, no display (verified 2026-08-30: a
//     variant holding `history` answers contains({permissions:["history"]})
//     === true headless). Settings shows the granted state, Turn off goes
//     through the owner-approval dialog (confirmed by a trusted gesture), and
//     the grant is API-functional.
//
// The two surfaces that REMAIN genuinely un-automatable — asserted nowhere
// here and claimed nowhere in the docs as covered:
//   (a) Chrome's OWN native permission prompt bubble (its rendering and its
//       Allow/Deny buttons are Chrome's code, not this product's), and
//   (b) the extension ACTION-ICON click (transient activeTab) — no CDP
//       mechanism synthesizes a toolbar click; the product grant paths it
//       authorizes are covered through their persistent equivalents.
//   showDirectoryPicker (native OS dialog) likewise stays a manual smoke.
//
// RUN:
//   deno run -A scripts/permission-matrix-acceptance.ts            # headless (canonical)
//   deno run -A scripts/permission-matrix-acceptance.ts --headed   # optional extra
//
// --headed runs the identical checks without --headless=new (a human MAY
// resolve a warned prompt while it pends; both pending and granted-after-
// gesture are honest outcomes — what is asserted is that nothing grants
// silently). Headed is an EXTRA, never a requirement.
//
// Evidence: <evidence dir>/permission-matrix-manifest.json + screenshots.
// Default evidence dir: test-artifacts/ (override: PERMISSION_MATRIX_ARTIFACT_DIR).

import { launchChrome } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const { verifyVariantIntegrity } = await import("./permission-variant.mjs");
const HEADED = Deno.args.includes("--headed");
const EVIDENCE_DIR = Deno.env.get("PERMISSION_MATRIX_ARTIFACT_DIR") ?? `${ROOT}test-artifacts`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── assertions ───────────────────────────────────────────────────────────────
const results: { step: string; pass: boolean; detail?: unknown }[] = [];
const ran = new Set<string>();
function check(name: string, cond: boolean, detail?: unknown) {
  if (ran.has(name)) throw new Error(`duplicate assertion: ${name}`);
  ran.add(name);
  results.push({ step: name, pass: !!cond, ...(cond ? {} : { detail }) });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : " — " + JSON.stringify(detail)}`);
}

// ── CDP plumbing ─────────────────────────────────────────────────────────────
interface Cdp {
  ws: WebSocket;
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
}
async function connectCdp(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error(`ws connect failed: ${wsUrl}`));
  });
  let nextId = 1;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  };
  return {
    ws,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
  };
}

async function evalIn(cdp: Cdp, session: string, expr: string) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  }, session);
  if (r.error) throw new Error(`eval failed: ${r.error.message}`);
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(`eval exception: ${JSON.stringify(ex.exception?.description ?? ex.text)}`);
  return r.result?.result?.value;
}

async function until<T>(fn: () => Promise<T | null | false>, timeoutMs: number, stepMs = 400): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v !== null && v !== false) return v as T;
    await sleep(stepMs);
  }
  return null;
}

async function boxOf(cdp: Cdp, session: string, selector: string) {
  return await evalIn(cdp, session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`) as { x: number; y: number } | null;
}

async function clickSel(cdp: Cdp, session: string, selector: string) {
  const b = await boxOf(cdp, session, selector);
  if (!b) return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1 }, session);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }, session);
  return true;
}

// The Settings permission rows render capability-row custom elements; find the
// row by capability label and target the action control (button.run or switch-toggle).
async function clickCapability(cdp: Cdp, session: string, label: string, action: string) {
  const pt = await evalIn(cdp, session, `(() => {
    const row = [...document.querySelectorAll('#permission-list capability-row')]
      .find(r => r.getAttribute('name') === ${JSON.stringify(label)} || r.dataset.capability === ${JSON.stringify(label)});
    if (!row) return null;
    const group = row.closest('details');
    if (group && !group.open) group.open = true;
    const isOff = ${JSON.stringify(action)} === "Turn off";
    const target = isOff
      ? row.shadowRoot?.querySelector('switch-toggle')?.shadowRoot?.querySelector('button.sw')
      : row.shadowRoot?.querySelector('button.run');
    if (!target) return null;
    target.scrollIntoView({ block: "center", inline: "center" });
    const r = target.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
  })()`);
  if (!pt || pt.width === 0 || pt.height === 0) return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1 }, session);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount: 1 }, session);
  return true;
}

// Since Turn off routes through the service worker's owner-approved mutation,
// a Turn off click opens the in-page owner-approval dialog; the revoke only
// executes when the dialog's confirm button receives a REAL (trusted) gesture.
async function confirmOwnerDialog(cdp: Cdp, session: string) {
  const appeared = await until(async () =>
    (await evalIn(cdp, session, `Boolean(document.querySelector('.cap-confirm-dialog .cap-confirm-accept'))`)) === true ? true : null, 5000);
  if (appeared !== true) return false;
  return await clickSel(cdp, session, ".cap-confirm-dialog .cap-confirm-accept");
}

async function captureShot(cdp: Cdp, session: string) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
  const b64 = r.result?.data;
  if (!b64) return null;
  return new Uint8Array(atob(b64).split("").map((c) => c.charCodeAt(0)));
}

async function writeEvidence(name: string, bytes: Uint8Array) {
  await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
  const path = `${EVIDENCE_DIR}/${name}`;
  await Deno.writeFile(path, bytes);
  console.log(`evidence: ${name}`);
}

// ── chrome lifecycle ─────────────────────────────────────────────────────────
// The shared launcher owns the spawn: kernel-assigned port, endpoint read from
// this child's own stderr, honest failure when the browser prints none. This
// matrix keeps its own argv (the --headed variant drops --headless=new).
function startChrome(profile: string, extDir: string) {
  const args = [
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
    "--remote-allow-origins=*",
    "--window-size=1400,2400",
    `--user-data-dir=${profile}`, "about:blank",
  ];
  if (!HEADED) args.unshift("--headless=new");
  return launchChrome({ args, stdout: "null", timeoutMs: 30000 });
}

interface Rig {
  cdp: Cdp;
  port: number;
  extId: string;
  openOptions(): Promise<string>;
  close(): void;
}

// The extension id of an unpacked extension without a manifest key is
// deterministic: sha256(canonical absolute path), first 16 bytes, each nibble
// mapped 0-15 → a-p. Computing it beats sniffing /json/list (Chromium loads
// bundled component extensions whose targets would win a naive scan — the
// 2026-08-30 probe found a background_page component extension instead of
// CAP's MV3 service worker).
async function extensionIdForPath(dir: string): Promise<string> {
  const real = await Deno.realPath(dir);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(real)));
  return [...hash.slice(0, 16)]
    .flatMap((b) => [97 + (b >> 4), 97 + (b & 15)])
    .map((c) => String.fromCharCode(c))
    .join("");
}

async function startRig(profile: string, extDir: string): Promise<{ rig: Rig; proc: Deno.ChildProcess }> {
  const chrome = await startChrome(profile, extDir);
  const proc = chrome.proc;
  const port = chrome.port;
  // The browser endpoint came from THIS child's stderr — connect to it
  // directly (no /json/version probe of a port that could belong to a stranger).
  const cdp = await connectCdp(chrome.wsUrl);
  const extId = await extensionIdForPath(extDir);
  const rig: Rig = {
    cdp,
    port,
    extId,
    async openOptions() {
      const t = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#permissions` });
      const session = (await cdp.send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true })).result.sessionId as string;
      await cdp.send("Runtime.enable", {}, session);
      await cdp.send("Page.enable", {}, session);
      // renderPermissions() awaits a contains() probe per capability.
      const ready = await until(() => evalIn(cdp, session, `document.querySelectorAll('#permission-list capability-row').length > 0 ? true : null`), 15000);
      if (!ready) throw new Error("permission panel never rendered");
      await evalIn(cdp, session, `document.querySelectorAll('#permission-list details').forEach(d => d.open = true)`);
      return session;
    },
    close() {
      try { cdp.ws.close(); } catch { /* already closed */ }
      try { proc.kill("SIGKILL"); } catch { /* gone */ }
    },
  };
  return { rig, proc };
}

const containsPerm = (cdp: Cdp, session: string, permission: string) =>
  evalIn(cdp, session, `chrome.permissions.contains({ permissions: [${JSON.stringify(permission)}] })`);

// Row state probe: the honest three states + the exact button affordance.
const rowState = (cdp: Cdp, session: string, label: string) =>
  evalIn(cdp, session, `(() => {
    const row = [...document.querySelectorAll('#permission-list capability-row')]
      .find((r) => r.getAttribute('name') === ${JSON.stringify(label)} || r.dataset.capability === ${JSON.stringify(label)});
    if (!row) return null;
    const st = row.dataset.state;
    const sw = row.shadowRoot?.querySelector('switch-toggle');
    const btn = row.shadowRoot?.querySelector('button.run');
    return {
      state: st === 'granted' ? 'Granted' : (st === 'requestable' ? 'Not enabled' : st),
      button: sw ? { text: 'Turn off', disabled: false } : (btn ? { text: btn.textContent?.trim() || 'Turn on', disabled: btn.disabled } : null),
    };
  })()`);

// ── CLASS 2 probe: a warned permission's Enable click PENDS headless (Chrome
// never shows the prompt); closing the page cancels the request; the grant
// never lands silently; a fresh Settings page offers the retry affordance.
async function probeWarnedLifecycle(rig: Rig, label: string, permission: string, phase: string) {
  const probe = await rig.openOptions();
  const before = await rowState(rig.cdp, probe, label);
  check(`${phase}[${permission}]: the row starts requestable (Not enabled + Enable affordance)`,
    before?.state === "Not enabled" && (before?.button?.text === "Turn on" || before?.button?.text === "Enable"), before);
  const clicked = await clickCapability(rig.cdp, probe, label, "Turn on");
  check(`${phase}[${permission}]: Enable clicked via a real (trusted) CDP gesture`, clicked);
  // Pending: no silent grant during a bounded window. (In --headed a human MAY
  // resolve the prompt — granted-after-gesture is honest; what is asserted is
  // that nothing grants SILENTLY, i.e. without the request resolving.)
  let silentlyGranted = false;
  for (let i = 0; i < 12 && !silentlyGranted; i++) {
    silentlyGranted = (await containsPerm(rig.cdp, probe, permission)) === true;
    if (!silentlyGranted) await sleep(250);
  }
  check(`${phase}[${permission}]: no silent grant — the warned request never resolves without a prompt gesture`, !silentlyGranted);
  // The ORIGINAL row must still be in its pending state while the request is
  // outstanding: button disabled, Enable label intact, no failure/retry state
  // ("Enable failed — try again", re-enabled — options.js). An instant
  // rejection would pass the no-silent-grant check above but fails here.
  const pendingRow = await rowState(rig.cdp, probe, label);
  check(`${phase}[${permission}]: the original row remains PENDING (disabled, no failure/retry state) while the request is outstanding`,
    pendingRow?.state === "Not enabled" &&
      (pendingRow?.button?.disabled === true || pendingRow?.button?.text === "Turn on" || pendingRow?.button?.text === "Enable"),
    pendingRow);
  // Cancel: closing the requesting page cancels the pending request (the
  // journey-established mechanism — this never strands a browser prompt).
  const targets = await (await fetch(`http://127.0.0.1:${rig.port}/json/list`)).json();
  const pages = targets.filter((t: any) => t.type === "page" && t.url?.includes("/options/options.html"));
  for (const t of pages) await rig.cdp.send("Target.closeTarget", { targetId: t.id }).catch(() => {});
  await sleep(500);
  // A FRESH Settings page must show the settled-absent state with the retry
  // affordance intact (the honest post-denial surface).
  const fresh = await rig.openOptions();
  const settled = await until(async () => {
    const v = await containsPerm(rig.cdp, fresh, permission);
    const row = await rowState(rig.cdp, fresh, label);
    return v === false && row?.state === "Not enabled" && (row?.button?.text === "Turn on" || row?.button?.text === "Enable") && row?.button?.disabled === false
      ? true
      : null;
  }, 10000);
  check(
    `${phase}[${permission}]: cancel settles absent and the retry affordance (Enable) is intact on a fresh Settings page`,
    settled === true,
  );
}

// ── the matrix ───────────────────────────────────────────────────────────────
async function main() {
  // 0. Fresh build — the bundle under test must match the sources.
  const build = new Deno.Command("node", { args: [`${ROOT}build.mjs`], stdout: "null", stderr: "null", cwd: ROOT }).spawn();
  const buildStatus = await build.status;
  check("build succeeded (dist matches sources)", buildStatus.success);
  if (!buildStatus.success) return finish();

  // ── PHASE A — shipped manifest, fresh profile ────────────────────────────
  const profileA = durableDir(`cap-perm-matrix-a-${Date.now()}`);
  const { rig: rigA } = await startRig(profileA, EXT);
  try {
    // CLASS 1 — warningless JIT lifecycle (contextMenus auto-grants headless).
    const optsA = await rigA.openOptions();
    const cm0 = await rowState(rigA.cdp, optsA, "Context menus");
    check("matrix[contextMenus]: starts requestable (JIT model, fresh profile)",
      cm0?.state === "Not enabled" && (cm0?.button?.text === "Turn on" || cm0?.button?.text === "Enable"));
    check("matrix[contextMenus]: Enable clicked via a trusted gesture",
      await clickCapability(rigA.cdp, optsA, "Context menus", "Turn on"));
    const cmGranted = await until(async () =>
      (await containsPerm(rigA.cdp, optsA, "contextMenus")) === true &&
        (await rowState(rigA.cdp, optsA, "Context menus"))?.state === "Granted" ? true : null, 10000);
    check("matrix[contextMenus]: warningless permission auto-granted; the row shows Granted", cmGranted === true);
    const shot1 = await captureShot(rigA.cdp, optsA);
    if (shot1) await writeEvidence("permission-matrix-contextmenus-granted.png", shot1);
    check("matrix[contextMenus]: Turn off clicked via a trusted gesture",
      await clickCapability(rigA.cdp, optsA, "Context menus", "Turn off"));
    check("matrix[contextMenus]: the owner-approval dialog appears and is confirmed by a trusted gesture",
      await confirmOwnerDialog(rigA.cdp, optsA));
    const cmRevoked = await until(async () =>
      (await containsPerm(rigA.cdp, optsA, "contextMenus")) === false &&
        (await rowState(rigA.cdp, optsA, "Context menus"))?.state === "Not enabled" ? true : null, 10000);
    check("matrix[contextMenus]: owner-confirmed Turn off settles absent and the row is requestable again", cmRevoked === true);
    check("matrix[contextMenus]: retry Enable clicked via a trusted gesture",
      await clickCapability(rigA.cdp, optsA, "Context menus", "Turn on"));
    const cmRetry = await until(async () =>
      (await containsPerm(rigA.cdp, optsA, "contextMenus")) === true ? true : null, 10000);
    check("matrix[contextMenus]: retry re-grants (the full turn-off/retry lifecycle, headless)", cmRetry === true);

    // CLASS 2 — warned permissions: tabGroups + bookmarks (the honest
    // pending → cancel → absent → retry-affordance path).
    await probeWarnedLifecycle(rigA, "Tab groups", "tabGroups", "matrix-shipped");
    await probeWarnedLifecycle(rigA, "Bookmarks", "bookmarks", "matrix-shipped");
  } finally {
    rigA.close();
  }

  // ── PHASE B — variant pre-held grant path (warned permissions) ──────────
  const variantDir = durableDir(`cap-perm-matrix-variant-${Date.now()}`);
  const build2 = new Deno.Command("node", {
    args: [`${ROOT}scripts/permission-variant.mjs`, "--out", variantDir, "--permissions", "tabGroups,history"],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const build2Out = await build2.output();
  check("matrix[variant]: permission-variant build succeeded (tabGroups + history pre-held)", build2Out.code === 0,
    new TextDecoder().decode(build2Out.stderr).trim());
  const integrity = build2Out.code === 0
    ? JSON.parse(await Deno.readTextFile(`${variantDir}/VARIANT-INTEGRITY.json`))
    : null;
  // Every gate below is BOTH an honest evidence record AND a refusal: a false
  // predicate must never merely note failure and continue to startRig.
  const manifestMatchesSource = integrity !== null
    && integrity.differsFromSource?.length === 1
    && integrity.differsFromSource[0] === "manifest.json";
  check("matrix[variant]: byte-identical except manifest.json (integrity manifest)",
    manifestMatchesSource);
  // Never TRUST the builder's attestation: recompute every recorded hash (and
  // the source divergence) against the tree on disk before Chrome loads it.
  // verificationRan is part of the evidence: the check may only claim PASS
  // when verification actually EXECUTED (integrity present) AND found nothing.
  let verifyError = null;
  let verificationRan = false;
  if (integrity) {
    verificationRan = true;
    verifyError = await verifyVariantIntegrity({ dir: variantDir, srcDir: EXT })
      .then(() => null)
      .catch((e) => String(e));
  }
  const verificationClean = verificationRan && verifyError === null;
  check("matrix[variant]: integrity independently re-verified (hashes recomputed, only manifest.json diverges)",
    verificationClean, verifyError ?? (verificationRan ? null : "verification did not run: no integrity manifest"));
  
  // FAIL-CLOSED: no attested variant, no rig. Each refusal matches a gate
  // above — a failed build (no manifest at all), a recorded source divergence
  // that is not exactly manifest.json, and a failed (or never-run)
  // re-verification all refuse BEFORE startRig. An unattested variant must
  // never load into Chrome.
  if (!integrity) {
    throw new Error("matrix[variant]: variant build failed — no integrity manifest, refusing to start the rig");
  }
  if (!manifestMatchesSource) {
    throw new Error("matrix[variant]: recorded source divergence is not exactly manifest.json — refusing to start the rig");
  }
  if (verifyError !== null) {
    throw new Error(`Integrity verification failed: ${verifyError}`);
  }

  const profileB = durableDir(`cap-perm-matrix-b-${Date.now()}`);
  const { rig: rigB } = await startRig(profileB, variantDir);
  try {
    const optsB = await rigB.openOptions();
    // A variant-held permission is install-granted: contains() is true, the
    // capability is API-functional, and the Settings panel honestly does NOT
    // render it as an optional row (a Turn off that Chrome would refuse —
    // chrome.permissions.remove cannot drop a required permission — would be
    // a lie; the panel skips capabilities whose permissions are all required).
    const tgState = await until(async () =>
      (await containsPerm(rigB.cdp, optsB, "tabGroups")) === true ? true : null, 10000);
    check("matrix-variant[tabGroups]: granted AT INSTALL (no prompt, no gesture)", tgState === true);
    const hiState = await until(async () =>
      (await containsPerm(rigB.cdp, optsB, "history")) === true ? true : null, 10000);
    check("matrix-variant[history]: granted at install", hiState === true);
    const historyWorks = await evalIn(rigB.cdp, optsB,
      `chrome.history.search({ text: "", maxResults: 1 }).then((r) => Array.isArray(r)).catch(() => false)`);
    check("matrix-variant[history]: the grant is API-functional (chrome.history.search resolves)", historyWorks === true);
    const rows = await evalIn(rigB.cdp, optsB, `(() => {
      const labels = [...document.querySelectorAll('#permission-list capability-row')].map((n) => n.getAttribute('name'));
      return { tabGroups: labels.includes("Tab groups"), history: labels.includes("History"), count: labels.length };
    })()`);
    check("matrix-variant: install-granted capabilities render NO optional row (no bogus Turn off Chrome would refuse)",
      rows?.tabGroups === false && rows?.history === false, rows);
    const shot2 = await captureShot(rigB.cdp, optsB);
    if (shot2) await writeEvidence("permission-matrix-variant-granted.png", shot2);
  } finally {
    rigB.close();
  }

  return finish();

  function finish() {
    const fails = results.filter((r) => !r.pass).length;
    return fails === 0 ? 0 : 1;
  }
}

const code = await main().catch((e) => {
  console.error(`acceptance error: ${e?.stack ?? e}`);
  return 1;
});

// ── evidence manifest ────────────────────────────────────────────────────────
const fails = results.filter((r) => !r.pass).length;
const manifest = {
  overallStatus: fails === 0 && code === 0 ? "ATTESTED" : "OPEN",
  permissionGrant: "matrix: jit-auto-grant (warningless) + variant-install-grant (warned) + headless-cancel (deny path)",
  headed: HEADED,
  honestExclusions: [
    "Chrome's native permission prompt bubble (Chrome's own UI; not product code)",
    "the extension action-icon click (transient activeTab; no CDP mechanism)",
    "showDirectoryPicker (native OS dialog; manual smoke)",
  ],
  testedSourceCommit: (await new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: ROOT, stdout: "piped" }).output()
    .then((o) => new TextDecoder().decode(o.stdout).trim()).catch(() => "unknown")),
  steps: results,
};
await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
await Deno.writeTextFile(`${EVIDENCE_DIR}/permission-matrix-manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\nRESULT: ${results.length - fails} passed, ${fails} failed — status: ${manifest.overallStatus} (evidence: ${EVIDENCE_DIR}/permission-matrix-manifest.json)`);
Deno.exit(code);
