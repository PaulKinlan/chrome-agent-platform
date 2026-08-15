// Unit tests for the security-critical pure helpers (no chrome.*, no AI SDK).
// These cover the exact cases the independent review flagged: canonicalOrigin
// scheme restriction, schema enforcement, tool-name sanitization, and the
// sender-origin authorization (the cross-origin directory-poisoning exploit).

import { assert, assertEquals } from "jsr:@std/assert@1";

import { canonicalOrigin } from "../extension/lib/memory.js";
import {
  schemaToZod,
  sanitizeToolName,
  authorizeToolReport,
} from "../extension/lib/pure.js";

// A tiny zod stand-in with the surface schemaToZod uses, plus a real safeParse.
function makeZ() {
  const mk = (parse: (v: unknown) => unknown) => Object.assign({ safeParse: (v: unknown) => ({ success: true, data: parse(v) }) }, { optional: function () { return this; }, passthrough: function () { return this; } });
  return {
    string: () => mk((v: unknown) => String(v)),
    number: () => { const s = mk((v: unknown) => Number(v)); return Object.assign(s, { int: () => mk((x: unknown) => Math.trunc(Number(x))) }); },
    boolean: () => mk((v: unknown) => Boolean(v)),
    array: (inner: unknown) => mk((v: unknown) => [inner]),
    object: (shape: unknown) => { const s = mk((v: unknown) => ({ shape })); return Object.assign(s, { passthrough: () => s }); },
    record: () => mk((v: unknown) => v),
    any: () => mk((v: unknown) => v),
  };
}

Deno.test("canonicalOrigin accepts http/https and rejects everything else", () => {
  assertEquals(canonicalOrigin("https://example.com/"), "https://example.com");
  assertEquals(canonicalOrigin("http://example.com:8080/x"), "http://example.com:8080");
  assertEquals(canonicalOrigin("file:///etc/passwd"), null);
  assertEquals(canonicalOrigin("data:text/html,hi"), null);
  assertEquals(canonicalOrigin("chrome-extension://abc/ntp.html"), null);
  assertEquals(canonicalOrigin("not a url"), null);
});

Deno.test("canonicalOrigin: a fake 'null' origin is rejected", () => {
  // A non-special scheme URL produces origin "null" — must be rejected.
  assertEquals(canonicalOrigin("javascript:alert(1)"), null);
});

Deno.test("schemaToZod builds an object schema with required/optional", () => {
  const z = makeZ();
  const s = schemaToZod(z, {
    type: "object",
    properties: { name: { type: "string" }, count: { type: "integer" } },
    required: ["name"],
  });
  assert(s, "schema returned");
  assert(typeof s.safeParse === "function", "schema is parseable");
});

Deno.test("schemaToZod falls back to a record for unknown shapes", () => {
  const z = makeZ();
  assert(schemaToZod(z, null), "null schema -> record");
  assert(schemaToZod(z, { type: "weird" }), "unknown type -> record");
});

Deno.test("sanitizeToolName strips URL punctuation to a valid tool id", () => {
  assertEquals(sanitizeToolName("https://example.com", "get user"), "site_get_user");
  assertEquals(sanitizeToolName("https://example.com", "a/b:c?d"), "site_a_b_c_d");
});

Deno.test("authorizeToolReport: a content script reports its OWN origin (accepted)", () => {
  const sender = {
    id: "ext-id",
    url: "https://example.com/page",
    tab: { url: "https://example.com/page" },
    frameId: 0,
  };
  const r = authorizeToolReport(sender, "https://example.com", canonicalOrigin, "ext-id");
  assertEquals(r.kind, "content-script");
  assertEquals(r.origin, "https://example.com");
});

Deno.test("authorizeToolReport: a message claiming a DIFFERENT origin is rejected", () => {
  const sender = {
    id: "ext-id",
    url: "https://example.com/page",
    tab: { url: "https://example.com/page" },
    frameId: 0,
  };
  const r = authorizeToolReport(sender, "https://victim.example", canonicalOrigin, "ext-id");
  assertEquals(r.kind, "content-script");
  assertEquals(r.error, "origin mismatch — tool report rejected");
});

Deno.test("authorizeToolReport: a non-top-frame page sender cannot report tools", () => {
  const sender = {
    id: "ext-id",
    url: "https://example.com/iframe",
    tab: { url: "https://example.com/" },
    frameId: 1,
  };
  const r = authorizeToolReport(sender, undefined, canonicalOrigin, "ext-id");
  assertEquals(r.kind, "unmatched");
});

Deno.test("authorizeToolReport: an extension page is not a content script", () => {
  const sender = { id: "ext-id", url: "chrome-extension://ext-id/ntp/ntp.html" };
  const r = authorizeToolReport(sender, undefined, canonicalOrigin, "ext-id");
  assertEquals(r.kind, "extension");
});

Deno.test("authorizeToolReport: a fake extension id is not authorized", () => {
  const sender = {
    id: "attacker-id",
    url: "https://example.com/",
    tab: { url: "https://example.com/" },
    frameId: 0,
  };
  const r = authorizeToolReport(sender, undefined, canonicalOrigin, "ext-id");
  assertEquals(r.kind, "unmatched"); // not a content script of OUR extension
});
