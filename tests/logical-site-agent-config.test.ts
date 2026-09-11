// tests/logical-site-agent-config.test.ts — chrome-agent-platform-8wbb.
//
// The canonical registry/schema helper + envelope contract for the logical
// archive target `logicalsiteagentconfig`
// (memory/origins/<origin>/agentConfig.json):
//
//   - the CURRENT GENUINE writer stores { name: normalizedName } via
//     siteMemory.setTrusted — that shape has explicit authority coverage here
//     and is preserved verbatim through a sanitize round-trip;
//   - the writer emits NO embedded provider secrets; the credential drop is a
//     DEFENSIVE extension (injected credential keys are sanitized out, and
//     the injected-credential mutant below fails if the drop is removed);
//   - a MISSING class sanitizer fails CLOSED (the injected-missing-helper
//     mutant: an unmanaged portable-redacted path is refused, never raw);
//   - MemoryStore envelope { __v, __value } AND legacy raw values decode;
//   - owning apply produces a FRESH envelope version with an EXACT raw
//     rollback;
//   - no blanket KV-array transform and no file-size cap: a large array value
//     is refused as an unlisted shape only by the schema, and a large record
//     is never truncated by any bound in this module.
//
// @ts-nocheck — injected OPFS/storage fakes are intentionally dynamic.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  LOGICAL_SITE_AGENT_CONFIG,
  applyLogicalSiteAgentConfig,
  decodeLogicalSiteAgentConfig,
  sanitizeLogicalSiteAgentConfig,
  sanitizeRedactedTargetText,
} from "../extension/lib/logical-site-agent-config.js";
import { classifyOpfsPath } from "../extension/lib/archive-target-registry.js";

const AGENT_CONFIG_PATH = "memory/origins/https%3A%2F%2Fexample.com/agentConfig.json";

// ── classification: the registry and the module agree on the target ──

Deno.test("the agentConfig OPFS leaf classifies portable-redacted and the module claims it", () => {
  assertEquals(classifyOpfsPath(AGENT_CONFIG_PATH).cls, "portable-redacted");
  assertEquals(LOGICAL_SITE_AGENT_CONFIG, "logicalsiteagentconfig");
});

// ── envelope + legacy decoding (MemoryStore { __v, __value } contract) ──

Deno.test("decode: the MemoryStore envelope and legacy raw values both decode, with provenance", () => {
  const value = { name: "Site Bot" };
  const envelope = decodeLogicalSiteAgentConfig(JSON.stringify({ __v: 7, __value: value }));
  assertEquals(envelope, { value, provenance: "envelope" });

  const legacy = decodeLogicalSiteAgentConfig(JSON.stringify(value));
  assertEquals(legacy, { value, provenance: "legacy" });

  assertThrows(() => decodeLogicalSiteAgentConfig("{not json"), TypeError);
  assertThrows(() => decodeLogicalSiteAgentConfig(42), TypeError);
});

// ── the sanitizer: existing name preserved; supported-field policy; ──
// ── defensive credential drop; fail-closed unknown fields ──────────────

Deno.test("sanitize: the current writer's name-only file is preserved verbatim", () => {
  const genuine = { name: "Site Bot" };
  assertEquals(sanitizeLogicalSiteAgentConfig(genuine), { name: "Site Bot" });
});

Deno.test("sanitize: an injected credential field is dropped defensively (8wbb mutant)", () => {
  // The current writer never emits this; a future bad writer must not have
  // the credential cross an archive.
  const injected = { name: "Site Bot", apiKey: "sk-injected-secret" };
  const out = sanitizeLogicalSiteAgentConfig(injected);
  assertEquals(out.name, "Site Bot");
  assertEquals(Object.hasOwn(out, "apiKey"), false, "the injected credential must be dropped");
  assertEquals(Object.hasOwn(out, "authToken"), false);
  assertEquals(Object.hasOwn(out, "clientSecret"), false);
});

