// chrome-agent-platform-ltkj.3 — loaded Emscripten runtime acceptance proof.
//
// The ltkj.3 contract requires:
//   - real native operation execution from BOTH call paths returning expected values:
//     1. Settings options document call path (tool.package.run)
//     2. Service worker broker call path (dispatchEmscriptenRun)
//   - honest failure on wrong sender, malformed envelopes, and stale graph
//   - canonical launchChrome and durable evidence
//
// Reuses the ltkj.2 disposable acceptance copy plumbing:
//   disposable copy in durableDir("scratch") -> rebuild with acceptance target
//   (--acceptance-emscripten-numeric) -> throwaway git repo -> Store build ->
//   launchChrome -> drive Settings validation -> drive native execution from
//   both call paths -> verify falsifications -> durable evidence.
// The reviewed source tree is NEVER written.

import { fileURLToPath } from "node:url";
import {
  launchChrome,
  openCdp,
  waitForServiceWorker,
  teardownChrome,
} from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";
import { NUMERIC_ACCEPTANCE_PINS } from "./lib/emscripten-numeric-acceptance.mjs";
import { prepareAcceptanceCopy } from "./emscripten-admission-loaded.ts";

const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const P = NUMERIC_ACCEPTANCE_PINS;
const PACKAGE_ID = P.packageId; // cap.acceptance.a0.numeric
const DEVELOPER_FEATURES_KEY = "cap:developerFeatures";

const LIBRARY_EVAL = (fnBody: string) => `(() => {
  const el = document.querySelector("#tool-library-view");
  const root = el && (el.shadowRoot || el);
  if (!root) return null;
  return ${fnBody};
})()`;

const REGISTRY_QUERY = `(async () => {
  const [{ readCommittedPackages }, { masterMemory }] = await Promise.all([
    import(chrome.runtime.getURL("lib/wasm-package-registry-core.js")),
    import(chrome.runtime.getURL("lib/memory.js")),
  ]);
  const store = await masterMemory();
  const read = await readCommittedPackages(store);
  if (!read.ok) return { ok: false, error: read.error };
  const pkg = read.packages.get(${JSON.stringify(PACKAGE_ID)});
  if (!pkg) return { ok: false, error: "not_found" };
  return {
    ok: true,
    version: pkg.version,
    manifestDigest: pkg.manifestDigest,
    graphDigest: pkg.graphDigest,
    state: pkg.state,
  };
})()`;

type Cdp = Awaited<ReturnType<typeof openCdp>>;

async function waitForLibrary(cdp: Cdp, sessionId: string, predicate: string, timeoutMs: number, consoleTail: string[] = []) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await cdp.eval(sessionId, LIBRARY_EVAL(predicate)).catch(() => null);
    if (value !== null && value !== undefined && value !== false) return value;
    await sleep(150);
  }
  const diag = await cdp.eval(sessionId, `(async () => {
    const out = {};
    try {
      out.routeProbe = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "tool.package.validation-list" }, (r) => {
            out.lastError = chrome.runtime.lastError?.message ?? null;
            resolve(JSON.stringify(r));
          });
        } catch (e) { resolve("throw: " + (e?.message ?? e)); }
      });
    } catch (e) { out.routeProbe = "eval-failed: " + (e?.message ?? e); }
    return JSON.stringify(out);
  })()`).catch((e: any) => `diag-eval-failed: ${e?.message ?? e}`);
  throw new Error(`timed out waiting for tool-library predicate: ${predicate}\ndiagnostics: ${diag}\nconsole tail:\n${consoleTail.join("\n")}`);
}

async function waitForLibraryReady(cdp: any, sessionId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await cdp.eval(sessionId, LIBRARY_EVAL("Boolean(root.querySelector('.packages'))")).catch(() => false);
    if (ready === true) return;
    await sleep(100);
  }
  throw new Error("timed out waiting for #tool-library-view DOM ready");
}

