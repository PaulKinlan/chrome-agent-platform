// lib/system-prompts.js — the layered, versioned system-prompt architecture.
//
// THE single composition authority for every system prompt the platform sends
// (docs/SYSTEM-PROMPTS.md). Every run type — hub tasks, named agents,
// background/scheduled agents, system-hook (scoped) runs, and per-site worker
// delegations — resolves its system prompt through composeSystemPrompt() here,
// and the Settings → Advanced preview describes the SAME composition, so the
// previewed prompt is byte-identical to the prompt the model receives.
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
//   5. protected       — the immutable safety constraints (docs/CONSTITUTION.md).
//                        ALWAYS present, NEVER editable/replaceable by owner
//                        customization, applied to every scope.
//   6. skills          — the per-run installed/included skills, appended by the
//                        agent core (lib/agent.js) via buildSkillsPrompt().
//
// ## The registry (versioned built-ins)
//
// Every built-in prompt is a registry entry with a STABLE id, a semantic
// version, the extension release it last changed in, and a deterministic
// content hash (fnv1a64 — the repo's existing hash primitive). There are no
// scattered duplicate prompt strings: the hub manual lives in
// lib/master-skill.js, the worker base + the protected constraints live here,
// and the registry references those single sources.
//
// ## Owner customization (persisted, migration-safe)
//
// Overrides live in `cap:promptOverrides` (chrome.storage via lib/kv.js),
// keyed by scope ("hub" | "worker" | "agent:<slug>"). A record stores the mode
// (append/prepend/replace), the text, AND the base version/hash/snapshot it
// was written against:
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
//
// Bounds (Constitution §4): override text ≤ 16 000 chars; the stored base
// snapshot ≤ 32 000 chars; the registry map ≤ 64 scopes. Validation is
// FAIL-CLOSED: an unknown scope, a bad mode, or an oversize/empty text is
// rejected with an error, never silently coerced.
//
// Secrets: the override is owner-authored free text. It is never logged and
// never sent anywhere except as part of the system prompt to the configured
// provider; the UI warns against pasting credentials. Only product-authored
// prompt content is ever shown — there is no hidden chain-of-thought here.

import { MASTER_SKILL } from "./master-skill.js";
import { fnv1a64 } from "./pure.js";
import { kvGet, kvSet } from "./kv.js";
import { buildSkillsPrompt } from "./skills.js";

/* ── The protected constraints (immutable, non-editable) ──────────────────
 * Extracted from lib/master-skill.js §3 so they compose OUTSIDE the editable
 * product prompt. The text is byte-identical to the old §3 so existing users
 * with no override see an unchanged hub prompt. */
export const PROTECTED_CONSTRAINTS = `## 3. Safety constraints (from the constitution)
- Never exfiltrate cross-origin data: one origin's memory/tools/results never
  flow to another origin. A site agent's output is scoped to its own origin.
- Respect grants: a permission or enrollment you don't hold means STOP, not
  workaround.
- Fail closed: if a fence, guard, or generation check fails, the operation
  aborts — report the honest failure, never fabricate a result.
- Never write to reserved authority keys (enrollment, approvals, toolDirectory,
  assets index) through memory_set — use the management tools instead.
- Be concise + correct. Prefer a real action over prose. When a tool returns an
  error, report it plainly and propose the next step.
- These constraints are platform invariants: owner customization can ADD
  instructions but can never relax, replace, or remove them.`;

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
    version: "1.0.0",
    release: "0.2.72",
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
    title: "Protected safety constraints",
    version: "1.0.0",
    release: "0.2.72",
    protected: true,
    content: PROTECTED_CONSTRAINTS,
  },
];

const CONSTRAINTS_ID = "cap.constraints.core";

/** A registry entry + its deterministic content hash. */
export function registryEntry(id, registry = PROMPT_REGISTRY) {
  const entry = registry.find((p) => p?.id === id) ?? null;
  if (!entry) return null;
  return { ...entry, hash: fnv1a64(String(entry.content ?? "")) };
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

/* ── Owner overrides (persisted) ────────────────────────────────────────── */
export const PROMPT_OVERRIDES_KEY = "cap:promptOverrides";
export const OVERRIDE_MODES = ["append", "prepend", "replace"];
export const MAX_OVERRIDE_CHARS = 16_000;
export const MAX_BASE_SNAPSHOT_CHARS = 32_000;
const MAX_SCOPES = 64;

// Serialize read-modify-writes of the overrides map (the same discipline as
// the named-agent registry — a concurrent set/reset must never lose a write).
let overridesMutex = Promise.resolve();
function withOverridesLock(fn) {
  const run = overridesMutex.then(fn, fn);
  overridesMutex = run.then(() => {}, () => {});
  return run;
}

async function readOverrides() {
  const s = await kvGet(PROMPT_OVERRIDES_KEY);
  const map = s[PROMPT_OVERRIDES_KEY];
  return map && typeof map === "object" ? map : {};
}

/** Validate + normalize an override INPUT ({mode, text}). FAIL-CLOSED: any
 * deviation is an error, never a silent coercion. */
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
  const text = input.text.trim();
  if (!text) {
    return {
      ok: false,
      error: "custom instructions are empty — use Reset to default instead",
    };
  }
  if (text.length > MAX_OVERRIDE_CHARS) {
    return {
      ok: false,
      error: `custom instructions are too long (max ${MAX_OVERRIDE_CHARS} chars)`,
    };
  }
  return { ok: true, value: { mode, text } };
}

