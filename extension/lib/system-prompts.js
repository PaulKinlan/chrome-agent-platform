// lib/system-prompts.js — the layered, versioned system-prompt architecture.
//
// THE single composition authority for every system prompt the platform sends
// (docs/SYSTEM-PROMPTS.md). Every run type — hub tasks, named agents,
// background/scheduled agents, system-hook (scoped) runs, and per-site worker
// delegations — resolves its system prompt through composeSystemPrompt() here,
// and the Settings → Advanced preview describes the SAME composition.
//
// ## The layers (composition order — fixed, documented, tested)
//
//   1. owner-prepend   — the owner's custom instructions (mode: "prepend")
//   2. product-base    — the versioned built-in prompt for the scope
//                        (the hub operating manual / the site-worker base);
//                        OMITTED when the override mode is "replace"
//   3. owner-append    — the owner's custom instructions (mode: "append");
//                        for mode "replace" the owner's text sits here in the
//                        base's position
//   4. agent-role      — a named agent's role (agent:<slug> scopes only)
//   5. skills          — the per-run installed/included skills
//   6. protected       — the immutable runtime policy (lib/runtime-policy.js —
//                        the SINGLE authoritative policy source). ALWAYS
//                        present, NEVER editable/replaceable, and ALWAYS the
//                        FINAL layer: it composes AFTER every editable layer
//                        AND the per-run skills, so no owner text, role, or
//                        site-origin skill can override it with a later
//                        instruction.
//
// ## The registry (versioned built-ins)
//
// Every built-in prompt is a registry entry with a STABLE id, a semantic
// version, the extension release it last changed in, and a collision-resistant
// content hash (SHA-256 over the UTF-8 bytes — lib/pure.js). There are no
// scattered duplicate prompt strings: the hub manual lives in
// lib/master-skill.js, the worker base lives here, the protected constraints
// are GENERATED from lib/runtime-policy.js, and the registry references those
// single sources.
//
// ## Owner customization (persisted, migration-safe, fail-closed)
//
// Overrides live in `cap:promptOverrides` (chrome.storage via lib/kv.js) as a
// versioned store: { version: 1, revision: N, scopes: { scope: record } }.
// A record stores the mode (append/prepend/replace), the text, AND the base
// version/hash/snapshot it was written against:
//
//   - No override → the CURRENT built-in always applies (product updates take
//     effect automatically — the safe/expected path).
//   - Override + unchanged built-in → the override composes normally.
//   - Override + CHANGED built-in (a product release updated the prompt) → the
//     override KEEPS APPLYING (deterministic: the owner's customization is
//     never silently lost and the run behavior never silently changes), and
//     the UI surfaces the update with an old-vs-new diff + explicit choices:
//     Keep (re-stamp onto the new base), edit + Save (manual merge), or Reset
//     to the new default. No silent overwrite, ever.
//
// Named-agent scopes INHERIT the hub override when they have none of their own
// (the scope chain is [agent:<slug>, hub]) — the hub manual is their base.
// Upgrade actions (keep/reset-from-the-banner) act on the EFFECTIVE override
// (the inherited hub record when the agent has none of its own).
//
// Durability + concurrency:
//   - The store carries a monotonic `revision`; writers pass the revision they
//     read (expectedRevision) and a stale writer gets a conflict error instead
//     of silently last-write-wins.
//   - Persisted records are validated against a STRICT schema on every read;
//     malformed records are QUARANTINED to `cap:promptOverrides:quarantine`
//     (visible, recoverable) and never composed.
//   - The generic kv.set/kv.remove message routes REFUSE the prompt-owned keys
//     (the service worker enforces it) — only the prompt.* routes may write
//     them, under the overrides mutex.
//   - chrome.storage needs the optional `storage` permission: the Settings UI
//     requests it on the owner's Save gesture, and describePrompt reports
//     `durable: false` so a session-only override is never claimed persistent.
//
// Bounds (Constitution §4) are UTF-8 BYTE bounds: override text ≤ 16 KiB;
// the stored base snapshot ≤ 32 KiB; the store ≤ 64 scopes. Malformed Unicode
// (lone surrogates) is REJECTED — it can never round-trip through UTF-8.
// Validation is FAIL-CLOSED: an unknown scope, a bad mode, or an
// oversize/empty/malformed text is rejected with an error, never silently
// coerced.
//
// Secrets: the override is owner-authored free text. It is never logged and
// never sent anywhere except as part of the system prompt to the configured
// provider; the UI warns against pasting credentials. Attestations/journals
// carry KEYED receipts (HMAC-SHA-256 with a per-install key that never leaves
// storage), not public content fingerprints — a receipt proves parity between
// the preview and a run without being dictionary-testable against guessed
// owner text. Only product-authored content carries public SHA-256 hashes.

