// tests/webmcp-honest-errors.test.ts — chrome-agent-platform-ajcc
// Structural invariants for the honest page-tool error path. The BEHAVIORAL
// proof (specific DOMException name+message crossing the bridge, bare
// DOMException honesty, credential redaction, result-serialization phase,
// happy path) is scripts/kat-webmcp-honest-errors.ts — these source
// assertions keep the mechanism from being quietly removed (the house
// pattern for the non-importable content-script IIFEs, per
// tests/webmcp-bridge-handshake.test.ts).
// @ts-nocheck — source-text assertions, house style.
import { assert } from "jsr:@std/assert@1";

const MAIN = await Deno.readTextFile(new URL("../extension/content/main-world.js", import.meta.url));
const BRIDGE = await Deno.readTextFile(new URL("../extension/content/content-script.js", import.meta.url));
const SW = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
const FIXTURE = await Deno.readTextFile(new URL("../fixtures/webmcp-errors.html", import.meta.url));

Deno.test("honest errors: the bridge composes a bounded honest description, not a bare redacted name", () => {
  assert(MAIN.includes("function describePageError("), "main-world must compose an honest page-error description");
  assert(MAIN.includes('phase,') && MAIN.includes("pageControlled"), "errorDetail carries phase + pageControlled");
  assert(MAIN.includes('const message = redactBridgeText('), "the message crosses bounded + redacted");
  assert(MAIN.includes('const stack = redactBridgeText('), "a bounded stack excerpt crosses");
  // The bare-DOMException case must SAY it has nothing, never invent detail.
  assert(MAIN.includes("with no message"), "a messageless page error is reported as exactly that");
});

Deno.test("honest errors: page text is still credential-redacted before it crosses (round-30 preserved + ajcc-P1 parity)", () => {
  assert(MAIN.includes("function redactBridgeText("), "the redaction choke point exists");
  assert(MAIN.includes("…[query redacted]") && MAIN.includes("/[?#]/"), "URL queries AND fragments are stripped (reflected credentials)");
  assert(MAIN.includes("bearer|basic"), "Bearer/Basic values are masked");
  assert(MAIN.includes(":\\/\\/[^:\\/\\s]+:"), "URL userinfo passwords are masked");
  assert(MAIN.includes("api[_-]?key|token|secret|password"), "generic keyword assignment is masked (token=hunter2hunter2)");
  assert(MAIN.includes("sk-ant"), "well-known credential shapes are masked");
  assert(MAIN.includes("redactSecretText"), "the port declares its source of truth (keep-in-sync pointer)");
  // The old strip-everything posture is gone BY OWNER DIRECTIVE (ajcc) —
  // replaced by redact-and-carry, not by carry-everything.
  assert(!MAIN.includes("SAFE_DOMEXCEPTION_NAMES"), "the allowlist-name-only redaction is superseded");
  assert(!MAIN.includes("never surface it to the bridge/SW/model"), "the old absolute-redaction comment is gone");
});

Deno.test("honest errors: a non-cloneable result is caught at the post and reported with phase=result-serialization", () => {
  assert(MAIN.includes('phase: "result-serialization"'), "the serialization failure gets its own phase");
  assert(MAIN.includes("could not cross the bridge"), "the serialization failure says what actually happened");
  // The success-path post must be the one wrapped — a throwing postMessage
  // must never fall into the handler-failure catch (the mislabel the RED run
  // proved: 'tool failed (DOMException: DataCloneError)').
  const okPost = MAIN.indexOf('post({ type: "result", requestId, ok: true, result });');
  const tryIdx = MAIN.lastIndexOf("try {", okPost);
  const catchIdx = MAIN.indexOf("catch (ser)", okPost);
  assert(okPost > 0 && tryIdx > 0 && tryIdx < okPost && catchIdx > okPost, "the success post is wrapped in try/catch(ser)");
});

Deno.test("honest errors: the isolated world forwards errorDetail and STAMPS realm + origin (never the page's claim)", () => {
  assert(BRIDGE.includes("msg.errorDetail"), "content-script forwards errorDetail");
  assert(
    BRIDGE.includes('realm: "main", origin: location.origin'),
    "content-script stamps realm + origin itself (the broadcast channel is page-observable)",
  );
});

Deno.test("honest errors: the tools.invoke route forwards errorDetail + reason + detail instead of re-wrapping to a bare string", () => {
  const routeIdx = SW.indexOf('async "tools.invoke"');
  assert(routeIdx > 0, "the tools.invoke route exists");
  const routeEnd = SW.indexOf('async "tools.policies"', routeIdx);
  const route = SW.slice(routeIdx, routeEnd > routeIdx ? routeEnd : routeIdx + 6000);
  assert(route.includes("out.errorDetail = res.errorDetail"), "the route forwards errorDetail");
  assert(route.includes("out.reason = res.reason"), "the route forwards the SW's own named reasons");
  assert(route.includes("out.detail = res.detail"), "the route forwards the SW's own detail");
});

Deno.test("honest errors: the failure-mode fixture declares all nine tools", () => {
  for (const name of ["happy_echo", "fail_named", "fail_bare", "fail_typeerror", "fail_leaky", "fail_kw_assignment", "fail_kw_password", "fail_userinfo_url", "return_noncloneable"]) {
    assert(FIXTURE.includes(`"${name}"`), `fixture declares ${name}`);
  }
  assert(FIXTURE.includes('"QuotaExceededError"'), "the named-DOMException fixture uses QuotaExceededError");
  assert(FIXTURE.includes("sk-live-abcdef123456"), "the leaky fixture embeds a credential shape the redaction must catch");
  assert(FIXTURE.includes("token=hunter2hunter2") && FIXTURE.includes("password=hunter2"), "the P1 keyword-assignment fixtures embed plain values the redaction must catch");
  assert(FIXTURE.includes("user:hunter2@example.com/x?y=1#frag"), "the P1 userinfo fixture embeds the URL credential the redaction must catch");
});

Deno.test("honest errors: pure.js carries the reverse keep-in-sync pointer", async () => {
  const PURE = await Deno.readTextFile(new URL("../extension/lib/pure.js", import.meta.url));
  assert(PURE.includes("redactBridgeText"), "redactSecretText names its content-script port so the two stay in sync");
});
