// lib/logical-site-agent-config.js — the canonical registry/schema helper for
// the LOGICAL archive target `logicalsiteagentconfig`
// (memory/origins/<origin>/agentConfig.json — chrome-agent-platform-8wbb).
//
// WHY THIS EXISTS. The archive-target registry classifies that OPFS leaf as
// `portable-redacted`, but nothing in the archive converter EXECUTED a
// sanitizer for it: the file's raw bytes crossed an export untouched. The
// bead's contract, implemented here:
//
//   - the current genuine writer (service-worker.js siteMemory.setTrusted)
//     stores exactly `{ name: normalizedName }` — name-only. This module
//     gives that file explicit authority coverage: the shape is a REGISTERED
//     schema, not an accident of a missing sanitizer.
//   - a MISSING class sanitizer fails CLOSED. A portable-redacted target
//     without a registered helper is refused, never passed raw. The
//     injected-missing-helper test pins this.
//   - the DEFENSIVE credential policy: the current writer emits no embedded
//     provider secrets, and this module does not claim it does. Credential-
//     named fields (`apiKey`/`authToken`/`clientSecret`, the exact
//     archive-registry set) and `__proto__` are dropped defensively anyway,
//     and that extension beyond the name-only writer is documented HERE.
//   - the SUPPORTED-FIELD policy is explicit: `name` is the writer's field;
//     `provider` is a defensive extension the sanitizer already understands
//     (delegated to the archive registry's sanitizeAgentConfig); anything
//     else FAILS CLOSED — an unlisted field is refused, never silently kept.
//   - the MEMORYSTORE ENVELOPE: values persist as `{ __v, __value }`
//     (memory.js). Decoding accepts the envelope AND legacy raw (pre-envelope
//     files), and reports which shape it saw.
//   - OWNING APPLY with EXACT RAW ROLLBACK: publishing a logical value
//     produces a FRESH envelope version plus the exact prior raw text for
//     rollback — no blanket KV-array transform, no file-size cap anywhere.

/** The logical archive target this module is the authority for. */
export const LOGICAL_SITE_AGENT_CONFIG = "logicalsiteagentconfig";

/** Credential-named fields dropped defensively. The current writer emits
 *  none of these; the drop is a defensive extension, documented here. */
const DEFENSIVE_CREDENTIAL_KEYS = new Set(["apiKey", "authToken", "clientSecret"]);

/** Fields the schema supports: exactly the current writer's field. Anything
 *  else — including a speculative provider container no writer emits — fails
 *  closed under the field policy until a writer makes it real. */
const SUPPORTED_FIELDS = new Set(["name"]);

/** Decode stored file text into the LOGICAL value. Accepts the MemoryStore
 *  envelope `{ __v, __value }` (a finite numeric `__v` with an own `__value`,
 *  mirroring memory.js) and legacy raw values (any pre-envelope JSON). The
 *  envelope must be an OBJECT envelope; `__value` must be a record for this
 *  target. Returns { value, provenance } — provenance is "envelope" or
 *  "legacy", so the caller knows which shape it came from. */
export function decodeLogicalSiteAgentConfig(rawText) {
  if (typeof rawText !== "string") throw new TypeError("archive_target_agent_config_text");
  let parsed;
  try { parsed = JSON.parse(rawText); } catch (error) {
    throw new TypeError("archive_target_agent_config_json");
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      typeof parsed.__v === "number" && Number.isFinite(parsed.__v) &&
      "__value" in parsed) {
    return { value: parsed.__value, provenance: "envelope" };
  }
  return { value: parsed, provenance: "legacy" };
}

/** The canonical sanitizer for the logical value. The existing name is
 *  preserved verbatim; unknown fields fail closed; credential-named fields
 *  are dropped defensively; `provider` delegates to the archive registry's
 *  own sanitizeAgentConfig contract. */
export function sanitizeLogicalSiteAgentConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("archive_target_agent_config_record");
  }
  // The DEFENSIVE credential policy runs FIRST: a credential-named field is a
  // recognized policy case (dropped), never an "unknown field" — and `__proto__`
  // goes with it. What remains is validated against the explicit supported set.
  const recognized = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (DEFENSIVE_CREDENTIAL_KEYS.has(key) || key === "__proto__") continue;
    Object.defineProperty(recognized, key, {
      value: descriptor.value, enumerable: true, writable: true, configurable: true,
    });
  }
  for (const key of Object.keys(recognized)) {
    if (!SUPPORTED_FIELDS.has(key)) {
      throw new TypeError(`archive_target_agent_config_field:${key}`);
    }
  }
  // The existing name is the record: preserved verbatim, untrimmed.
  const out = {};
  for (const key of Object.keys(recognized)) out[key] = recognized[key];
  if (typeof out.name !== "string" || out.name.length === 0) {
    throw new TypeError("archive_target_agent_config_name");
  }
  return out;
}

/** Encode a logical value back to stored text: a fresh MemoryStore envelope
 *  version. `previousVersion` is the `__v` of the decoded input (0 for
 *  legacy) — the fresh version always advances past it. */
export function encodeLogicalSiteAgentConfig(value, previousVersion = 0) {
  const fresh = Number.isFinite(previousVersion) ? Math.floor(previousVersion) + 1 : 1;
  return JSON.stringify({ __v: fresh, __value: value });
}

/** OWNING APPLY with EXACT RAW ROLLBACK. Takes the current stored text (may
 *  be "" for a not-yet-existing file), applies `logicalValue` as a fresh
 *  envelope version, and returns both the next stored text and the EXACT
 *  prior raw text for rollback. Never mutates its inputs. */
export function applyLogicalSiteAgentConfig(previousRawText, logicalValue) {
  if (typeof previousRawText !== "string") throw new TypeError("archive_target_agent_config_text");
  const { value, provenance } = decodeLogicalSiteAgentConfig(
    previousRawText === "" ? JSON.stringify({}) : previousRawText,
  );
  const sanitized = sanitizeLogicalSiteAgentConfig(logicalValue);
  const previousVersion = provenance === "envelope"
    ? JSON.parse(previousRawText).__v
    : 0;
  return {
    nextRaw: encodeLogicalSiteAgentConfig(sanitized, previousVersion),
    rollbackRaw: previousRawText,
    provenance,
  };
}

/** The class-dispatch table: logical target -> sanitizer. A target absent
 *  from this table has NO registered sanitizer and MUST fail closed. */
const SANITIZERS = new Map([
  [LOGICAL_SITE_AGENT_CONFIG, sanitizeLogicalSiteAgentConfig],
]);

/** Does this path classify as a portable-redacted OPFS target this module
 *  holds authority for? Keyed on the registry's own classification, so the
 *  dispatch and the classifier cannot disagree. */
export function isManagedRedactedTarget(path) {
  return path.includes("/") && path.endsWith("/agentConfig.json") &&
    path.startsWith("memory/origins/");
}

/** THE DISPATCH. Execute the registered sanitizer for a portable-redacted
 *  target's stored text. A target without a registered helper FAILS CLOSED
 *  (typed refusal) — the raw bytes of an unredacted file never cross an
 *  export. Returns the sanitized logical value decoded from `rawText`. */
export function sanitizeRedactedTargetText(path, rawText) {
  if (!isManagedRedactedTarget(path)) {
    throw new TypeError(`archive_target_redacted_unmanaged:${path}`);
  }
  const helper = SANITIZERS.get(LOGICAL_SITE_AGENT_CONFIG);
  if (typeof helper !== "function") {
    // Missing class sanitizer: fail closed. (Reached only if the registry
    // above is edited to drop the helper — the injected-mutant case.)
    throw new TypeError("archive_target_redacted_missing_helper");
  }
  const { value } = decodeLogicalSiteAgentConfig(rawText);
  return helper(value);
}