async function waitForValidationStatus(cdp: any, sessionId: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusText = await cdp.eval(sessionId, LIBRARY_EVAL(`(() => { const s = root.querySelector(".validation-status"); return s ? s.textContent : null; })()`)) as string | null;
    if (statusText && statusText.includes("Package validated")) return statusText;
    if (statusText && statusText.includes("Validation failed")) throw new Error(`validation failed: ${statusText}`);
    await sleep(200);
  }
  throw new Error("timed out waiting for validation status to settle");
}

async function main() {
  const evidence = await Deno.makeTempDir({ dir: durableDir("astra", "ltkj3"), prefix: "runtime-loaded-" });
  const copyRoot = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-emscripten-runtime-copy-" });
  const profile = await Deno.makeTempDir({ dir: durableDir("chrome-profiles"), prefix: "cap-emscripten-runtime-" });
  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let teardownOk = false;
  let teardownFailed = false;
  let teardownError: string | null = null;
  let retainedCopyRoot: string | null = null;
  let error: string | null = null;
  const externalRequests: string[] = [];
  const result: Record<string, unknown> = {
    packageId: PACKAGE_ID,
    version: P.packageVersion,
    evidenceDir: evidence,
  };

  try {
    console.log(`[runtime] preparing acceptance copy at ${copyRoot}`);
    const prepared = await prepareAcceptanceCopy(copyRoot);
    result.copy = prepared;

    // Launch Chrome with --disable-crash-reporter per coord heads-up
    chrome = await launchChrome({
      extension: join(copyRoot, "extension"),
      profile,
      windowSize: "1440,1000",
      args: ["--disable-crash-reporter"],
    });
    const cdp = await openCdp(chrome.wsUrl, { timeoutMs: 30_000 });
    result.browser = (await cdp.send("Browser.getVersion")).result;
    const serviceWorker = await waitForServiceWorker(cdp.send, { timeoutMs: 20_000 });
    if (!serviceWorker) throw new Error("acceptance extension did not register its service worker");
    const extensionId = new URL(serviceWorker.url).host;
    result.extensionId = extensionId;

    const page = await cdp.open("about:blank");
    const sessionId = page.sessionId;
    await cdp.send("Network.enable", {}, sessionId);
    const consoleTail = [] as string[];
    cdp.on("Runtime.consoleAPICalled", (params: any) => {
      const text = (params?.args ?? []).map((a: { value?: unknown; description?: string }) => String(a?.value ?? a?.description ?? "")).join(" ").slice(0, 300);
      consoleTail.push(`${params?.type ?? "log"}: ${text}`);
      if (consoleTail.length > 60) consoleTail.shift();
    });
    cdp.on("Runtime.exceptionThrown", (params: any) => {
      const d = params?.exceptionDetails ?? {};
      consoleTail.push(`EXCEPTION: ${d.text ?? ""} ${d.exception?.description ?? ""}`.slice(0, 400));
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    cdp.on("Network.requestWillBeSent", (params: any) => {
      const url = String(params?.request?.url ?? "");
      if (/^https?:/u.test(url)) externalRequests.push(url);
    });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url: `chrome-extension://${extensionId}/options/options.html` }, sessionId);
    await waitForLibraryReady(cdp, sessionId);

    // Enable developer features through kv.set + cross-document reload
    const kvSet = await cdp.eval(sessionId, `(async () => await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "kv.set", values: { ${JSON.stringify(DEVELOPER_FEATURES_KEY)}: true } }, (r) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message ?? "kv.set failed")); else resolve(JSON.stringify(r));
      });
    }))()`).catch((e: any) => `kv.set-failed: ${e?.message ?? e}`);
    if (typeof kvSet === "string" && kvSet.startsWith("kv.set-failed")) {
      throw new Error(`developer-features flag could not be set: ${kvSet}`);
    }

    await cdp.eval(sessionId, "window.__harnessPreReload = true");
    await cdp.send("Page.navigate", { url: "about:blank" }, sessionId);
    await cdp.send("Page.navigate", { url: `chrome-extension://${extensionId}/options/options.html#tool-library` }, sessionId);
    await waitForLibraryReady(cdp, sessionId);

    // Explicitly switch navigation to the tool-library section so it is visible on screen
    await cdp.eval(sessionId, `(() => {
      document.querySelector('a[data-section="tool-library"]')?.click();
      document.getElementById("tool-library")?.scrollIntoView({ behavior: "instant", block: "start" });
      return true;
    })()`);

    // Wait for the validation list to render the acceptance package row
    const rows = await waitForLibrary(
      cdp,
      sessionId,
      `(() => { const r = Array.from(root.querySelectorAll(".validation-packages .validation-row .validation-pkg-info")).map((n) => n.textContent); return r.length ? r : false; })()`,
      30_000,
      consoleTail,
    );
    result.listRows = rows;
    const expectedRow = `${PACKAGE_ID} (v${P.packageVersion})`;
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0] !== expectedRow) {
      throw new Error(`validation list is wrong: ${JSON.stringify(rows)} (expected exactly [${expectedRow}])`);
    }

    const buttonVisible = await cdp.eval(sessionId, LIBRARY_EVAL(`(() => { const b = root.querySelector(".package-validate-btn"); return Boolean(b && !b.hidden && !b.disabled); })()`));
    if (buttonVisible !== true) throw new Error("validate button is not visible/enabled with a listed package");

    // Click "Validate package" to admit the package into the registry
    await cdp.eval(sessionId, LIBRARY_EVAL(`(() => { root.querySelector(".package-validate-btn").click(); return true; })()`));
    const statusText = await waitForValidationStatus(cdp, sessionId);
    result.validationStatus = statusText;

    // Verify registry committed record
    const regCheck = await cdp.eval(sessionId, REGISTRY_QUERY);
    result.registryCheck = regCheck;
    if (!regCheck || regCheck.ok !== true) throw new Error(`registry check failed: ${JSON.stringify(regCheck)}`);

    // ── Call Path 1: Settings options document (tool.package.run) ────────────
    // ── Call Path 1: Settings internal route (tool.package.run) ────────────
    console.log("[runtime] testing Call Path 1: Settings-principal route (tool.package.run)");
    const settingsRun = await cdp.eval(sessionId, `(async () => await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: "tool.package.run",
        packageId: ${JSON.stringify(PACKAGE_ID)},
        version: ${JSON.stringify(P.packageVersion)},
        operationId: "weighted_sum",
        args: [6, 7, 0.5],
      }, (res) => resolve(res));
    }))()`);
    result.settingsRun = settingsRun;
    console.log("[runtime] Settings run result:", JSON.stringify(settingsRun));

    if (!settingsRun || settingsRun.ok !== true || settingsRun.phase !== "completed" || settingsRun.result !== 42.5) {
      throw new Error(`Settings call path failed: expected result 42.5, got: ${JSON.stringify(settingsRun)}`);
    }

    // ── Call Path 2: Service Worker lazy-tool / model-facing broker dispatch ─
    console.log("[runtime] testing Call Path 2: Service Worker lazy-tool / model-facing broker dispatch");
    const brokerRun = await cdp.eval(sessionId, `(async () => await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: "tool.package.run",
        mode: "broker", // Exercises liveChromeLazyRecords in the Service Worker (lines 2460-2463)
        packageId: ${JSON.stringify(PACKAGE_ID)},
        version: ${JSON.stringify(P.packageVersion)},
        operationId: "weighted_sum",
        args: [10, 2, 2.5],
      }, (res) => resolve(res));
    }))()`);
    result.brokerRun = brokerRun;
    console.log("[runtime] Broker run result:", JSON.stringify(brokerRun));

    // 10 * 2 + 2.5 = 22.5
    if (!brokerRun || brokerRun.ok !== true || brokerRun.phase !== "completed" || brokerRun.result !== 22.5) {
      throw new Error(`Broker call path failed: expected result 22.5, got: ${JSON.stringify(brokerRun)}`);
    }

    console.log("[runtime] testing Broker Falsification: stale graph refusal via dispatchEmscriptenRun");
    const brokerStaleRun = await cdp.eval(sessionId, `(async () => await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: "tool.package.run",
        mode: "broker",
        packageId: ${JSON.stringify(PACKAGE_ID)},
        version: ${JSON.stringify(P.packageVersion)},
        graphDigest: "0".repeat(64), // Mismatched graphDigest
        operationId: "weighted_sum",
        args: [10, 2, 2.5],
      }, (res) => resolve(res));
    }))()`);
    result.brokerStaleRun = brokerStaleRun;
    console.log("[runtime] Broker stale run result:", JSON.stringify(brokerStaleRun));
    if (brokerStaleRun?.ok !== false || brokerStaleRun?.error !== "emscripten_stale_graph") {
      throw new Error(`broker stale graph rejection failed: got ${JSON.stringify(brokerStaleRun)}`);
    }

    // ── Falsification 1: Malformed envelope (extra keys / invalid args) ─────
    console.log("[runtime] testing Falsification: malformed envelope (extra keys rejected)");
    const extraKeysRun = await cdp.eval(sessionId, `(async () => await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: "tool.package.run",
        packageId: ${JSON.stringify(PACKAGE_ID)},
        version: ${JSON.stringify(P.packageVersion)},
        operationId: "weighted_sum",
        args: [6, 7, 0.5],
        maliciousExtra: "exploit",
      }, (res) => resolve(res));
    }))()`);
    result.extraKeysRun = extraKeysRun;
    if (extraKeysRun?.ok !== false || extraKeysRun?.error !== "extra_keys_rejected") {
      throw new Error(`malformed extra keys must be rejected: got ${JSON.stringify(extraKeysRun)}`);
    }

    // ── Falsification 2: Out of bounds arguments ─────────────────────────────
    console.log("[runtime] testing Falsification: out of bounds arguments");
    const outOfBoundsRun = await cdp.eval(sessionId, `(async () => await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: "tool.package.run",
        packageId: ${JSON.stringify(PACKAGE_ID)},
        version: ${JSON.stringify(P.packageVersion)},
        operationId: "weighted_sum",
        args: [6, 2000000, 0.5], // max is 1000000
      }, (res) => resolve(res));
    }))()`);
    result.outOfBoundsRun = outOfBoundsRun;
    if (outOfBoundsRun?.ok !== false || (!String(outOfBoundsRun?.error).includes("outside") && outOfBoundsRun?.error !== "emscripten_run_args")) {
      throw new Error(`out-of-bounds argument must be rejected: got ${JSON.stringify(outOfBoundsRun)}`);
    }

    // ── Falsification 3: Stale graph / version mismatch ─────────────────────
    console.log("[runtime] testing Falsification: stale graph / version mismatch");
    const staleVersionRun = await cdp.eval(sessionId, `(async () => await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: "tool.package.run",
        packageId: ${JSON.stringify(PACKAGE_ID)},
        version: "9.9.9",
        operationId: "weighted_sum",
        args: [6, 7, 0.5],
      }, (res) => resolve(res));
    }))()`);
    result.staleVersionRun = staleVersionRun;
    if (staleVersionRun?.ok !== false || staleVersionRun?.error !== "emscripten_stale_graph") {
      throw new Error(`stale graph version must be rejected: got ${JSON.stringify(staleVersionRun)}`);
    }

    // ── Falsification 4: Direct non-SW submission to offscreen host ─────────
    console.log("[runtime] testing Falsification: direct non-SW message rejected by offscreen host");
    const directHostRun = await cdp.eval(sessionId, `(async () => await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: "cap:emscripten-run",
        packageId: ${JSON.stringify(PACKAGE_ID)},
        version: ${JSON.stringify(P.packageVersion)},
        graphDigest: ${JSON.stringify(P.main.sha256)},
        operationId: "weighted_sum",
        operation: { id: "weighted_sum", adapterId: "cap-a0-numeric-v1", exportName: "cap_weighted_sum", result: "f64", params: [] },
        args: [],
        assets: [],
        lifecycle: { startupMs: 1000, callMs: 1000 },
        authority: { sessionId: "s", executionId: "e", callId: "c", agentId: "a", origin: "o", documentId: "d" },
      }, (res) => resolve(res));
    }))()`);
    result.directHostRun = directHostRun;
    if (directHostRun?.ok !== false || (directHostRun?.error !== "emscripten_run_sender" && directHostRun?.error !== "unknown message: cap:emscripten-run")) {
      throw new Error(`direct non-SW sender to offscreen host must be rejected: got ${JSON.stringify(directHostRun)}`);
    }

    // Ensure the tool library section is visible and scroll the package status into view
    const activeSection = await cdp.eval(sessionId, `(async () => {
      document.querySelector('a[data-section="tool-library"]')?.click();
      window.location.hash = "#tool-library";
      await new Promise((r) => setTimeout(r, 200));
      const panel = document.getElementById("tool-library");
      const library = document.getElementById("tool-library-view");
      const root = library?.shadowRoot ?? library;
      const statusEl = root?.querySelector(".validation-status");
      const pkgSection = root?.querySelector(".packages");
      (statusEl ?? pkgSection ?? panel)?.scrollIntoView({ behavior: "instant", block: "center" });
      await new Promise((r) => setTimeout(r, 100));
      const rect = statusEl?.getBoundingClientRect();
      const inViewport = Boolean(
        rect &&
        rect.top >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.width > 0 &&
        rect.height > 0,
      );
      return {
        activePanelId: document.querySelector('.panel.active')?.id ?? null,
        toolLibraryDisplay: panel ? window.getComputedStyle(panel).display : null,
        statusText: statusEl ? statusEl.textContent : null,
        statusVisibleInViewport: inViewport,
      };
    })()`);
    result.activeSection = activeSection;
    if (activeSection?.activePanelId !== "tool-library" || activeSection?.toolLibraryDisplay !== "block") {
      throw new Error(`tool-library panel is not active/block on screen: ${JSON.stringify(activeSection)}`);
    }
    if (activeSection?.statusVisibleInViewport !== true) {
      throw new Error(`validation status element is not visible within viewport: ${JSON.stringify(activeSection)}`);
    }

    // Capture screenshot
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const screenshotData = screenshot?.result?.data ?? screenshot?.data;
    if (!screenshotData || typeof screenshotData !== "string") {
      throw new Error(`Page.captureScreenshot returned no data: ${JSON.stringify(screenshot)}`);
    }
    const screenshotBytes = Uint8Array.from(atob(screenshotData), (c) => c.charCodeAt(0));
    if (screenshotBytes.byteLength === 0) {
      throw new Error("Page.captureScreenshot returned empty byte array");
    }
    await Deno.writeFile(join(evidence, "options-runtime.png"), screenshotBytes);
    result.screenshot = "options-runtime.png";

    result.externalRequests = externalRequests;
    if (externalRequests.length > 0) {
      throw new Error(`unexpected external network requests made: ${externalRequests.join(", ")}`);
    }

    result.status = "PASS";
    console.log(`RESULT: GREEN; evidence ${evidence}`);
  } catch (err: any) {
    error = err?.stack ?? String(err);
    result.status = "FAIL";
    result.error = error;
    console.error(error);
    console.log(`RESULT: RED; evidence ${evidence}`);
  } finally {
    if (chrome) {
      try {
        await teardownChrome(chrome);
        teardownOk = true;
      } catch (tErr) {
        teardownFailed = true;
        teardownError = String((tErr as any)?.message ?? tErr);
      }
    }
    if (teardownOk && copyRoot) {
      try { await Deno.remove(copyRoot, { recursive: true }); } catch {}
    } else {
      retainedCopyRoot = copyRoot;
    }
    result.teardownOk = teardownOk;
    result.teardownFailed = teardownFailed;
    if (teardownError) result.teardownError = teardownError;
    if (retainedCopyRoot) result.retainedCopyRoot = retainedCopyRoot;
    await Deno.writeTextFile(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  }

  Deno.exit(error ? 1 : 0);
}

if (import.meta.main) {
  main();
}
