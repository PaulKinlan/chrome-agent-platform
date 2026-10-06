// tests/preference-bridge.test.ts — unit tests for preference percolation (chrome-agent-platform-v5ee)
//
// Verifies:
// 1. Extended preference set schema validation (locale, colorScheme, reduceMotion)
// 2. Fail-closed rejection of disallowed keys, malformed types, and corrupted messages
// 3. Document mutation via applyPreference across all extended keys
// 4. Automatic nonce generation and thread-safe bootstrap injection
// 5. Origin-scoped channel enforcement and cross-origin attack defense
// 6. Content-script and page-agent layer percolation channel lifecycle

import { assertEquals, assert } from "jsr:@std/assert";
import {
  PREFERENCE_MSG_TYPE,
  PREFERENCE_READY_MSG_TYPE,
  ALLOWED_PREFERENCE_KEYS,
  ALLOWED_COLOR_SCHEMES,
  generatePreferenceNonce,
  buildPreferenceMessage,
  validatePreferenceMessage,
  applyPreference,
  buildPreferenceBootstrapScript,
  injectPreferenceBootstrap,
  listenForPreferences,
  createPageAgentPreferenceChannel,
  sendPageAgentPreference,
} from "../extension/lib/preference-bridge.js";

Deno.test("preference-bridge: validates extended preference set (locale, colorScheme, reduceMotion)", () => {
  const nonce = "nonce-12345";

  // 1. All valid extended keys in one message
  const msg = buildPreferenceMessage(
    {
      locale: "en-US",
      colorScheme: "dark",
      reduceMotion: true,
    },
    nonce,
  );

  const res = validatePreferenceMessage(msg, { nonce, sourceIsParent: true });
  assertEquals(res.ok, true);
  assertEquals(res.preference?.locale, "en-US");
  assertEquals(res.preference?.colorScheme, "dark");
  assertEquals(res.preference?.reduceMotion, true);

  // 2. Validate string variations for reduceMotion ('reduce' and 'no-preference')
  const msgReduce = buildPreferenceMessage({ reduceMotion: "reduce" }, nonce);
  const resReduce = validatePreferenceMessage(msgReduce, { nonce, sourceIsParent: true });
  assertEquals(resReduce.ok, true);
  assertEquals(resReduce.preference?.reduceMotion, true);

  const msgNoPref = buildPreferenceMessage({ reduceMotion: "no-preference" }, nonce);
  const resNoPref = validatePreferenceMessage(msgNoPref, { nonce, sourceIsParent: true });
  assertEquals(resNoPref.ok, true);
  assertEquals(resNoPref.preference?.reduceMotion, false);

  // 3. Validate all allowed color schemes
  for (const cs of ALLOWED_COLOR_SCHEMES) {
    const msgCs = buildPreferenceMessage({ colorScheme: cs }, nonce);
    const resCs = validatePreferenceMessage(msgCs, { nonce, sourceIsParent: true });
    assertEquals(resCs.ok, true);
    assertEquals(resCs.preference?.colorScheme, cs);
  }
});

