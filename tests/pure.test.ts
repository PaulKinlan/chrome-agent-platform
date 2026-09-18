// Unit tests for the security-critical pure helpers (no chrome.*, no AI SDK).
// Uses REAL zod (not a permissive fake) so the schema-converter + authorization
// tests actually prove fail-closed behaviour: enum violations, extra-property
// rejection, collision-resistant tool ids, and the cross-origin spoof rejection.

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { z } from "npm:zod@3";

import { canonicalOrigin } from "../extension/lib/memory.js";
import {
  authorizeToolReport,
  discoveredOnly,
  fnv1a,
  PAGE_ALLOWED_ROUTES,
  parseOmniboxContent,
  redactSecrets,
  sanitizeToolName,
  schemaToZod,
} from "../extension/lib/pure.js";

Deno.test("canonicalOrigin accepts http/https and rejects everything else", () => {
  assertEquals(canonicalOrigin("https://example.com/"), "https://example.com");
  assertEquals(
    canonicalOrigin("http://example.com:8080/x"),
    "http://example.com:8080",
  );
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

Deno.test("schemaToZod honors min/max length; pattern is dropped fail-open (never a regex-DoS vector)", () => {
  const s = schemaToZod(z, { type: "string", minLength: 2, maxLength: 4 });
  assertEquals(s.safeParse("ab").success, true);
  assertEquals(s.safeParse("a").success, false);
  assertEquals(s.safeParse("abcde").success, false);

  // Pattern/regex is NOT enforced (regex-DoS vector) — under the fail-open
  // policy (CAP-FB-20260824-WEBMCP-ARGSVALIDATION-01) the keyword is DROPPED
  // (recorded), never compiled and never bricking the tool: the string type
  // itself stays strict, the pattern simply does not constrain.
  const p = schemaToZod(z, { type: "string", pattern: "^[a-z]+$" });
  assertEquals(p.safeParse("abc").success, true);
  assertEquals(p.safeParse("ABC1").success, true);
  assertEquals(p.safeParse(42).success, false); // the TYPE is still enforced
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
  // null/undefined schema nodes -> z.never() (they are not schemas at all),
  // NOT a permissive record.
  assertEquals(schemaToZod(z, null).safeParse({ anything: 1 }).success, false);
  assertEquals(schemaToZod(z, undefined).safeParse({}).success, false);
  // An unknown TYPE value is dropped fail-open (the node becomes untyped and
  // unconstrained) — a page typo must not brick its own tool.
  assertEquals(schemaToZod(z, { type: "weird" }).safeParse("x").success, true);
  // An EMPTY schema means "no constraints" (JSON Schema semantics) — a tool
  // that declares no inputSchema accepts any arguments object.
  assertEquals(schemaToZod(z, {}).safeParse({ anything: 1 }).success, true);
});

Deno.test("schemaToZod bounds: too-deep schema fails closed", () => {
  let deep = { type: "object", properties: {} };
  for (let i = 0; i < 10; i++) {
    deep = { type: "object", properties: { n: deep } };
  }
  const s = schemaToZod(z, deep);
  assertEquals(
    s.safeParse({ n: { n: { n: { n: { n: {} } } } } }).success,
    false,
  );
});

Deno.test("schemaToZod rejects enum/const values that mismatch the declared type", () => {
  // {type:"string", enum:[42]} — 42 is not a string, so it must fail closed.
  const s = schemaToZod(z, { type: "string", enum: [42, "a"] });
  assertEquals(s.safeParse(42).success, false);
  assertEquals(s.safeParse("a").success, true);
  // const with a type mismatch.
  const c = schemaToZod(z, { type: "string", const: 42 });
  assertEquals(c.safeParse(42).success, false);
});

Deno.test("schemaToZod downgrades oneOf to a union (fail-open; exactly-one is not enforced)", () => {
  const s = schemaToZod(z, { oneOf: [{ type: "string" }, { type: "number" }] });
  assertEquals(s.safeParse("x").success, true);
  assertEquals(s.safeParse(1).success, true);
  assertEquals(s.safeParse(true).success, false); // no matching branch
});

Deno.test("schemaToZod compiles a schema-valued additionalProperties as a catchall", () => {
  const s = schemaToZod(z, {
    type: "object",
    properties: { name: { type: "string" } },
    additionalProperties: { type: "string" },
  });
  // Extra properties must satisfy the catchall schema — faithful, not rejected.
  assertEquals(s.safeParse({ name: "x", extra: "y" }).success, true);
  assertEquals(s.safeParse({ name: "x", extra: 42 }).success, false);
});

Deno.test("schemaToZod drops unsupported keywords fail-open (exclusiveMinimum etc.)", () => {
  // exclusiveMinimum is NOT enforced — dropped with a record, never bricking
  // the tool; the declared type stays strict.
  const s = schemaToZod(z, { type: "number", exclusiveMinimum: 5 });
  assertEquals(s.safeParse(10).success, true);
  assertEquals(s.safeParse(0).success, true);
  assertEquals(s.safeParse("not-a-number").success, false);
  // multipleOf is likewise dropped.
  const m = schemaToZod(z, { type: "integer", multipleOf: 3 });
  assertEquals(m.safeParse(9).success, true);
  assertEquals(m.safeParse(4).success, true);
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
  const sender = {
    id: "ext-id",
    url: "https://example.com/page",
    tab: { url: "https://example.com/page" },
    frameId: 0,
  };
  const r = authorizeToolReport(
    sender,
    "https://example.com",
    canonicalOrigin,
    "ext-id",
  );
  assertEquals(r.kind, "content-script");
  assertEquals(r.origin, "https://example.com");
});

Deno.test("authorizeToolReport: browser-reported sender.origin must match sender.tab.url", () => {
  const sender = {
    id: "ext-id",
    url: "https://example.com/page",
    origin: "https://victim.example",
    tab: { url: "https://example.com/page" },
    frameId: 0,
  };
  const r = authorizeToolReport(sender, "https://example.com", canonicalOrigin, "ext-id");
  assertEquals(r.kind, "content-script");
  assertEquals(r.error, "sender origin mismatch — tool report rejected");
});

Deno.test("authorizeToolReport: a message claiming a DIFFERENT origin is rejected", () => {
  const sender = {
    id: "ext-id",
    url: "https://example.com/page",
    tab: { url: "https://example.com/page" },
    frameId: 0,
  };
  const r = authorizeToolReport(
    sender,
    "https://victim.example",
    canonicalOrigin,
    "ext-id",
  );
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
  assertEquals(
    authorizeToolReport(sender, undefined, canonicalOrigin, "ext-id").kind,
    "unmatched",
  );
});

Deno.test("authorizeToolReport: an extension page is not a content script", () => {
  const sender = {
    id: "ext-id",
    url: "chrome-extension://ext-id/ntp/ntp.html",
  };
  assertEquals(
    authorizeToolReport(sender, undefined, canonicalOrigin, "ext-id").kind,
    "extension",
  );
});

Deno.test("authorizeToolReport: a fake extension id is not authorized", () => {
  const sender = {
    id: "attacker-id",
    url: "https://example.com/",
    tab: { url: "https://example.com/" },
    frameId: 0,
  };
  assertEquals(
    authorizeToolReport(sender, undefined, canonicalOrigin, "ext-id").kind,
    "unmatched",
  );
});

Deno.test("PAGE_ALLOWED_ROUTES is an allowlist (admin routes are NOT in it)", () => {
  assert(PAGE_ALLOWED_ROUTES.has("webmcp.detect.bootstrap"));
  assert(PAGE_ALLOWED_ROUTES.has("webmcp.detect.arm"));
  assert(PAGE_ALLOWED_ROUTES.has("webmcp.detected"));
  assert(PAGE_ALLOWED_ROUTES.has("tools.upsert"));
  assert(PAGE_ALLOWED_ROUTES.has("tools.list"));
  assert(!PAGE_ALLOWED_ROUTES.has("memory.set"));
  assert(!PAGE_ALLOWED_ROUTES.has("provider.set"));
  assert(!PAGE_ALLOWED_ROUTES.has("agent.run"));
  assert(!PAGE_ALLOWED_ROUTES.has("browser-control.set"));
  // Approval is an OWNER decision — a content script must NEVER approve its own tools.
  assert(!PAGE_ALLOWED_ROUTES.has("tools.approve"));
});

Deno.test("schemaToZod drops a keyword on the wrong type (fail-open, type stays strict)", () => {
  // minLength is string-only; on a number it is dropped, not enforced.
  const n = schemaToZod(z, { type: "number", minLength: 99 });
  assertEquals(n.safeParse(1).success, true);
  assertEquals(n.safeParse("not-a-number").success, false);
  // minimum is number-only; on a string it is dropped.
  const s = schemaToZod(z, { type: "string", minimum: 5 });
  assertEquals(s.safeParse("ok").success, true);
  assertEquals(s.safeParse(42).success, false);
});

Deno.test("schemaToZod drops malformed keyword shapes fail-open (the rest of the schema stays strict)", () => {
  // required must be an array of strings — a malformed one is dropped.
  const r = schemaToZod(z, {
    type: "object",
    properties: { x: { type: "string" } },
    required: "x",
  });
  assertEquals(r.safeParse({ x: "ok" }).success, true);
  assertEquals(r.safeParse({ x: 42 }).success, false); // the property stays strict
  // anyOf must be an array — dropped.
  const a = schemaToZod(z, { type: "string", anyOf: "bad" });
  assertEquals(a.safeParse("ok").success, true);
  // enum must be an array — dropped.
  const e = schemaToZod(z, { type: "string", enum: "bad" });
  assertEquals(e.safeParse("ok").success, true);
});

Deno.test("schemaToZod drops an empty enum fail-open (the type stays strict)", () => {
  const s = schemaToZod(z, { type: "string", enum: [] });
  assertEquals(s.safeParse("anything").success, true);
  assertEquals(s.safeParse(42).success, false);
});

Deno.test("schemaToZod composes anyOf with the declared type", () => {
  // {type:"string", anyOf:[{type:"number"}]} — JSON Schema requires BOTH the
  // type AND an anyOf branch to match; 42 matches the number branch but not the
  // string type, so it must be rejected.
  const s = schemaToZod(z, { type: "string", anyOf: [{ type: "number" }] });
  assertEquals(s.safeParse(42).success, false);
});

// ---- round-7 regressions: the 9 malformed-probe cases the reviewer found ----
// Each previously returned success:true; each must now REJECT (fail closed).

const malformedCases = [
  ["const ignores minLength", { type: "string", minLength: 2, const: "x" }, "x"],
  ["enum ignores minLength", { type: "string", minLength: 2, enum: ["x"] }, "x"],
  ["anyOf ignores minLength", { type: "string", minLength: 5, anyOf: [{ type: "string" }] }, "x"],
];

for (const [label, schema, value] of malformedCases) {
  Deno.test(`schemaToZod fails closed: ${label}`, () => {
    const s = schemaToZod(z, schema);
    assertEquals(s.safeParse(value).success, false, `${label} accepted a value it must reject`);
  });
}

// ---- round-13 policy change (CAP-FB-20260824-WEBMCP-ARGSVALIDATION-01):
// malformed-but-benign keyword SHAPES are dropped fail-open (recorded), so a
// page bug in one keyword never bricks the whole tool. The remaining fields
// stay strictly validated.
const failOpenCases = [
  ["null type ignores minLength (wrong-type keyword dropped)", { type: "null", minLength: 2 }, null],
  ["properties:null is dropped", { type: "object", properties: null }, { x: 1 }],
  ["malformed optional property (properties:{x:null}) is dropped", { type: "object", properties: { x: null } }, {}],
  ["malformed anyOf branch (null branch) is dropped, survivors still enforce", { anyOf: [null, { type: "string" }] }, "ok"],
  ["negative minLength is dropped", { type: "string", minLength: -1 }, "x"],
  ["fractional maxItems is dropped", { type: "array", maxItems: 1.5 }, [1, 2]],
];

for (const [label, schema, value] of failOpenCases) {
  Deno.test(`schemaToZod fail-open: ${label}`, () => {
    const s = schemaToZod(z, schema);
    assertEquals(s.safeParse(value).success, true, `${label} must no longer brick the tool`);
  });
}

Deno.test("schemaToZod fail-open still rejects genuinely wrong values under a dropped-keyword schema", () => {
  // The surviving constraint still enforces: a null anyOf branch is dropped,
  // the string branch still rejects non-strings.
  const s = schemaToZod(z, { anyOf: [null, { type: "string" }] });
  assertEquals(s.safeParse(42).success, false);
  // A dropped minLength does not weaken the TYPE.
  const t = schemaToZod(z, { type: "string", minLength: -1 });
  assertEquals(t.safeParse(42).success, false);
});

// ---- round-8 regressions: const/enum/anyOf must COMPOSE with every sibling ----
Deno.test("schemaToZod: unknown required keys are malformed (fail closed)", () => {
  // {required:["x"]} with no properties, and with properties lacking x, are malformed.
  const noProps = schemaToZod(z, { type: "object", required: ["x"] });
  assertEquals(noProps.safeParse({}).success, false);
  const absent = schemaToZod(z, { type: "object", properties: {}, required: ["x"] });
  assertEquals(absent.safeParse({}).success, false);
  // and the well-formed form still works:
  const ok = schemaToZod(z, { type: "object", properties: { x: { type: "string" } }, required: ["x"] });
  assertEquals(ok.safeParse({ x: "a" }).success, true);
  assertEquals(ok.safeParse({}).success, false);
});

Deno.test("schemaToZod: const + enum that conflict is unsatisfiable", () => {
  // const "x" but enum ["y"] — no value can satisfy both.
  const s = schemaToZod(z, { type: "string", const: "x", enum: ["y"] });
  assertEquals(s.safeParse("x").success, false);
  assertEquals(s.safeParse("y").success, false);
});

Deno.test("schemaToZod: const + anyOf compose (const must satisfy an anyOf branch)", () => {
  const s = schemaToZod(z, { type: "string", const: "x", anyOf: [{ const: "y" }] });
  assertEquals(s.safeParse("x").success, false); // "x" is not the anyOf branch value
  const ok = schemaToZod(z, { type: "string", const: "x", anyOf: [{ const: "x" }] });
  assertEquals(ok.safeParse("x").success, true);
});

Deno.test("schemaToZod: bounds apply to const/enum even without a declared type", () => {
  const s = schemaToZod(z, { const: "x", minLength: 2 });
  assertEquals(s.safeParse("x").success, false); // "x" length 1 < 2
  const n = schemaToZod(z, { const: 0, minimum: 5 });
  assertEquals(n.safeParse(0).success, false);
  const e = schemaToZod(z, { enum: ["x"], minLength: 2 });
  assertEquals(e.safeParse("x").success, false);
});

Deno.test("schemaToZod: array/object const siblings are enforced", () => {
  const a = schemaToZod(z, { type: "array", minItems: 2, const: [] });
  assertEquals(a.safeParse([]).success, false); // minItems 2 violated
  const o = schemaToZod(z, { type: "object", required: ["x"], const: {} });
  assertEquals(o.safeParse({}).success, false); // required x violated
});

Deno.test("schemaToZod: untyped anyOf accepts matching values (does not reject all)", () => {
  const s = schemaToZod(z, { anyOf: [{ type: "string" }, { type: "number" }] });
  assertEquals(s.safeParse("ok").success, true);
  assertEquals(s.safeParse(42).success, true);
  assertEquals(s.safeParse(true).success, false);
});

Deno.test("schemaToZod composes const with satisfying bounds (valid const still works)", () => {
  const s = schemaToZod(z, { type: "string", minLength: 1, const: "ok" });
  assertEquals(s.safeParse("ok").success, true);
});


// ---- round-9: untyped anyOf sibling composition + structural const/enum ----

Deno.test("untyped anyOf composes string siblings (minLength applies)", () => {
  // {minLength:5, anyOf:[{type:string}]} must REJECT "x" (sibling minLength).
  const s = schemaToZod(z, { minLength: 5, anyOf: [{ type: "string" }] });
  assertEquals(s.safeParse("x").success, false);
  assertEquals(s.safeParse("xxxxx").success, true);
});

Deno.test("untyped anyOf composes object siblings (required applies)", () => {
  // {properties:{x}, required:[x], anyOf:[{type:object}]} must REJECT {}.
  const s = schemaToZod(z, {
    properties: { x: { type: "string" } },
    required: ["x"],
    anyOf: [{ type: "object" }],
  });
  assertEquals(s.safeParse({}).success, false);
  assertEquals(s.safeParse({ x: "ok" }).success, true);
});

Deno.test("untyped conjunction applies only type-applicable siblings (no false negative)", () => {
  // minLength (string-only) + properties (object-only) + anyOf union: a string
  // satisfies minLength + the string branch; an object satisfies properties +
  // the object branch. Neither sibling is treated as a global type declaration.
  const s = schemaToZod(z, {
    minLength: 2,
    properties: { x: { type: "string" } },
    anyOf: [{ type: "string" }, { type: "object" }],
  });
  assertEquals(s.safeParse("abcd").success, true);
  assertEquals(s.safeParse({ x: "ok" }).success, true);
  // The applicable bound is still enforced for the matching kind:
  assertEquals(s.safeParse("a").success, false); // length 1 < minLength 2
});

Deno.test("bare untyped anyOf (no siblings) still accepts union members", () => {
  const s = schemaToZod(z, { anyOf: [{ type: "string" }, { type: "number" }] });
  assertEquals(s.safeParse("ok").success, true);
  assertEquals(s.safeParse(42).success, true);
  assertEquals(s.safeParse(true).success, false);
});

Deno.test("structural const accepts an equal object clone", () => {
  const s = schemaToZod(z, { type: "object", const: { x: 1 } });
  // A separately-parsed but structurally-equal object must PASS (not identity).
  assertEquals(s.safeParse({ x: 1 }).success, true);
  assertEquals(s.safeParse({ x: 2 }).success, false);
  // A same-length but different-key object must NOT pass (own-key check).
  assertEquals(s.safeParse({ y: 1 }).success, false);
});

Deno.test("structural const accepts an equal array clone", () => {
  const s = schemaToZod(z, { type: "array", const: [1, 2] });
  assertEquals(s.safeParse([1, 2]).success, true);
  assertEquals(s.safeParse([1, 3]).success, false);
});

Deno.test("structural enum accepts an equal object clone", () => {
  const s = schemaToZod(z, { type: "object", enum: [{ a: 1 }, { b: 2 }] });
  assertEquals(s.safeParse({ a: 1 }).success, true);
  assertEquals(s.safeParse({ c: 3 }).success, false);
});

Deno.test("schemaToZod bounds const/enum literals (no size-cap bypass)", () => {
  // A 101-item array const and a 10,001-char string const exceed SCHEMA_BOUNDS
  // and must fail closed (not compile into a z.literal that bypasses bounds).
  const bigArr = schemaToZod(z, {
    type: "array",
    const: Array.from({ length: 101 }, (_, i) => i),
  });
  assertEquals(bigArr.safeParse(Array.from({ length: 101 }, (_, i) => i)).success, false);

  const bigStr = schemaToZod(z, { type: "string", const: "x".repeat(10001) });
  assertEquals(bigStr.safeParse("x".repeat(10001)).success, false);

  // A huge enum literal is likewise rejected.
  const bigEnum = schemaToZod(z, { type: "array", enum: [Array.from({ length: 101 }, (_, i) => i)] });
  assertEquals(bigEnum.safeParse(Array.from({ length: 101 }, (_, i) => i)).success, false);
});

Deno.test("Ollama-compatible model allows an optional key (no key required)", async () => {
  const { createOpenAICompatibleModel } = await import(
    "../extension/lib/models/openai-model.js"
  );
  // Ollama (local) has NO apiKey — construction must succeed with an empty key.
  const model = createOpenAICompatibleModel({
    baseURL: "http://localhost:11434/v1",
    apiKey: "",
    model: "llama3",
  });
  assertEquals(typeof model?.doGenerate, "function");
});

Deno.test("redactSecrets strips credential keys but keeps non-secret data", () => {
  const payload = {
    providerConfig: {
      baseURL: "https://api.example.com",
      apiKey: "sk-secret-123",
      model: "gpt-4o",
    },
    changes: {
      capHooks: { oldValue: { token: "abc", list: [1, 2] }, newValue: "x" },
    },
    plain: "hello",
    count: 7,
  };
  const redacted = redactSecrets(payload);
  // The apiKey + token values are gone; surrounding non-secret data is kept.
  assertEquals(redacted.providerConfig.apiKey, "[REDACTED]");
  assertEquals(redacted.providerConfig.baseURL, "https://api.example.com");
  assertEquals(redacted.providerConfig.model, "gpt-4o");
  assertEquals(redacted.changes.capHooks.oldValue.token, "[REDACTED]");
  assertEquals(redacted.changes.capHooks.oldValue.list, [1, 2]);
  assertEquals(redacted.plain, "hello");
  assertEquals(redacted.count, 7);
  // No credential survives anywhere in the redacted payload.
  assert(!JSON.stringify(redacted).includes("sk-secret-123"), "apiKey must never survive");
});

Deno.test("parseOmniboxContent maps recipe/thread/run intents", () => {
  assertEquals(parseOmniboxContent("recipe:tab-hygiene"), {
    kind: "recipe",
    id: "tab-hygiene",
  });
  assertEquals(parseOmniboxContent("thread:abc123"), {
    kind: "thread",
    id: "abc123",
  });
  assertEquals(parseOmniboxContent("summarise this page"), {
    kind: "run",
    query: "summarise this page",
  });
  // Whitespace + empty fail closed to a no-op, never a wild run.
  assertEquals(parseOmniboxContent("   "), { kind: "none" });
  assertEquals(parseOmniboxContent(""), { kind: "none" });
  assertEquals(parseOmniboxContent(null), { kind: "none" });
  // A "recipe:" prefix with an empty id is a recipe intent with an empty id
  // (the caller resolves it; an unknown recipe falls back to running the text).
  assertEquals(parseOmniboxContent("recipe:"), { kind: "recipe", id: "" });
});

Deno.test("discoveredOnly: discovered pages minus enrolled, deduped by origin", () => {
  const tabs = [
    { origin: "https://a.example", toolCount: 3, lastAccessed: 2 },
    { origin: "https://b.example", toolCount: 1, lastAccessed: 1 },
    { origin: "https://a.example", toolCount: 3, lastAccessed: 3 }, // same origin, newer tab
    { origin: "", toolCount: 1 },
    { toolCount: 1 }, // no origin
    null,
  ];
  // nothing enrolled: one row per origin, route order preserved
  const out = discoveredOnly(tabs, []);
  assertEquals(out.map((t) => t.origin), ["https://a.example", "https://b.example"]);
  // enrolled origins drop out entirely:
  assertEquals(discoveredOnly(tabs, ["https://a.example"]).map((t) => t.origin), ["https://b.example"]);
  // everything enrolled → empty (the directory shows the enrolled groups instead):
  assertEquals(discoveredOnly(tabs, ["https://a.example", "https://b.example"]), []);
  // non-arrays fail closed:
  assertEquals(discoveredOnly(null, []), []);
  assertEquals(discoveredOnly(undefined, []), []);
});
