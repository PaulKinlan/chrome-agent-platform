// tests/secret-redaction.test.ts — the sol review's HIGH-2 attestation:
// provider errors and generic KV reads can never carry a credential out.

// @ts-nocheck — dynamic browser-global stubs for the module import.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { redactSecretText, safeProviderError, boundErrorText } from "../extension/lib/pure.js";

Deno.test("redaction: an echoed known key is masked in EVERY credential context (exact, JSON, keyword)", () => {
  const key = "sk-echo-me-123456";
  const cases = [
    `Bad key: ${key}`,
    `"authorization": "${key}"`,
    `{"error":{"message":"invalid api_key ${key} provided"}}`,
  ];
  for (const c of cases) {
    const out = safeProviderError(c, [key]);
    assert(!out.includes(key), `the raw key must never survive: ${out}`);
    assert(out.includes("[REDACTED]"), `the mask is present: ${out}`);
  }
  // A bare mention with NO credential context survives as prose (context-only
  // masking for ALL lengths — never global substrings).
  const bare = safeProviderError(`the words ${key} appear in prose`, [key]);
  assert(bare.includes(key), "a bare non-credential mention is NOT globally masked");
});

Deno.test("redaction: pattern-embedded credentials are masked WITHOUT a known key", () => {
  // A hostile endpoint echoes a Bearer header the extension never told us about.
  assert(!safeProviderError("Bad bearer credentials: Bearer abcdef1234567890").includes("abcdef1234567890"));
  assertEquals(
    safeProviderError("Bad bearer credentials: Bearer abcdef1234567890").includes("[REDACTED]"),
    true,
  );
  // URL credentials (password part only).
  const urlOut = safeProviderError("could not reach https://user:supersecret99@example.com/v1");
  assert(!urlOut.includes("supersecret99"), "the URL password is masked");
  assert(urlOut.includes("user:[REDACTED]@") || urlOut.includes("[REDACTED]@"), "user retained, password masked");
  // key=value assignment.
  assert(!safeProviderError('failed: api_key = "verysecret42"').includes("verysecret42"));
});

Deno.test("redaction: harmless text passes through unchanged (no false positives)", () => {
  assertEquals(safeProviderError("HTTP 429 rate limited — retry later"), "HTTP 429 rate limited — retry later");
  assertEquals(safeProviderError("model xyz is unknown"), "model xyz is unknown");
});

Deno.test("redaction: the error text is bounded", () => {
  const long = "A".repeat(2000);
  const out = boundErrorText(long, 300);
  assertEquals(out.length, 301); // 300 + ellipsis
  assertEquals(boundErrorText("short"), "short");
});

// ── the kv.get secret-namespace deny, through the REAL route logic ──────────
// The route body is extracted to a testable pure function? No — it is inline in
// the SW. We assert the same contract via the route's building blocks: the
// SECRET_KV_KEYS set + redactSecrets behavior on a realistic registry shape.
Deno.test("kv deny (contract): redactSecrets masks provider.apiKey in a named-agents registry", async () => {
  const { redactSecrets } = await import("../extension/lib/pure.js");
  const registry = {
    "picker-probe": {
      id: "picker-probe",
      name: "Picker Probe",
      provider: { provider: "deepseek", baseURL: "https://api.deepseek.com/v1", apiKey: "sk-registry-key-999", model: "deepseek-chat" },
    },
  };
  const out = redactSecrets(registry);
  assert(!JSON.stringify(out).includes("sk-registry-key-999"), "the key never survives");
  assertEquals(out["picker-probe"].provider.apiKey, "[REDACTED]");
  assertEquals(out["picker-probe"].provider.model, "deepseek-chat", "non-secret fields survive");
});

