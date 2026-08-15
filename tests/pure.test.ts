// Unit tests for the security-critical pure helpers (no chrome.*, no AI SDK).
// Uses REAL zod (not a permissive fake) so the schema-converter + authorization
// tests actually prove fail-closed behaviour: enum violations, extra-property
// rejection, collision-resistant tool ids, and the cross-origin spoof rejection.

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { z } from "npm:zod@3";

import { canonicalOrigin } from "../extension/lib/memory.js";
import {
  schemaToZod,
  sanitizeToolName,
  authorizeToolReport,
  PAGE_ALLOWED_ROUTES,
  fnv1a,
} from "../extension/lib/pure.js";

Deno.test("canonicalOrigin accepts http/https and rejects everything else", () => {
  assertEquals(canonicalOrigin("https://example.com/"), "https://example.com");
  assertEquals(canonicalOrigin("http://example.com:8080/x"), "http://example.com:8080");
  assertEquals(canonicalOrigin("file:///etc/passwd"), null);
  assertEquals(canonicalOrigin("data:text/html,hi"), null);
  assertEquals(canonicalOrigin("chrome-extension://abc/ntp.html"), null);
  assertEquals(canonicalOrigin("not a url"), null);
  assertEquals(canonicalOrigin("javascript:alert(1)"), null);
});

// ---- schema conversion: FAIL CLOSED ----

Deno.test("schemaToZod rejects a wrong primitive type", () => {
  const s = schemaToZod(z, { type: "string" });
  assertEquals(s.safeParse(42).success, false);
  assertEquals(s.safeParse("ok").success, true);
});

Deno.test("schemaToZod honors enum (an enum violation is rejected)", () => {
  const s = schemaToZod(z, { type: "string", enum: ["a", "b"] });
  assertEquals(s.safeParse("a").success, true);
  assertEquals(s.safeParse("z").success, false);
});

Deno.test("schemaToZod honors additionalProperties:false (extra property rejected)", () => {
  const s = schemaToZod(z, {
    type: "object",
    properties: { name: { type: "string" } },
    additionalProperties: false,
  });
  assertEquals(s.safeParse({ name: "x" }).success, true);
  // an extra field must be rejected — the exact finding from the review
  assertEquals(s.safeParse({ name: "x", admin: true }).success, false);
});

Deno.test("schemaToZod honors min/max length; pattern fails closed", () => {
  const s = schemaToZod(z, { type: "string", minLength: 2, maxLength: 4 });
  assertEquals(s.safeParse("ab").success, true);
  assertEquals(s.safeParse("a").success, false);
  assertEquals(s.safeParse("abcde").success, false);

  // Pattern/regex is NOT supported (regex-DoS vector) — a descriptor carrying
  // `pattern` fails closed and rejects every value.
  const p = schemaToZod(z, { type: "string", pattern: "^[a-z]+$" });
  assertEquals(p.safeParse("abc").success, false);
  assertEquals(p.safeParse("ABC1").success, false);
});

Deno.test("schemaToZod honors number/integer minimum/maximum", () => {
  const n = schemaToZod(z, { type: "number", minimum: 0, maximum: 10 });
  assertEquals(n.safeParse(5).success, true);
  assertEquals(n.safeParse(-1).success, false);
  assertEquals(n.safeParse(11).success, false);

  const i = schemaToZod(z, { type: "integer" });
  assertEquals(i.safeParse(5).success, true);
  assertEquals(i.safeParse(5.5).success, false);
});

Deno.test("schemaToZod honors required properties", () => {
  const s = schemaToZod(z, {
    type: "object",
    properties: { name: { type: "string" }, count: { type: "integer" } },
    required: ["name"],
  });
  assertEquals(s.safeParse({ name: "x" }).success, true);
  assertEquals(s.safeParse({ count: 1 }).success, false); // name required
});

