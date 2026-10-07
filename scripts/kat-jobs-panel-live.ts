// @ts-nocheck
// scripts/kat-jobs-panel-live.ts — focused real-browser Jobs panel acceptance.
//
// Drives the four canonical jobs panel journeys end to end in ONE fresh browser:
//   1. 'jobs panel: open jobs render with poster + recency (live, no reload)'
//   2. 'jobs panel: the message feed renders the broadcast'
//   3. 'jobs panel: the open-count hint reflects the board'
//   4. 'jobs panel: the settled group renders the outcome + result excerpt (live, no reload)'
//
// Preconditions:
//   - Empty board on a fresh profile
//   - Raw NTP principal chrome.runtime.sendMessage board.post twice + board.message (no seed bypass)
//   - Worker named-agent.create + named-agent.run @demo-board after kv.set cap:developerFeatures
//   - board.list confirms completed job id and result
//   - Real CDP Input.dispatchMouseEvent click on settled button and assert expanded result
//
// Run with:
//   deno run -A scripts/kat-jobs-panel-live.ts
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { validateDistCompleteMarker } from "./dist-complete.mjs";
import { launchChrome, openCdp, resolveChromiumBinary, SW_MATCH, teardownChrome } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXT = `${ROOT}extension`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const EXPECTED_CHECKS = [
  "jobs panel: open jobs render with poster + recency (live, no reload)",
  "jobs panel: the message feed renders the broadcast",
  "jobs panel: the open-count hint reflects the board",
  "jobs panel: the settled group renders the outcome + result excerpt (live, no reload)",
] as const;

export type Verdict = "PASS" | "FAIL" | "NOT_REACHED";
export type Check = { name: string; verdict: Verdict; detail?: unknown };

export function allNamedChecksPass(checks: Check[]): boolean {
  return checks.length === EXPECTED_CHECKS.length &&
    EXPECTED_CHECKS.every((name, i) => checks[i]?.name === name && checks[i]?.verdict === "PASS");
}

export async function runForVerdict(run: () => Promise<Check[]>, report: (error: unknown) => void = console.error): Promise<number> {
  try { return allNamedChecksPass(await run()) ? 0 : 1; }
  catch (error) { report(error); return 1; }
}

