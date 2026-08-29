// @ts-nocheck — detector scripts run in mocked MAIN/ISOLATED worlds.
import { assertEquals } from "jsr:@std/assert@1";

await import("../extension/content/bridge-auth.js");
const auth = globalThis.CapBridgeAuth;
const mainSource = await Deno.readTextFile(new URL("../extension/content/webmcp-detect-main.js", import.meta.url));
const relaySource = await Deno.readTextFile(new URL("../extension/content/webmcp-detect-relay.js", import.meta.url));

Deno.test("passive detector rejects forged snapshots and relays the genuine probe", async () => {
  const listeners = [];
  const detections = [];
  const makeWindow = () => ({
    CapBridgeAuth: auth,
    addEventListener(type, listener) {
      if (type === "message") listeners.push({ window: this, listener });
    },
    postMessage(data) {
      for (const entry of [...listeners]) entry.listener({ source: entry.window, data });
    },
  });
  const mainWindow = makeWindow();
  const relayWindow = makeWindow();
  const location = { origin: "https://tools.example", href: "https://tools.example/tools" };
  const document = {
    modelContext: { getTools: async () => [{ name: "search" }] },
    addEventListener() {},
  };
  const evaluate = (source, window, chrome = undefined) => new Function(
    "window", "document", "navigator", "location", "chrome", "setTimeout", "globalThis",
    source,
  )(window, document, {}, location, chrome, () => 0, window);

  evaluate(mainSource, mainWindow);
  evaluate(relaySource, relayWindow, {
    runtime: {
      async sendMessage(message) {
        if (message.type === "webmcp.detect.bootstrap") {
          return { ok: true, nonce: "detector-test-nonce-0123456789" };
        }
        if (message.type === "webmcp.detect.arm") {
          return { ok: mainWindow.__capWebmcpDetectBootstrap("detector-test-nonce-0123456789") };
        }
        if (message.type === "webmcp.detected") {
          detections.push(message);
          return { ok: true };
        }
        return { ok: false };
      },
    },
  });

  relayWindow.postMessage({ __cap_webmcp_detect: 1, type: "snapshot", toolCount: 99 }, "*");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(detections.length, 1, "nonce-less page forgery must not update the registry");
  assertEquals(detections[0].toolCount, 1, "the authenticated MAIN probe is relayed");
});