Deno.test("preference-bridge: rejects disallowed keys, invalid schemas, and corrupted payloads fail-closed", () => {
  const nonce = "test-nonce";

  // Unknown/disallowed keys rejected fail-closed
  const forged = {
    type: PREFERENCE_MSG_TYPE,
    nonce,
    preference: { apiKey: "secret", theme: "cyberpunk" },
  };
  const resForged = validatePreferenceMessage(forged, { nonce, sourceIsParent: true });
  assertEquals(resForged.ok, false);
  assert((resForged.error ?? "").includes("disallowed preference key"));

  // Disallowed color scheme rejected
  const badCs = {
    type: PREFERENCE_MSG_TYPE,
    nonce,
    preference: { colorScheme: "high-contrast-neon" },
  };
  const resBadCs = validatePreferenceMessage(badCs, { nonce, sourceIsParent: true });
  assertEquals(resBadCs.ok, false);
  assert((resBadCs.error ?? "").includes("invalid colorScheme"));

  // Disallowed reduceMotion rejected
  const badRm = {
    type: PREFERENCE_MSG_TYPE,
    nonce,
    preference: { reduceMotion: "aggressive" },
  };
  const resBadRm = validatePreferenceMessage(badRm, { nonce, sourceIsParent: true });
  assertEquals(resBadRm.ok, false);
  assert((resBadRm.error ?? "").includes("invalid reduceMotion"));

  // Invalid locale rejected
  const badLoc = {
    type: PREFERENCE_MSG_TYPE,
    nonce,
    preference: { locale: "invalid/locale!" },
  };
  const resBadLoc = validatePreferenceMessage(badLoc, { nonce, sourceIsParent: true });
  assertEquals(resBadLoc.ok, false);
  assert((resBadLoc.error ?? "").includes("invalid locale"));

  // Non-parent source rejected
  const validMsg = buildPreferenceMessage({ locale: "fr-FR" }, nonce);
  const resNotParent = validatePreferenceMessage(validMsg, { nonce, sourceIsParent: false });
  assertEquals(resNotParent.ok, false);
  assertEquals(resNotParent.error, "source is not the parent");

  // Nonce mismatch rejected
  const resWrongNonce = validatePreferenceMessage(validMsg, { nonce: "different-nonce", sourceIsParent: true });
  assertEquals(resWrongNonce.ok, false);
  assertEquals(resWrongNonce.error, "nonce mismatch");

  // Malformed type or payload
  assertEquals(validatePreferenceMessage(null, { nonce }).ok, false);
  assertEquals(validatePreferenceMessage({ type: "other", nonce }, { nonce, sourceIsParent: true }).ok, false);
  assertEquals(validatePreferenceMessage({ type: PREFERENCE_MSG_TYPE, nonce, preference: "string" }, { nonce, sourceIsParent: true }).ok, false);
  assertEquals(validatePreferenceMessage({ type: PREFERENCE_MSG_TYPE, nonce, preference: [] }, { nonce, sourceIsParent: true }).ok, false);
});

Deno.test("preference-bridge: applies preferences to documentElement (lang, data-color-scheme, style.colorScheme, data-reduce-motion)", () => {
  const attrs: Record<string, string> = {};
  const styles: Record<string, string> = {};

  const fakeDoc = {
    documentElement: {
      setAttribute(name: string, value: string) {
        attrs[name] = value;
      },
      style: {
        set colorScheme(val: string) {
          styles.colorScheme = val;
        },
        get colorScheme() {
          return styles.colorScheme;
        },
      },
    },
  };

  applyPreference(
    {
      locale: "ja-JP",
      colorScheme: "dark",
      reduceMotion: true,
    },
    { document: fakeDoc },
  );

  assertEquals(attrs["lang"], "ja-JP");
  assertEquals(attrs["data-color-scheme"], "dark");
  assertEquals(styles.colorScheme, "dark");
  assertEquals(attrs["data-reduce-motion"], "reduce");

  // System/no-preference colorScheme maps to 'light dark' UA styling
  applyPreference(
    {
      colorScheme: "system",
      reduceMotion: false,
    },
    { document: fakeDoc },
  );

  assertEquals(attrs["data-color-scheme"], "system");
  assertEquals(styles.colorScheme, "light dark");
  assertEquals(attrs["data-reduce-motion"], "no-preference");
});

Deno.test("preference-bridge: generatePreferenceNonce produces random, 32-char hex tokens", () => {
  const n1 = generatePreferenceNonce();
  const n2 = generatePreferenceNonce();

  assertEquals(typeof n1, "string");
  assertEquals(n1.length, 32);
  assert(/^[0-9a-f]{32}$/.test(n1));
  assert(n1 !== n2, "subsequent nonces must be unguessable and distinct");
});

Deno.test("preference-bridge: buildPreferenceBootstrapScript and injectPreferenceBootstrap thread nonce and listener into HTML before model content", () => {
  const nonce = "custom-nonce-42";
  const targetOrigin = "https://sandbox.chrome-agent.internal";

  const script = buildPreferenceBootstrapScript({ nonce, targetOrigin });
  assert(script.includes("data-cap-preference-bootstrap"));
  assert(script.includes(`nonce="custom-nonce-42"`));
  assert(script.includes(`expectedOrigin="${targetOrigin}"`));
  assert(script.includes("cap:preference"));
  assert(script.includes("cap:preference-ready"));

  // HTML with existing <head>
  const htmlWithHead = "<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>";
  const injected1 = injectPreferenceBootstrap(htmlWithHead, { nonce, targetOrigin });
  assertEquals(injected1.nonce, nonce);
  assert(injected1.html.startsWith("<html><head><script data-cap-preference-bootstrap>"));
  assert(injected1.html.includes("<title>Test</title>"));

  // Raw HTML without <head> (e.g. model generated snippet)
  const rawHtml = "<div>User generated component</div>";
  const injected2 = injectPreferenceBootstrap(rawHtml, { nonce });
  assert(injected2.html.startsWith("<script data-cap-preference-bootstrap>"));
  assert(injected2.html.endsWith(rawHtml));
});

