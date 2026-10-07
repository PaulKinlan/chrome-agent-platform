// @ts-nocheck
// Focused real-Chrome acceptance for gi0jw + b7ny0.9. ONE fresh browser,
// ONLY the Settings deny/restart and model-created Activity/Undo flows.
// Run after npm run build:production, through fleet-gate with a hard timeout.
// No synthetic principal, DOM .click(), or whole chrome-journeys.ts import.
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { validateDistCompleteMarker } from "./dist-complete.mjs";
import { launchChrome, openCdp, resolveChromiumBinary, SW_MATCH, teardownChrome } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";
import { durableDir } from "./lib/durable-root.mjs";
import { composerInput, composerSend } from "./lib/composer-target.ts";
import { startScriptedProvider, SCRIPTED_DUMMY_KEY, selectionRefOf, executeEnvelope } from "./lib/scripted-provider.ts";
import { trackEmbeddedFrameContexts } from "./lib/embedded-frame-eval.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXT = `${ROOT}extension`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const SETTINGS_CHECKS = [
  "approval: primary NTP Settings iframe can deny an exact request",
  "approval: deny row is singular and capability material absent from the payload",
  "approval: NTP cannot programmatically resolve an owner approval",
  "approval: deny leaves the exact target unchanged",
  "approval: install-scoped opaque reference survives a worker restart",
  "approval: post-restart deny leaves the exact target unchanged",
] as const;
export const ACTIVITY_CHECKS = [
  "Activity ledger: a new pending model-create card is visible and genuinely Allowed",
  "Activity ledger: a real run creates the agent inside a genuine live run",
  "Activity ledger: the ledger row for the run-created agent carries its undo",
  "Activity ledger: the hub sidebar renders the sentence and an Undo button",
  "Activity ledger: opening the disclosure makes the Undo button hit-testable (co35)",
  "Activity ledger: a real Undo deletes the agent and marks the row undone",
] as const;
export const EXPECTED_CHECKS = [...SETTINGS_CHECKS, ...ACTIVITY_CHECKS] as const;
type Verdict = "PASS" | "FAIL" | "NOT_REACHED";
type Check = { name: string; verdict: Verdict; detail?: unknown };

export function allNamedChecksPass(checks: Check[]): boolean {
  return checks.length === EXPECTED_CHECKS.length &&
    EXPECTED_CHECKS.every((name, i) => checks[i]?.name === name && checks[i]?.verdict === "PASS");
}

export async function runForVerdict(run: () => Promise<Check[]>, report: (error: unknown) => void = console.error): Promise<number> {
  try { return allNamedChecksPass(await run()) ? 0 : 1; }
  catch (error) { report(error); return 1; }
}

