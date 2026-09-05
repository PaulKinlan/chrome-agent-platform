// @ts-nocheck — detector scripts run in mocked MAIN/ISOLATED worlds.
import { assertEquals } from "jsr:@std/assert@1";

await import("../extension/content/bridge-auth.js");
const auth = globalThis.CapBridgeAuth;
const mainSource = await Deno.readTextFile(new URL("../extension/content/webmcp-detect-main.js", import.meta.url));
const relaySource = await Deno.readTextFile(new URL("../extension/content/webmcp-detect-relay.js", import.meta.url));

Deno.test("passive detector is statically loaded into top-level HTTP pages", async () => {
  const manifest = JSON.parse(await Deno.readTextFile(new URL("../extension/manifest.json", import.meta.url)));
  assertEquals(manifest.content_scripts, [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["content/webmcp-detect-main.js"],
      run_at: "document_start",
      world: "MAIN",
      all_frames: false,
    },
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["content/webmcp-detect-relay.js"],
      run_at: "document_start",
      world: "ISOLATED",
      all_frames: false,
    },
  ]);
});

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
      onMessage: { addListener: () => {} },
      async sendMessage(message) {
        if (message.type === "webmcp.detect.bootstrap") {
          return { ok: true, nonce: "detector-test-nonce-0123456789" };
        }
        if (message.type === "webmcp.detect.arm") {
          return { ok: mainWindow.capWebmcpDetectBootstrap("detector-test-nonce-0123456789") };
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

Deno.test("passive detector relay re-arms on the SW's post-grant nudge", async () => {
  // The arm needs chrome.scripting — absent on a fresh profile until the JIT
  // grant. The relay must retry when the SW broadcasts webmcp.detect.rearm
  // after the grant lands; without it, pages open before the grant stay
  // invisible to the picker until a reload.
  const runtimeMessages = [];
  let armAttempts = 0;
  let armSucceeds = false;
  const relayWindow = {
    addEventListener() {},
    postMessage() {},
  };
  const onMessageListeners = [];
  const chromeStub = {
    runtime: {
      onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
      async sendMessage(message) {
        runtimeMessages.push(message.type);
        if (message.type === "webmcp.detect.bootstrap") {
          return { ok: true, nonce: "detector-test-nonce-0123456789" };
        }
        if (message.type === "webmcp.detect.arm") {
          armAttempts++;
          return armSucceeds ? { ok: true } : { ok: false, error: "scripting not granted" };
        }
        return { ok: false };
      },
    },
  };
  new Function(
    "window", "document", "navigator", "location", "chrome", "setTimeout", "globalThis",
    relaySource,
  )(
    relayWindow,
    { addEventListener() {} },
    {},
    { origin: "https://tools.example", href: "https://tools.example/tools" },
    chromeStub,
    () => 0,
    relayWindow,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(armAttempts, 1, "the initial arm attempt runs at bootstrap");
  assertEquals(onMessageListeners.length, 1, "the relay listens for the SW's re-arm nudge");

  // Unrelated messages do not retry the arm.
  for (const fn of onMessageListeners) fn({ type: "webmcp.unrelated" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(armAttempts, 1, "unrelated messages trigger no re-arm");

  // The SW's nudge retries the arm — and with the JIT grant landed it succeeds.
  armSucceeds = true;
  for (const fn of onMessageListeners) fn({ type: "webmcp.detect.rearm" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(armAttempts, 2, "the re-arm nudge retries the arm exactly once");

  // Once armed, further nudges are no-ops (no repeated MAIN-world injection).
  for (const fn of onMessageListeners) fn({ type: "webmcp.detect.rearm" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(armAttempts, 2, "an already-armed relay ignores further nudges");
});