Deno.test("preference-bridge: origin-scoped channel isolates against cross-origin and mismatched targetOrigin injection", () => {
  const expectedOrigin = "chrome-extension://cap-extension-id";
  const nonce = "origin-nonce-99";

  const validMsg = buildPreferenceMessage(
    { locale: "de-DE", colorScheme: "light" },
    nonce,
    { targetOrigin: expectedOrigin },
  );

  // Exact origin match passes
  const validRes = validatePreferenceMessage(validMsg, {
    nonce,
    sourceIsParent: true,
    expectedOrigin,
    eventOrigin: expectedOrigin,
  });
  assertEquals(validRes.ok, true);
  assertEquals(validRes.preference?.locale, "de-DE");

  // Spoofed cross-origin event rejected
  const spoofedOrigin = validatePreferenceMessage(validMsg, {
    nonce,
    sourceIsParent: true,
    expectedOrigin,
    eventOrigin: "https://malicious.origin.com",
  });
  assertEquals(spoofedOrigin.ok, false);
  assertEquals(spoofedOrigin.error, "origin mismatch");

  // Mismatched targetOrigin in message rejected
  const mismatchMsg = buildPreferenceMessage(
    { locale: "de-DE" },
    nonce,
    { targetOrigin: "https://other.target.com" },
  );
  const targetMismatch = validatePreferenceMessage(mismatchMsg, {
    nonce,
    sourceIsParent: true,
    expectedOrigin,
    eventOrigin: expectedOrigin,
  });
  assertEquals(targetMismatch.ok, false);
  assertEquals(targetMismatch.error, "target origin mismatch");
});