async function waitFor<T>(name: string, probe: () => Promise<T | null | false>, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value as T;
      last = value;
    } catch (error) {
      if (!/execution context|navigat/i.test(String(error))) throw error;
      last = error;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${name} (${String(last).slice(0, 140)})`);
}

export async function main(): Promise<Check[]> {
  const checks: Check[] = EXPECTED_CHECKS.map((name) => ({ name, verdict: "NOT_REACHED" }));
  const evidenceFiles: { name: string; sha256: string; bytes: number }[] = [];
  const evidence = durableDir("kat-jobs-panel-live", `${Date.now()}-${Deno.pid}`);
  const profile = chromeProfileDir(`kat-jobs-panel-live-${Deno.pid}-${Date.now()}`);
  await Deno.mkdir(evidence, { recursive: true });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  let distMarker: any = null, browser: any = null, chrome: any = null, cdp: any = null, binary: string | null = null;
  let failure: string | null = null;
  let teardownError: string | null = null;
  const domSnapshots: Record<string, any> = {};

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
    distMarker = await validateDistCompleteMarker({ root: ROOT, distRoot: `${EXT}/dist`, expectedTarget: "store" });
    if (distMarker.commit !== sourceCommit) {
      throw new Error("production bundle is not bound to this KAT's exact source commit — rebuild first");
    }
    binary = resolveChromiumBinary();
    chrome = await launchChrome({
      extension: EXT,
      profile,
      binary,
      windowSize: "1400,900",
      clearEnv: true,
      env: Deno.env.get("FLEET_LANE") ? { FLEET_LANE: Deno.env.get("FLEET_LANE")! } : {},
    });
    cdp = await openCdp(chrome.wsUrl);
    const sw = await cdp.serviceWorker({ match: SW_MATCH, timeoutMs: 15000 });
    if (!sw?.url) throw new Error("loaded extension service worker was absent");
    browser = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json();
    const extId = new URL(sw.url).host;

    const ntp = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html`);
    const ntpSession = ntp.sessionId;

    const ntpEval = (expression: string) => cdp.eval(ntpSession, expression);
    const rpc = (session: string, payload: any) => cdp.eval(session,
      `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => v, e => ({ error: String(e?.message ?? e) }))`);
    const ntpMsg = (payload: any) => rpc(ntpSession, payload);

    const mouse = async (session: string, x: number, y: number) => {
      if (!session || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("real CDP click lacks target session/coordinates");
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, session);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, session);
    };

    const jobsPanel = async () =>
      await ntpEval(`(() => {
        const el = document.querySelector("#jobs-board-host jobs-board");
        if (!el || !el.shadowRoot) return null;
        const q = (sel) => el.shadowRoot.querySelector(sel);
        return {
          text: el.shadowRoot.textContent ?? "",
          empty: q(".jb-empty")?.textContent ?? null,
          emptyHidden: q(".jb-empty")?.hidden ?? null,
          openRows: el.shadowRoot.querySelectorAll(".jb-open .jb-row").length,
          settledRows: el.shadowRoot.querySelectorAll(".jb-settled .jb-row").length,
          msgRows: el.shadowRoot.querySelectorAll(".jb-msgs .jb-row").length,
          hint: document.getElementById("jobs-count")?.textContent ?? null,
        };
      })()`);

    // An unsuccessful live projection is an observed named FAIL, not a
    // NOT_REACHED thrown by a waitFor() before the check could run.
    const observePanel = async (accept: (state: any) => boolean, ms = 15000) => {
      const deadline = Date.now() + ms;
      let latest: any = null;
      do {
        latest = await jobsPanel();
        if (accept(latest)) break;
        await sleep(150);
      } while (Date.now() < deadline);
      return latest;
    };

    // 1. Precondition: empty board fresh profile
    const emptyBoard = await waitFor("Jobs board empty state on fresh profile", async () => {
      const jp = await jobsPanel();
      if (jp && jp.emptyHidden === false && typeof jp.empty === "string" && jp.empty.includes("No shared jobs yet")) {
        return jp;
      }
      return null;
    }, 15000);
    domSnapshots.empty = emptyBoard;
    await save("jobs-panel-empty.png", await cdp.screenshot(ntpSession, { timeoutMs: 8000 }));

    // 2. Precondition: raw NTP principal chrome.runtime.sendMessage board.post twice + message
    const jpJob1 = await ntpMsg({ type: "board.post", description: "Critique the journey draft — tighten the intro" });
    if (jpJob1?.ok !== true) throw new Error(`board.post 1 failed: ${JSON.stringify(jpJob1)}`);
    const jpJob2 = await ntpMsg({ type: "board.post", description: "Find three comparable tools and summarise pricing" });
    if (jpJob2?.ok !== true) throw new Error(`board.post 2 failed: ${JSON.stringify(jpJob2)}`);
    const jpMsg = await ntpMsg({ type: "board.message", to: "broadcast", body: "Two jobs are up for the journey" });
    if (jpMsg?.ok !== true) throw new Error(`board.message failed: ${JSON.stringify(jpMsg)}`);

    // The panel re-renders LIVE from the board-* progress events (no reload)
    const populatedBoard = await observePanel((jp) => jp?.openRows === 2 && jp?.msgRows === 1 && jp?.hint === "2 open");
    domSnapshots.populated = populatedBoard;
    await save("jobs-panel-populated.png", await cdp.screenshot(ntpSession, { timeoutMs: 8000 }));

    // Check 1: 'jobs panel: open jobs render with poster + recency (live, no reload)'
    const openJobsOk = populatedBoard !== null && populatedBoard.openRows === 2 &&
      populatedBoard.text.includes("Critique the journey draft") &&
      populatedBoard.text.includes("Find three comparable tools") &&
      populatedBoard.text.includes("posted by Hub");
    record(EXPECTED_CHECKS[0], openJobsOk, { populatedBoard });

    // Check 2: 'jobs panel: the message feed renders the broadcast'
    const msgOk = populatedBoard !== null && populatedBoard.msgRows === 1 &&
      populatedBoard.text.includes("Two jobs are up for the journey");
    record(EXPECTED_CHECKS[1], msgOk, { populatedBoard });

    // Check 3: 'jobs panel: the open-count hint reflects the board'
    const hintOk = populatedBoard !== null && populatedBoard.hint === "2 open";
    record(EXPECTED_CHECKS[2], hintOk, { hint: populatedBoard?.hint, populatedBoard });

    // Precondition for Check 4: worker named-agent.create + named-agent.run @demo-board after kv.set developerFeatures
    const kvRes = await ntpMsg({ type: "kv.set", values: { "cap:developerFeatures": true } });
    if (kvRes?.ok !== true) throw new Error(`kv.set developerFeatures failed: ${JSON.stringify(kvRes)}`);

    const jpAgent = await ntpMsg({
      type: "named-agent.create",
      name: "Jobs Journey Worker",
      role: "You claim and complete board jobs.",
    });
    const jpAgentId = jpAgent?.agent?.id ?? null;
    if (!jpAgentId) throw new Error(`named-agent.create failed: ${JSON.stringify(jpAgent)}`);

    const jpRun = await ntpMsg({ type: "named-agent.run", id: jpAgentId, task: "@demo-board" });
    if (jpRun?.ok !== true && jpRun?.status !== "done" && jpRun?.done !== true) {
      throw new Error(`named-agent.run @demo-board failed: ${JSON.stringify(jpRun)}`);
    }

    // board.list confirms completed job id and result
    const listRes = await ntpMsg({ type: "board.list" });
    const completedJob = (listRes?.jobs ?? []).find((j: any) => j?.status === "completed");
    if (!completedJob?.id || completedJob?.claimantId !== jpAgentId ||
        typeof completedJob?.result !== "string" || !completedJob.result.length) {
      throw new Error(`board.list does not confirm completed job: ${JSON.stringify(listRes)}`);
    }

    // Live again: the settled group shows outcome + bounded result excerpt,
    // and the open count drops — all WITHOUT a reload.
    const settledBoard = await observePanel((jp) => jp?.settledRows === 1 && jp?.openRows === 1 && jp?.hint === "1 open");
    domSnapshots.settled = settledBoard;
    await save("jobs-panel-settled.png", await cdp.screenshot(ntpSession, { timeoutMs: 8000 }));

    // Real CDP Input.dispatchMouseEvent click on settled button and assert expanded result
    let expandedState: any = null, expansionError: string | null = null;
    try {
    const settledBtnPoint = await waitFor("settled button center point", async () => {
      const pt = await ntpEval(`(() => {
        const el = document.querySelector("#jobs-board-host jobs-board");
        const sr = el?.shadowRoot;
        const btn = sr?.querySelector(".jb-settled-btn:not([disabled])");
        if (!btn) return null;
        btn.scrollIntoView({ block: "center", inline: "center" });
        const r = btn.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      })()`);
      return pt && Number.isFinite(pt.x) && Number.isFinite(pt.y) ? pt : null;
    }, 15000);

    await mouse(ntpSession, settledBtnPoint.x, settledBtnPoint.y);

    expandedState = await waitFor("expanded result visible after click", async () => {
      const exp = await ntpEval(`(() => {
        const el = document.querySelector("#jobs-board-host jobs-board");
        const sr = el?.shadowRoot;
        const btn = sr?.querySelector(".jb-settled-btn:not([disabled])");
        const full = btn?.parentElement?.querySelector(".jb-full");
        return {
          ariaExpanded: btn?.getAttribute("aria-expanded"),
          fullHidden: full ? full.hidden : null,
          fullText: full?.textContent ?? null,
        };
      })()`);
      if (exp?.ariaExpanded === "true" && exp?.fullHidden === false &&
          typeof exp?.fullText === "string" && exp.fullText.length > 0) {
        return exp;
      }
      return null;
    }, 15000);
    } catch (error) {
      expansionError = String(error);
    }
    domSnapshots.expanded = expandedState;

    // Check 4: 'jobs panel: the settled group renders the outcome + result excerpt (live, no reload)'
    const settledOk = settledBoard !== null && settledBoard.settledRows === 1 && settledBoard.openRows === 1 &&
      settledBoard.text.includes("Completed") &&
      settledBoard.text.includes("claimed and completed via @demo-board") &&
      settledBoard.hint === "1 open" &&
      expandedState?.ariaExpanded === "true" &&
      expandedState?.fullHidden === false &&
      typeof expandedState?.fullText === "string" &&
      expandedState.fullText.includes(completedJob.result);
    record(EXPECTED_CHECKS[3], settledOk, { settledBoard, expandedState, expansionError, completedJobId: completedJob.id });
  } catch (error) {
    failure = String(error?.stack ?? error?.message ?? error);
    console.error(`FOCUSED_KAT_ABORT: ${failure}`);
  } finally {
    cdp?.close();
    try {
      await teardownChrome(chrome, profile);
    } catch (error) {
      teardownError = `Chrome teardown: ${String(error)}`;
    }
    const manifest = {
      schema: "cap-jobs-panel-live-v1",
      sourceCommit,
      distMarker,
      browser: browser?.Browser ?? null,
      binary,
      checks,
      domSnapshots,
      files: evidenceFiles,
      failure,
      teardownError,
      evidenceDir: evidence,
      totals: {
        passed: checks.filter((c) => c.verdict === "PASS").length,
        failed: checks.filter((c) => c.verdict === "FAIL").length,
        notReached: checks.filter((c) => c.verdict === "NOT_REACHED").length,
      },
    };
    await Deno.writeTextFile(`${evidence}/manifest.json`, JSON.stringify(manifest, null, 2));
    for (const check of checks) {
      if (check.verdict === "NOT_REACHED") console.error(`NOT_REACHED: ${check.name}`);
    }
    console.log(`FOCUSED_KAT_RESULT=${JSON.stringify({
      sourceCommit,
      evidence,
      ...manifest.totals,
      failure: !!failure,
      teardownError: !!teardownError,
    })}`);
    if (teardownError) console.error(`FOCUSED_KAT_CLEANUP_ERROR: ${teardownError}`);
  }

  if (failure || teardownError) throw new Error(`focused acceptance incomplete: ${failure ?? teardownError}`);
  return checks;
}

if (import.meta.main) Deno.exit(await runForVerdict(main));