Deno.test("schemaToZod fails closed on unsupported/malformed schemas", () => {
  // null schema -> z.never() (rejects everything), NOT a permissive record
  assertEquals(schemaToZod(z, null).safeParse({ anything: 1 }).success, false);
  assertEquals(schemaToZod(z, { type: "weird" }).safeParse("x").success, false);
  assertEquals(schemaToZod(z, undefined).safeParse({}).success, false);
});

Deno.test("schemaToZod bounds: too-deep schema fails closed", () => {
  let deep = { type: "object", properties: {} };
  for (let i = 0; i < 10; i++) deep = { type: "object", properties: { n: deep } };
  const s = schemaToZod(z, deep);
  assertEquals(s.safeParse({ n: { n: { n: { n: { n: {} } } } } }).success, false);
});

// ---- tool name: collision-resistant ----

Deno.test("sanitizeToolName is collision-resistant (a/b vs a:b differ)", () => {
  const a = sanitizeToolName("https://example.com", "a/b");
  const b = sanitizeToolName("https://example.com", "a:b");
  assert(a !== b, `collision: ${a} == ${b}`);
});

Deno.test("sanitizeToolName is bounded + includes an origin+name hash", () => {
  const id = sanitizeToolName("https://example.com", "some tool name");
  assert(id.length <= 64, `too long: ${id.length}`);
  assert(id.startsWith("site_"), "should start with site_");
  assert(id.includes("_"), "should contain a hash + sanitized name");
});

Deno.test("fnv1a is deterministic", () => {
  assertEquals(fnv1a("abc"), fnv1a("abc"));
  assert(fnv1a("abc") !== fnv1a("abd"));
});

// ---- sender authorization ----

Deno.test("authorizeToolReport: a content script reports its OWN origin (accepted)", () => {
  const sender = { id: "ext-id", url: "https://example.com/page", tab: { url: "https://example.com/page" }, frameId: 0 };
  const r = authorizeToolReport(sender, "https://example.com", canonicalOrigin, "ext-id");
  assertEquals(r.kind, "content-script");
  assertEquals(r.origin, "https://example.com");
});

Deno.test("authorizeToolReport: a message claiming a DIFFERENT origin is rejected", () => {
  const sender = { id: "ext-id", url: "https://example.com/page", tab: { url: "https://example.com/page" }, frameId: 0 };
  const r = authorizeToolReport(sender, "https://victim.example", canonicalOrigin, "ext-id");
  assertEquals(r.kind, "content-script");
  assertEquals(r.error, "origin mismatch — tool report rejected");
});

Deno.test("authorizeToolReport: a non-top-frame page sender cannot report tools", () => {
  const sender = { id: "ext-id", url: "https://example.com/iframe", tab: { url: "https://example.com/" }, frameId: 1 };
  assertEquals(authorizeToolReport(sender, undefined, canonicalOrigin, "ext-id").kind, "unmatched");
});

Deno.test("authorizeToolReport: an extension page is not a content script", () => {
  const sender = { id: "ext-id", url: "chrome-extension://ext-id/ntp/ntp.html" };
  assertEquals(authorizeToolReport(sender, undefined, canonicalOrigin, "ext-id").kind, "extension");
});

Deno.test("authorizeToolReport: a fake extension id is not authorized", () => {
  const sender = { id: "attacker-id", url: "https://example.com/", tab: { url: "https://example.com/" }, frameId: 0 };
  assertEquals(authorizeToolReport(sender, undefined, canonicalOrigin, "ext-id").kind, "unmatched");
});

Deno.test("PAGE_ALLOWED_ROUTES is an allowlist (admin routes are NOT in it)", () => {
  assert(PAGE_ALLOWED_ROUTES.has("tools.upsert"));
  assert(PAGE_ALLOWED_ROUTES.has("tools.list"));
  assert(!PAGE_ALLOWED_ROUTES.has("memory.set"));
  assert(!PAGE_ALLOWED_ROUTES.has("provider.set"));
  assert(!PAGE_ALLOWED_ROUTES.has("agent.run"));
  assert(!PAGE_ALLOWED_ROUTES.has("browser-control.set"));
});
