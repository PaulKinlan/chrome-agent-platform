// tests/acp-native-permission.test.ts — chrome-agent-platform-o65r.
//
// The shipped manifest lists `nativeMessaging` in optional_permissions (install never
// demands it), so the grant is requested JIT from the owner's gesture. This file proves
// the grant helper's contract functionally: idempotence, the happy path, a refusal, a
// failed request, and a missing chrome.permissions surface — each with a fake surface,
// no Chrome and no real permission prompt.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { classifyNativeFailure, ensureAcpNativePermission } from "../extension/lib/acp-native.js";

Deno.test("ensureAcpNativePermission: an already-granted permission is detected and never re-prompts", async () => {
  let requests = 0;
  const res = await ensureAcpNativePermission({
    contains: async () => true,
    request: async () => {
      requests += 1;
      return true;
    },
  });
  assertEquals(res, { granted: true, error: "" });
  assertEquals(requests, 0, "contains=true must short-circuit before request()");
});

Deno.test("ensureAcpNativePermission: a refused request is a clear denial, not a silent pass", async () => {
  const bundles: Array<{ permissions: string[] }> = [];
  const res = await ensureAcpNativePermission({
    contains: async () => false,
    request: async (bundle) => {
      bundles.push(bundle);
      return false;
    },
  });
  assertEquals(res.granted, false);
  assert(res.error.includes("not granted"), `denial message must say so: ${res.error}`);
  assertEquals(bundles.length, 1);
  assertEquals(bundles[0].permissions, ["nativeMessaging"], "exactly the nativeMessaging permission is requested");
});

Deno.test("ensureAcpNativePermission: a thrown request is reported with the retry hint", async () => {
  const res = await ensureAcpNativePermission({
    contains: async () => false,
    request: async () => {
      throw new Error("This function must be called during a user gesture");
    },
  });
  assertEquals(res.granted, false);
  assert(res.error.includes("could not be requested"), `error must name the failure: ${res.error}`);
  assert(res.error.includes("Test connection"), `error must offer the click-grant retry: ${res.error}`);
  assert(res.error.includes("user gesture"), `error must carry Chrome's reason: ${res.error}`);
});

Deno.test("ensureAcpNativePermission: no permissions surface fails with an actionable message", async () => {
  const res = await ensureAcpNativePermission({});
  assertEquals(res.granted, false);
  assert(res.error.includes("unavailable"), `error must name the missing surface: ${res.error}`);
});

Deno.test("ensureAcpNativePermission: a failed contains() is not read as a denial", async () => {
  let requests = 0;
  const res = await ensureAcpNativePermission({
    contains: async () => {
      throw new Error("transient");
    },
    request: async () => {
      requests += 1;
      return true;
    },
  });
  assertEquals(res, { granted: true, error: "" });
  assertEquals(requests, 1, "contains() failing must fall through to request(), not abort the grant");
});

// chrome-agent-platform-q9g8x: the SAME connect() rejection covers two different states — the grant was
// refused/revoked (Chrome never exposes connectNative, so the transport rejects "native messaging is not
// available in this context") and the host is genuinely absent or exited. The runner used to answer both
// with "install the local host", so an owner who only had to press "Test connection" was told to reinstall
// a host they already had. These are the exact message shapes Chrome/our transport produce.
Deno.test("q9g8x: a refused nativeMessaging grant is classified as a GRANT problem, not a missing host", () => {
  for (const message of [
    "native messaging is not available in this context",
    "Native messaging permission was not granted — the native host transport stays unavailable",
    "nativeMessaging permission denied",
  ]) {
    assertEquals(classifyNativeFailure(message), "permission-grant", `must classify as a grant problem: ${message}`);
  }
});

Deno.test("q9g8x: a genuinely absent or exited host is still a HOST problem", () => {
  for (const message of [
    'native host "com.cap.host" is not installed or exited (Specified native messaging host not found.). Install it with: npm run acp:native:install',
    'native host "com.cap.host" could not be started: boom',
    "Access to the specified native messaging host is forbidden.",
  ]) {
    assertEquals(classifyNativeFailure(message), "host-missing", `must classify as a host problem: ${message}`);
  }
});

Deno.test("q9g8x: an unrecognised failure keeps BOTH remedies rather than guessing one", () => {
  for (const message of ["", "   ", "something else entirely", null, undefined]) {
    assertEquals(classifyNativeFailure(message), "unknown", `an unknown failure must not claim a cause: ${String(message)}`);
  }
});
