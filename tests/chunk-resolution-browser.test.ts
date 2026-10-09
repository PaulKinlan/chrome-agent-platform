// tests/chunk-resolution-browser.test.ts — chrome-agent-platform-20e2u
// Proves condition (e): load ntp/sidepanel/options in real Chrome and prove each dynamic chunk
// resolves cleanly with 0 404s, 0 CSP violations, and 0 runtime exceptions.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { launchChrome, openCdp, waitForServiceWorker, teardownChrome, resolveChromiumBinaryReport } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT_DIR = `${ROOT}/extension`;
const { binary: RESOLVED_BIN, tried: TRIED_BINS } = resolveChromiumBinaryReport();

async function computeExpectedChunkGraph(bundlePath: string): Promise<Set<string>> {
  const chunksDir = `${ROOT}/extension/dist/chunks`;
  const visited = new Set<string>();
  const queue: string[] = [];

  const bundleCode = await Deno.readTextFile(bundlePath);
  for (const m of bundleCode.matchAll(/\.\/chunks\/([a-zA-Z0-9._-]+\.js)/g)) {
    if (!visited.has(m[1])) {
      visited.add(m[1]);
      queue.push(m[1]);
    }
  }

  while (queue.length > 0) {
    const chunkName = queue.shift()!;
    const chunkFile = `${chunksDir}/${chunkName}`;
    const chunkCode = await Deno.readTextFile(chunkFile).catch(() => "");
    for (const m of chunkCode.matchAll(/\.\/([a-zA-Z0-9._-]+\.js)/g)) {
      if (!visited.has(m[1])) {
        visited.add(m[1]);
        queue.push(m[1]);
      }
    }
  }

  return visited;
}