import { MASTER_SKILL } from "./master-skill.js";
import {
  hasLoneSurrogates,
  hmacSha256Hex,
  sha256Hex,
  truncateUtf8,
  utf8ByteLength,
} from "./pure.js";
import { kvGet, kvSet, storageAvailable } from "./kv.js";
import { buildSkillsPrompt } from "./skills.js";
import { renderRuntimePolicy } from "./runtime-policy.js";

/* ── The protected constraints (immutable, non-editable, FINAL layer) ──────
 * GENERATED from lib/runtime-policy.js — the single authoritative runtime
 * policy source. Never hand-edit here; the drift test proves the identity. */
export const PROTECTED_CONSTRAINTS = renderRuntimePolicy();

/* ── The site-worker base prompt (moved from lib/agent.js — single source) ── */
export const WORKER_BASE_PROMPT =
  `You are the Chrome Agent Platform hub agent. You help the
user get things done on the web. You can read and write memory, call tools, and
delegate to per-site sub-agents. Be concise; prefer actions over prose.

For REPEATABLE work, write a script (create_script) and run it (run_script) or
schedule it (schedule_task with scriptId) instead of re-reasoning every time — a
script runs the same JavaScript without re-invoking the model (speed, security,
verifiability). A script is an ASYNC function body; it runs SANDBOXED with a
CONTROLLED api: await fetch(url, opts) (reads an http/https page, returns
{status, text}) and log(...). No DOM, no extension APIs, no network of its own.
return the result.`;

/* ── The versioned registry ─────────────────────────────────────────────── */
export const PROMPT_REGISTRY = [
  {
    id: "cap.hub.master",
    title: "Hub agent operating manual",
    // 1.1.0: the runtime-security statements moved OUT of the editable base
    // into lib/runtime-policy.js (the protected layer now carries them).
    version: "1.1.0",
    release: "0.2.74",
    protected: false,
    content: MASTER_SKILL,
  },
  {
    id: "cap.worker.base",
    title: "Site sub-agent base prompt",
    version: "1.0.0",
    release: "0.2.72",
    protected: false,
    content: WORKER_BASE_PROMPT,
  },
  {
    id: "cap.constraints.core",
    title: "Protected safety constraints (the runtime policy)",
    // 1.1.0: generated from lib/runtime-policy.js; now the FINAL layer (after
    // skills) and carries the secret/origin/permission rules.
    version: "1.1.0",
    release: "0.2.74",
    protected: true,
    content: PROTECTED_CONSTRAINTS,
  },
];

const CONSTRAINTS_ID = "cap.constraints.core";

/** A registry entry + its collision-resistant content hash (SHA-256/UTF-8). */
export function registryEntry(id, registry = PROMPT_REGISTRY) {
  const entry = registry.find((p) => p?.id === id) ?? null;
  if (!entry) return null;
  return { ...entry, hash: sha256Hex(String(entry.content ?? "")) };
}

/* ── Scopes ─────────────────────────────────────────────────────────────── */
const AGENT_SCOPE_RE = /^agent:[a-z0-9][a-z0-9-]{0,63}$/;

/** Normalize a scope selector. Returns null for anything unrecognized
 * (fail-closed — an unknown scope can never read/write an override). */
export function normalizeScope(scope) {
  const s = String(scope ?? "").trim();
  if (s === "hub" || s === "worker") return s;
  if (AGENT_SCOPE_RE.test(s)) return s;
  return null;
}

/** The built-in base prompt a scope composes over. */
export function baseIdForScope(scope) {
  const s = normalizeScope(scope);
  if (s === "worker") return "cap.worker.base";
  if (s === "hub" || s?.startsWith("agent:")) return "cap.hub.master";
  return null;
}

/** The override lookup chain for a scope (specific → general). A named agent
 * inherits the hub override when it has none of its own. */
