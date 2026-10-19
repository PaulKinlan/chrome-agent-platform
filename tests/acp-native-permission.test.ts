// tests/acp-native-permission.test.ts — chrome-agent-platform-o65r.
//
// The shipped manifest lists `nativeMessaging` in optional_permissions (install never
// demands it), so the grant is requested JIT from the owner's gesture. This file proves
// the grant helper's contract functionally: idempotence, the happy path, a refusal, a
// failed request, and a missing chrome.permissions surface — each with a fake surface,
// no Chrome and no real permission prompt.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { ensureAcpNativePermission } from "../extension/lib/acp-native.js";

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
