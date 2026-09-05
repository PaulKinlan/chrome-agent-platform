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
  // f62c: the hook name is per-document and unguessable — the relay learns it
  // from the probe's one-time channel announcement and the (mock) SW calls it
  // by THAT name, exactly like the real arm route.
  const location = { origin: "https://tools.example", href: "https://tools.example/tools" };
  const document = {
    modelContext: { getTools: async () => [{ name: "search" }] },
    addEventListener() {},
  };
  const evaluate = (source, window, chrome = undefined, timers = false) => new Function(
    "window", "document", "navigator", "location", "chrome", "setTimeout", "globalThis",
    source,
  )(window, document, {}, location, chrome, timers ? ((fn, ms) => setTimeout(fn, ms)) : (() => 0), window);

  // The MAIN probe gets REAL timers so its hook-announcement retries (which
  // fix the document_start race with the relay listener) actually fire.
  evaluate(mainSource, mainWindow, undefined, true);
  evaluate(relaySource, relayWindow, {
    runtime: {
      onMessage: { addListener: () => {} },
      async sendMessage(message) {
        if (message.type === "webmcp.detect.bootstrap") {
          return { ok: true, nonce: "detector-test-nonce-0123456789" };
        }
        if (message.type === "webmcp.detect.arm") {
          const hook = mainWindow[message.hook];
          return { ok: typeof hook === "function" && hook("detector-test-nonce-0123456789") };
        }
        if (message.type === "webmcp.detected") {
          detections.push(message);
          return { ok: true };
        }
        return { ok: false };
      },
    },
  });
  // The static fingerprint name is GONE; the hook lives under a random suffix.
  assertEquals(typeof mainWindow.capWebmcpDetectBootstrap, "undefined", "no static hook name");
  const hookName = Object.getOwnPropertyNames(mainWindow)
    .find((n) => /^capWebmcpDetectBootstrap_[0-9a-f]{32}$/.test(n));
  assertEquals(typeof hookName, "string", "a per-document randomized hook exists");

  relayWindow.postMessage({ __cap_webmcp_detect: 1, type: "snapshot", toolCount: 99 }, "*");
  await new Promise((resolve) => setTimeout(resolve, 100));
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
  let armHook = null;
  const relayWindow = {
    addEventListener(type, listener) {
      if (type === "message") this.__messageListener = listener;
    },
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
          armHook = message.hook ?? null;
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
  // No arm before the MAIN probe's hook announcement arrives (f62c) — even
  // with the nonce in hand and an explicit SW nudge.
  assertEquals(armAttempts, 0, "the relay cannot arm before the probe announces its hook name");
  for (const fn of onMessageListeners) fn({ type: "webmcp.detect.rearm" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(armAttempts, 0, "a nudge without the hook name still cannot arm");
  // The announcement arrives: with the nonce already present the relay arms
  // immediately (the two document_start worlds race in either order).
  relayWindow.__messageListener({
    source: relayWindow,
    data: { __cap_webmcp_detect: 1, type: "hook", hook: "capWebmcpDetectBootstrap_0123456789abcdef0123456789abcdef" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(armAttempts, 1, "the relay arms as soon as nonce + hook name both exist");
  assertEquals(armHook, "capWebmcpDetectBootstrap_0123456789abcdef0123456789abcdef", "the arm carries the probe-announced hook name");
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

Deno.test("passive detector: a page-forged hook announcement can only name a same-prefix function (first-write-wins)", async () => {
  // f62c: the hook announcement is unauthenticated by necessity (no nonce
  // exists yet). A page can therefore inject a fake name — but it must match
  // the probe's shape, the FIRST valid name wins (the genuine document_start
  // announcement precedes any page script in practice), and the name only
  // ever scopes the nonce to the page's own detection feed.
  let armHook = null;
  const relayWindow = {
    addEventListener(type, listener) {
      if (type === "message") this.__messageListener = listener;
    },
    postMessage() {},
  };
  const chromeStub = {
    runtime: {
      onMessage: { addListener: () => {} },
      async sendMessage(message) {
        if (message.type === "webmcp.detect.bootstrap") {
          return { ok: true, nonce: "detector-test-nonce-0123456789" };
        }
        if (message.type === "webmcp.detect.arm") {
          armHook = message.hook ?? null;
          return { ok: true };
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
  // Malformed names are ignored outright.
  relayWindow.__messageListener({ source: relayWindow, data: { __cap_webmcp_detect: 1, type: "hook", hook: "alert" } });
  relayWindow.__messageListener({ source: relayWindow, data: { __cap_webmcp_detect: 1, type: "hook", hook: "capWebmcpDetectBootstrap" } }); // static (no suffix)
  relayWindow.__messageListener({ source: relayWindow, data: { __cap_webmcp_detect: 1, type: "hook", hook: 42 } });
  // The first VALID name wins...
  relayWindow.__messageListener({ source: relayWindow, data: { __cap_webmcp_detect: 1, type: "hook", hook: "capWebmcpDetectBootstrap_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
  // ...and a later valid name cannot rotate it.
  relayWindow.__messageListener({ source: relayWindow, data: { __cap_webmcp_detect: 1, type: "hook", hook: "capWebmcpDetectBootstrap_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } });
  await new Promise((resolve) => setTimeout(resolve, 1400)); // let the retry timers fire the arm
  assertEquals(armHook, "capWebmcpDetectBootstrap_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "first valid hook name wins; malformed and later names are ignored");
});