export function scopeChain(scope) {
  const s = normalizeScope(scope);
  if (!s) return [];
  return s.startsWith("agent:") ? [s, "hub"] : [s];
}

/* ── Owner overrides (persisted, strict-schema, CAS) ────────────────────── */
export const PROMPT_OVERRIDES_KEY = "cap:promptOverrides";
export const PROMPT_QUARANTINE_KEY = "cap:promptOverrides:quarantine";
export const ATTESTATION_KEY_STORE = "cap:attestationKey";
/** The keys ONLY the prompt.* routes may write (the SW refuses them on the
 * generic kv.set/kv.remove routes — key-specific storage authority). */
export const PROMPT_OWNED_KEYS = [
  PROMPT_OVERRIDES_KEY,
  PROMPT_QUARANTINE_KEY,
  ATTESTATION_KEY_STORE,
];
export const OVERRIDE_MODES = ["append", "prepend", "replace"];
export const MAX_OVERRIDE_BYTES = 16_384; // 16 KiB of UTF-8
export const MAX_BASE_SNAPSHOT_BYTES = 32_768; // 32 KiB of UTF-8
const MAX_SCOPES = 64;
const MAX_QUARANTINE = 25;
const STORE_VERSION = 1;

// Serialize read-modify-writes of the overrides store (the same discipline as
// the named-agent registry — a concurrent set/reset must never lose a write).
let overridesMutex = Promise.resolve();
function withOverridesLock(fn) {
  const run = overridesMutex.then(fn, fn);
  overridesMutex = run.then(() => {}, () => {});
  return run;
}

/** Validate ONE persisted override record against the strict schema. Returns
 * { ok:true, record } (unknown fields STRIPPED) or { ok:false, reason }. */
function validateStoredRecord(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
    return { ok: false, reason: "not an object" };
  }
  if (!OVERRIDE_MODES.includes(rec.mode)) return { ok: false, reason: "mode" };
  if (typeof rec.text !== "string" || !rec.text.trim()) {
    return { ok: false, reason: "text" };
  }
  if (hasLoneSurrogates(rec.text)) {
    return { ok: false, reason: "malformed unicode" };
  }
  if (utf8ByteLength(rec.text) > MAX_OVERRIDE_BYTES) {
    return { ok: false, reason: "oversize text" };
  }
  if (typeof rec.baseId !== "string" || !rec.baseId) {
    return { ok: false, reason: "baseId" };
  }
  if (typeof rec.baseVersion !== "string" || !rec.baseVersion) {
    return { ok: false, reason: "baseVersion" };
  }
  if (typeof rec.baseHash !== "string" || !rec.baseHash) {
    return { ok: false, reason: "baseHash" };
  }
  if (
    typeof rec.baseSnapshot !== "string" ||
    hasLoneSurrogates(rec.baseSnapshot) ||
    utf8ByteLength(rec.baseSnapshot) > MAX_BASE_SNAPSHOT_BYTES
  ) {
    return { ok: false, reason: "baseSnapshot" };
  }
  if (typeof rec.updatedAt !== "number" || !Number.isFinite(rec.updatedAt)) {
    return { ok: false, reason: "updatedAt" };
  }
  return {
    ok: true,
    record: {
      mode: rec.mode,
      text: rec.text,
      baseId: rec.baseId,
      baseVersion: rec.baseVersion,
      baseHash: rec.baseHash,
      baseSnapshot: rec.baseSnapshot,
      updatedAt: rec.updatedAt,
    },
  };
}

/** Read + validate the persisted store. Returns
 * { revision, scopes, invalid: [{scope, reason, record}] }. Legacy shapes
 * migrate: a plain scope→record map (the pre-versioned format) reads as
 * revision 0; anything unrecognized reads as EMPTY + quarantined. */
