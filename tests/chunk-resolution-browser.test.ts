// tests/chunk-resolution-browser.test.ts — chrome-agent-platform-20e2u
// Proves condition (e): load ntp/sidepanel/options in real Chrome and prove each dynamic chunk
// resolves cleanly with 0 404s, 0 CSP violations, and 0 runtime exceptions.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { launchChrome, openCdp, waitForServiceWorker, teardownChrome, resolveChromiumBinaryReport } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { ENVIRONMENTAL_REFUSAL_MARKER } from "../scripts/lib/environmental-verdict.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT_DIR = `${ROOT}/extension`;
const DIST = `${EXT_DIR}/dist`;
const { binary: RESOLVED_BIN, tried: TRIED_BINS } = resolveChromiumBinaryReport();

const SURFACES = [
  { path: "ntp/ntp.html", bundle: "ntp.bundle.js", minChunks: 4 },
  { path: "sidepanel/sidepanel.html", bundle: "sidepanel.bundle.js", minChunks: 3 },
  { path: "options/options.html", bundle: "options.bundle.js", minChunks: 4 },
];

type MarkerIndex = {
  /** A fingerprint of the build that wrote dist: commit + every indexed output byte. */
  fingerprint: string;
  /** dist-relative path -> the sha256 and size dist.complete records for it. */
  outputs: Map<string, { sha256: string; size: number }>;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** dist.complete is the build's own record of the byte it wrote for every output. */
async function readMarkerIndex(): Promise<MarkerIndex> {
  let marker: { commit?: string; outputs?: Array<{ path: string; sha256: string; size: number }> };
  try {
    marker = JSON.parse(await Deno.readTextFile(`${DIST}/dist.complete`));
  } catch (e) {
    throw new Error(
      `extension/dist/dist.complete is not a readable built marker (${String((e as Error)?.message ?? e)}). ` +
        `This test derives its expected chunk graph from the build's own record, so the extension must be built: npm run build:production`,
    );
  }
  const outputs = new Map((marker.outputs ?? []).map((o) => [o.path, { sha256: o.sha256, size: o.size }]));
  if (outputs.size === 0) throw new Error("extension/dist/dist.complete indexes no outputs: npm run build:production");
  return {
    fingerprint: `${marker.commit ?? "unknown"}:${await sha256Hex(new TextEncoder().encode(JSON.stringify([...outputs])))}`,
    outputs,
  };
}

/** Read one built file AS THE BYTE dist.complete records for it, waiting briefly for a rebuild in flight.
 *
 *  chrome-agent-platform-kxzib: this test derives its expectation from dist, and a build that was writing
 *  dist concurrently was read as a TRUNCATED bundle - undefined content is a shorter string, not an error.
 *  options.bundle.js references vault-quotas-GKSROYHG.js at 78% of its bytes (the other four chunk
 *  references sit in the first 0.3%), so a short read dropped exactly that chunk from the "expected"
 *  graph while the browser had loaded it, reding the whole serial phase on a tree nothing was wrong
 *  with. Reading the byte the marker records makes the expectation a function of ONE build, and a tree
 *  that never settles is an explicit refusal naming the file - never a silently smaller graph.
 */
async function readMarkerVerifiedFile(index: MarkerIndex, relPath: string): Promise<string> {
  const expected = index.outputs.get(relPath);
  if (!expected) {
    throw new Error(
      `dist.complete does not index ${relPath}, so the expected import graph could not be attributed to a build output`,
    );
  }
  let observed = "not read";
  for (let attempt = 1; attempt <= 40; attempt++) {
    const bytes = await Deno.readFile(`${DIST}/${relPath}`).catch(() => null);
    if (bytes) {
      const actual = await sha256Hex(bytes);
      if (bytes.byteLength === expected.size && actual === expected.sha256) {
        return new TextDecoder().decode(bytes);
      }
      observed = `${bytes.byteLength} bytes (sha256 ${actual.slice(0, 12)})`;
    }
    if (attempt < 40) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `${ENVIRONMENTAL_REFUSAL_MARKER} {"method":"readMarkerVerifiedFile","reason":"dist is not the build dist.complete records - a rebuild is rewriting it while this expectation is derived","file":"${relPath}","read":"${observed}","markerRecords":"${expected.size} bytes (sha256 ${expected.sha256.slice(0, 12)})","attempts":40}`,
  );
}

async function computeExpectedChunkGraph(index: MarkerIndex, bundleRelPath: string): Promise<Set<string>> {
  const visited = new Set<string>();
  const queue: string[] = [];

  const bundleCode = await readMarkerVerifiedFile(index, bundleRelPath);
  for (const m of bundleCode.matchAll(/\.\/chunks\/([a-zA-Z0-9._-]+\.js)/g)) {
    if (!visited.has(m[1])) {
      visited.add(m[1]);
      queue.push(m[1]);
    }
  }

  while (queue.length > 0) {
    const chunkName = queue.shift()!;
    // A referenced chunk that the marker does not index, or whose bytes are not the recorded ones, is a
    // hard stop: the old `.catch(() => "")` here could silently shorten the graph instead.
    const chunkCode = await readMarkerVerifiedFile(index, `chunks/${chunkName}`);
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
  if (RESOLVED_BIN === null) {
    const { refuseWithoutBrowser } = await import("../scripts/lib/browser-refusal.ts");
    refuseWithoutBrowser({ binary: null, tried: TRIED_BINS }, ["20e2u condition (e)"]);
    return;
  }
  const CHROME_BIN = RESOLVED_BIN;
  const tmp = durableDir(`cap-chunk-browser-${Date.now()}`);

  // The expectation is derived from the build's own record BEFORE the browser loads it, once per
  // surface: one settled build, one graph - and the same bytes the browser is about to load (kxzib).
  const markerIndex = await readMarkerIndex();
  const expectedGraphs = new Map<string, Set<string>>();
  for (const surface of SURFACES) {
    expectedGraphs.set(surface.path, await computeExpectedChunkGraph(markerIndex, surface.bundle));
  }

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

    const surfaces = SURFACES;
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

      // 2. The expected static chunk import graph for this surface bundle, derived from the build's
      //    own record before the browser was launched (see expectedGraphs above).
      const expectedGraph = expectedGraphs.get(surface.path)!;
      assert(expectedGraph.size > 0, `${surface.path} expected graph must not be empty`);

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

    // The comparison above is only meaningful against the build the browser loaded. If another process
    // rebuilt dist while this run was in flight, say so as an environmental refusal naming the build,
    // rather than reporting the delta for a tree that changed under it.
    const after = await readMarkerIndex();
    if (after.fingerprint !== markerIndex.fingerprint) {
      throw new Error(
        `${ENVIRONMENTAL_REFUSAL_MARKER} {"method":"readMarkerIndex","reason":"dist was rebuilt while this run loaded it, so the loaded chunks and the expected graph describe different builds","before":"${markerIndex.fingerprint.slice(0, 24)}","after":"${after.fingerprint.slice(0, 24)}"}`,
      );
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
