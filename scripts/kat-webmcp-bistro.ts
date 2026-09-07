// scripts/kat-webmcp-bistro.ts — real-browser KAT for chrome-agent-platform-l3vc / 06qj:
// asserts WebMCP tool execution on GoogleChromeLabs French Bistro declarative demo
// accepts JSON-formatted string arguments for native WebMCP WebIDL compatibility.
// Bounded execution with ?toolautosubmit, CDP interception, and clean process lifecycle.
// Usage: deno run -A scripts/kat-webmcp-bistro.ts [extension-dir] [evidence-dir]
//
// chrome-agent-platform-cvlf: every decision unit (predicates, error capture,
// report/teardown assembly, launch config, the finally block) lives in
// lib/kat-bistro-caller.ts and is EXECUTED by tests/kat-bistro-caller.test.ts —
// this script is the wiring only.

import { launchChrome, openCdp, withTimeout } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";
import {
  announceRunError,
  assembleBistroReport,
  URL_BISTRO,
  assembleBistroTeardown,
  BISTRO_READY_EXPRESSION,
  bistroDomBookingHolds,
  bistroFalsificationHolds,
  bistroJsonStringProbe,
  bistroJsonStringSuccessHolds,
  bistroProfileDir,
  bistroRunReport,
  buildBistroLaunchConfig,
  captureRunError,
  hasGitChanges,
  mainWorldSha256Of,
  persistBistroScreenshot,
  runBistroEvidenceDir,
  screenshotCapturedHolds,
  serviceWorkerRegisteredHolds,
  settleBistroRun,
} from "./lib/kat-bistro-caller.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
// The positional evidence arg is the PARENT. Every INVOCATION owns a fresh,
// run-bound child OUT (z6xw: the current invocation's evidence authority is
// fresh by construction — a stale/read-only parent or prior result can never
// alias this run's receipt). The exact receipt path prints at the end.
const head = await git("rev-parse", "HEAD").catch(() => "unknown");
const tree = await git("rev-parse", "HEAD^{tree}").catch(() => "unknown");
const dirty = hasGitChanges(await git("status", "--porcelain").catch(() => ""));

const OUT_PARENT = Deno.args[1] ?? durableDir("kat-webmcp-bistro");
// A FULL-UUID child per invocation, created EXCLUSIVELY — a collision fails
// CLOSED, never aliases another run's evidence (the allocator is the real,
// imported, test-executed seam).
const OUT = await runBistroEvidenceDir({ parent: OUT_PARENT });
const PROFILE = bistroProfileDir(Date.now());


await Deno.mkdir(PROFILE, { recursive: true });

const checks: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
let pass = 0, fail = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  const entry = { name, passed: cond, ...(detail === undefined ? {} : { detail }) };
  checks.push(entry);
  if (cond) {
    pass++;
    console.log(`PASS: ${name}`);
  } else {
    fail++;
    console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`);
  }
}

async function waitFor(
  cdp: Awaited<ReturnType<typeof openCdp>>,
  sessionId: string,
  expression: string,
  timeoutMs = 30_000,
) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await cdp.eval(sessionId, expression)) return;
    } catch {
      /* navigation / pending load */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${expression}`);
}

