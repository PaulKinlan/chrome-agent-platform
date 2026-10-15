// chrome-agent-platform-fpb0: the vault route declares the status codes the Settings
// "Test connection" line can report. A declared code that no producer can set makes the
// UI advertise a state that cannot occur, which is what auth_failed and timeout did.
//
// The matcher is deliberately a CODE POSITION (`code: "x"` or `code = "x"`, since the
// proxy assigns e.code and then propagates `code: e.code`), not a bare string search:
// the whitelist itself would otherwise count as its own producer, and unrelated strings
// like a timer named timeout would look like a produced code. That would make this test
// pass while the drift it exists to catch is present.
import { assert, assertEquals } from "jsr:@std/assert@1";

const PRODUCERS = [
  "extension/lib/provider-test.js",
  "extension/lib/provider-gate.js",
  "extension/background/routes/enclave-proxy.js",
  "extension/background/routes/vault.js",
  // slice 1 (jao1.6) produces its ledger codes here, which is why it must be a producer source
  "extension/lib/enclave-ledger.js",
];

Deno.test("fpb0: every code the vault route declares for Test connection has a producer path", async () => {
  const vault = await Deno.readTextFile(new URL("../extension/background/routes/vault.js", import.meta.url));
  const block = vault.match(/const KNOWN_CODES = new Set\(\[([\s\S]*?)\]\);/);
  assert(block, "KNOWN_CODES literal not found in vault.js");
  const declared = [...block![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert(declared.length >= 5, `expected to parse the declared set, got ${declared.length}: ${declared.join(", ")}`);

  const sources = (await Promise.all(
    PRODUCERS.map((p) => Deno.readTextFile(new URL(`../${p}`, import.meta.url))),
  )).join("\n");

  const unproduced = declared.filter((code) =>
    !new RegExp(`code\\s*[:=]\\s*["']${code}["']`).test(sources)
  );
  assertEquals(
    unproduced,
    [],
    `declared for Test connection but producible by no path (remove from KNOWN_CODES or add its producer): ${unproduced.join(", ")}`,
  );
});

// The reverse pin, so the contract cannot silently regain a dead code: a code that was
// removed for having no producer must STAY unproduced. If one of these ever gains a
// producer, the product can reach a state the panel no longer advertises, and this fails
// so the declaration is put back deliberately rather than by memory.
const REMOVED_AS_UNPRODUCIBLE = ["auth_failed", "timeout", "secret_unavailable"];

Deno.test("fpb0: codes removed for having no producer have not silently gained one", async () => {
  const sources = (await Promise.all(
    PRODUCERS.map((p) => Deno.readTextFile(new URL(`../${p}`, import.meta.url))),
  )).join("\n");
  const revived = REMOVED_AS_UNPRODUCIBLE.filter((code) =>
    new RegExp(`code\\s*[:=]\\s*["']${code}["']`).test(sources)
  );
  assertEquals(
    revived,
    [],
    `these were removed from the declared set because nothing produced them, and now something does - add them back to KNOWN_CODES in vault.js: ${revived.join(", ")}`,
  );
});


// BIDIRECTIONAL, because a one-directional census is how the mirror bug got through: a
// newer main added producible codes to this same declaration, and a rebase that only
// checked declared-is-produced would have dropped them silently.
//
// WHAT THIS CANNOT SEE, stated rather than implied, and found by RUNNING the reverse
// check rather than assumed: the Test-connection route forwards the codes produced on its
// own path, but provider-test.js and provider-gate.js also carry the Settings/readiness
// domain, which this route never forwards. Those five are excluded by name below. A code
// produced by a source outside PRODUCERS is invisible here; the forward check is what
// fails when a newly declared code has no producer in PRODUCERS, which is the signal to
// extend the list deliberately.
const NOT_FORWARDED_BY_THIS_ROUTE = [
  "base_url_missing", "base_url_invalid", "ready",
  "provider_temporarily_unavailable", "permission_required",
];

Deno.test("fpb0: every producible Test-connection code is DECLARED (the mirror direction)", async () => {
  const vault = await Deno.readTextFile(new URL("../extension/background/routes/vault.js", import.meta.url));
  const block = vault.match(/const KNOWN_CODES = new Set\(\[([\s\S]*?)\]\);/);
  assert(block, "KNOWN_CODES literal not found in vault.js");
  const declared = [...block![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

  const sources = (await Promise.all(
    PRODUCERS.map((p) => Deno.readTextFile(new URL(`../${p}`, import.meta.url))),
  )).join("\n");
  const produced = [...new Set([...sources.matchAll(/code\s*[:=]\s*["']([a-z_]+)["']/g)].map((m) => m[1]))]
    .filter((code) => !NOT_FORWARDED_BY_THIS_ROUTE.includes(code));

  const undeclared = produced.filter((code) => !declared.includes(code));
  assertEquals(
    undeclared,
    [],
    `producible but NOT declared (add to KNOWN_CODES in vault.js, or the declaration has silently lost a live code): ${undeclared.join(", ")}`,
  );
});
