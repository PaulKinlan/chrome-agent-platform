// cap-evidence/2y7qe-browser-smoke.ts — Comprehensive real-browser smoke for chrome-agent-platform-2y7qe
// Verifies in real Chrome with the built extension that ALL surfaces:
//   - ntp/ntp.html
//   - sidepanel/sidepanel.html
//   - options/options.html
//   - artifacts/index.html
//   - artifact/artifact.html
//   - directory/directory.html
//   - privacy/privacy.html
//   - about/about.html
// load cleanly with ZERO ReferenceErrors and ZERO exceptionThrown events, and that custom components
// (including agent-conversation, webmcp-consent-manager, artifact-card, etc.)
// connectedCallback and render cycles execute without throwing.

import { fileURLToPath } from "node:url";
import { launchChrome, openCdp, SW_MATCH, teardownChrome } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const EXT = `${ROOT}/extension`;

async function main() {
  const profile = chromeProfileDir("2y7qe-browser-smoke");
  const evidenceDir = durableDir("2y7qe-browser-smoke", `${Date.now()}-${Deno.pid}`);
  await Deno.mkdir(evidenceDir, { recursive: true });

  const logLines: string[] = [];
  function log(msg: string) {
    console.log(msg);
    logLines.push(msg);
  }

  log(`[2y7qe-smoke] Starting comprehensive real-Chrome verification for 2y7qe regression fix`);
  log(`[2y7qe-smoke] Profile: ${profile}`);
  log(`[2y7qe-smoke] Evidence dir: ${evidenceDir}`);

  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let cdp: Awaited<ReturnType<typeof openCdp>> | undefined;

  let passCount = 0;
  let failCount = 0;

  function recordCheck(name: string, ok: boolean, detail = "") {
    if (ok) {
      passCount++;
      log(`  PASS: ${name}${detail ? ` (${detail})` : ""}`);
    } else {
      failCount++;
      log(`  FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    }
  }

  try {
    chrome = await launchChrome({
      extension: EXT,
      profile,
      windowSize: "1400,900",
      clearEnv: true,
    });
    log(`[2y7qe-smoke] Chrome launched at ${chrome.wsUrl}`);

    cdp = await openCdp(chrome.wsUrl, { timeoutMs: 30000 });
    log(`[2y7qe-smoke] Connected to browser CDP`);

    const sw = await cdp.serviceWorker({ match: SW_MATCH, timeoutMs: 30000 });
    if (!sw) throw new Error("Service worker did not register within 30s");
    const extId = new URL(sw.url).host;
    log(`[2y7qe-smoke] Extension loaded with ID: ${extId}`);

    // Helper to monitor console and page errors
    async function testPage(pagePath: string, testFn?: (sid: string) => Promise<void>) {
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];

      const url = `chrome-extension://${extId}/${pagePath}`;
      log(`\n[2y7qe-smoke] Testing ${url}...`);

      const page = await cdp!.open("about:blank");
      const sid = page.sessionId;

      await cdp!.send("Runtime.enable", {}, sid);
      await cdp!.send("Page.enable", {}, sid);

      const offConsole = cdp!.on("Runtime.consoleAPICalled", (params, msgSid) => {
        if (msgSid !== sid) return;
        if (params.type === "error") {
          const text = params.args?.map((a: any) => a.value ?? a.description ?? JSON.stringify(a)).join(" ") ?? "";
          consoleErrors.push(text);
        }
      });

      const offException = cdp!.on("Runtime.exceptionThrown", (params, msgSid) => {
        if (msgSid !== sid) return;
        const text = params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "unknown exception";
        pageErrors.push(text);
      });

      try {
        await cdp!.send("Page.navigate", { url }, sid);
        // Wait for page load and hydration
        await new Promise((r) => setTimeout(r, 1500));

        if (testFn) {
          await testFn(sid);
        }

        const allErrors = [...pageErrors, ...consoleErrors];
        const ensureStyleErrors = allErrors.filter((e) => e.includes("ensureStyle"));
        const normalizeErrors = allErrors.filter((e) => e.includes("normalizeSiteActivity"));
        const fmtTimeErrors = allErrors.filter((e) => e.includes("fmtTime"));
        const backendErrors = allErrors.filter((e) => e.includes("backend is not defined"));
        const parseJsonErrors = allErrors.filter((e) => e.includes("parseJSONAttr"));
        const wireHtmlErrors = allErrors.filter((e) => e.includes("wireHtmlFrame"));
        const refErrors = allErrors.filter((e) => e.includes("ReferenceError"));

        recordCheck(`${pagePath}: No ReferenceError: ensureStyle`, ensureStyleErrors.length === 0,
          ensureStyleErrors.length ? ensureStyleErrors.join("; ") : "clean");
        recordCheck(`${pagePath}: No ReferenceError: normalizeSiteActivity`, normalizeErrors.length === 0,
          normalizeErrors.length ? normalizeErrors.join("; ") : "clean");
        recordCheck(`${pagePath}: No ReferenceError: fmtTime`, fmtTimeErrors.length === 0,
          fmtTimeErrors.length ? fmtTimeErrors.join("; ") : "clean");
        recordCheck(`${pagePath}: No ReferenceError: backend`, backendErrors.length === 0,
          backendErrors.length ? backendErrors.join("; ") : "clean");
        recordCheck(`${pagePath}: No ReferenceError: parseJSONAttr`, parseJsonErrors.length === 0,
          parseJsonErrors.length ? parseJsonErrors.join("; ") : "clean");
        recordCheck(`${pagePath}: No ReferenceError: wireHtmlFrame*`, wireHtmlErrors.length === 0,
          wireHtmlErrors.length ? wireHtmlErrors.join("; ") : "clean");
        recordCheck(`${pagePath}: Zero ReferenceErrors of any kind`, refErrors.length === 0,
          refErrors.length ? refErrors.join("; ") : "clean");
        recordCheck(`${pagePath}: Zero exceptionThrown events`, pageErrors.length === 0,
          pageErrors.length ? pageErrors.join("; ") : "clean");
      } finally {
        offConsole();
        offException();
        await cdp!.send("Target.closeTarget", { targetId: page.targetId });
      }
    }

    // ── 1. NTP Page ──
    await testPage("ntp/ntp.html", async (sid) => {
      // NTP defers non-hub components (including agent-conversation) via requestIdleCallback/load
      // Wait for agent-conversation to be defined
      const hasAgentConv = await cdp!.eval(sid, `(async () => {
        if (customElements.get("agent-conversation")) return true;
        try {
          await Promise.race([
            customElements.whenDefined("agent-conversation"),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 6000)),
          ]);
          return true;
        } catch {
          return !!customElements.get("agent-conversation");
        }
      })()`);
      recordCheck("ntp: customElements.get('agent-conversation') registered", hasAgentConv === true);

      const mountResult = await cdp!.eval(sid, `(() => {
        try {
          const el = document.createElement("agent-conversation");
          document.body.appendChild(el);
          const style = document.getElementById("sc-agent-conversation-style");
          const injected = !!style && style.textContent.includes("agent-conversation");
          el.remove();
          return { ok: true, injected };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      })()`);

      recordCheck("ntp: agent-conversation connectedCallback succeeds without throwing",
        mountResult?.ok === true, mountResult?.error ?? "");
      recordCheck("ntp: ensureStyle injected sc-agent-conversation-style into head",
        mountResult?.injected === true);
    });

    // ── 2. Sidepanel Page ──
    await testPage("sidepanel/sidepanel.html", async (sid) => {
      const sidepanelCheck = await cdp!.eval(sid, `(() => {
        const conv = document.querySelector("agent-conversation");
        const style = document.getElementById("sc-agent-conversation-style");
        return {
          hasConv: !!conv,
          injected: !!style && style.textContent.includes("agent-conversation"),
        };
      })()`);

      recordCheck("sidepanel: agent-conversation element upgraded in DOM", sidepanelCheck?.hasConv === true);
      recordCheck("sidepanel: sc-agent-conversation-style injected into head via ensureStyle", sidepanelCheck?.injected === true);
    });

    // ── 3. Options Page ──
    await testPage("options/options.html", async (sid) => {
      const optionsCheck = await cdp!.eval(sid, `(() => {
        try {
          const Klass = customElements.get("webmcp-consent-manager");
          if (!Klass) return { ok: false, error: "webmcp-consent-manager not registered" };
          const el = document.createElement("webmcp-consent-manager");
          document.body.appendChild(el);
          const focusResult = el.focusSiteActivity({ origin: "https://example.com", tool: "demo" });
          el.remove();
          return { ok: true, focusResult };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      })()`);

      recordCheck("options: webmcp-consent-manager and normalizeSiteActivity execute cleanly",
        optionsCheck?.ok === true, optionsCheck?.error ?? "");
    });

    // ── 4. Artifacts Index Page ──
    await testPage("artifacts/index.html", async (sid) => {
      const artifactsCheck = await cdp!.eval(sid, `(() => {
        try {
          const drawerKlass = customElements.get("artifact-quick-drawer");
          const cardKlass = customElements.get("artifact-card");
          return { ok: true, hasDrawer: !!drawerKlass, hasCard: !!cardKlass };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      })()`);

      recordCheck("artifacts/index.html: artifact components registered and clean",
        artifactsCheck?.ok === true && artifactsCheck?.hasCard === true, artifactsCheck?.error ?? "");
    });

    // ── 5. Single Artifact Viewer Page ──
    await testPage("artifact/artifact.html", async (sid) => {
      const artifactCheck = await cdp!.eval(sid, `(() => {
        try {
          return { ok: true, title: document.title };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      })()`);

      recordCheck("artifact/artifact.html: loaded cleanly", artifactCheck?.ok === true);
    });

    // ── 6. Directory Page ──
    await testPage("directory/directory.html", async (sid) => {
      const dirCheck = await cdp!.eval(sid, `(() => {
        try {
          const cardKlass = customElements.get("tool-directory-card");
          return { ok: true, hasCard: !!cardKlass };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      })()`);

      recordCheck("directory/directory.html: tool-directory-card registered and clean",
        dirCheck?.ok === true && dirCheck?.hasCard === true, dirCheck?.error ?? "");
    });

    // ── 7. Privacy Page ──
    await testPage("privacy/privacy.html", async (sid) => {
      const privacyCheck = await cdp!.eval(sid, `(() => {
        try {
          const stmtKlass = customElements.get("privacy-statement");
          return { ok: true, hasStmt: !!stmtKlass };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      })()`);

      recordCheck("privacy/privacy.html: privacy-statement registered and clean",
        privacyCheck?.ok === true && privacyCheck?.hasStmt === true, privacyCheck?.error ?? "");
    });

    // ── 8. About Page ──
    await testPage("about/about.html", async (sid) => {
      const aboutCheck = await cdp!.eval(sid, `(() => {
        try {
          return { ok: true, title: document.title };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      })()`);

      recordCheck("about/about.html: loaded cleanly", aboutCheck?.ok === true);
    });

  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      log(`[2y7qe-smoke] Tearing down Chrome...`);
      await teardownChrome(chrome);
    }
  }

  log(`\n[2y7qe-smoke] COMPREHENSIVE SUMMARY: ${passCount} passed, ${failCount} failed`);

  const evidenceFilePath = `${evidenceDir}/report.txt`;
  await Deno.writeTextFile(evidenceFilePath, logLines.join("\n"));
  // Also copy to canonical cap-evidence path
  await Deno.writeTextFile(`${ROOT}/cap-evidence/2y7qe-browser-smoke.txt`, logLines.join("\n"));
  log(`[2y7qe-smoke] Evidence written to ${evidenceFilePath} and cap-evidence/2y7qe-browser-smoke.txt`);

  if (failCount > 0) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