Deno.test("sanitize: an unlisted field fails closed — the supported-field policy is explicit", () => {
  assertThrows(
    () => sanitizeLogicalSiteAgentConfig({ name: "Site Bot", mysteryField: 1 }),
    TypeError,
    "archive_target_agent_config_field:mysteryField",
  );
  assertThrows(() => sanitizeLogicalSiteAgentConfig({ name: "" }), TypeError);
  assertThrows(() => sanitizeLogicalSiteAgentConfig(null), TypeError);
  assertThrows(() => sanitizeLogicalSiteAgentConfig([1, 2]), TypeError);
});

Deno.test("sanitize: a speculative provider container fails closed under the field policy", () => {
  // No writer emits a provider container in agentConfig; until one does, the
  // field policy refuses it (the provider/MCP helpers are tofr/115p/66t3's).
  assertThrows(
    () => sanitizeLogicalSiteAgentConfig({ name: "Site Bot", provider: { provider: "openai", baseURL: "https://api.example.test/v1" } }),
    TypeError,
    "archive_target_agent_config_field:provider",
  );
  assertThrows(
    () => sanitizeLogicalSiteAgentConfig({ name: "x", provider: { provider: "p", baseURL: "ftp://nope" } }),
    TypeError,
    "archive_target_agent_config_field:provider",
  );
});

// ── owning apply with exact raw rollback ──

Deno.test("apply: a fresh envelope version is written and rollback is the EXACT prior raw text", async () => {
  const legacyRaw = JSON.stringify({ name: "Legacy Bot" });
  const applied = applyLogicalSiteAgentConfig(legacyRaw, { name: "Renamed Bot" });
  assertEquals(JSON.parse(applied.nextRaw), { __v: 1, __value: { name: "Renamed Bot" } });
  assertEquals(applied.rollbackRaw, legacyRaw, "rollback restores the exact prior raw bytes");
  assertEquals(applied.provenance, "legacy");

  const again = applyLogicalSiteAgentConfig(applied.nextRaw, { name: "Renamed Again" });
  assertEquals(JSON.parse(again.nextRaw), { __v: 2, __value: { name: "Renamed Again" } });
  assertEquals(again.rollbackRaw, applied.nextRaw, "rollback is the exact prior raw, not a re-encoding");
  assertEquals(again.provenance, "envelope");

  const empty = applyLogicalSiteAgentConfig("", { name: "First" });
  assertEquals(JSON.parse(empty.nextRaw), { __v: 1, __value: { name: "First" } });
  assertEquals(empty.rollbackRaw, "");
});

// ── class dispatch + helper execution + the missing-helper fail-closed ──

Deno.test("dispatch: the registered target executes the helper on the decoded value", () => {
  const out = sanitizeRedactedTargetText(
    AGENT_CONFIG_PATH,
    JSON.stringify({ __v: 3, __value: { name: "Site Bot", apiKey: "sk-x" } }),
  );
  assertEquals(out.name, "Site Bot");
  assertEquals(Object.hasOwn(out, "apiKey"), false, "the helper executed over the decoded envelope value");
});

Deno.test("dispatch: an unmanaged portable-redacted path FAILS CLOSED (missing-helper mutant)", () => {
  // A portable-redacted leaf this module holds no authority for: the raw
  // bytes of such a file must never cross an export.
  assertThrows(
    () => sanitizeRedactedTargetText("memory/origins/https%3A%2F%2Fexample.com/futureRedacted.json", "{}"),
    TypeError,
    "archive_target_redacted_unmanaged",
  );
  assertThrows(
    () => sanitizeRedactedTargetText("completely/different.json", "{}"),
    TypeError,
    "archive_target_redacted_unmanaged",
  );
});

// ── integration tests (export-walk dispatch) are PARKED with the wiring hunk: ──
// the +1.5KB SW-surface dispatch is sequenced behind the 11rm streamed converter (2g90);
// the ready-to-apply wiring diff + these two tests live in the 8wbb bead notes.
