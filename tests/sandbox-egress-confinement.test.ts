// tests/sandbox-egress-confinement.test.ts
// Verification of chrome-agent-platform-4h2x:
// Script sandbox: ambient connection APIs and remote images are denied (connect-src 'none', img-src data: blob:).
//
// Verifies that:
// 1. The manifest sandbox CSP and store target policy declare connect-src 'none' and img-src data: blob:.
// 2. In a real loaded extension (headless Chrome):
//    - Ambient egress attempts (XMLHttpRequest, remote Image, navigator.sendBeacon) from inside the
//      sandboxed iframe are BLOCKED by CSP and never arrive at the test server.
//    - Local in-memory images (data: URLs) inside sandboxed frames and real rendered artifact cards SUCCEED.
//    - Legitimate sandboxed compute (ES module imports via blob URLs) SUCCEEDS.
//    - The host-bridged fetch channel dispatches real cap:script-call messages to the host and returns
//      the Service Worker's fetch-policy response (not a native CSP TypeError).
// @ts-nocheck

import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { launchChrome, openCdp, computeUnpackedExtensionId } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { resolveChromeForTesting } from "../scripts/lib/chrome-for-testing.ts";
import { STORE_SANDBOX_CSP } from "../scripts/store-target-policy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const EXT = `${ROOT}/extension`;
const CHROME_FOR_TESTING = resolveChromeForTesting();

Deno.test("4h2x source pin: sandbox CSP declares connect-src 'none' and img-src data: blob:", async () => {
  const manifestRaw = await Deno.readTextFile(new URL("../extension/manifest.json", import.meta.url));
  const manifest = JSON.parse(manifestRaw);
  const csp = manifest.content_security_policy?.sandbox ?? "";

  assert(csp.includes("connect-src 'none'"), "sandbox CSP must declare connect-src 'none'");
  assert(csp.includes("img-src data: blob:"), "sandbox CSP must declare img-src data: blob:");
  // chrome-agent-platform-206v: ambient media is the same egress class as
  // connect/img — generated-content playback (data:/blob:) stays permitted,
  // network media fetches are denied. Same rationale as img-src, one directive
  // down (media-src governs <audio>/<video>/<source>/<track>).
  assert(csp.includes("media-src data: blob:"), "sandbox CSP must declare media-src data: blob:");
  assertEquals(csp, STORE_SANDBOX_CSP, "manifest sandbox CSP must match STORE_SANDBOX_CSP exactly");
});