async function readStore() {
  const s = await kvGet(PROMPT_OVERRIDES_KEY);
  const raw = s[PROMPT_OVERRIDES_KEY];
  const store = { revision: 0, scopes: {}, invalid: [] };
  if (raw == null) return store;
  let revision = 0;
  let scopesRaw = null;
  if (
    typeof raw === "object" && !Array.isArray(raw) && raw.version === STORE_VERSION &&
    typeof raw.scopes === "object" && raw.scopes !== null && !Array.isArray(raw.scopes)
  ) {
    revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
    scopesRaw = raw.scopes;
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    // Legacy: a plain scope→record map (pre-versioned). Migrate on next write.
    scopesRaw = raw;
  } else {
    store.invalid.push({ scope: "(store)", reason: "unrecognized store shape", record: null });
    return store;
  }
  store.revision = revision;
  for (const [scope, rec] of Object.entries(scopesRaw)) {
    if (!normalizeScope(scope)) {
      store.invalid.push({ scope, reason: "invalid scope key", record: null });
      continue;
    }
    const v = validateStoredRecord(rec);
    if (v.ok) store.scopes[scope] = v.record;
    else store.invalid.push({ scope, reason: v.reason, record: rec });
  }
  return store;
}

/** Persist the store (+ any quarantined records). LOCKED-callers only. */
async function writeStoreLocked(store) {
  const ops = {
    [PROMPT_OVERRIDES_KEY]: {
      version: STORE_VERSION,
      revision: store.revision,
      scopes: store.scopes,
    },
  };
  if (store.invalid?.length) {
    const q = await kvGet(PROMPT_QUARANTINE_KEY);
    const list = Array.isArray(q[PROMPT_QUARANTINE_KEY]) ? q[PROMPT_QUARANTINE_KEY] : [];
    for (const bad of store.invalid) {
      list.push({
        scope: String(bad.scope ?? "?"),
        reason: String(bad.reason ?? "invalid"),
        at: Date.now(),
        // Keep the offending record for owner inspection/recovery, bounded.
        record: bad.record == null ? null : JSON.parse(JSON.stringify(bad.record)),
      });
    }
    ops[PROMPT_QUARANTINE_KEY] = list.slice(-MAX_QUARANTINE);
    store.invalid = [];
  }
  await kvSet(ops);
}

/** Read the store and (when invalid records were found) QUARANTINE them
 * durably — a malformed record is never composed AND never silently dropped:
 * it is moved to the quarantine key (visible + recoverable) exactly once. */
async function readStoreQuarantining() {
  return await withOverridesLock(async () => {
    const store = await readStore();
    if (store.invalid.length) await writeStoreLocked(store);
    return store;
  });
}

/** Validate + normalize an override INPUT ({mode, text}). FAIL-CLOSED: any
 * deviation is an error, never a silent coercion. Bounds are UTF-8 BYTES;
 * malformed Unicode (lone surrogates) is rejected outright. */
export function normalizeOverrideInput(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "an override needs a mode and text" };
  }
  const mode = String(input.mode ?? "").trim();
  if (!OVERRIDE_MODES.includes(mode)) {
    return {
      ok: false,
      error: `mode must be one of ${OVERRIDE_MODES.join("/")}`,
    };
  }
  if (typeof input.text !== "string") {
    return { ok: false, error: "custom instructions must be text" };
  }
  if (hasLoneSurrogates(input.text)) {
    return {
      ok: false,
      error: "custom instructions contain malformed Unicode (a lone surrogate) — remove it and retry",
    };
  }
  const text = input.text.trim();
  if (!text) {
    return {
      ok: false,
      error: "custom instructions are empty — use Reset to default instead",
    };
  }
  const bytes = utf8ByteLength(text);
  if (bytes > MAX_OVERRIDE_BYTES) {
    return {
      ok: false,
      error: `custom instructions are too long (max ${MAX_OVERRIDE_BYTES} UTF-8 bytes; this is ${bytes})`,
    };
  }
  return { ok: true, value: { mode, text } };
}

/** The effective override for a scope (walks the inheritance chain). Returns
 * { override, overrideScope, inherited } — override null when none applies. */
export async function getPromptOverride(scope, { registry } = {}) {
  const s = normalizeScope(scope);
  if (!s) return { override: null, overrideScope: null, inherited: false };
  const store = await readStoreQuarantining();
  for (const candidate of scopeChain(s)) {
    const rec = store.scopes[candidate];
    if (rec) {
      return {
        override: rec,
        overrideScope: candidate,
        inherited: candidate !== s,
      };
    }
  }
  return { override: null, overrideScope: null, inherited: false };
}

