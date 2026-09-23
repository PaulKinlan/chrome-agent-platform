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

      // 4. No ambient requests arrived at the HTTP server
      assertEquals(seenPaths.includes("/ambient-xhr"), false, "Ambient XHR must not reach the wire");
      assertEquals(seenPaths.includes("/ambient-img"), false, "Ambient remote Image must not reach the wire");
      assertEquals(seenPaths.includes("/ambient-beacon"), false, "Ambient sendBeacon must not reach the wire");

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