Deno.test("preference-bridge: percolates channel to content-script and page-agent layers with origin-scoped nonces", () => {
  const origin = "https://example.com";
  const nonce = "page-agent-nonce-777";

  let receivedPreference: any = null;
  const appliedAttrs: Record<string, string> = {};

  const fakeDoc = {
    documentElement: {
      setAttribute(name: string, value: string) {
        appliedAttrs[name] = value;
      },
    },
  };

  type MessageListener = (event: any) => void;
  const listeners: MessageListener[] = [];

  const fakeTargetWindow = {
    parent: null as any,
    addEventListener(type: string, listener: MessageListener) {
      if (type === "message") listeners.push(listener);
    },
    removeEventListener(type: string, listener: MessageListener) {
      const idx = listeners.indexOf(listener);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    postMessage(data: any, targetOrigin: string) {
      // Dispatch simulated message event to listeners
      for (const fn of listeners) {
        fn({
          data,
          origin,
          source: fakeTargetWindow.parent,
        });
      }
    },
  };
  fakeTargetWindow.parent = fakeTargetWindow; // in top frame / same window

  // Wire receiver channel in page agent layer
  const disconnect = createPageAgentPreferenceChannel({
    origin,
    nonce,
    targetWindow: fakeTargetWindow,
    document: fakeDoc,
    onPreference(pref) {
      receivedPreference = pref;
    },
  });

  // Send preference from outer/parent surface
  const sent = sendPageAgentPreference(
    fakeTargetWindow,
    {
      locale: "en-CA",
      colorScheme: "dark",
      reduceMotion: true,
    },
    { origin, nonce },
  );

  assertEquals(sent, true);
  assert(receivedPreference !== null, "page agent receiver must receive preference");
  assertEquals(receivedPreference.locale, "en-CA");
  assertEquals(receivedPreference.colorScheme, "dark");
  assertEquals(receivedPreference.reduceMotion, true);

  assertEquals(appliedAttrs["lang"], "en-CA");
  assertEquals(appliedAttrs["data-color-scheme"], "dark");
  assertEquals(appliedAttrs["data-reduce-motion"], "reduce");

  // Attack attempt: cross-origin spoof from another origin
  for (const fn of listeners) {
    fn({
      data: buildPreferenceMessage({ colorScheme: "light" }, nonce, { targetOrigin: origin }),
      origin: "https://attacker.site",
      source: fakeTargetWindow.parent,
    });
  }

  // Value must remain unchanged (fail-closed)
  assertEquals(appliedAttrs["data-color-scheme"], "dark");

  // Disconnect removes listener
  disconnect();
  assertEquals(listeners.length, 0);
});

// chrome-agent-platform-yi5q: dynamic wildcard postMessage fallbacks fail closed
Deno.test("preference-bridge (yi5q): sendPageAgentPreference fails closed on missing, empty, or wildcard origin", () => {
  let callCount = 0;
  let postedTarget = "";
  const targetWindow = {
    postMessage(_data: any, targetOrigin: string) {
      callCount++;
      postedTarget = targetOrigin;
    },
  };

  const pref = { locale: "en-US", colorScheme: "dark" };
  const nonce = "nonce-test-123";

  // 1. Missing origin -> fails closed, no postMessage
  assertEquals(sendPageAgentPreference(targetWindow, pref, { nonce } as any), false);
  assertEquals(callCount, 0);

  // 2. Empty string origin -> fails closed, no postMessage
  assertEquals(sendPageAgentPreference(targetWindow, pref, { origin: "", nonce }), false);
  assertEquals(callCount, 0);

  // 3. Wildcard origin ("*") -> fails closed, no postMessage
  assertEquals(sendPageAgentPreference(targetWindow, pref, { origin: "*", nonce }), false);
  assertEquals(callCount, 0);

  // 4. Whitespace-only origin -> fails closed, no postMessage
  assertEquals(sendPageAgentPreference(targetWindow, pref, { origin: "   ", nonce }), false);
  assertEquals(callCount, 0);

  // 5. Valid origin -> succeeds, targetOrigin passed directly (no wildcard fallback)
  const validOrigin = "https://trusted.example.com";
  assertEquals(sendPageAgentPreference(targetWindow, pref, { origin: validOrigin, nonce }), true);
  assertEquals(callCount, 1);
  assertEquals(postedTarget, validOrigin);
});

Deno.test("preference-bridge (yi5q): buildPreferenceBootstrapScript fails closed when targetOrigin is absent or wildcard", () => {
  const extractBody = (scriptTag: string) => scriptTag.replace(/<script[^>]*>/, "").replace(/<\/script>/, "");

  // 1. Behavioral execution test (P1): When targetOrigin is omitted, expectedOrigin is ""
  // and the IIFE fails closed: postMessage is NEVER called (posted.length === 0).
  const scriptNoOrigin = buildPreferenceBootstrapScript({ nonce: "test-nonce-1" });
  assert(!scriptNoOrigin.includes("expectedOrigin||'*'"), "must not contain dynamic fallback expectedOrigin||'*'");
  assert(!scriptNoOrigin.includes("expectedOrigin || '*'"), "must not contain dynamic fallback expectedOrigin || '*'");

  const postedNoOrigin: Array<{ msg: any; target: string }> = [];
  const winShimNoOrigin = {
    parent: {
      postMessage: (msg: any, target: string) => postedNoOrigin.push({ msg, target }),
    },
    addEventListener: () => {},
  };
  const docShim = { documentElement: { setAttribute: () => {}, style: {} } };

  // Parse and execute against shims — proves syntax validity and behavior
  const fnNoOrigin = new Function("window", "document", extractBody(scriptNoOrigin));
  fnNoOrigin(winShimNoOrigin, docShim);
  assertEquals(postedNoOrigin.length, 0, "must fail closed without targetOrigin: zero messages posted");

  // 2. Behavioral execution test (P1): When targetOrigin is provided, expectedOrigin is bound
  // and the frame posts cap:preference-ready strictly to expectedOrigin (never '*').
  const expectedTarget = "chrome-extension://my-extension-id";
  const scriptWithOrigin = buildPreferenceBootstrapScript({
    nonce: "test-nonce-2",
    targetOrigin: expectedTarget,
  });

  const postedWithOrigin: Array<{ msg: any; target: string }> = [];
  const winShimWithOrigin = {
    parent: {
      postMessage: (msg: any, target: string) => postedWithOrigin.push({ msg, target }),
    },
    addEventListener: () => {},
  };

  const fnWithOrigin = new Function("window", "document", extractBody(scriptWithOrigin));
  fnWithOrigin(winShimWithOrigin, docShim);
  assertEquals(postedWithOrigin.length, 1, "exactly one message posted when targetOrigin is set");
  assertEquals(postedWithOrigin[0].target, expectedTarget, "target must match expectedOrigin exactly");
  assertEquals(postedWithOrigin[0].msg, { type: "cap:preference-ready", nonce: "test-nonce-2" });
});