async function git(...args: string[]) {
  const out = await new Deno.Command("git", { cwd: ROOT, args, stdout: "piped" }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")} failed`);
  return new TextDecoder().decode(out.stdout).trim();
}

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let cdp: Awaited<ReturnType<typeof openCdp>> | undefined;
let page: { targetId: string; sessionId: string } | undefined;
let runError: string | null = null;
let browserVersion: unknown = null;
let mainWorldSha256: string = "";


try {
  const mwBytes = await Deno.readFile(`${EXT}/content/main-world.js`).catch(() => new Uint8Array());
  mainWorldSha256 = mainWorldSha256Of(mwBytes);
} catch {
  mainWorldSha256 = "unknown";
}

console.log(`Launching Chromium with WebMCP feature (profile: ${PROFILE})...`);

try {
  chrome = await launchChrome({
    ...buildBistroLaunchConfig({ extensionDir: EXT, profileDir: PROFILE }),
  });

  cdp = await openCdp(chrome.wsUrl, { timeoutMs: 30_000 });
  browserVersion = await cdp.send("Browser.getVersion");

  const worker = await cdp.serviceWorker({ timeoutMs: 20_000 });
  check("this fresh-profile extension registered its service worker", serviceWorkerRegisteredHolds(worker), worker?.url);

  console.log("Navigating to French Bistro demo with ?toolautosubmit...");
  page = await cdp.open(URL_BISTRO);

  await waitFor(cdp, page.sessionId, BISTRO_READY_EXPRESSION, 30_000);
  const mcInfo = await cdp.eval(page.sessionId, `({
    hasModelContext: !!document.modelContext,
    hasExecuteTool: typeof document.modelContext?.executeTool === "function",
    hasGetTools: typeof document.modelContext?.getTools === "function",
  })`);
  check("document.modelContext is present on page", mcInfo?.hasModelContext === true && mcInfo?.hasExecuteTool === true, mcInfo);

  const discovered = await cdp.eval(page.sessionId, `(async () => (await document.modelContext.getTools()).map(t => t.name))()`);
  check("French Bistro native WebMCP tool is discovered", Array.isArray(discovered) && discovered.includes("book_table_le_petit_bistro"), discovered);

  const validBooking = {
    name: "Jean-Luc Picard",
    phone: "1234567890",
    date: "2026-09-10",
    time: "19:00",
    guests: "2",
    seating: "Main Dining",
  };

  // 1. FALSIFICATION: Object args trigger WebIDL DOMString coercion to '[object Object]', failing native C++ JSONReader parse
  const objRes = await cdp.eval(page.sessionId, `(async () => {
    const tool = (await document.modelContext.getTools()).find(t => t.name === "book_table_le_petit_bistro");
    try {
      const res = await document.modelContext.executeTool(tool, ${JSON.stringify(validBooking)});
      return { ok: true, res };
    } catch (err) {
      return { ok: false, error: String(err?.name) + ": " + String(err?.message) };
    }
  })()`);
  check("falsification: unstringified object args fail with JSON parse error in native WebMCP",
    bistroFalsificationHolds(objRes),
    objRes,
  );

  // 2. SUCCESS: JSON-formatted string args pass WebIDL DOMString check, parse cleanly, and execute the booking
  const payload = JSON.stringify(validBooking);
  const strRes = await bistroJsonStringProbe(cdp, page.sessionId, payload);
  check("JSON-string arguments settle successfully through native WebMCP",
    bistroJsonStringSuccessHolds(strRes),
    strRes,
  );

  // 3. DOM & DIALOG VISIBLE VERIFICATION: Page reflects exact form fields and booking confirmation dialog
  const visible = await cdp.eval(page.sessionId, `({
    dialogOpen: document.getElementById("bookingDialog")?.open === true,
    modalText: document.getElementById("modalDetails")?.textContent ?? "",
    name: document.getElementById("name")?.value ?? "",
    phone: document.getElementById("phone")?.value ?? "",
    date: document.getElementById("date")?.value ?? "",
    time: document.getElementById("time")?.value ?? "",
    guests: document.getElementById("guests")?.value ?? "",
    seating: document.getElementById("seating")?.value ?? "",
  })`);
  check("the real page visibly reflects the exact booking and opens its result dialog",
    bistroDomBookingHolds(visible, validBooking),
    visible,
  );

  // 4. SCREENSHOT CAPTURE: capture the open dialog
  const shot = await cdp.screenshot(page.sessionId, { captureBeyondViewport: true, fromSurface: false });
  check("post-invocation screenshot captured", screenshotCapturedHolds(shot), shot?.length ?? 0);
  await persistBistroScreenshot({ shot, outDir: OUT });

} catch (err) {
  // ll7q: the stack carries run paths — the CONSOLE gets the sanitized class,
  // never raw paths, before the exact locator line. The receipt keeps the
  // bounded message (the receipt is the authoritative artifact, post-locator).
  runError = captureRunError(err);
  announceRunError(err);
} finally {
  // GUARANTEED TEARDOWN + decision + reports + fail-closed exit: ONE call into
  // the production finalizer via the extracted settle unit — the committed
  // tests execute THAT function, never a simulation of it.
  await settleBistroRun({
    runError,
    checks,
    teardown: assembleBistroTeardown({ cdp, chrome, profilePath: PROFILE, withTimeout }),
    report: bistroRunReport({
      evidence: OUT,
      head,
      tree,
      dirty,
      mainWorldSha256,
      url: URL_BISTRO,
      browserVersion,
      lockWaitMs: chrome?.lockWaitMs ?? null,
    }),
  });
}