/** Create/update the override for a scope, stamped with the CURRENT base
 * version/hash/snapshot. Options:
 *   expectedRevision — CAS guard: when non-null, the write is REJECTED with
 *     a conflict error unless the store's current revision matches (two
 *     Settings windows can never silently last-write-wins).
 *   agentExists — async (slug) => boolean: agent:<slug> scopes are rejected
 *     when the named agent does not exist (no orphan overrides).
 * Returns { ok, override, revision } or { ok:false, error, conflict? }. */
export async function setPromptOverride(scope, input, { registry, expectedRevision = null, agentExists = null } = {}) {
  const s = normalizeScope(scope);
  if (!s) return { ok: false, error: "unknown prompt scope" };
  const base = registryEntry(baseIdForScope(s), registry);
  if (!base) return { ok: false, error: "unknown base prompt for scope" };
  const clean = normalizeOverrideInput(input);
  if (!clean.ok) return clean;
  if (s.startsWith("agent:") && typeof agentExists === "function") {
    const exists = await agentExists(s.slice("agent:".length)).catch(() => false);
    if (!exists) {
      return { ok: false, error: `no named agent ${s.slice("agent:".length)} — create it first` };
    }
  }
  return await withOverridesLock(async () => {
    const store = await readStore();
    if (expectedRevision != null && expectedRevision !== store.revision) {
      return {
        ok: false,
        conflict: true,
        revision: store.revision,
        error: "the customization changed elsewhere (another window?) — reloaded state required; retry the save",
      };
    }
    if (!store.scopes[s] && Object.keys(store.scopes).length >= MAX_SCOPES) {
      return { ok: false, error: `too many prompt overrides (${MAX_SCOPES})` };
    }
    const override = {
      mode: clean.value.mode,
      text: clean.value.text,
      baseId: base.id,
      baseVersion: base.version,
      baseHash: base.hash,
      // The base text at save time — the old-vs-new diff source when a later
      // release changes the built-in. Bounded in UTF-8 BYTES, never splitting
      // a code point, so it can't bloat storage or store malformed Unicode.
      baseSnapshot: truncateUtf8(String(base.content ?? ""), MAX_BASE_SNAPSHOT_BYTES),
      updatedAt: Date.now(),
    };
    store.scopes[s] = override;
    store.revision += 1;
    await writeStoreLocked(store);
    return { ok: true, override, revision: store.revision };
  });
}

/** Delete a scope's override (reset-to-default). Idempotent.
 * `target: "effective"` walks the inheritance chain and deletes the override
 * that ACTUALLY applies (the inherited hub record when an agent has none of
 * its own) — the release-update banner's Reset uses this so it never no-ops
 * against an inherited conflict. */
export async function clearPromptOverride(scope, { target = "exact" } = {}) {
  const s = normalizeScope(scope);
  if (!s) return { ok: false, error: "unknown prompt scope" };
  return await withOverridesLock(async () => {
    const store = await readStore();
    if (target === "effective") {
      for (const candidate of scopeChain(s)) {
        if (store.scopes[candidate]) {
          delete store.scopes[candidate];
          break;
        }
      }
    } else {
      delete store.scopes[s];
    }
    store.revision += 1;
    await writeStoreLocked(store);
    return { ok: true, revision: store.revision };
  });
}

/** "Keep my customization" after a built-in update: re-stamp the EFFECTIVE
 * override (the inherited hub record when this scope has none of its own)
 * onto the CURRENT base (version/hash/snapshot) without touching mode/text. */
export async function restampPromptOverride(scope, { registry } = {}) {
  const s = normalizeScope(scope);
  if (!s) return { ok: false, error: "unknown prompt scope" };
  const base = registryEntry(baseIdForScope(s), registry);
  if (!base) return { ok: false, error: "unknown base prompt for scope" };
  return await withOverridesLock(async () => {
    const store = await readStore();
    let target = null;
    for (const candidate of scopeChain(s)) {
      if (store.scopes[candidate]) {
        target = candidate;
        break;
      }
    }
    if (!target) return { ok: false, error: "no customization to keep" };
    store.scopes[target] = {
      ...store.scopes[target],
      baseVersion: base.version,
      baseHash: base.hash,
      baseSnapshot: truncateUtf8(String(base.content ?? ""), MAX_BASE_SNAPSHOT_BYTES),
      updatedAt: Date.now(),
    };
    store.revision += 1;
    await writeStoreLocked(store);
    return { ok: true, override: store.scopes[target], overrideScope: target, revision: store.revision };
  });
}