Deno.test("20e2u condition (e): load ntp, sidepanel, options in real Chrome; all dynamic chunks resolve with 0 404s and 0 CSP errors", async () => {
  assert(
    RESOLVED_BIN !== null,
    `20e2u browser verification requires a resolved Chrome binary (tried: ${TRIED_BINS.join("; ")})`,
  );
  const CHROME_BIN = RESOLVED_BIN;
  const tmp = durableDir(`cap-chunk-browser-${Date.now()}`);

  let chrome = null;
  let client = null;
  try {
    chrome = await launchChrome({
      binary: CHROME_BIN,
      extension: EXT_DIR,
      profile: tmp,
      timeoutMs: 30000,
    });
    client = await openCdp(chrome.wsUrl);

    const sw = await waitForServiceWorker(client.send, {
      timeoutMs: 15000,
      match: (t: any) => typeof t.url === "string" && t.url.includes("dist/background/service-worker.js"),
    });
    assert(sw, "Service worker must start");
    const extId = sw.url.split("/")[2];

    const surfaces = [
      { path: "ntp/ntp.html", bundle: "ntp.bundle.js", minChunks: 4 },
      { path: "sidepanel/sidepanel.html", bundle: "sidepanel.bundle.js", minChunks: 3 },
      { path: "options/options.html", bundle: "options.bundle.js", minChunks: 4 },
    ];
    for (const surface of surfaces) {
      const openTarget = await client.open("about:blank");
      const { targetId, sessionId } = openTarget;

      const networkFailed: string[] = [];
      const distinctChunkUrls = new Set<string>();
      const inFlightRequests = new Map<string, string>();
      const cspViolations: string[] = [];
      const runtimeErrors: string[] = [];
      let lastActivityTime = Date.now();

      await client.send("Network.enable", {}, sessionId);
      await client.send("Runtime.enable", {}, sessionId);
      await client.send("Page.enable", {}, sessionId);

      client.on("Network.requestWillBeSent", (params: any, sid?: string) => {
        if (sid && sid !== sessionId) return;
        lastActivityTime = Date.now();
        const url = params.request?.url || "";
        // Persistent Web Worker scripts remain active while the thread runs
        if (params.type !== "Worker" && !url.includes("worker.js") && params.requestId) {
          inFlightRequests.set(params.requestId, url);
        }
      });

      client.on("Network.responseReceived", (params: any, sid?: string) => {
        if (sid && sid !== sessionId) return;
        lastActivityTime = Date.now();
        const url = params.response?.url || "";
        const status = params.response?.status;
        if (url.startsWith(`chrome-extension://${extId}/`)) {
          if (status !== 200 && status !== 304) {
            networkFailed.push(`${url} returned status ${status}`);
          }
          if (url.includes("/dist/chunks/")) {
            distinctChunkUrls.add(url);
          }
        }
      });

      client.on("Network.loadingFinished", (params: any, sid?: string) => {
        if (sid && sid !== sessionId) return;
        lastActivityTime = Date.now();
        if (params.requestId) {
          inFlightRequests.delete(params.requestId);
        }
      });

      client.on("Network.loadingFailed", (params: any, sid?: string) => {
        if (sid && sid !== sessionId) return;
        lastActivityTime = Date.now();
        if (params.requestId) {
          inFlightRequests.delete(params.requestId);
        }
        networkFailed.push(`Network failed: ${JSON.stringify(params)}`);
      });

      client.on("Runtime.consoleAPICalled", (params: any, sid?: string) => {
        if (sid && sid !== sessionId) return;
        const text = params.args?.map((a: any) => a.value || "").join(" ") || "";
        if (text.includes("Content Security Policy") || text.includes("CSP")) {
          cspViolations.push(text);
        }
      });

      client.on("Runtime.exceptionThrown", (params: any, sid?: string) => {
        if (sid && sid !== sessionId) return;
        const msg = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || JSON.stringify(params.exceptionDetails);
        runtimeErrors.push(msg);
      });

      await client.send("Page.navigate", { url: `chrome-extension://${extId}/${surface.path}` }, sessionId);

      // 1. Wait for document.readyState === "complete" (fail if wait times out)
      let readyStateComplete = false;
      const readyDeadline = Date.now() + 8000;
      while (Date.now() < readyDeadline) {
        const state = await client.eval(sessionId, "document.readyState").catch(() => null);
        if (state === "complete") {
          readyStateComplete = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(
        readyStateComplete,
        `${surface.path} document.readyState failed to reach 'complete' within 8s`,
      );

      // 2. Wait until all expected dynamic chunks resolve, in-flight requests drain, and 300ms quiet window elapses
      let settled = false;
      const settleDeadline = Date.now() + 8000;
      while (Date.now() < settleDeadline) {
        const quietMs = Date.now() - lastActivityTime;
        if (
          distinctChunkUrls.size >= surface.minChunks &&
          inFlightRequests.size === 0 &&
          quietMs >= 300
        ) {
          settled = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(
        settled,
        `${surface.path} failed to settle within 8s: distinctChunks=${distinctChunkUrls.size}/${surface.minChunks}, inFlight=[${[...inFlightRequests.values()].join(", ")}], quietMs=${Date.now() - lastActivityTime} (need >=300ms)`,
      );

      // 1. Assert the page URL reached the expected extension target
      const pageUrl = await client.eval(sessionId, "window.location.href");
      assertEquals(
        pageUrl,
        `chrome-extension://${extId}/${surface.path}`,
        `Page URL must match expected target for ${surface.path}`,
      );

      // 2. Compute the exact static chunk import graph for this surface bundle
      const expectedGraph = await computeExpectedChunkGraph(`${ROOT}/extension/dist/${surface.bundle}`);

      // 3. Assert zero network failures, zero CSP violations, and zero runtime exceptions
      assertEquals(networkFailed, [], `No network failures loading ${surface.path}`);
      assertEquals(cspViolations, [], `No CSP violations loading ${surface.path}`);
      assertEquals(runtimeErrors, [], `No runtime exceptions loading ${surface.path}`);

      // 4. Compare loaded dynamic chunk URLs against the expected per-surface import graph
      const loadedChunkNames = new Set(
        [...distinctChunkUrls].map((u) => {
          const m = u.match(/\/dist\/chunks\/([a-zA-Z0-9._-]+\.js)/);
          return m ? m[1] : u;
        }),
      );
      assertEquals(
        [...loadedChunkNames].sort(),
        [...expectedGraph].sort(),
        `Loaded chunks for ${surface.path} must match the expected per-surface import graph exactly`,
      );

      console.log(`Loaded ${surface.path} successfully. Chunks verified against import graph: ${[...loadedChunkNames].join(", ")}`);

      // 5. Exercise lazy dynamic imports separately in the surface context
      if (surface.bundle === "options.bundle.js") {
        const lazyStoreResult = await client.eval(
          sessionId,
          `import(chrome.runtime.getURL("dist/user-wasm-store-client.bundle.js")).then(m => typeof m.runOwnerBlobStore === "function")`,
        );
        assertEquals(lazyStoreResult, true, "Lazy dynamic import of dist/user-wasm-store-client.bundle.js must resolve and export runOwnerBlobStore");
      }

      const sampleChunk = [...expectedGraph][0];
      const lazyChunkResult = await client.eval(
        sessionId,
        `import(chrome.runtime.getURL("dist/chunks/${sampleChunk}")).then(m => typeof m === "object" && m !== null)`,
      );
      assertEquals(lazyChunkResult, true, `Lazy dynamic import of dist/chunks/${sampleChunk} must resolve cleanly via chrome.runtime.getURL`);

      await client.send("Target.closeTarget", { targetId });
    }
  } finally {
    if (client) {
      try { client.close(); } catch {}
    }
    if (chrome) {
      await teardownChrome(chrome);
    }
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});