/** The effective override for a scope (walks the inheritance chain). Returns
 * { override, overrideScope, inherited } — override null when none applies. */
export async function getPromptOverride(scope, { registry } = {}) {
  const s = normalizeScope(scope);
  if (!s) return { override: null, overrideScope: null, inherited: false };
  const map = await readOverrides();
  for (const candidate of scopeChain(s)) {
    const rec = map[candidate];
    if (rec && typeof rec === "object" && typeof rec.text === "string") {
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
 * version/hash/snapshot. Returns { ok, override } or { ok:false, error }. */
export async function setPromptOverride(scope, input, { registry } = {}) {
  const s = normalizeScope(scope);
  if (!s) return { ok: false, error: "unknown prompt scope" };
  const base = registryEntry(baseIdForScope(s), registry);
  if (!base) return { ok: false, error: "unknown base prompt for scope" };
  const clean = normalizeOverrideInput(input);
  if (!clean.ok) return clean;
  return await withOverridesLock(async () => {
    const map = await readOverrides();
    if (!map[s] && Object.keys(map).length >= MAX_SCOPES) {
      return { ok: false, error: `too many prompt overrides (${MAX_SCOPES})` };
    }
    const override = {
      mode: clean.value.mode,
      text: clean.value.text,
      baseId: base.id,
      baseVersion: base.version,
      baseHash: base.hash,
      // The base text at save time — the old-vs-new diff source when a later
      // release changes the built-in. Bounded so it can't bloat storage.
      baseSnapshot: String(base.content ?? "").slice(0, MAX_BASE_SNAPSHOT_CHARS),
      updatedAt: Date.now(),
    };
    map[s] = override;
    await kvSet({ [PROMPT_OVERRIDES_KEY]: map });
    return { ok: true, override };
  });
}

/** Delete a scope's override (reset-to-default). Idempotent. */
export async function clearPromptOverride(scope) {
  const s = normalizeScope(scope);
  if (!s) return { ok: false, error: "unknown prompt scope" };
  return await withOverridesLock(async () => {
    const map = await readOverrides();
    delete map[s];
    await kvSet({ [PROMPT_OVERRIDES_KEY]: map });
    return { ok: true };
  });
}

/** "Keep my customization" after a built-in update: re-stamp the override onto
 * the CURRENT base (version/hash/snapshot) without touching the mode/text. */
export async function restampPromptOverride(scope, { registry } = {}) {
  const s = normalizeScope(scope);
  if (!s) return { ok: false, error: "unknown prompt scope" };
  const base = registryEntry(baseIdForScope(s), registry);
  if (!base) return { ok: false, error: "unknown base prompt for scope" };
  return await withOverridesLock(async () => {
    const map = await readOverrides();
    const rec = map[s];
    if (!rec) return { ok: false, error: "no customization to keep" };
    map[s] = {
      ...rec,
      baseVersion: base.version,
      baseHash: base.hash,
      baseSnapshot: String(base.content ?? "").slice(0, MAX_BASE_SNAPSHOT_CHARS),
      updatedAt: Date.now(),
    };
    await kvSet({ [PROMPT_OVERRIDES_KEY]: map });
    return { ok: true, override: map[s] };
  });
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
 *   skills   — installed skills for the run (appended as the final layer)
 *   registry — the built-in registry (injectable for upgrade-simulation tests)
 *
 * Returns { text, hash, base, builtinChanged, layers }. `layers` carries every
 * layer's text + provenance so the UI can render a labelled preview. The
 * protected constraints layer is ALWAYS present and ALWAYS after the editable
 * layers — owner text can never replace it.
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

  // 5. protected constraints — ALWAYS present, never replaceable.
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

  // 6. skills (the per-run layer — the agent core appends the same block)
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

  const text = layers.filter((l) => !l.omitted).map((l) => l.text).join("\n\n");
  return {
    text,
    hash: fnv1a64(text),
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

/* ── The Settings describe payload (preview == sent) ────────────────────── */

/**
 * Everything the Advanced Settings UI needs for one scope: the built-in base
 * (read-only viewer), the stored override (editor), the effective composed
 * prompt with labelled layers (preview), and the built-in-changed state.
 */
export async function describePrompt(scope, { role = "", skills = [], registry } = {}) {
  const s = normalizeScope(scope);
  if (!s) return { ok: false, error: "unknown prompt scope" };
  const base = registryEntry(baseIdForScope(s), registry);
  const { override, overrideScope, inherited } = await getPromptOverride(s, { registry });
  const composed = composeSystemPrompt({
    baseId: baseIdForScope(s),
    override,
    role,
    skills,
    registry,
  });
  const changed = composed.builtinChanged;
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
    limits: { maxOverrideChars: MAX_OVERRIDE_CHARS },
  };
}

/* ── Attestation (hash-only — proves parity without leaking content) ─────── */

/**
 * A content-free attestation of the effective prompt: the composed hash plus
 * per-layer hashes/bytes. Debug/test path — a caller can prove the Settings
 * preview and the actual sent prompt are identical WITHOUT the prompt text
 * ever crossing the wire. Also journaled (in summary form) at run start.
 */
export function attestComposition(composed, scope = "hub") {
  return {
    scope,
    hash: composed.hash,
    bytes: composed.text.length,
    layers: composed.layers.map((l) => ({
      id: l.id,
      label: l.label,
      source: l.source,
      version: l.version ?? null,
      hash: fnv1a64(l.text ?? ""),
      bytes: String(l.text ?? "").length,
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