/** Delete a named agent's override when the agent is deleted (lifecycle
 * cleanup — a deleted agent must never leave an orphan override that a
 * later same-slug agent would silently inherit). Called by named-agents.js. */
export async function deleteAgentPromptOverride(slug) {
  const s = normalizeScope(`agent:${String(slug ?? "")}`);
  if (!s) return { ok: false, error: "invalid agent slug" };
  return await clearPromptOverride(s);
}

/* ── Composition (the single authority) ─────────────────────────────────── */

/**
 * Compose the EFFECTIVE system prompt for a scope. Pure: every input is passed
 * in, so the run path (the service worker), the Settings preview, and the tests
 * all compose identically.
 *
 *   baseId   — a registry id (see baseIdForScope)
 *   override — a stored override record (or null)
 *   role     — a named agent's role text (agent scopes; "" otherwise)
 *   skills   — installed skills for the run
 *   registry — the built-in registry (injectable for upgrade-simulation tests)
 *
 * Returns { text, hash, base, builtinChanged, layers }. `layers` carries every
 * layer's text + provenance so the UI can render a labelled preview. The
 * protected constraints layer is ALWAYS present and ALWAYS LAST — after every
 * editable layer AND the skills layer — so no owner text, role, or
 * site-origin skill can override it with later instructions.
 */
export function composeSystemPrompt({
  baseId,
  override = null,
  role = "",
  skills = [],
  registry = PROMPT_REGISTRY,
}) {
  const base = registryEntry(baseId, registry);
  const constraints = registryEntry(CONSTRAINTS_ID, registry);
  const layers = [];

  const mode = override && OVERRIDE_MODES.includes(override.mode)
    ? override.mode
    : null;
  const customText = mode ? String(override.text ?? "").trim() : "";
  const ownerLayer = (position) => ({
    id: `owner-${position}`,
    label: "Your custom instructions",
    source: "owner",
    editable: true,
    protected: false,
    text: `## Owner custom instructions\n${customText}`,
  });

  // 1. owner-prepend
  if (mode === "prepend" && customText) layers.push(ownerLayer("prepend"));

  // 2. product-base (omitted under replace — recorded so the UI can show it)
  if (base && mode === "replace" && customText) {
    layers.push({
      id: base.id,
      label: base.title,
      source: "built-in",
      version: base.version,
      release: base.release,
      hash: base.hash,
      editable: true,
      protected: false,
      omitted: true,
      text: "",
    });
  } else if (base) {
    layers.push({
      id: base.id,
      label: base.title,
      source: "built-in",
      version: base.version,
      release: base.release,
      hash: base.hash,
      editable: true,
      protected: false,
      text: String(base.content ?? ""),
    });
  }

  // 3. owner-append / owner-replace (the replace text sits in the base slot)
  if ((mode === "append" || mode === "replace") && customText) {
    layers.push(ownerLayer(mode));
  }

  // 4. agent-role (named agents)
  const roleText = String(role ?? "").trim();
  if (roleText) {
    layers.push({
      id: "agent-role",
      label: "Agent role",
      source: "agent",
      editable: false,
      protected: false,
      text: `## Agent role\n${roleText}`,
    });
  }

  // 5. skills (the per-run layer — BEFORE the protected constraints, so a
  // mutable/site-origin skill can never override the runtime policy).
  const skillsText = buildSkillsPrompt(skills).trim();
  if (skillsText) {
    layers.push({
      id: "skills",
      label: "Installed skills",
      source: "skills",
      editable: false,
      protected: false,
      text: skillsText,
    });
  }

  // 6. protected constraints — ALWAYS present, never replaceable, ALWAYS LAST.
  if (constraints) {
    layers.push({
      id: constraints.id,
      label: constraints.title,
      source: "protected",
      version: constraints.version,
      release: constraints.release,
      hash: constraints.hash,
      editable: false,
      protected: true,
      text: String(constraints.content ?? ""),
    });
  }

  const text = layers.filter((l) => !l.omitted).map((l) => l.text).join("\n\n");
  return {
    text,
    hash: sha256Hex(text),
    base: base
      ? { id: base.id, title: base.title, version: base.version, release: base.release, hash: base.hash }
      : null,
    builtinChanged: Boolean(
      override && base && override.baseHash && override.baseHash !== base.hash,
    ),
    layers,
  };
}