Deno.test({
  name: "4h2x: real-browser script sandbox denies ambient connections and remote images while preserving host bridge and local data images",
  ignore: CHROME_FOR_TESTING === null,
  fn: async () => {
    // 1. Start an owned HTTP endpoint on port 0 to detect any ambient network egress
    const seenPaths: string[] = [];
    const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
      const url = new URL(req.url);
      seenPaths.push(url.pathname);
      return new Response("server-ok", { headers: { "access-control-allow-origin": "*" } });
    });
    const port = server.addr.port;
    const base = `http://127.0.0.1:${port}`;

    const profile = chromeProfileDir("sandbox-egress-confinement");
    let chromeInstance: Awaited<ReturnType<typeof launchChrome>> | null = null;
    let cdp: Awaited<ReturnType<typeof openCdp>> | null = null;

    try {
      chromeInstance = await launchChrome({
        binary: CHROME_FOR_TESTING,
        args: [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--silent-debugger-extension-api",
          `--disable-extensions-except=${EXT}`,
          `--load-extension=${EXT}`,
          "--remote-allow-origins=*",
          `--user-data-dir=${profile}`,
          "about:blank",
        ],
      });

      cdp = await openCdp(chromeInstance.wsUrl, { timeoutMs: 30000 });
      const sw = await cdp.serviceWorker({
        timeoutMs: 10000,
        match: (t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"),
      });
      assert(sw, "Service worker must be running");
      const extId = await computeUnpackedExtensionId(EXT);

      // Open NTP page which has full component and script-host runtime
      const page = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html`);
      await new Promise((r) => setTimeout(r, 1500));

      // Execute a probe script inside the sandboxed iframe with host message observer
      const probeSource = `
        export default async () => {
          const results = {};
          const B = ${JSON.stringify(base)};

          // Test 1: Ambient XMLHttpRequest (should be blocked by connect-src 'none')
          results.xhr = await new Promise((res) => {
            try {
              const x = new XMLHttpRequest();
              x.open("GET", B + "/ambient-xhr");
              x.onload = () => res("arrived");
              x.onerror = () => res("blocked");
              x.send();
            } catch (e) {
              res("threw:" + e.message);
            }
          });

          // Test 2: Ambient remote Image (should be blocked by img-src data: blob:)
          results.remoteImage = await new Promise((res) => {
            try {
              const img = new Image();
              img.onload = () => res("arrived");
              img.onerror = () => res("blocked");
              img.src = B + "/ambient-img?t=" + Date.now();
              setTimeout(() => res("timeout"), 2000);
            } catch (e) {
              res("threw:" + e.message);
            }
          });

          // Test 3: Local data: Image (must SUCCEED under img-src data: blob:)
          results.dataImage = await new Promise((res) => {
            try {
              const img = new Image();
              img.onload = () => res("loaded:" + img.naturalWidth);
              img.onerror = () => res("blocked");
              img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Ccircle cx='10' cy='10' r='10' fill='green'/%3E%3C/svg%3E";
              setTimeout(() => res("timeout"), 2000);
            } catch (e) {
              res("threw:" + e.message);
            }
          });

          // Test 3b (chrome-agent-platform-206v): generated-content AUDIO must
          // SUCCEED under media-src data: blob: — a decoded local WAV proves
          // the directive permits in-memory media while denying network fetches.
          results.dataAudio = await new Promise((res) => {
            try {
              const a = new Audio();
              a.onloadedmetadata = () => res("loaded:" + (a.duration > 0));
              a.onerror = () => res("blocked");
              a.src = "data:audio/wav;base64," +
                "UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAOAP4R1YKAsuTC4TKf8eQRF4AYTxRuNt2EHSf9E81urfY+0P/RMNjRvEJmYtqi5pKiUh9RNpBFj0p+UU2v3SONH71NXdueoh+jkKHRkJJZQs2i6VKykjlRZVBzj3JOji2+bTINHm0+LbJOg491UHlRYpI5Ur2i6ULAklHRk5CiH6uerV3fvUONH90hTap+VY9GkE9RMlIWkqqi5mLcQmjRsTDQ/9Y+3q3zzWf9FB0m3YRuOE8XgBQRH/HhMpTC4LLlgo4R3gDwAAIPAf4qjX9dG00e3WAeG/7oj+fA66HJMnvy2BLsQpFiCdEvEC7fJz5DzZmtJW0ZfV294L7Jf7qAtZGuwlAy3ILgUrKyJHFd8Fx/Xj5vfabNMm0WvU19xr6av4yAjcFx4kGizgLhosHiTcF8gIq/hr6dfca9Qm0WzT99rj5sf13wVHFSsiBSvILgMt7CVZGqgLl/sL7Nvel9VW0ZrSPNlz5O3y8QKdEhYgxCmBLr8tkye6HHwOiP6/7gHh7da00fXRqNcf4iDwAADgD+EdWCgLLkwuEyn/HkEReAGE8UbjbdhB0n/RPNbq32PtD/0TDY0bxCZmLaouaSolIfUTaQRY9KflFNr90jjR+9TV3bnqIfo5Ch0ZCSWULNoulSspI5UWVQc49yTo4tvm0yDR5tPi2yToOPdVB5UWKSOVK9oulCwJJR0ZOQoh+rnq1d371DjR/dIU2qflWPRpBPUTJSFpKqouZi3EJo0bEw0P/WPt6t881n/RQdJt2EbjhPF4AUER/x4TKUwuCy5YKOEd4A8AACDwH+Ko1/XRtNHt1gHhv+6I/nwOuhyTJ78tgS7EKRYgnRLxAu3yc+Q82ZrSVtGX1dveC+yX+6gLWRrsJQMtyC4FKysiRxXfBcf14+b32mzTJtFr1Nfca+mr+MgI3BceJBos4C4aLB4k3BfICKv4a+nX3GvUJtFs0/fa4+bH9d8FRxUrIgUryC4DLewlWRqoC5f7C+zb3pfVVtGa0jzZc+Tt8vECnRIWIMQpgS6/LZMnuhx8Doj+v+4B4e3WtNH10ajXH+Ig8A==";
              setTimeout(() => res("timeout"), 2000);
            } catch (e) {
              res("threw:" + e.message);
            }
          });

          // Test 2b/2c (chrome-agent-platform-206v): ambient AUDIO and VIDEO
          // network sources — the media-src residual. Endpoint-side arrival is
          // the authority; the element event is secondary.
          const mediaDeny = (tag) => new Promise((res) => {
            try {
              const el = document.createElement(tag);
              el.onerror = () => res("blocked");
              el.onloadedmetadata = () => res("arrived");
              el.src = B + "/ambient-" + tag + "?t=" + Date.now();
              el.preload = "auto";
              setTimeout(() => res("timeout"), 2000);
            } catch (e) {
              res("threw:" + e.message);
            }
          });
          results.ambientAudio = await mediaDeny("audio");
          results.ambientVideo = await mediaDeny("video");

          // Test 4: Ambient sendBeacon (should be blocked by connect-src 'none')
          results.beacon = (() => {
            try {
              const queued = navigator.sendBeacon(B + "/ambient-beacon", "test");
              return queued ? "queued" : "rejected";
            } catch (e) {
              return "threw:" + e.message;
            }
          })();

          // Test 5: Host-bridged fetch (runs through window.parent postMessage, NOT sandbox network stack)
          try {
            const r = await fetch(B + "/bridge-check");
            results.bridgedFetch = "status:" + r.status;
          } catch (e) {
            results.bridgedFetch = String(e && e.message ? e.message : e);
          }

          return results;
        };
      `;

      const execution = await cdp.eval(page.sessionId, `(async () => {
        const calls = [];
        const observer = (event) => {
          if (event.data?.runId === "test-4h2x" && event.data?.type === "cap:script-call") {
            calls.push({ kind: event.data.kind, url: event.data.payload?.url });
          }
        };
        window.addEventListener("message", observer);
        try {
          const host = await import(chrome.runtime.getURL("lib/script-host.js"));
          const result = await host.runScriptInIframe(document, ${JSON.stringify(probeSource)}, "test-4h2x", { timeoutMs: 15000 });
          return { result, calls };
        } finally {
          window.removeEventListener("message", observer);
        }
      })()`);

      assertEquals(execution?.result?.ok, true, `Script execution must succeed: ${JSON.stringify(execution)}`);
      const probeResults = execution.result.result;
      const calls = execution.calls ?? [];

      // 1. Ambient XHR was blocked
      assertEquals(probeResults.xhr, "blocked", "Ambient XMLHttpRequest must be blocked by connect-src 'none'");

      // 2. Ambient remote Image was blocked
      assertEquals(probeResults.remoteImage, "blocked", "Ambient remote Image must be blocked by img-src data: blob:");

      // 3. Local data: image succeeded
      assertEquals(probeResults.dataImage, "loaded:20", "Local data: SVG image must be permitted by img-src data: blob:");

      // 3b. Generated-content audio succeeded (206v: media-src data: blob:)
      assertEquals(probeResults.dataAudio, "loaded:true", "Local data: WAV audio must be permitted by media-src data: blob:");

      // 2b/2c. Ambient AUDIO and VIDEO were blocked (206v: media-src data: blob:)
      assertEquals(probeResults.ambientAudio, "blocked", "Ambient audio must be blocked by media-src data: blob:");
      assertEquals(probeResults.ambientVideo, "blocked", "Ambient video must be blocked by media-src data: blob:");

      // 4. No ambient requests arrived at the HTTP server
      assertEquals(seenPaths.includes("/ambient-xhr"), false, "Ambient XHR must not reach the wire");
      assertEquals(seenPaths.includes("/ambient-img"), false, "Ambient remote Image must not reach the wire");
      assertEquals(seenPaths.includes("/ambient-beacon"), false, "Ambient sendBeacon must not reach the wire");
      assertEquals(seenPaths.includes("/ambient-audio"), false, "Ambient audio must not reach the wire (206v)");
      assertEquals(seenPaths.includes("/ambient-video"), false, "Ambient video must not reach the wire (206v)");

      // 5. Host-bridged fetch: verify real bridge dispatch and refusal
      // If window.fetch = call("fetch") is deleted, calls is [] and bridgedFetch is "Failed to fetch" (kills mutant).
      assertEquals(calls.length, 1, "Host-bridged fetch must emit a cap:script-call message to parent window");
      assertEquals(calls[0].kind, "fetch", "Bridged call must be kind: fetch");
      assertEquals(calls[0].url, base + "/bridge-check", "Bridged call must target the requested URL");
      assertEquals(
        probeResults.bridgedFetch,
        "fetch to 127.0.0.1 refused: private or loopback address",
        "Must receive the service worker fetch-policy refusal, proving execution reached the host bridge rather than native CSP failure",
      );

      // 6. Test artifact preview consumer: verify that artifact-preview.html mounts and renders data: SVG images
      const testSvg = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'><rect width='20' height='20' fill='blue'/></svg>");
      const previewHtml = '<!doctype html><html><head><title>Preview</title></head><body><img id="local-img" src="' + testSvg + '"><p id="img-res">pending</p><script>var i=document.getElementById("local-img"),o=document.getElementById("img-res");i.decode().then(function(){o.textContent="image-"+"loaded:"+i.naturalWidth}).catch(function(){o.textContent="image-"+"blocked:"+i.naturalWidth});<' + '/script></body></html>';

      await cdp.eval(page.sessionId, `(async () => {
        const created = await chrome.runtime.sendMessage({ type: "asset.create", origin: "master", assetType: "html", name: "4h2x preview test", content: ${JSON.stringify(previewHtml)} });
        if (!created?.ok) throw new Error("asset.create failed: " + JSON.stringify(created));
        const asset = created.asset ?? {};
        const id = asset.id ?? created.id;
        document.querySelector("main")?.remove();
        document.querySelectorAll("agent-conversation").forEach((n) => n.remove());
        const conv = document.createElement("agent-conversation");
        conv.style.cssText = "display:block;padding:24px;max-width:1000px";
        document.body.prepend(conv);
        conv.appendArtifact({ artifact: { ...asset, origin: asset.origin ?? "master", id } });
      })()`);

      let imageStatus = null;
      for (let attempt = 0; attempt < 24; attempt++) {
        const snapshot = await cdp.send("Page.captureSnapshot", { format: "mhtml" }, page.sessionId);
        const mhtml = String(snapshot.result?.data ?? "").replace(/=\r?\n/g, "");
        if (mhtml.includes("image-loaded:20")) { imageStatus = "loaded:20"; break; }
        if (mhtml.includes("image-blocked:0")) { imageStatus = "blocked:0"; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      assertEquals(imageStatus, "loaded:20", "Artifact preview must render local data: images without CSP blockage");
    } finally {
      cdp?.close();
      if (chromeInstance) {
        try { chromeInstance.proc.kill("SIGKILL"); } catch { /* gone */ }
        try { await chromeInstance.proc.status; } catch { /* reaped */ }
      }
      await server.shutdown();
    }
  },
});
