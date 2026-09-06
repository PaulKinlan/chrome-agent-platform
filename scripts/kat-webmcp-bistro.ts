// scripts/kat-webmcp-bistro.ts — real-browser KAT for chrome-agent-platform-l3vc / 06qj:
// asserts WebMCP tool execution on GoogleChromeLabs French Bistro declarative demo
// accepts JSON-formatted string arguments for native WebMCP WebIDL compatibility.
// Bounded execution with ?toolautosubmit, CDP interception, and clean process lifecycle.
// Usage: deno run -A scripts/kat-webmcp-bistro.ts [extension-dir] [evidence-dir]

import { createHash } from "node:crypto";
import { launchChrome, openCdp, withTimeout } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? durableDir(`kat-webmcp-bistro-${Date.now()}`);
const PROFILE = durableDir(`kat-webmcp-bistro-profile-${Date.now()}`);
const URL_BISTRO = "https://googlechromelabs.github.io/webmcp-tools/demos/french-bistro/?toolautosubmit";

await Deno.mkdir(OUT, { recursive: true });
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

const head = await git("rev-parse", "HEAD").catch(() => "unknown");
const tree = await git("rev-parse", "HEAD^{tree}").catch(() => "unknown");
const dirty = (await git("status", "--porcelain").catch(() => "")).length > 0;

try {
  const mwBytes = await Deno.readFile(`${EXT}/content/main-world.js`).catch(() => new Uint8Array());
  mainWorldSha256 = createHash("sha256").update(mwBytes).digest("hex");
} catch {
  mainWorldSha256 = "unknown";
}

console.log(`Launching Chromium with WebMCP feature (profile: ${PROFILE})...`);

try {
  chrome = await launchChrome({
    binary: "/usr/bin/chromium",
    extension: EXT,
    profile: PROFILE,
    timeoutMs: 30_000,
    args: [
      "--enable-features=WebMCP",
    ],
  });

  cdp = await openCdp(chrome.wsUrl, { timeoutMs: 30_000 });
  browserVersion = await cdp.send("Browser.getVersion");

  const worker = await cdp.serviceWorker({ timeoutMs: 20_000 });
  check("this fresh-profile extension registered its service worker", !!worker?.url?.startsWith("chrome-extension://"), worker?.url);

  console.log("Navigating to French Bistro demo with ?toolautosubmit...");
  page = await cdp.open(URL_BISTRO);

  await waitFor(cdp, page.sessionId, `document.readyState === "complete" && typeof document.modelContext?.getTools === "function"`, 30_000);
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
    objRes?.ok === false && /Failed to parse input string as JSON/i.test(objRes?.error ?? ""),
    objRes,
  );

  // 2. SUCCESS: JSON-formatted string args pass WebIDL DOMString check, parse cleanly, and execute the booking
  const payload = JSON.stringify(validBooking);
  const strRes = await withTimeout(cdp.eval(page.sessionId, `(async () => {
    const tool = (await document.modelContext.getTools()).find(t => t.name === "book_table_le_petit_bistro");
    try {
      const res = await document.modelContext.executeTool(tool, ${JSON.stringify(payload)});
      return { ok: true, res };
    } catch (err) {
      return { ok: false, error: String(err?.name) + ": " + String(err?.message) };
    }
  })()`), 30_000);
  check("JSON-string arguments settle successfully through native WebMCP",
    strRes?.ok === true && typeof strRes?.res === "string" && strRes.res.includes("We look forward to welcoming you"),
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
    visible?.dialogOpen === true &&
    visible?.name === validBooking.name &&
    visible?.phone === validBooking.phone &&
    visible?.date === validBooking.date &&
    visible?.time === validBooking.time &&
    visible?.guests === validBooking.guests &&
    visible?.seating === validBooking.seating &&
    visible?.modalText.includes("We look forward to welcoming you"),
    visible,
  );

  // 4. SCREENSHOT CAPTURE: capture the open dialog
  const shot = await cdp.screenshot(page.sessionId, { captureBeyondViewport: true, fromSurface: false });
  check("post-invocation screenshot captured", !!shot?.length, shot?.length ?? 0);
  if (shot) {
    await Deno.writeFile(`${OUT}/bistro-json-string-success.png`, shot);
  }

} catch (err) {
  runError = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error("KAT Execution Error:", runError);
} finally {
  // 1. GUARANTEED TEARDOWN: Execute browser termination and profile cleanup first.
  // Never let reporting failure skip cleanup, and never swallow cleanup failure.
  let cleanupError: string | null = null;
  try {
    if (cdp) {
      await withTimeout(cdp.send("Browser.close"), 4_000).catch(() => {});
      cdp.close();
    }
    if (chrome) {
      await withTimeout(chrome.proc.status, 8_000).catch(async () => {
        try { chrome?.proc.kill("SIGKILL"); } catch { /* process already exited */ }
        await withTimeout(chrome?.proc.status, 4_000).catch(() => {});
      });
    }
  } catch (teardownErr) {
    cleanupError = `browser_teardown_failed: ${teardownErr instanceof Error ? teardownErr.message : String(teardownErr)}`;
    console.error(cleanupError);
  }

  try {
    if (PROFILE) await Deno.remove(PROFILE, { recursive: true });
  } catch (rmErr) {
    const rmMsg = `profile_cleanup_failed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`;
    cleanupError = cleanupError ? `${cleanupError}; ${rmMsg}` : rmMsg;
    console.error(rmMsg);
  }

  // 2. CHECK POISON AND RESIDUAL LOCK
  const POISON_FILE = "/tmp/cap-chrome-slot-POISON";
  let poisonDetected = false;
  try {
    if (await Deno.stat(POISON_FILE).then(() => true).catch(() => false)) {
      poisonDetected = true;
      cleanupError = cleanupError ? `${cleanupError}; poison_slot_detected` : "poison_slot_detected";
    }
  } catch {}

  const isGreen = !runError && fail === 0 && !cleanupError && !poisonDetected;
  const resultData = {
    state: isGreen ? "GREEN" : "RED",
    error: runError || cleanupError,
    cleanupError,
    poisonDetected,
    expected: head,
    head,
    tree,
    dirty,
    mainWorldSha256,
    url: URL_BISTRO,
    browserVersion,
    lockWaitMs: chrome?.lockWaitMs ?? null,
    checks,
  };

  try {
    await Deno.writeTextFile(`${OUT}/result.json`, JSON.stringify(resultData, null, 2) + "\n");
    await Deno.writeTextFile(
      `${OUT}/kat.log`,
      checks.map((c) => `${c.passed ? "PASS" : "FAIL"}: ${c.name}`).join("\n") +
        `\nRESULT: ${pass}/${checks.length}; ${isGreen ? "GREEN" : "RED"}\n` +
        (cleanupError ? `CLEANUP ERROR: ${cleanupError}\n` : ""),
    );
  } catch (reportErr) {
    console.error("FATAL: Failed to write KAT reports:", reportErr);
    Deno.exit(1);
  }

  console.log(`\nKAT Result: ${pass} passed, ${fail} failed (cleanup: ${cleanupError ?? "ok"}); evidence ${OUT}`);
  if (!isGreen) Deno.exit(1);
}