/** The baseline (no-override) prompt for a base id — lib/agent.js's default. */
export function baselineSystemPrompt(baseId, registry = PROMPT_REGISTRY) {
  return composeSystemPrompt({ baseId, registry }).text;
}

/**
 * Append the per-run skills layer to an ALREADY-COMPOSED system prompt while
 * preserving the protected-last invariant (lib/agent.js uses this when a
 * caller supplies skills outside the composer): the skills text is inserted
 * BEFORE the trailing protected constraints block, never after it.
 */
export function appendSkillsLayer(systemText, skills, registry = PROMPT_REGISTRY) {
  const sys = String(systemText ?? "");
  const skillsText = buildSkillsPrompt(skills).trim();
  if (!skillsText) return sys;
  const constraints = registryEntry(CONSTRAINTS_ID, registry);
  const protectedText = constraints ? String(constraints.content ?? "") : "";
  if (protectedText && sys.endsWith(protectedText)) {
    const head = sys.slice(0, sys.length - protectedText.length).replace(/\s+$/, "");
    return `${head}\n\n${skillsText}\n\n${protectedText}`;
  }
  // A foreign system prompt (not composed here): no protected block to
  // protect — append the skills at the end.
  return sys ? `${sys}\n\n${skillsText}` : skillsText;
}

/**
 * Resolve the effective prompt for a scope from persisted state (the run
 * path's entry point). `role`/`skills` thread the per-run layers.
 * Fail-closed: an unknown scope composes the protected constraints ONLY —
 * never an unprotected empty prompt.
 */
export async function resolveSystemPrompt(scope, { role = "", skills = [], registry } = {}) {
  const s = normalizeScope(scope);
  if (!s) {
    return composeSystemPrompt({ baseId: null, registry });
  }
  const { override } = await getPromptOverride(s, { registry });
  return composeSystemPrompt({
    baseId: baseIdForScope(s),
    override,
    role,
    skills,
    registry,
  });
}

/* ── The Settings describe payload (the preview of the composition) ──────── */

/**
 * Everything the Advanced Settings UI needs for one scope: the built-in base
 * (read-only viewer), the stored override (editor), the effective composed
 * prompt with labelled layers (preview), the built-in-changed state, the
 * store revision (CAS on save), and the durability of the storage backend.
 */
export async function describePrompt(scope, { role = "", skills = [], registry } = {}) {
  const s = normalizeScope(scope);
  if (!s) return { ok: false, error: "unknown prompt scope" };
  const base = registryEntry(baseIdForScope(s), registry);
  const store = await readStoreQuarantining();
  let override = null, overrideScope = null, inherited = false;
  for (const candidate of scopeChain(s)) {
    if (store.scopes[candidate]) {
      override = store.scopes[candidate];
      overrideScope = candidate;
      inherited = candidate !== s;
      break;
    }
  }
  const composed = composeSystemPrompt({
    baseId: baseIdForScope(s),
    override,
    role,
    skills,
    registry,
  });
  const changed = composed.builtinChanged;
  // Is this preview the FULL run composition? The worker scope's real runs
  // append the ORIGIN's skills at run time; a named agent's runs carry its
  // role (threaded by the SW). The preview is context-aware about what it
  // does NOT include rather than claiming blind parity.
  const contextNote = s === "worker" && !(skills?.length)
    ? "Each site sub-agent's run also appends THAT origin's skills at run time. This preview covers the scope composition (base + customization + runtime policy); a specific run's exact sent prompt is proven by its run-bound attestation."
    : null;
  return {
    ok: true,
    scope: s,
    base: base
      ? {
        id: base.id,
        title: base.title,
        version: base.version,
        release: base.release,
        hash: base.hash,
        content: base.content,
      }
      : null,
    override: override ?? null,
    overrideScope,
    inherited,
    builtinChanged: changed,
    // The old-vs-new line diff (only when the built-in changed under an
    // existing override) — the release-update UI's "View changes".
    diff: changed && override
      ? diffLines(override.baseSnapshot ?? "", base?.content ?? "")
      : null,
    effective: { text: composed.text, hash: composed.hash, layers: composed.layers },
    limits: { maxOverrideBytes: MAX_OVERRIDE_BYTES },
    // The store revision the UI must echo back on save (the CAS guard).
    revision: store.revision,
    // Is the persistence backend durable? When the optional `storage`
    // permission is absent the override is SESSION-ONLY — the UI must say so
    // rather than claim "saved".
    durable: await storageAvailable().catch(() => false),
    context: { includesRunSkills: Boolean(skills?.length), note: contextNote },
  };
}