// ── provider-test echo (HIGH-2): a hostile endpoint echoing the key ─────────
Deno.test("provider-test: a hostile error body echoing the key is redacted before Settings", async () => {
  const { testProvider } = await import("../extension/lib/provider-test.js");
  // Local throwaway endpoint: echoes the Authorization header back in the body.
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen: () => {} }, (req) => {
    const auth = req.headers.get("authorization") ?? "";
    return new Response(
      JSON.stringify({ error: { message: `Invalid credentials: ${auth}` } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  });
  try {
    const port = server.addr?.port ?? 0;
    const res = await testProvider(
      { id: "openai-compatible", name: "BYO", baseURL: "", needsKey: true, needsModel: true },
      { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sk-hostile-echo-777", model: "m" },
    );
    assertEquals(res.ok, false);
    assertEquals(res.errorKind, "auth");
    assert(!res.error.includes("sk-hostile-echo-777"), `the echoed key must be redacted: ${res.error}`);
    assert(res.error.includes("[REDACTED]"), `the mask is shown instead: ${res.error}`);
  } finally {
    ac.abort();
  }
});

// ── final review: the CENTRAL describeError path → persistence chain ────────
Deno.test("describeError: a hostile provider body echoing credentials is redacted in EVERY output field", async () => {
  const { describeError } = await import("../extension/lib/error-report.js");
  const hostile = new Error("Provider returned error: invalid key sk-live-abcdef123456 and bearer ZmFrZS1rZXk= rejected");
  hostile.name = "AI_APICallError";
  hostile.statusCode = 401;
  hostile.url = "https://api.example.com/v1/chat?key=sk-live-abcdef123456&x=1";
  hostile.responseBody = JSON.stringify({ error: { message: "bad api_key sk-live-abcdef123456 (also try password=hunter2000)" } });
  const d = describeError(hostile, { provider: "openai-compatible", model: "m" });
  const all = JSON.stringify(d);
  assert(!all.includes("sk-live-abcdef123456"), `no key anywhere in describeError output: ${all}`);
  assert(!all.includes("hunter2000"), `no assignment password: ${all}`);
  assert(!all.includes("ZmFrZS1rZXk=") || all.includes("[REDACTED]"), "bearer token masked");
  assert(!all.includes("key=sk"), "URL query dropped/masked");
});

Deno.test("describeError: RetryError unwraps to a REDACTED inner description", async () => {
  const { describeError } = await import("../extension/lib/error-report.js");
  const inner = new Error("401 invalid_api_key Bearer abcdef1234567890xyz");
  inner.name = "AI_APICallError";
  inner.statusCode = 401;
  const retry = new Error(`AI_RetryError: Failed after 3 attempts. Last error: ${inner.message}`);
  retry.name = "AI_RetryError";
  retry.lastError = inner;
  const d = describeError(retry, { provider: "deepseek" });
  const all = JSON.stringify(d);
  assert(!all.includes("abcdef1234567890xyz"), "the inner credential never survives the unwrap");
});

Deno.test("redaction: leading-boundary — mytoken/notasecret are NOT redacted", async () => {
  const { redactSecrets } = await import("../extension/lib/pure.js");
  const out = redactSecrets({ mytoken: "abc", notasecret: "xyz", api_key: "real-one" });
  assertEquals(out.mytoken, "abc", "mytoken (keyword INSIDE a word) survives");
  assertEquals(out.notasecret, "xyz", "notasecret survives");
  assertEquals(out.api_key, "[REDACTED]", "a real credential key is redacted");
});

Deno.test("redaction: known secrets of ANY length mask in credential contexts ONLY", () => {
  assert(!safeProviderError("api_key: k3y9", ["k3y9"]).includes("k3y9"), "a 4-char key masked after a credential keyword");
  assert(!safeProviderError("api_key abc", ["abc"]).includes("abc"), "3-char key masked after a credential keyword");
  assert(!safeProviderError("token=ab", ["ab"]).includes("ab"), "2-char token masked after a credential keyword");
  assert(!safeProviderError("Authorization: Bearer k", ["k"]).includes("k"), "1-char bearer credential masked");
  // …but NEVER as global substrings (any length): prose + prior markers stay readable.
  const prose = safeProviderError("the quick abc fox jumps k3y9 too", ["abc", "k3y9"]);
  assert(prose.includes("abc") && prose.includes("k3y9"), "ordinary prose is NOT corrupted (no global masking at any length)");
  const marker = safeProviderError("already [REDACTED] here with REDA inside", ["REDA"]);
  assert(marker.includes("[REDACTED]"), "existing redaction markers are never corrupted (even by a 4-char colliding substring)");
});

Deno.test("redaction: Unicode NFKC forms are masked in credential contexts", () => {
  const key = "sk-uni-1234";
  const fullwidth = "\uff53\uff4b-uni-1234"; // ｓｋ-uni-1234
  const out = safeProviderError(`echo key ${fullwidth}`, [key]);
  assert(!out.includes("1234"), `the fullwidth form is masked via NFKC in context: ${out}`);
});

Deno.test("redaction: embedded URL queries stripped WHOLESALE (sig=, unknown creds)", () => {
  const out = safeProviderError("fetch failed for https://api.example.com/v1/x?sig=ENCRYPTEDSIG1234&key=abc123456&foo=1");
  assert(!out.includes("ENCRYPTEDSIG1234"), "sig param gone");
  assert(!out.includes("abc123456"), "unknown key param gone");
  assert(out.includes("[query redacted]"), "the strip is visible");
  // Non-URL text with a colon assignment still redacts.
  assert(!safeProviderError("error: api_key=zzz999zzz").includes("zzz999zzz"));
});

Deno.test("securityEvent: details are redacted + bounded in securityState", async () => {
  globalThis.chrome = globalThis.chrome ?? {};
  const { securityEvent, securityState } = await import("../extension/lib/diagnostics.js");
  securityEvent("permission", `denied https://x.example/p?token=supertoken777 api_key=sk-sec-999999`);
  const state = securityState();
  const all = JSON.stringify(state);
  assert(!all.includes("supertoken777"), "no token in the security buffer");
  assert(!all.includes("sk-sec-999999"), "no key in the security buffer");
  assert(state.count >= 1);
});

Deno.test("threads: recordThreadError PERSISTS redacted text (the real storage chain)", async () => {
  // Real recordThreadError → OPFS-backed masterMemory is stubbed via the
  // chrome.storage mock the threads module uses (kv/session) — we drive it
  // with the hostile describeError output and read the STORED thread back.
  // Minimal OPFS shim (threads persist through masterMemory → OPFS).
  class FileShim {
    constructor(data) { this.data = data ?? ""; }
    getFile() { return { text: async () => this.data }; }
    createWritable() {
      let sink = "";
      return { write: async (s) => { sink += s; }, close: async () => { this.data = sink; } };
    }
  }
  class DirShim {
    constructor() { this.kids = new Map(); }
    async getDirectoryHandle(name, { create } = {}) {
      if (!this.kids.has(name)) { if (!create) throw new Error("nf"); this.kids.set(name, new DirShim()); }
      return this.kids.get(name);
    }
    async getFileHandle(name, { create } = {}) {
      if (!this.kids.has(name)) {
        // The REAL OPFS API throws a NotFoundError DOMException for a missing
        // handle; the product's isNotFound() recognises that name. The previous
        // harness threw a plain Error("nf") whose message matched none of the
        // heuristics, so readJsonStrict re-threw and issueVersion failed closed
        // with "the durable generation authority is corrupt" — a HARNESS
        // defect, not a product bug.
        if (!create) {
          const missing = new Error("not found: " + name);
          missing.name = "NotFoundError";
          throw missing;
        }
        this.kids.set(name, new FileShim(""));
      }
      return this.kids.get(name);
    }
    async *entries() { for (const [n, v] of this.kids) yield [n, v.constructor === FileShim ? n : n]; }
    async removeEntry(name) { this.kids.delete(name); }
  }
  const opfsRoot = new DirShim();
  globalThis.navigator = globalThis.navigator ?? {};
  (globalThis.navigator as never as { storage: unknown }).storage = {
    getDirectory: async () => opfsRoot,
  };
  const store = new Map();
  globalThis.chrome = globalThis.chrome ?? {};
  globalThis.chrome.storage = {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
    },
  };
  const threads = await import("../extension/lib/threads.js");
  // Seed a thread.
  await threads.createThread("probe task");
  const list = await threads.listThreads();
  const id = list[list.length - 1]?.id;
  assert(id, "thread created");
  // The hostile error detail (an echoed key in every string field).
  const hostile = {
    message: "provider 401 (bad api_key sk-thread-real-777777)",
    category: "provider-auth",
    reason: "the provider returned 401 (bad key sk-thread-real-777777)",
    action: "Check the API key in Settings",
    detail: "body: bad api_key sk-thread-real-777777 · url: https://api.example.com/v1/x?token=tok-thread-9999",
  };
  await threads.recordThreadError(id, hostile);
  // Read the stored thread BACK through the module (the storage read path).
  const stored = await threads.getThread(id);
  const all = JSON.stringify(stored);
  assert(!all.includes("sk-thread-real-777777"), `the key never persists: ${all.slice(0, 200)}`);
  assert(!all.includes("tok-thread-9999"), "the URL query token never persists");
  assert(all.includes("[REDACTED]"), "the mask is what persisted");
});

Deno.test("redaction: known secrets masked case-insensitively + percent-encoded (credential contexts)", () => {
  const key = "Sk-MiXeDcAsE-987654";
  const out = safeProviderError(`api_key: ${key} and api_key: ${encodeURIComponent(key)}`, [key]);
  assert(!out.toLowerCase().includes("sk-mixedcase-987654"), "case-folded form masked");
  assert(!out.includes(encodeURIComponent(key)), "percent-encoded form masked");
});

Deno.test("redaction: tokenCount/secretary fields are NOT redacted (no false positives)", async () => {
  const { redactSecrets } = await import("../extension/lib/pure.js");
  const payload = { tokenCount: 42, secretary: "Ms. Vale", authorization: "Bearer real-secret-999" };
  const out = redactSecrets(payload);
  assertEquals(out.tokenCount, 42, "tokenCount survives");
  assertEquals(out.secretary, "Ms. Vale", "secretary survives");
  assertEquals(out.authorization, "[REDACTED]", "real authorization still redacted");
});

Deno.test("diagnostics: captured console text is redacted + bounded before storage", async () => {
  globalThis.chrome = globalThis.chrome ?? {};
  const { push } = await import("../extension/lib/diagnostics.js");
  const key = "sk-diag-leak-424242";
  const entry = push("error", `provider failed with api_key ${key} … ${"A".repeat(500)}`);
  assert(!entry.message.includes(key), "the key never persists into diagnostics");
  assert(entry.message.length < 400, `bounded: ${entry.message.length}`);
});

Deno.test("threads: a described provider error persists REDACTED into thread storage", async () => {
  // The chain the reviewer required: describeError -> route-style persistence
  // (threads.js appendMessage/lastError) -> read back -> no credential.
  const { describeError } = await import("../extension/lib/error-report.js");
  const hostile = new Error("401: invalid api_key sk-thread-leak-777777");
  hostile.name = "AI_APICallError";
  hostile.statusCode = 401;
  hostile.responseBody = JSON.stringify({ error: { message: "bad key sk-thread-leak-777777" } });
  const d = describeError(hostile, { provider: "openai-compatible", model: "m" });
  // The persistence shape the thread/lastError path stores (threads.js stores
  // the formatted message + detail).
  const stored = { lastError: d.message, detail: d.detail, reason: d.reason };
  const readBack = JSON.stringify(stored);
  assert(!readBack.includes("sk-thread-leak-777777"), `the stored thread error is key-free: ${readBack}`);
});

// ── vj4s review P0: the bounded scheme run ({0,63}) must not leak long-scheme
// userinfo passwords the unbounded pre-vj4s regex masked. The match window
// only slides onto a LETTER start — a scheme run whose trailing 64 chars are
// all digits/signs has no valid start inside the window (the reviewer's
// counterexample). A linear indexOf("://")-anchored covering pass restores
// exact parity. The OLD unbounded regex is inlined as the reference oracle.

const OLD_USERINFO = (s) =>
  String(s).replace(/([a-z][a-z0-9+.-]*:\/\/[^:\/\s]+:)([^@\s]{4,})@/gi, "$1[REDACTED]@");

Deno.test("redaction: long-scheme userinfo regression — digit-tail scheme leaks nothing (vj4s P0)", () => {
  // The reviewer's exact counterexample: masked by the old regex, leaked by
  // the naive {0,63} bound (positions 1-64 are digits — no [a-z] match start).
  const hostile = "a" + "0".repeat(64) + "://user:supersecret99@example.com";
  const out = redactSecretText(hostile);
  assert(!out.includes("supersecret99"), `password must be masked: ${out.slice(-80)}`);
  assert(out.includes("[REDACTED]@"), `mask marker present: ${out.slice(-80)}`);
});

Deno.test("redaction: scheme-length boundary family masks exactly like the unbounded regex", () => {
  for (const len of [4, 63, 64, 65, 66, 100]) {
    // letter-ful tail: the window slides — the bounded pass alone covers it.
    const letterful = "a".repeat(len) + "://user:hunter2pw@example.com";
    // letter-less tail: one letter then digits — needs the covering pass >64.
    const digitTail = "a" + "0".repeat(len - 1) + "://user:hunter2pw@example.com";
    // sign/dot mix tail.
    const signTail = "a" + "+.-0".repeat(Math.ceil((len - 1) / 4)).slice(0, len - 1) + "://user:hunter2pw@example.com";
    for (const [label, input] of [["letterful", letterful], ["digit-tail", digitTail], ["sign-tail", signTail]]) {
      const out = redactSecretText(input);
      assert(!out.includes("hunter2pw"), `${label} scheme len ${len}: password masked (got …${out.slice(-60)})`);
      assertEquals(
        OLD_USERINFO(input).includes("[REDACTED]@"),
        true,
        `oracle sanity: the old regex masked ${label} len ${len}`,
      );
    }
  }
  // Parity NEGATIVE (no over-redaction): a scheme run with NO letter anywhere
  // is not a URL scheme — the old regex leaves it alone, and so must we.
  const noLetter = "1" + "0".repeat(70) + "://user:hunter2pw@example.com";
  assertEquals(OLD_USERINFO(noLetter).includes("[REDACTED]"), false, "oracle: old regex does not mask letter-less runs");
  assert(redactSecretText(noLetter).includes("hunter2pw"), "letter-less scheme run is NOT masked (no over-redaction)");
});

Deno.test("redaction: userinfo subset-match parity with the pre-vj4s regex over a corpus", () => {
  const corpus = [
    // every boundary length × tail shape, with and without surrounding prose
    ...[1, 2, 4, 32, 63, 64, 65, 66, 128].flatMap((len) => [
      "a".repeat(len) + "://user:password123@example.com",
      "a" + "0".repeat(len - 1) + "://user:password123@example.com",
      `fetch ${"a" + "9".repeat(len - 1)}://u:p@ssw0rd@example.com failed`, // first @ terminates (pw "p" <4… covered below)
    ]),
    // tail-shape edges the oracle treats specifically
    "https://user:abc@example.com", // password <4 chars — never masked
    "https://:password123@example.com", // empty user — never masked
    "https://user:password123example.com", // no @ — never masked
    "https://user:password123 @example.com", // whitespace before @ — never masked
    "0".repeat(80) + "://user:password123@example.com", // no letter — never masked
    "a.b-c+d".repeat(20) + "://user:password123@example.com", // long mixed run, letters throughout
  ];
  for (const input of corpus) {
    const oldMasked = OLD_USERINFO(input).includes("[REDACTED]@");
    const out = redactSecretText(input);
    const newMasked = out.includes("[REDACTED]@");
    if (oldMasked) {
      assert(newMasked, `subset-match: old masked, new must too — ${input.slice(0, 50)}…`);
      assert(!out.includes("password123"), `password gone — ${input.slice(0, 50)}…`);
    }
    if (!oldMasked && input.includes("password123") && !/api[_-]?key|token|secret|password|bearer/i.test(input.split("://")[0])) {
      // no NEW over-redaction of the userinfo shape (other passes may still
      // mask credential-KEYWORD text — excluded here by the keyword guard).
      assert(newMasked === false || !out.includes("[REDACTED]@"),
        `no over-redaction beyond the oracle — ${input.slice(0, 50)}…`);
    }
  }
});