async function waitFor<T>(name: string, probe: () => Promise<T | null | false>, ms = 12000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value as T;
      last = value;
    } catch (error) {
      // An execution context briefly disappearing during navigation is normal.
      if (!/execution context|navigat/i.test(String(error))) throw error;
      last = error;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${name} (${String(last).slice(0, 140)})`);
}

async function main(): Promise<Check[]> {
  const checks: Check[] = EXPECTED_CHECKS.map((name) => ({ name, verdict: "NOT_REACHED" }));
  const evidenceFiles: { name: string; sha256: string; bytes: number }[] = [];
  const evidence = durableDir("gi0jw-activity-approval", `${Date.now()}-${Deno.pid}`);
  const profile = chromeProfileDir(`gi0jw-activity-approval-${Deno.pid}-${Date.now()}`);
  await Deno.mkdir(evidence, { recursive: true });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  let distMarker: any = null, browser: any = null, chrome: any = null, cdp: any = null, binary: string | null = null;
  let provider: any = null, optsSession: string | null = null;
  let closeFrameTracker = () => {};
  let failure: string | null = null;
  let teardownError: string | null = null;
  const record = (name: string, ok: boolean, detail?: unknown) => {
    const row = checks.find((check) => check.name === name);
    if (!row || row.verdict !== "NOT_REACHED") throw new Error(`duplicate/unknown focused check: ${name}`);
    row.verdict = ok ? "PASS" : "FAIL";
    if (!ok && detail !== undefined) row.detail = detail;
    console.log(`${row.verdict}: ${name}${ok ? "" : ` — ${JSON.stringify(detail)?.slice(0, 450) ?? "false"}`}`);
  };
  const save = async (name: string, bytes: Uint8Array | null) => {
    if (!bytes || bytes.length < 200) throw new Error(`evidence capture failed: ${name}`);
    await Deno.writeFile(`${evidence}/${name}`, bytes);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    evidenceFiles.push({ name, bytes: bytes.length, sha256: [...hash].map((n) => n.toString(16).padStart(2, "0")).join("") });
  };
  try {
    // A passing KAT against yesterday's ignored bundle would be counterfeit.
    distMarker = await validateDistCompleteMarker({ root: ROOT, distRoot: `${EXT}/dist`, expectedTarget: "store" });
    if (distMarker.commit !== sourceCommit) throw new Error("production bundle is not bound to this KAT's exact source commit — rebuild first");
    binary = resolveChromiumBinary();
    chrome = await launchChrome({ extension: EXT, profile, binary, windowSize: "1400,900", clearEnv: true,
      env: Deno.env.get("FLEET_LANE") ? { FLEET_LANE: Deno.env.get("FLEET_LANE")! } : {} });
    cdp = await openCdp(chrome.wsUrl);
    const sw = await cdp.serviceWorker({ match: SW_MATCH, timeoutMs: 20000 });
    if (!sw?.url) throw new Error("loaded extension service worker was absent");
    browser = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json();
    const extId = new URL(sw.url).host;
    const ntp = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html`);
    const ntpSession = ntp.sessionId;
    const opts = await cdp.open(`chrome-extension://${extId}/options/options.html`);
    optsSession = opts.sessionId;
    const ntpEval = (expression: string) => cdp.eval(ntpSession, expression);
    const optsEval = (expression: string) => cdp.eval(opts.sessionId, expression);
    const rpc = (session: string, payload: any) => cdp.eval(session,
      `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => v, e => ({ error: String(e?.message ?? e) }))`);
    const ntpMsg = (payload: any) => rpc(ntpSession, payload);
    const optsMsg = (payload: any) => rpc(opts.sessionId, payload);
    const mouse = async (session: string, x: number, y: number) => {
      if (!session || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("real CDP click lacks target session/coordinates");
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, session);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, session);
    };
    const click = async (session: string, selector: string): Promise<boolean> => {
      const point = await cdp.eval(session, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
        el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? {x:r.x+r.width/2,y:r.y+r.height/2} : null; })()`);
      if (!point) return false;
      await mouse(session, point.x, point.y);
      return true;
    };
    const clickShadow = async (session: string, hostSelector: string, buttonSelector: string): Promise<boolean> => {
      const point = await cdp.eval(session, `(() => { const host = document.querySelector(${JSON.stringify(hostSelector)});
        const el = host?.shadowRoot?.querySelector(${JSON.stringify(buttonSelector)}); if (!el) return null;
        el.scrollIntoView({block:'center',inline:'center'}); const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? {x:r.x+r.width/2,y:r.y+r.height/2} : null; })()`);
      if (!point) return false;
      await mouse(session, point.x, point.y);
      return true;
    };
    const typeInto = async (session: string, selector: string, text: string) => {
      if (!(await click(session, selector))) throw new Error(`composer missing: ${selector}`);
      for (const ch of text) await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch }, session);
    };
    const pending = () => optsMsg({ type: "management.pending-approvals" });
    const onePending = async (action: string) => {
      const rows = await waitFor(`one pending ${action} row`, async () => {
        const r = await pending();
        return r?.ok === true && r.approvals?.length === 1 && r.approvals[0]?.action === action ? r.approvals[0] : null;
      }, 8000);
      return rows;
    };
    const resolve = async (id: string, approve = false) => {
      if (!id) throw new Error("refusing to resolve an absent/expired pending approval");
      const result = await optsMsg({ type: "management.resolve-approval", approvalId: id, approve });
      if (result?.ok !== true || result.decision !== (approve ? "approved" : "denied")) throw new Error(`Settings resolution failed: ${JSON.stringify(result)}`);
      return result;
    };

    // --------------------------------------------------------------
    // Settings: EXACT live owner-options document, exact pending row.
    // --------------------------------------------------------------
    await waitFor("NTP and owner Settings documents", async () =>
      await ntpEval(`!!document.querySelector('#open-settings')`) && await optsEval(`!!chrome.runtime?.id`), 15000);
    const origin = "https://mgmt.example", original = "renamed-worker";
    // agent.create enrols the origin but DOES NOT persist its supplied name.
    // Establish the expected target through the real gated update, then
    // consume the exact digest-bound owner approval before the deny checks.
    const seeded = await ntpMsg({ type: "agent.create", origin });
    if (seeded?.ok !== true) throw new Error(`agent enrolment failed: ${JSON.stringify(seeded)}`);
    const rename = { type: "agent.update", origin, name: original };
    const seedRequest = await ntpMsg(rename);
    if (seedRequest?.ok !== false || !/requires owner approval/i.test(String(seedRequest.error))) {
      throw new Error(`agent rename did not pay its real owner gate: ${JSON.stringify(seedRequest)}`);
    }
    const seedRow = await onePending("agent.update");
    await resolve(seedRow.approvalId, true);
    const seededRename = await ntpMsg(rename);
    if (seededRename?.ok !== true || (await ntpMsg({ type: "agent.get", origin }))?.agent?.name !== original) {
      throw new Error(`agent owner-approved rename precondition failed: ${JSON.stringify(seededRename)}`);
    }
    if ((await pending())?.approvals?.length !== 0) throw new Error("Settings approval queue was not drained by seed rename");
    // Subscribe BEFORE opening the pooled Settings frame. CDP frameId survives
    // navigation, but its earlier default-context id does not; the shared
    // tracker removes destroyed contexts and checks URL/readiness before use.
    const frameTracker = trackEmbeddedFrameContexts(cdp, ntpSession);
    closeFrameTracker = frameTracker.close;
    const firstRequest = await ntpMsg({ type: "agent.update", origin, name: "must-not-apply" });
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, ntpSession);
    if (!(await click(ntpSession, "#open-settings"))) throw new Error("could not click NTP Settings view");
    const iframeEvaluation = await frameTracker.evaluate({
      extensionId: extId, path: "/options/options.html", timeoutMs: 15_000,
      expression: `(async () => { const rows = await chrome.runtime.sendMessage({type:'management.pending-approvals'});
        if (rows?.ok !== true || rows.approvals?.length !== 1 || rows.approvals[0]?.action !== 'agent.update') return {ok:false,rows};
        const id = rows.approvals[0].approvalId;
        const resolved = await chrome.runtime.sendMessage({type:'management.resolve-approval',approvalId:id,approve:false});
        return {ok:!!id && resolved?.ok === true && resolved?.decision === 'denied',resolved}; })()`,
    });
    closeFrameTracker();
    closeFrameTracker = () => {};
    const iframeResult = iframeEvaluation.result;
    const iframeDeny = iframeResult?.result?.result?.value?.ok === true;
    const iframeAfter = await ntpMsg({ type: "agent.get", origin });
    await save("settings-iframe-denied.png", await cdp.screenshot(ntpSession, { timeoutMs: 8000 }));
    record(SETTINGS_CHECKS[0], firstRequest?.ok === false && /requires owner approval/i.test(String(firstRequest.error)) &&
      iframeDeny && iframeAfter?.ok === true && iframeAfter.agent?.name === original,
      { deniedRequest: firstRequest?.error, iframeDeny, staleContextRetries: iframeEvaluation.staleRetries,
        frameId: iframeEvaluation.frameId, targetName: iframeAfter?.agent?.name });
    if (!iframeDeny) throw new Error("embedded owner Settings did not deny exact row; refusing contaminated next checks");
    await click(ntpSession, "#view-back");

    const denyRequest = await ntpMsg({ type: "agent.update", origin, name: "deny-must-not-apply" });
    const denyRows = await pending();
    const denyList = Array.isArray(denyRows?.approvals) ? denyRows.approvals : [];
    const denyRow = denyList[0] ?? {};
    const denyPayload = JSON.stringify(denyList);
    record(SETTINGS_CHECKS[1], denyRequest?.ok === false && /requires owner approval/i.test(String(denyRequest.error)) &&
      denyList.length === 1 && denyRow.action === "agent.update" &&
      Object.keys(denyRow).sort().join(",") === "action,approvalId,at,targetRef" &&
      typeof denyRow.approvalId === "string" && denyRow.approvalId.length > 0 &&
      typeof denyRow.targetRef === "string" && denyRow.targetRef.length === 32 &&
      !denyPayload.includes(origin) && !denyPayload.includes("digest") && !denyPayload.includes("origin:"),
      { request: denyRequest?.error, count: denyList.length, fields: Object.keys(denyRow).sort(), opaqueRefLength: denyRow.targetRef?.length });
    if (!denyRow.approvalId) throw new Error("no actual pending row after second request");
    await save("settings-deny-pending.png", await cdp.screenshot(opts.sessionId, { timeoutMs: 8000 }));
    const forged = await ntpMsg({ type: "management.resolve-approval", approvalId: denyRow.approvalId,
      approve: true, __ownerUI: true, userActivation: true });
    const stillPending = await pending();
    record(SETTINGS_CHECKS[2], forged?.ok === false && /Settings/.test(String(forged?.error ?? "")) &&
      stillPending?.approvals?.[0]?.approvalId === denyRow.approvalId,
      { forgedError: forged?.error, stillPending: stillPending?.approvals?.[0]?.approvalId === denyRow.approvalId });
    await resolve(denyRow.approvalId, false);
    await save("settings-deny-resolved.png", await cdp.screenshot(opts.sessionId, { timeoutMs: 8000 }));
    const afterDeny = await ntpMsg({ type: "agent.get", origin });
    record(SETTINGS_CHECKS[3], afterDeny?.ok === true && afterDeny.agent?.name === original,
      { targetName: afterDeny?.agent?.name });

    const restartRequest = await ntpMsg({ type: "agent.update", origin, name: "restart-must-not-apply" });
    const restartRow = await onePending("agent.update");
    const oldSw = (await cdp.send("Target.getTargets"))?.result?.targetInfos?.find((t: any) => t.type === "service_worker" && t.url.includes(extId));
    if (!oldSw?.targetId) throw new Error("approval service worker target missing before restart");
    await cdp.send("Target.closeTarget", { targetId: oldSw.targetId });
    await sleep(300);
    const wake = await waitFor("service worker wake", async () => {
      const reply = await ntpMsg({ type: "asset.list", origin: "master" });
      return reply?.ok === true ? reply : null;
    }, 7000);
    const restartAgain = await ntpMsg({ type: "agent.update", origin, name: "restart-must-not-apply" });
    const newRow = await onePending("agent.update");
    const newSw = await waitFor("different service worker target", async () =>
      (await cdp.send("Target.getTargets"))?.result?.targetInfos?.find((t: any) =>
        t.type === "service_worker" && t.url.includes(extId) && t.targetId !== oldSw.targetId) ?? null, 8000);
    record(SETTINGS_CHECKS[4], restartRequest?.ok === false && restartAgain?.ok === false &&
      wake?.ok === true && newSw.targetId !== oldSw.targetId &&
      typeof restartRow.targetRef === "string" && restartRow.targetRef.length === 32 && newRow.targetRef === restartRow.targetRef,
      { oldWorker: Boolean(oldSw.targetId), newWorker: Boolean(newSw.targetId), sameOpaqueRef: newRow.targetRef === restartRow.targetRef });
    await resolve(newRow.approvalId, false);
    const afterRestart = await ntpMsg({ type: "agent.get", origin });
    record(SETTINGS_CHECKS[5], afterRestart?.ok === true && afterRestart.agent?.name === original,
      { targetName: afterRestart?.agent?.name });

    // --------------------------------------------------------------
    // Activity: the MODEL's real live run must pay and consume its owner card.
    // Do this LAST: if this leg stalls, Settings has already been measured.
    // --------------------------------------------------------------
    const emptyLedger = await ntpMsg({ type: "memory.set", origin: "master", key: "cap:action-ledger", value: [] });
    if (emptyLedger?.ok === false) throw new Error("could not clear Activity fixture row");
    provider = await startScriptedProvider({ steps: [
      { tool: "search_tools", args: { query: "create_named_agent", limit: 1 } },
      { tool: "execute_tool", args: (req: any) => ({ selectionRef: selectionRefOf(req),
        arguments: { name: "Undo Journey Agent", role: "created to prove the activity ledger's Undo" } }) },
      { text: "Created the Undo Journey Agent." },
    ] });
    const configured = await optsMsg({ type: "provider.set", config: { provider: "openai-compatible",
      baseURL: provider.baseURL, apiKey: SCRIPTED_DUMMY_KEY, model: "scripted" } });
    if (configured?.provider !== "openai-compatible" || configured?.error) throw new Error(`scripted provider setup failed: ${configured?.error ?? "wrong provider"}`);
    await cdp.send("Target.activateTarget", { targetId: ntp.targetId });
    if (!(await click(ntpSession, "#home"))) throw new Error("hub Home button missing before Activity run");
    await sleep(600);
    const beforeRuns = (await optsMsg({ type: "run.list" }))?.runs ?? [];
    const beforeIds = new Set(beforeRuns.map((row: any) => row.executionId));
    await ntpEval(`(() => { globalThis.__katOldApprovalCards = new WeakSet(document.querySelectorAll('#thread-conversation approval-card'));
      globalThis.__katCurrentApprovalCard = null; return true; })()`);
    await typeInto(ntpSession, composerInput("hub"), "create the Undo Journey Agent");
    if (!(await click(ntpSession, composerSend("hub")))) throw new Error("hub Send was not clickable");
    const pendingCard = await waitFor("new pending named-agent.create approval card", () => ntpEval(`(() => {
      const cards = [...document.querySelectorAll('#thread-conversation approval-card')].filter((card) =>
        !globalThis.__katOldApprovalCards.has(card) && (card.getAttribute('state') || 'pending') === 'pending' &&
        card.shadowRoot?.querySelector('.title')?.textContent === 'Approve named-agent.create?');
      if (cards.length !== 1) return null;
      const card = cards[0]; globalThis.__katCurrentApprovalCard = card;
      card.scrollIntoView({block:'center',inline:'center'});
      return { title: card.shadowRoot.querySelector('.title').textContent, count: cards.length };
    })()`), 30000);
    await save("activity-pending-card.png", await cdp.screenshot(ntpSession, { timeoutMs: 8000 }));
    const point = await ntpEval(`(() => { const card = globalThis.__katCurrentApprovalCard;
      if (!card?.isConnected || (card.getAttribute('state') || 'pending') !== 'pending' ||
          card.shadowRoot?.querySelector('.title')?.textContent !== 'Approve named-agent.create?') return null;
      const button = card.shadowRoot.querySelector('.approve'); if (!button) return null;
      button.scrollIntoView({block:'center',inline:'center'});
      const r = button.getBoundingClientRect(); const x = r.x+r.width/2, y = r.y+r.height/2;
      return r.width > 0 && r.height > 0 && card.shadowRoot.elementFromPoint(x,y) === button ? {x,y} : null;
    })()`);
    if (!point) throw new Error("observed approval button was disconnected/not hit-testable");
    await mouse(ntpSession, point.x, point.y);
    record(ACTIVITY_CHECKS[0], pendingCard.count === 1 && pendingCard.title === "Approve named-agent.create?" &&
      evidenceFiles.some((file) => file.name === "activity-pending-card.png") && Boolean(point),
      { cardTitle: pendingCard.title, screenshot: true });
    await waitFor("three scripted provider turns", async () => provider.requests.length === 3, 45000);
    const run = await waitFor("exact Activity run terminal record", async () => {
      const rows = (await optsMsg({ type: "run.list" }))?.runs ?? [];
      const row = rows.find((r: any) => !beforeIds.has(r.executionId) && r.taskPreview?.includes("create the Undo Journey Agent"));
      return row?.phase === "terminal" || row?.phase === "cancelled" ? row : null;
    }, 90000);
    const envelope = executeEnvelope(provider.requests.at(-1), "create_named_agent");
    const createdId = envelope?.result?.agent?.id ?? envelope?.result?.id ?? null;
    record(ACTIVITY_CHECKS[1], provider.overflow === 0 && provider.requests.length === 3 &&
      envelope?.ok === true && envelope?.result?.approvalDenied !== true &&
      typeof createdId === "string" && createdId.length > 0 && run.phase === "terminal" && run.terminal?.ok === true,
      { requests: provider.requests.length, overflow: provider.overflow, envOk: envelope?.ok, runPhase: run?.phase, terminalOk: run?.terminal?.ok });
    if (!createdId) throw new Error("model create did not produce an agent; no inverse may be seeded");
    const rowId = `kat-create-${Date.now()}`;
    await ntpMsg({ type: "memory.set", origin: "master", key: "cap:action-ledger", value: [{
      id: rowId, ts: Date.now(), tool: "create_named_agent", sentence: "Created the agent Undo Journey Agent",
      argsDigest: "name=Undo Journey Agent", inverse: { tool: "delete_named_agent", args: { id: createdId } },
      source: "hub", undone: false,
    }] });
    const row = await waitFor("Activity row for run-created agent", async () =>
      (await ntpMsg({ type: "actions.list", limit: 20 }))?.rows?.find((r: any) => r.id === rowId) ?? null, 8000);
    record(ACTIVITY_CHECKS[2], row.tool === "create_named_agent" && row.sentence === "Created the agent Undo Journey Agent" &&
      row.inverse?.tool === "delete_named_agent" && row.inverse?.args?.id === createdId && row.undone === false);
    const ui = await waitFor("Activity sidebar Undo button", async () => {
      const state = await ntpEval(`(async () => { const el = document.getElementById('side-action-ledger');
        await el?.refresh?.(); const section = document.getElementById('activity-section');
        const root = el?.shadowRoot; const undo = root?.querySelector('.al-undo');
        return { hidden: section?.hidden, text: root?.textContent ?? '', rows:root?.querySelectorAll('.al-row').length ?? 0,
          hasUndo: !!undo, undoLabel:undo?.getAttribute('aria-label') ?? '' }; })()`);
      return state?.hasUndo ? state : null;
    }, 8000);
    record(ACTIVITY_CHECKS[3], ui.hidden === false && ui.rows >= 1 &&
      ui.text.includes("Created the agent Undo Journey Agent") && ui.undoLabel.includes("Undo:"), ui);
    await save("activity-before-undo.png", await cdp.screenshot(ntpSession, { timeoutMs: 8000 }));
    const summaryClicked = await click(ntpSession, "#activity-section > summary");
    const visible = await waitFor("expanded Activity Undo hit target", async () => ntpEval(`(() => {
      const section = document.getElementById('activity-section');
      const host = document.getElementById('side-action-ledger'); const undo = host?.shadowRoot?.querySelector('.al-undo');
      if (!section?.open || !undo) return null;
      undo.scrollIntoView({block:'center',inline:'center'}); const r = undo.getBoundingClientRect();
      const hit = host.shadowRoot.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return { open:section.open, hidden:section.hidden, visible:undo.checkVisibility?.() ?? null, hit:hit === undo };
    })()`), 4000);
    record(ACTIVITY_CHECKS[4], summaryClicked && visible.open && !visible.hidden && visible.visible === true && visible.hit === true,
      visible);
    const undoClicked = await clickShadow(ntpSession, "#side-action-ledger", ".al-undo");
    const undone = await waitFor("real Undo removes agent and marks row undone", async () => {
      const agents = await ntpMsg({ type: "named-agent.list" });
      const items = (await ntpMsg({ type: "actions.list", limit: 20 }))?.rows ?? [];
      const current = items.find((r: any) => r.id === rowId);
      return !agents?.agents?.some((a: any) => a.id === createdId) && current?.undone === true
        ? { agentGone: true, rowUndone: true } : null;
    }, 8000);
    record(ACTIVITY_CHECKS[5], undoClicked && undone.agentGone && undone.rowUndone, undone);
    await save("activity-after-undo.png", await cdp.screenshot(ntpSession, { timeoutMs: 8000 }));
  } catch (error) {
    failure = String(error?.stack ?? error?.message ?? error);
    console.error(`FOCUSED_KAT_ABORT: ${failure}`);
  } finally {
    closeFrameTracker();
    try {
      if (optsSession && cdp) await cdp.eval(optsSession,
        `chrome.runtime.sendMessage({type:'provider.set',config:{provider:'demo',apiKey:''}}).then(v=>v,e=>({error:String(e?.message??e)}))`);
    } catch (error) { teardownError = `provider restore: ${String(error)}`; }
    try { await provider?.close(); } catch (error) { teardownError = `${teardownError ?? ""}; provider close: ${String(error)}`; }
    cdp?.close();
    if (chrome) {
      try { await teardownChrome(chrome, profile); }
      catch (error) { teardownError = `${teardownError ?? ""}; Chrome teardown: ${String(error)}`; }
    }
    const manifest = { schema: "cap-focused-approval-v1", sourceCommit, distMarker,
      browser: browser?.Browser ?? null, binary,
      checks, settings: checks.slice(0, SETTINGS_CHECKS.length), activity: checks.slice(SETTINGS_CHECKS.length),
      files: evidenceFiles, failure, teardownError, evidenceDir: evidence,
      totals: { passed: checks.filter((c) => c.verdict === "PASS").length,
        failed: checks.filter((c) => c.verdict === "FAIL").length,
        notReached: checks.filter((c) => c.verdict === "NOT_REACHED").length },
    };
    await Deno.writeTextFile(`${evidence}/manifest.json`, JSON.stringify(manifest, null, 2));
    for (const check of checks) if (check.verdict === "NOT_REACHED") console.error(`NOT_REACHED: ${check.name}`);
    console.log(`FOCUSED_KAT_RESULT=${JSON.stringify({ sourceCommit, evidence, ...manifest.totals, failure: !!failure, teardownError: !!teardownError })}`);
    if (teardownError) console.error(`FOCUSED_KAT_CLEANUP_ERROR: ${teardownError}`);
  }
  // Even 12 green rows cannot excuse a failed owner-clean shutdown or an
  // exception AFTER the last assertion. The manifest keeps both signals.
  if (failure || teardownError) throw new Error(`focused acceptance incomplete: ${failure ?? teardownError}`);
  return checks;
}

if (import.meta.main) Deno.exit(await runForVerdict(main));