/* ── Attestation (keyed receipts — parity proof without a public fingerprint) */

let cachedAttestationKey = null;
let attestationKeyInFlight = null;

/** The per-install attestation key (32 random bytes, generated once, stored
 * via kv, NEVER exposed by any message route). Receipts keyed with it prove
 * two platform-computed values are identical without publishing a stable
 * content fingerprint that could be dictionary-tested against guessed owner
 * text. Concurrent first calls share ONE generation (the in-flight promise),
 * so two callers can never cache different keys. */
export function attestationKeyBytes() {
  if (cachedAttestationKey) return Promise.resolve(cachedAttestationKey);
  if (!attestationKeyInFlight) {
    attestationKeyInFlight = (async () => {
      const s = await kvGet(ATTESTATION_KEY_STORE);
      const raw = s[ATTESTATION_KEY_STORE];
      if (
        Array.isArray(raw) && raw.length === 32 &&
        raw.every((n) => Number.isInteger(n) && n >= 0 && n < 256)
      ) {
        cachedAttestationKey = new Uint8Array(raw);
        return cachedAttestationKey;
      }
      const key = new Uint8Array(32);
      globalThis.crypto.getRandomValues(key);
      await kvSet({ [ATTESTATION_KEY_STORE]: [...key] });
      cachedAttestationKey = key;
      return key;
    })().finally(() => {
      attestationKeyInFlight = null;
    });
  }
  return attestationKeyInFlight;
}

/** Test hook: forget the cached attestation key (unit tests). */
export function __resetAttestationKeyForTest() {
  cachedAttestationKey = null;
}

/**
 * A content-free attestation of the effective prompt: a KEYED receipt
 * (HMAC-SHA-256) of the composed text plus per-layer receipts and UTF-8 byte
 * counts. A caller can prove the Settings preview and the actual sent prompt
 * are identical WITHOUT the prompt text ever crossing the wire — and the
 * receipt is not a public stable fingerprint of (possibly low-entropy) owner
 * text. Also journaled (in summary form) at run start.
 */
export async function attestComposition(composed, scope = "hub", { key } = {}) {
  const k = key ?? await attestationKeyBytes();
  return {
    scope,
    receipt: hmacSha256Hex(k, composed.text ?? ""),
    // The keyed receipt of the composition's public digest — the comparison
    // basis for a run-bound attestation's composedReceipt (which is computed
    // over the digest the agent core captured, not the text).
    digestReceipt: hmacSha256Hex(k, composed.hash ?? sha256Hex(composed.text ?? "")),
    bytes: utf8ByteLength(composed.text ?? ""),
    layers: (composed.layers ?? []).map((l) => ({
      id: l.id,
      label: l.label,
      source: l.source,
      version: l.version ?? null,
      receipt: hmacSha256Hex(k, l.text ?? ""),
      bytes: utf8ByteLength(l.text ?? ""),
      protected: Boolean(l.protected),
      omitted: Boolean(l.omitted),
    })),
  };
}

/* ── Line diff (old-vs-new base, for the release-update UI) ─────────────── */

const DIFF_MAX_LINES = 600;

/** A bounded line diff (LCS) between two texts. Returns rows of
 * { type: "same"|"add"|"del", text }. Over the bound, falls back to a coarse
 * note (never throws, never hangs on a huge snapshot). */
export function diffLines(oldText, newText) {
  const a = String(oldText ?? "").split("\n");
  const b = String(newText ?? "").split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return [{
      type: "note",
      text: "(the prompt changed but is too large to diff line-by-line)",
    }];
  }
  // LCS over lines (bounded above, so the O(n·m) table is ≤ 360k cells).
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i] });
      i++;
    } else {
      rows.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ type: "del", text: a[i++] });
  while (j < m) rows.push({ type: "add", text: b[j++] });
  return rows;
}
