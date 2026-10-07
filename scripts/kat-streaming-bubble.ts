// scripts/kat-streaming-bubble.ts — standalone bounded real Chrome acceptance
// harness for chrome-agent-platform-b7ny0.18 and chrome-agent-platform-b7ny0.19.
//
// Verifies:
// 1. "Streaming: the assistant bubble grows across at least 5 distinct lengths"
// 2. "Streaming: the final bubble equals the non-streamed render"
//
// In headless Chrome with real extension and demo model.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, openCdp, waitForServiceWorker, teardownChrome } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";
import { composerInput, composerSend } from "./lib/composer-target.ts";
import { DEMO_STREAM_ANSWER } from "../extension/lib/models/demo-model.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT_DIR = join(ROOT, "extension");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const evidenceDir = await Deno.makeTempDir({ dir: durableDir("astra", "b7ny0-18"), prefix: "streaming-" });
  const profileDir = chromeProfileDir("cap-kat-streaming-profile");

  let chrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let teardownOk = false;

  const result: Record<string, unknown> = {
    evidenceDir,
    checks: {},
    status: "FAIL",
  };

  try {
    console.log(`[streaming-kat] launching real Chrome with profile at ${profileDir}`);
    chrome = await launchChrome({
      extension: EXT_DIR,
      profile: profileDir,
      args: ["--disable-crash-reporter"],
      windowSize: "1440,900",
    });

    const cdp = await openCdp(chrome.wsUrl, { timeoutMs: 30_000 });
    const serviceWorker = await waitForServiceWorker(cdp.send, { timeoutMs: 20_000 });
    if (!serviceWorker) throw new Error("extension service worker not registered");

    const extensionId = new URL(serviceWorker.url).host;
    result.extensionId = extensionId;

    // Open Options page to configure demo provider (provider.set is Settings-sender restricted)
    console.log("[streaming-kat] configuring demo provider via options page");
    const optsPage = await cdp.open(`chrome-extension://${extensionId}/options/options.html`);
    const optsSession = optsPage.sessionId;
    await cdp.send("Page.enable", {}, optsSession);
    await cdp.send("Runtime.enable", {}, optsSession);
    await sleep(500);

    const setRes = await cdp.eval(
      optsSession,
      `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "demo", apiKey: "", baseURL: "", model: "" } })`,
    );
    console.log(`[streaming-kat] provider.set result:`, setRes);

    const devFlagRes = await cdp.eval(
      optsSession,
      `chrome.runtime.sendMessage({ type: "kv.set", values: { "cap:developerFeatures": true } })`,
    );
    console.log(`[streaming-kat] developer flag result:`, devFlagRes);

    // Open NTP page
    const ntpPage = await cdp.open(`chrome-extension://${extensionId}/ntp/ntp.html`);
    const ntpSession = ntpPage.sessionId;

    await cdp.send("Page.enable", {}, ntpSession);
    await cdp.send("Runtime.enable", {}, ntpSession);
    await cdp.send("Target.activateTarget", { targetId: ntpPage.id }).catch(() => {});
    await cdp.send("Page.bringToFront", {}, ntpSession).catch(() => {});
    await sleep(600);

    // Helper methods for genuine CDP input
    const boxOf = async (selector: string) => {
      const v = await cdp.eval(
        ntpSession,
        `(() => {
          let el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          el.scrollIntoView({ block: "center", inline: "center" });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        })()`,
      );
      return v && typeof v === "object" && typeof v.x === "number" ? v : null;
    };

    const clickSel = async (selector: string) => {
      const b = await boxOf(selector);
      if (!b) return false;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1,
      }, ntpSession);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1,
      }, ntpSession);
      return true;
    };

    const typeText = async (text: string) => {
      for (const ch of text) {
        await cdp.send("Input.dispatchKeyEvent", {
          type: "char", text: ch, unmodifiedText: ch,
        }, ntpSession);
      }
    };

    const typeInto = async (selector: string, text: string) => {
      const clicked = await clickSel(selector);
      if (!clicked) return false;
      await typeText(text);
      return true;
    };

    // Wait for the composer input to be ready
    const inputSelector = composerInput("hub");
    const sendSelector = composerSend("hub");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const ready = await cdp.eval(ntpSession, `Boolean(document.querySelector(${JSON.stringify(inputSelector)}))`).catch(() => false);
      if (ready) break;
      await sleep(200);
    }

    const STREAM_ARM = `(() => {
      window.__capLongTasks = [];
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__capLongTasks.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false }); } catch {}
      return true;
    })()`;

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

    await cdp.eval(ntpSession, STREAM_ARM).catch(() => null);

    // Type and send task through real CDP user input
    console.log("[streaming-kat] typing and sending @demo-stream task to composer");
    const typed = await typeInto(inputSelector, "@demo-stream tell me about the platform");
    if (!typed) throw new Error(`failed to type into ${inputSelector}`);
    await sleep(300);
    const sent = await clickSel(sendSelector);
    if (!sent) throw new Error(`failed to click ${sendSelector}`);

    const streamSamples: any[] = [];
    let midStreamShot: any = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
      let st: any = null;
      try {
        const raw = await cdp.eval(ntpSession, STREAM_STATE);
        st = raw ? JSON.parse(raw) : null;
      } catch {
        st = null;
      }

      if (st) {
        streamSamples.push({ t: Date.now() - t0, ...st });
        if (!midStreamShot && st.streaming && st.len > 0 && st.len < DEMO_STREAM_ANSWER.length) {
          try {
            const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, ntpSession);
            if (shot?.result?.data) midStreamShot = shot.result.data;
          } catch {
            midStreamShot = null;
          }
        }
        const settled = !st.streaming && st.len >= DEMO_STREAM_ANSWER.length &&
          !(st.status ?? []).some((r: any) => r.state === "running" || r.state === "queued" || r.state === "retrying");
        if (settled || (st.status ?? []).some((r: any) => r.state === "failed" || r.state === "cancelled")) {
          console.log(`[streaming-kat] streaming settled after ${Date.now() - t0}ms`);
          break;
        }
      }
      await sleep(200);
    }

    if (midStreamShot) {
      await Deno.writeFile(join(evidenceDir, "streaming-mid.png"), Uint8Array.from(atob(midStreamShot), (c) => c.charCodeAt(0)));
    }

    const finalShot = await cdp.send("Page.captureScreenshot", { format: "png" }, ntpSession);
    const finalShotData = finalShot?.result?.data ?? finalShot?.data;
    if (finalShotData) {
      await Deno.writeFile(join(evidenceDir, "streaming-final.png"), Uint8Array.from(atob(finalShotData), (c) => c.charCodeAt(0)));
      result.screenshot = "streaming-final.png";
    }

    const distinctLens = new Set(streamSamples.map((s) => s.len).filter((n) => n > 0));
    const sawStreamingAttr = streamSamples.some((s) => s.streaming && s.len > 0);
    const textNodesOnly = streamSamples.filter((s) => s.streaming && s.textNodesOnly != null).every((s) => s.textNodesOnly === true);
    const lastSample = streamSamples.at(-1) ?? {};
    const worstLongTask = Math.max(0, ...(lastSample.longTasks ?? []));
    const firstVisibleMs = streamSamples.find((s) => s.len > 0)?.t ?? null;

    console.log(`[streaming-kat] samples=${streamSamples.length} firstVisibleMs=${firstVisibleMs} distinctLens=${[...distinctLens].join(",")} streamingAttrSeen=${sawStreamingAttr} textNodesOnly=${textNodesOnly} longTasksMs=${JSON.stringify(lastSample.longTasks ?? [])} final=${JSON.stringify({ bubbles: lastSample.bubbles, len: lastSample.len, streaming: lastSample.streaming, status: lastSample.status })}`);

    const check1Pass = distinctLens.size >= 5 && sawStreamingAttr && textNodesOnly &&
      lastSample.bubbles === 1 && lastSample.streaming === false &&
      lastSample.len === DEMO_STREAM_ANSWER.length &&
      !(lastSample.status ?? []).some((r: any) => r.state !== "completed") &&
      worstLongTask <= 50;

    result.checks = {
      "Streaming: the assistant bubble grows across at least 5 distinct lengths": check1Pass,
      distinctLensCount: distinctLens.size,
      sawStreamingAttr,
      textNodesOnly,
      lastSampleStreaming: lastSample.streaming,
      lastSampleLen: lastSample.len,
      expectedLen: DEMO_STREAM_ANSWER.length,
    };

    if (!check1Pass) {
      throw new Error(`Check 1 failed: distinctLens=${distinctLens.size} (>=5), sawStreamingAttr=${sawStreamingAttr}, textNodesOnly=${textNodesOnly}, streaming=${lastSample.streaming} (expected false), len=${lastSample.len} (expected ${DEMO_STREAM_ANSWER.length})`);
    }

    const STREAM_FINAL_COMPARE = `(() => {
      const conv = document.getElementById('thread-conversation');
      const last = [...conv.querySelectorAll('message-bubble[role="agent"]')].at(-1);
      if (!last) return JSON.stringify({ error: "no agent bubble found" });
      const streamedHtml = last.shadowRoot.innerHTML;
      const streamedText = last.shadowRoot.querySelector('.body')?.textContent ?? '';
      const fresh = document.createElement('message-bubble');
      fresh.setAttribute('role', 'agent');
      fresh.setAttribute('content', last.getAttribute('content') ?? '');
      for (const a of ['author', 'author-avatar', 'ts']) {
        const v = last.getAttribute(a);
        if (v != null) fresh.setAttribute(a, v);
      }
      fresh.hidden = true;
      document.body.appendChild(fresh);
      const freshHtml = fresh.shadowRoot.innerHTML;
      fresh.remove();
      return JSON.stringify({ equal: streamedHtml === freshHtml, streamedText, contentAttr: last.getAttribute('content') });
    })()`;

    let streamCompare: any = null;
    try {
      const raw = await cdp.eval(ntpSession, STREAM_FINAL_COMPARE);
      streamCompare = raw ? JSON.parse(raw) : null;
    } catch {
      streamCompare = null;
    }

    const check2Pass = streamCompare?.equal === true &&
      streamCompare?.contentAttr === DEMO_STREAM_ANSWER &&
      streamCompare?.streamedText === DEMO_STREAM_ANSWER;

    (result.checks as Record<string, unknown>)["Streaming: the final bubble equals the non-streamed render"] = check2Pass;
    (result.checks as Record<string, unknown>)["streamCompare"] = streamCompare;

    if (!check2Pass) {
      throw new Error(`Check 2 failed: equal=${streamCompare?.equal}, contentAttrMatches=${streamCompare?.contentAttr === DEMO_STREAM_ANSWER}, streamedTextMatches=${streamCompare?.streamedText === DEMO_STREAM_ANSWER}`);
    }

    result.status = "PASS";
    console.log(`[streaming-kat] ALL CHECKS PASS! Evidence saved at ${evidenceDir}`);
  } catch (err: any) {
    console.error("[streaming-kat] FAILED:", err?.message ?? err);
    result.error = err?.message ?? String(err);
  } finally {
    if (chrome) {
      try {
        await teardownChrome(chrome);
        teardownOk = true;
      } catch (e: any) {
        console.error("teardown error:", e);
      }
    }
    result.teardownOk = teardownOk;
    await Deno.writeTextFile(join(evidenceDir, "result.json"), JSON.stringify(result, null, 2));
    if (teardownOk) {
      try {
        await Deno.remove(profileDir, { recursive: true });
      } catch {
        // ignore
      }
    }
  }

  if (result.status !== "PASS") {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
