// lib/named-agents.js — the named-agent layer (the persistent teammates).
//
// A named agent is a persistent, NAMED identity (the docs/AGENT-MODEL.md model):
//   - a name + an avatar,
//   - a role ("my PR reviewer", "my reader"),
//   - its OWN OPFS sandbox (memory + run history + skills + agents.md),
//     keyed separately from the site-origin stores (memory/agents/<slug>/*),
//   - callable/delegatable (/agent:name or "ask <name> to <task>").
//
// The AUTHORITATIVE registry is `cap:namedAgents` in chrome.storage (like
// `cap:enrollment`): it is NOT writable by the model's `memory_set` (a forged
// registry must never create/impersonate an agent). Every mutation goes through
// the registry lock so concurrent create/update/delete read-modify-writes are
// serialized (the same discipline as the enrollment registry).

import { kvGet, kvSet } from "./kv.js";
import { GEMINI_IMAGE_MODEL } from "./model-catalog.js";
import { namedAgentMemory, purgeStoreDir } from "./memory.js";
import { deleteAgentPromptOverride } from "./system-prompts.js";
import { normalizeCanDelegateTo } from "./agent-delegation.js";
import {
  normalizeMcpServerList,
  preserveExistingMcpTokens,
  redactMcpServerList,
} from "./mcp-config.js";

const AGENTS_KEY = "cap:namedAgents";

// Bounds (Constitution §4 + §2): names/roles are short, and an agent registry
// is bounded so a hostile prompt cannot grow it without limit.
// Bounds family (CAP-FB-20260824-AGENT-ROLE-TRUNCATION-01, owner direction):
// generous enough that a real owner never hits them, still FINITE so a hostile
// prompt can't grow the chrome.storage-backed registry unboundedly
// (Constitution §4). Over-cap ROLE/NAME input is REJECTED with a clear error
// — never silently clipped (the 200-char silent slice destroyed detailed
// roles, the P0 this family raise fixes).
const MAX_AGENTS = 200;
const MAX_NAME_LEN = 120;
export const MAX_ROLE_LEN = 32000;
export const MAX_SKILLS = 128;
const MAX_CORE_ASSETS = 8;
const MAX_CORE_ASSET_BYTES = 131072; // 128 KiB per core asset
const MAX_PROFILE_GRANTS = 8;
export const MAX_PROFILE_GRANTS_INPUT = 32;

export const VALID_PROFILE_GRANTS = new Set([
  "profile:basic",
  "profile:work_history",
  "profile:education",
  "profile:disclosures",
  "profile:*",
  "*",
  "basic",
  "work_history",
  "education",
  "disclosures",
]);

/** Validate, normalize, and bound an agent's explicit profile grants. Fails closed on malformed input. */
export function validateProfileGrants(grants) {
  if (!Array.isArray(grants)) {
    return { ok: false, error: "profileGrants must be an array of grant strings" };
  }
  if (grants.length > MAX_PROFILE_GRANTS_INPUT) {
    return {
      ok: false,
      error: `profileGrants exceeds maximum allowed length (${grants.length} > ${MAX_PROFILE_GRANTS_INPUT})`,
    };
  }
  const out = [];
  for (let i = 0; i < grants.length; i++) {
    const g = grants[i];
    if (typeof g !== "string") {
      return { ok: false, error: `profileGrants entry at index ${i} must be a string` };
    }
    const clean = g.trim().toLowerCase();
    if (!clean || !VALID_PROFILE_GRANTS.has(clean)) {
      return { ok: false, error: `invalid profile grant: "${g}"` };
    }
    const canonical = clean.startsWith("profile:") || clean === "*"
      ? clean
      : `profile:${clean}`;
    if (!out.includes(canonical)) {
      out.push(canonical);
      if (out.length >= MAX_PROFILE_GRANTS) break;
    }
  }
  return { ok: true, grants: out };
}

/** Normalize profile grants safely (fallback helper). */
export function normalizeProfileGrants(grants) {
  const res = validateProfileGrants(grants);
  return res.ok ? res.grants : [];
}

/** Normalize the core assets (files the owner attaches as the agent's core
 * context — a text file's content, or an image's data URL). Bounded so a
 * hostile/huge attachment can't bloat the chrome.storage registry. */
export function normalizeCoreAssets(assets) {
  if (!Array.isArray(assets)) return [];
  const out = [];
  for (const a of assets) {
    if (!a || typeof a !== "object") continue;
    const name = String(a.name ?? "").slice(0, 96);
    const type = String(a.type ?? "text/plain").slice(0, 64);
    let content = a.content == null ? "" : String(a.content);
    if (content.length > MAX_CORE_ASSET_BYTES) content = content.slice(0, MAX_CORE_ASSET_BYTES) + "…";
    if (!name && !content) continue;
    out.push({ name, type, content });
    if (out.length >= MAX_CORE_ASSETS) break;
  }
  return out;
}

let agentsMutex = Promise.resolve();
// Exported (as withNamedAgentsLock) so the service worker's prompt.set route
// can hold the agent registry across a prompt-override write for an
// agent:<slug> scope — the SAME lock order deleteNamedAgent uses (agents →
// prompt-overrides), so an agent deletion can never interleave between the
// override's existence check and its write (no orphan/ABA override).
function withAgentsLock(fn) {
  const run = agentsMutex.then(fn, fn);
  agentsMutex = run.then(() => {}, () => {});
  return run;
}
export { withAgentsLock as withNamedAgentsLock };

/** Normalize an agent id to a kebab-case slug. */
export function slugifyAgentId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// A per-agent provider override is a COMPLETE provider-specific config
// (provider id + baseURL + apiKey + model). It is self-contained so it can
// never mix one provider's endpoint with another's credential (the wider-goal
// review's credential-disclosure finding). The override is null (inherit the
// global) when absent.
const PROVIDER_IDS = new Set([
  "demo", "openai", "openai-compatible", "anthropic", "gemini", "deepseek", "ollama", "prompt-api",
]);

/** Validate + normalize a per-agent provider override. Returns null when the
 * value is null/empty (inherit the global), or a clean complete config. */
export function normalizeAgentProvider(value) {
  if (value == null) return null;
  if (typeof value !== "object") return null;
  const provider = String(value.provider ?? "").trim();
  if (!provider || !PROVIDER_IDS.has(provider)) return null;
  return {
    provider,
    baseURL: String(value.baseURL ?? "").slice(0, 512),
    apiKey: String(value.apiKey ?? "").slice(0, 512),
    model: String(value.model ?? "").slice(0, 128),
  };
}

/** Strip the apiKey from a provider override before it crosses into any
 * non-Settings surface (the NTP sidebar, the directory, the model's tool
 * results, the journal). Credentials never leave the Settings → resolution
 * path. */
export function redactAgentProvider(provider) {
  if (!provider || typeof provider !== "object") return null;
  return {
    provider: provider.provider,
    baseURL: provider.baseURL ?? "",
    model: provider.model ?? "",
    // apiKey deliberately omitted — hasApiKey carries ONLY the presence bit
    // (the UI shows "(kept — blank keeps it)" + the Clear key control without
    // ever seeing the key).
    hasApiKey: Boolean(provider.apiKey),
  };
}

// A per-agent MCP server list is stored EXACTLY like the provider override: a
// self-contained, validated list on the agent record. It INHERITS the global
// set (see mcp-config.js resolveEffectiveMcpServers) and may add its own or
// disable an inherited one. Credentials (the auth token) are handled like the
// provider key: stored on the record, REDACTED before any list/get crosses out,
// and read back in full ONLY by the SW resolution path (getNamedAgentMcpServers).

/** Redact an agent record for any non-Settings surface: the provider override
 * AND the MCP server list drop their credentials (only presence bits survive). */
function redactAgentRecord(agent) {
  if (!agent || typeof agent !== "object") return agent;
  const out = agent.provider
    ? { ...agent, provider: redactAgentProvider(agent.provider) }
    : agent;
  if (Array.isArray(agent.mcpServers) && agent.mcpServers.length) {
    return { ...out, mcpServers: redactMcpServerList(agent.mcpServers) };
  }
  return out;
}

async function agentsMap() {
  const s = await kvGet(AGENTS_KEY);
  return s[AGENTS_KEY] ?? {};
}

async function writeAgents(map) {
  await kvSet({ [AGENTS_KEY]: map });
}

/** List all named agents, most-recently-created first. The per-agent provider
 * override is REDACTED (no apiKey) — this list crosses into the NTP/sidebar. */
export async function listNamedAgents() {
  const map = await agentsMap();
  return Object.values(map)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .map(redactAgentRecord);
}

/** Fetch one named agent by id (or name). Returns null when absent. The
 * per-agent provider override is REDACTED (no apiKey). */
export async function getNamedAgent(id) {
  const map = await agentsMap();
  const slug = slugifyAgentId(id);
  const agent = map[slug] ?? null;
  if (!agent) return null;
  return redactAgentRecord(agent);
}

/** Fetch a named agent's FULL provider override (WITH the apiKey) — the SW
 * model-resolution path ONLY. Never surfaced to the UI/model/console. */
export async function getNamedAgentProvider(id) {
  const map = await agentsMap();
  const slug = slugifyAgentId(id);
  return map[slug]?.provider ?? null;
}

/** Fetch a named agent's FULL per-agent MCP server list (WITH tokens) — the SW
 * MCP resolution / tool-injection path ONLY. Never surfaced to the UI/model. */
export async function getNamedAgentMcpServers(id) {
  const map = await agentsMap();
  const slug = slugifyAgentId(id);
  return normalizeMcpServerList(map[slug]?.mcpServers ?? []);
}

/** Validate + normalize a per-agent MCP server list (self-contained, bounded). */
export function normalizeAgentMcpServers(value) {
  return normalizeMcpServerList(value);
}

/**
 * Create (or replace) a named agent. `id` is optional — when omitted a slug is
 * derived from the name. Returns `{ ok, agent }` or `{ ok:false, error }`.
 * This is the AUTHORITATIVE create path (the UI + the master's tool + the
 * natural-language path all land here); it also provisions the agent's own OPFS
 * sandbox (its `agents.md` operating instructions).
 */
export async function createNamedAgent(
  { id, name, role = "", avatar = null, skills = [], coreAssets = [], profileGrants = [], agentsMd = null, provider = null, canDelegateTo = [], mcpServers = null },
  { gateOnReplace = null } = {},
) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) return { ok: false, error: "an agent needs a name" };
  if (cleanName.length > MAX_NAME_LEN) return { ok: false, error: `name too long (${MAX_NAME_LEN})` };
  const roleText = String(role ?? "").trim();
  if (roleText.length > MAX_ROLE_LEN) {
    return { ok: false, error: `role too long (${roleText.length} > ${MAX_ROLE_LEN}) — shorten the role; it was NOT saved` };
  }
  const skillList = Array.isArray(skills) ? skills.slice(0, MAX_SKILLS) : [];
  const assetList = normalizeCoreAssets(coreAssets);

  let cleanProfileGrants = [];
  if (profileGrants !== undefined) {
    if (profileGrants === null) {
      return { ok: false, error: "profileGrants must be an array of grant strings" };
    }
    const validatedGrants = validateProfileGrants(profileGrants);
    if (!validatedGrants.ok) return validatedGrants;
    cleanProfileGrants = validatedGrants.grants;
  }

  return await withAgentsLock(async () => {
    const map = await agentsMap();
    const slug = slugifyAgentId(id) || slugifyAgentId(cleanName) || `agent-${Date.now()}`;
    const existing = map[slug];
    if (!existing && Object.keys(map).length >= MAX_AGENTS) {
      return { ok: false, error: `too many agents (${MAX_AGENTS})` };
    }
    const agent = {
      id: slug,
      name: cleanName,
      role: roleText,
      avatar: avatar ? String(avatar) : (existing?.avatar ?? null),
      skills: skillList,
      coreAssets: assetList,
      profileGrants: profileGrants !== undefined && profileGrants !== null
        ? cleanProfileGrants
        : (existing?.profileGrants ?? []),
      provider: normalizeAgentProvider(provider) ?? (existing?.provider ?? null),
      // Per-agent MCP servers (self-contained + validated, like the provider
      // override). `null`/absent keeps the existing list; a list replaces it.
      mcpServers: mcpServers != null
        ? normalizeMcpServerList(mcpServers)
        : (Array.isArray(existing?.mcpServers) ? existing.mcpServers : []),
      // Agent→agent delegation (G5): the owner-configured allow-list of agent
      // ids this agent may delegate to. Empty = cannot delegate. Normalized by
      // the shared guard module so the record and the route can never disagree.
      canDelegateTo: normalizeCanDelegateTo(canDelegateTo.length ? canDelegateTo : (existing?.canDelegateTo ?? [])),
      // Non-reusable row identity + monotonic per-row revision let an owner
      // approval bind the exact current agent without hashing large avatars or
      // credential-bearing provider state.
      instanceId: existing?.instanceId ?? crypto.randomUUID(),
      revision: (Number.isSafeInteger(existing?.revision) ? existing.revision : 0) + 1,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    // Replacement detection, trusted approval consumption, and mutation share
    // this ONE uninterrupted registry-lock critical section. The callback is
    // supplied only by the service worker; request/model data cannot provide it.
    if (existing && typeof gateOnReplace === "function") {
      const gate = await gateOnReplace({ slug, existing, candidate: agent });
      if (!gate?.ok) return gate ?? { ok: false, error: "owner approval required" };
    }
    map[slug] = agent;
    await writeAgents(map);
    // Provision the agent's OWN sandbox: its operating instructions (agents.md)
    // live in its store, distinct from every other agent — namespaced by the
    // IMMUTABLE instanceId (review P1-2): the slug is reusable, the instanceId
    // is not, so a recreated same-name agent never inherits the old agents.md.
    const mem = namedAgentMemory(agent.instanceId || slug);
    await mem.setTrusted("agents.md", agentsMd ?? defaultAgentsMd(agent));
    return { ok: true, agent };
  });
}

/** Update a named agent's name/role/avatar/skills. Returns the updated agent. */
export async function updateNamedAgent(id, patch = {}, { gateBeforeMutation = null } = {}) {
  const slug = slugifyAgentId(id);
  return await withAgentsLock(async () => {
    const map = await agentsMap();
    const existing = map[slug];
    if (!existing) return { ok: false, error: `no agent ${slug}` };
    const next = { ...existing };
    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n) return { ok: false, error: "an agent needs a name" };
      if (n.length > MAX_NAME_LEN) return { ok: false, error: `name too long (${MAX_NAME_LEN})` };
      next.name = n;
    }
    if (patch.role !== undefined) {
      const roleText = String(patch.role).trim();
      if (roleText.length > MAX_ROLE_LEN) {
        return { ok: false, error: `role too long (${roleText.length} > ${MAX_ROLE_LEN}) — shorten the role; the agent was NOT changed` };
      }
      next.role = roleText;
    }
    if (patch.avatar !== undefined) next.avatar = patch.avatar ? String(patch.avatar) : null;
    if (patch.skills !== undefined) next.skills = Array.isArray(patch.skills) ? patch.skills.slice(0, MAX_SKILLS) : [];
    if (patch.coreAssets !== undefined) next.coreAssets = normalizeCoreAssets(patch.coreAssets);
    if (patch.profileGrants !== undefined) {
      if (patch.profileGrants === null) {
        return { ok: false, error: "profileGrants must be an array of grant strings" };
      }
      const validatedGrants = validateProfileGrants(patch.profileGrants);
      if (!validatedGrants.ok) return validatedGrants;
      next.profileGrants = validatedGrants.grants;
    }
    if (patch.provider !== undefined) {
      // `null` clears the override (inherit the global); a complete config sets it.
      next.provider = normalizeAgentProvider(patch.provider);
    }
    if (patch.mcpServers !== undefined) {
      // `null`/[] clears the per-agent list (inherit only the global set); a list
      // replaces it. Always normalized + bounded (self-contained per server).
      next.mcpServers = normalizeMcpServerList(patch.mcpServers);
    }
    if (patch.canDelegateTo !== undefined) next.canDelegateTo = normalizeCanDelegateTo(patch.canDelegateTo);
    next.instanceId = existing.instanceId ?? crypto.randomUUID();
    next.revision = (Number.isSafeInteger(existing.revision) ? existing.revision : 0) + 1;
    next.updatedAt = Date.now();
    if (typeof gateBeforeMutation === "function") {
      const gate = await gateBeforeMutation({ slug, existing, candidate: next });
      if (!gate?.ok) return gate ?? { ok: false, error: "owner approval required" };
    }
    map[slug] = next;
    await writeAgents(map);
    return { ok: true, agent: next };
  });
}

/** Set (or clear) a named agent's provider override. `config` is a COMPLETE
 * provider-specific config, or null to inherit the global. Returns { ok, agent }
 * (the agent is REDACTED — no apiKey). */
// KEY PRESERVATION (provider-picker integration, k3 HIGH-1): an ABSENT apiKey
// (undefined — dropped by message serialization) on the SAME provider carries
// the EXISTING stored key forward; an explicit "" still clears. This MUST run
// BEFORE normalizeAgentProvider, which would coerce the absent apiKey to "" and
// destroy the blank-save signal — the reason this is a shared helper called both
// here and by the service-worker route (which otherwise pre-normalizes).
export async function preserveExistingProviderKey(id, config) {
  if (
    config && typeof config === "object" && config.apiKey === undefined &&
    typeof config.provider === "string"
  ) {
    const existing = await getNamedAgentProvider(id);
    if (existing?.provider === config.provider && existing.apiKey) {
      return { ...config, apiKey: existing.apiKey };
    }
  }
  return config;
}

export async function setNamedAgentProvider(id, config, { gateBeforeMutation = null } = {}) {
  config = await preserveExistingProviderKey(id, config);
  const normalized = config == null ? null : normalizeAgentProvider(config);
  const r = await updateNamedAgent(id, { provider: normalized }, { gateBeforeMutation });
  if (r?.ok === false) return r;
  // REDACTED result: the apiKey never crosses back out of the resolution path
  // (the contract the doc-comment always claimed — now enforced).
  return {
    ok: true,
    agent: r.agent?.provider
      ? { ...r.agent, provider: redactAgentProvider(r.agent.provider) }
      : r.agent,
  };
}

/** Set (or clear) a named agent's per-agent MCP server list. `list` is a full
 * list (self-contained servers) or null/[] to inherit only the global set. Each
 * server's auth token is preserved on a blank-save (same id + header name), the
 * same key-preservation the provider override uses. Returns { ok, agent } with
 * the agent REDACTED (no tokens). */
export async function setNamedAgentMcpServers(id, list, { gateBeforeMutation = null } = {}) {
  const existing = await getNamedAgentMcpServers(id);
  const preserved = list == null ? [] : preserveExistingMcpTokens(list, existing);
  const r = await updateNamedAgent(id, { mcpServers: preserved }, { gateBeforeMutation });
  if (r?.ok === false) return r;
  // REDACTED result: a token never crosses back out of the resolution path.
  return { ok: true, agent: redactAgentRecord(r.agent) };
}

/** Delete a named agent + its OPFS sandbox + its system-prompt override
 * (lifecycle cleanup: a deleted agent must never leave an orphan override
 * that a later same-slug agent would silently inherit). Idempotent.
 * The prompt-override cleanup runs FIRST inside the same registry-lock
 * transaction and its failure PROPAGATES (the deletion reports failure and
 * the agent is preserved, so the owner can retry) — never silently swallowed
 * while the agent row disappears. */
const MAX_PENDING_TEARDOWNS = 50;

/** Bounded memory of namespaces whose teardown did not complete (the agent row
 * is already gone, so a plain `named-agent.delete` retry would return early
 * and never finish the job). Each entry records BOTH namespaces that may hold
 * state for the dead agent: the immutable instanceId dir (post-fix runs +
 * memory) and the legacy slug dir (pre-fix leftovers). Consumed by the
 * absent-row branch of deleteNamedAgent; swept entries are removed. */
async function recordPendingTeardown(slug, instanceId) {
  try {
    const store = (await kvGet(PENDING_KEY))?.[PENDING_KEY];
    const list = Array.isArray(store) ? store : [];
    list.push({ slug, instanceId: instanceId || null, at: Date.now() });
    await kvSet({ [PENDING_KEY]: list.slice(-MAX_PENDING_TEARDOWNS) });
  } catch { /* best-effort: the orphan sweep remains the safety net */ }
}

const PENDING_KEY = "agents-pending-teardown";

/** ATOMIC PER-AGENT take (review P1-4): remove and return ONLY this slug's
 * pending-teardown entries, leaving every OTHER agent's record untouched. The
 * old global take cleared the whole list before filtering — a retry for one
 * agent silently dropped the other agents' outstanding repairs. Callers hold
 * the agents lock, so the read-modify-write is atomic w.r.t. other deletes
 * and records. */
async function takePendingTeardownsFor(slug) {
  try {
    const store = (await kvGet(PENDING_KEY))?.[PENDING_KEY];
    const list = Array.isArray(store) ? store : [];
    const mine = list.filter((p) => p?.slug === slug);
    if (mine.length) {
      await kvSet({ [PENDING_KEY]: list.filter((p) => p?.slug !== slug) });
    }
    return mine;
  } catch { return []; }
}

export async function deleteNamedAgent(id, { gateBeforeDelete = null, revokeGrants = null, closeAgentWorker = null, fenceActiveRuns = null } = {}) {
  const slug = slugifyAgentId(id);
  return await withAgentsLock(async () => {
    const map = await agentsMap();
    const existing = map[slug];
    if (!existing) {
      // RETRY-REPAIR: the row may already be gone while namespaces from a
      // partially-failed teardown remain. Take ONLY this slug's pending
      // records (other agents' entries are preserved — review P1-4) and
      // REPLAY THE FULL TEARDOWN (fence → prompt → row → schedules → grants
      // → worker → dirs → durable family), not just the directory purge.
      // Absent state is fine (idempotent).
      const pending = await takePendingTeardownsFor(slug);
      const fails = [];
      if (pending.length === 0) {
        // No record (pre-fix leftover): best-effort legacy slug teardown so a
        // plain retry can still repair the common case.
        const repair = await teardownAgentState({ slug, instanceId: "" }, { fenceActiveRuns, revokeGrants, closeAgentWorker });
        fails.push(...repair.fails);
      } else {
        for (const entry of pending) {
          const repair = await teardownAgentState(
            { slug, instanceId: String(entry?.instanceId ?? "") },
            { fenceActiveRuns, revokeGrants, closeAgentWorker },
          );
          if (repair.fails.length) {
            // Re-record so a later retry (or the sweep) finishes the job —
            // the take removed it optimistically.
            fails.push(...repair.fails);
            try { await recordPendingTeardown(slug, entry?.instanceId ?? null); } catch { /* sweep is the net */ }
          }
        }
      }
      return fails.length ? { ok: false, retryable: true, error: `teardown repair incomplete: ${fails.join("; ")}` } : { ok: true };
    }
    if (typeof gateBeforeDelete === "function") {
      const gate = await gateBeforeDelete({ slug, existing });
      if (!gate?.ok) return gate ?? { ok: false, error: "owner approval required" };
    }
    // review r4 P1-2: ONE admission fence gates the ENTIRE destructive
    // sequence. The prompt-override delete, the registry-row delete, and
    // every teardown phase now live INSIDE teardownAgentState, strictly
    // behind its fence — a refusal can never follow partial destruction
    // because no destructive phase precedes the single fence, and no fence
    // is ever re-consulted as a first gate after something was destroyed.
    const instanceId = String(existing.instanceId || "");
    const { fails, rowDeleted, phasesCompleted = [] } = await teardownAgentState(
      { slug, instanceId },
      {
        fenceActiveRuns,
        revokeGrants,
        closeAgentWorker,
        // The row deletion is a closure over THIS call's registry snapshot:
        // dropping the row is the identity-destructive step and must run
        // behind the same fence as everything else.
        deleteIdentityRow: async () => {
          const fresh = await agentsMap();
          if (!fresh[slug]) return { ok: true, already: true };
          delete fresh[slug];
          await writeAgents(fresh);
          return { ok: true };
        },
      },
    );
    if (fails.length && !rowDeleted) {
      // Refused before the registry row went — the agent still EXISTS.
      // Truthful partial state (review r5 P1-a): phases that already ran
      // (the prompt override may be gone; the row is intact) replay on the
      // retry — the owner must not read "NOT deleted" as "untouched".
      const partial = phasesCompleted.length
        ? ` (phases already run: ${phasesCompleted.join(", ")} — they replay on retry)`
        : "";
      return {
        ok: false,
        retryable: true,
        error: `delete refused (${fails.join("; ")}) — the agent was NOT deleted${partial}; retry`,
      };
    }
    if (fails.length) {
      // Destruction began; the remaining phases are recoverable via the
      // pending record + retry/sweep. Honest: the row IS gone.
      try { await recordPendingTeardown(slug, instanceId); } catch { /* sweep is the net */ }
      return {
        ok: false,
        retryable: true,
        error: `teardown incomplete (${fails.join("; ")}) — the agent row was removed; retry the delete to finish cleanup`,
      };
    }
    // Fully cleaned: clear this agent's pending record.
    try {
      const store = (await kvGet(PENDING_KEY))?.[PENDING_KEY];
      const list = (Array.isArray(store) ? store : []).filter((p) => p?.slug !== slug);
      await kvSet({ [PENDING_KEY]: list });
    } catch { /* best-effort */ }
    return { ok: true };
  });
}

/** The agent's own OPFS store (memory + history + skills + agents.md).
 * LEGACY read path: keys by slug. The LIVE run/deletion path namespaces by
 * the agent's immutable instanceId (see deleteNamedAgent + the SW run path);
 * this helper remains for pre-fix rows and tool-facing reads where only the
 * slug is known. Live consumers should use resolveNamedAgentStore instead —
 * it routes through the immutable identity. */
export function agentMemory(id) {
  return namedAgentMemory(slugifyAgentId(id));
}

/** The namespaces that may hold an agent's state, LIVE identity first: the
 * immutable instanceId (post-fix memory + durable family) then the legacy
 * slug (pre-fix leftovers). Every consumer that touches an agent's OPFS dirs,
 * durable targets, grants, or worker keys must address the agent through
 * THIS list — the slug alone stopped being the live identity once instanceId
 * namespacing landed (review P1-2). */
/** review r4 P1-3: the read-only agent memory selectors. Legacy/orphan dirs
 * resolve LITERALLY and are declared read-only — the ONLY thing that removes
 * them is agent teardown (which purges BOTH namespaces). The SW's memory
 * set/clear routes gate on this predicate so a post-purge write can never
 * recreate a "read-only" dir. Single source of truth: the routes and the
 * classification UI (and the tests) all call this. */
export function readOnlyAgentMemorySelector(origin) {
  return typeof origin === "string" &&
    (origin.startsWith("agent-legacy:") || origin.startsWith("agent-orphan:"));
}

export function agentStateNamespaces(agent) {
  const slug = slugifyAgentId(agent?.id ?? agent?.slug ?? "");
  const instanceId = String(agent?.instanceId ?? "").trim();
  return [...new Set([instanceId, slug].filter(Boolean))];
}

/** Classify enumerated `memory/agents/*` directory names against the LIVE
 * registry (review r3 P1-3): a dir is CANONICAL when it is a live row's
 * instanceId, LEGACY when it is a live row's slug (pre-instanceId leftovers
 * — its selector must never clear the live store, so it is read-only), or
 * ORPHAN when no live row claims it (safe to clear from the explorer; the
 * teardown sweep also removes it). Pure so the KAT pins the contract. */
export function classifyAgentMemoryDirs({ dirs, agents }) {
  const rows = Array.isArray(agents) ? agents : [];
  const byInstance = new Map(rows.map((a) => [String(a?.instanceId ?? ""), a]));
  const bySlug = new Map(rows.map((a) => [slugifyAgentId(a?.id ?? a?.slug ?? ""), a]));
  return (Array.isArray(dirs) ? dirs : []).map((dir) => {
    const name = String(dir ?? "");
    if (byInstance.has(name)) return { dir: name, selector: `agent:${name}`, state: "canonical", readOnly: false };
    const slug = slugifyAgentId(name);
    if (slug && bySlug.has(slug)) return { dir: name, selector: `agent-legacy:${name}`, state: "legacy", readOnly: true };
    return { dir: name, selector: `agent-orphan:${name}`, state: "orphan", readOnly: false };
  });
}

/** Resolve a slug-or-instanceId selector to the agent's LIVE memory store: a
 * row whose slug OR instanceId matches resolves to its immutable instanceId
 * namespace; an unknown selector resolves literally so cleanup paths can
 * still name an orphan/legacy dir. THE single resolver for live OPFS + worker
 * consumers (review P1-2) — address an agent by anything else and you risk
 * reading a dead namespace while the live one grows. */
export async function resolveNamedAgentStore(selector) {
  const raw = String(selector ?? "");
  let row = null;
  try {
    const map = await agentsMap();
    row = map[slugifyAgentId(raw)] ?? Object.values(map).find((a) => a?.instanceId === raw) ?? null;
  } catch { row = null; }
  if (row?.instanceId) return namedAgentMemory(row.instanceId);
  return namedAgentMemory(raw);
}

/** The immutable worker/identity key for a selector (same resolution rule as
 * resolveNamedAgentStore, returning the identity STRING): live row → its
 * instanceId; unknown → the literal selector. The agent-worker routes key
 * host workers + the alive-set through this so a recreated same-name agent
 * cannot inherit the previous instance's worker. */
export async function resolveAgentInstanceId(selector) {
  const raw = String(selector ?? "");
  try {
    const map = await agentsMap();
    const row = map[slugifyAgentId(raw)] ?? Object.values(map).find((a) => a?.instanceId === raw) ?? null;
    if (row?.instanceId) return row.instanceId;
  } catch { /* fall through to the literal */ }
  return raw;
}

/** FENCE live writers before teardown (review P1-3): cancel every durable run
 * whose journalTarget belongs to this agent (post-fix `agent:<instanceId>` +
 * legacy `agent:<slug>`) and AWAIT terminal state, so an in-flight writer
 * cannot recreate a removed dir mid-teardown. Registry is injectable for
 * tests; timeout bounds the wait — an honest failure (retryable) beats an
 * unbounded delete. */
export async function fenceAgentActiveRuns({ registry, slug, instanceId, timeoutMs = 15000, resolveAborter = null } = {}) {
  if (!registry || typeof registry.list !== "function" || typeof registry.cancel !== "function") {
    return { ok: false, error: "fence requires a durable registry with list+cancel" };
  }
  const targets = new Set(
    [instanceId ? `agent:${instanceId}` : null, slug ? `agent:${slug}` : null].filter(Boolean),
  );
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let live = [];
  while (Date.now() < deadline) {
    // Ownership matching uses the registry's dedicated projection (list()
    // strips journalTarget from public records — review-found blind spot).
    if (typeof registry.activeByJournalTarget === "function") {
      try {
        live = await registry.activeByJournalTarget(targets);
      } catch (e) {
        return { ok: false, error: `fence could not list active runs: ${String(e?.message ?? e)}` };
      }
    } else {
      // Fallback for minimal registry doubles: list + isActive, matching on
      // whatever ownership field the double exposes.
      let runs;
      try {
        runs = await registry.list();
      } catch (e) {
        return { ok: false, error: `fence could not list runs: ${String(e?.message ?? e)}` };
      }
      live = (runs?.runs ?? []).filter((r) =>
        targets.has(String(r?.journalTarget ?? "")) && registry.isActive?.(r?.executionId) === true,
      );
    }
    if (!live.length) return { ok: true };
    for (const r of live) {
      try {
        // review P1-1: the fence must invoke the REAL live abort (the SW's
        // orchestrator aborter) — cancelling without `onAuthorityPersisted`
        // durably recorded "no live abort callback registered" and left the
        // execution running while the teardown proceeded.
        await registry.cancel(r.executionId, {
          reason: "agent deleted — teardown fence",
          onAuthorityPersisted: () => {
            const abort = typeof resolveAborter === "function" ? resolveAborter(r.executionId) : null;
            if (typeof abort !== "function") return false;
            abort();
            return true;
          },
        });
      } catch { /* retried next pass */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {
    ok: false,
    error: `active runs did not reach terminal within ${timeoutMs}ms (${live.map((r) => r.executionId).join(", ")})`,
  };
}

/** The COMPLETE state teardown for a dead agent identity (review P1-3/P1-4):
 * fence live writers FIRST, then remove the prompt override + the registry
 * row (review r4 P1-2 — both are destructive and therefore run strictly
 * behind the single admitted fence), then cancel owned schedules, revoke
 * scoped grants, close the shared worker, remove BOTH OPFS namespaces, and
 * purge the durable run family. External effects are injected where the
 * caller has the authority (SW); scheduler access is dynamic to keep this
 * module's import graph clean. Returns { fails, rowDeleted, phasesCompleted }:
 * `fails` is the failure list (empty = complete), `rowDeleted` says whether
 * the registry row was removed (false = the agent was NOT deleted; a retry
 * replays everything), and `phasesCompleted` names the phases that ALREADY
 * ran when a failure halted the teardown (review r5 P1-a — a halted teardown
 * must report truthful partial state, never claim the row is gone when the
 * registry write failed). Used by BOTH the row-present delete and the
 * absent-row retry so a retry REPLAYS EVERY phase, not just the directory
 * purge. */
async function teardownAgentState({ slug, instanceId }, { fenceActiveRuns = null, revokeGrants = null, closeAgentWorker = null, deleteIdentityRow = null } = {}) {
  const fails = [];
  const phasesCompleted = [];
  const markFail = (what, e) => {
    const msg = `${what}: ${String(e?.message ?? e?.error ?? e ?? "failed")}`;
    fails.push(msg);
  };
  const namespaces = [...new Set([instanceId, slug].filter(Boolean))];
  // P1-3: the fence is FIRST — abort + await in-flight writers so nothing
  // recreates a removed namespace after the purge below. A fence FAILURE
  // gates the removal phases (dirs + durable family): deleting while writers
  // are live is exactly the data-loss shape the fence exists to prevent. The
  // pending record + retry finish the removals once writers are gone.
  let fenced = true;
  if (typeof fenceActiveRuns === "function") {
    try {
      const f = await fenceActiveRuns({ slug, instanceId, namespaces });
      if (f?.ok === false) { markFail("active-run fence", f); fenced = false; }
    } catch (e) { markFail("active-run fence", e); fenced = false; }
  }
  // review r3 P1-2: a REFUSED fence gates EVERY destructive phase — not just
  // the dir/durable removals. Cancelling schedules, revoking grants, or
  // closing the worker while writers are live is teardown work that cannot
  // be un-done by the retry replay (an already-cancelled schedule replays as
  // a no-op and the phase is then never re-verified). Everything below is
  // skipped; the pending record + retry re-fence and re-run all phases.
  if (!fenced) {
    return { fails, rowDeleted: false, phasesCompleted };
  }
  // review r4 P1-2: the prompt override and the registry row are DESTRUCTIVE
  // phases and run strictly behind the single admitted fence above — a fence
  // refusal can never follow partial destruction, because nothing destructive
  // precedes this point. A prompt-cleanup failure aborts with the row intact
  // (the owner retries; nothing was destroyed).
  phasesCompleted.push("fence");
  const cleanup = await deleteAgentPromptOverride(slug)
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  if (cleanup?.ok === false) {
    markFail("prompt-override cleanup", cleanup);
    return { fails, rowDeleted: false, phasesCompleted };
  }
  phasesCompleted.push("prompt-override");
  // Namespace identity FIRST: the immutable instanceId (NOT the reusable
  // slug) keys this agent's OPFS dir and its durable run family, so a
  // later same-name agent can never inherit state.
  if (typeof deleteIdentityRow === "function") {
    // review r5 P1-a: a row-delete failure HALTS the teardown. Continuing
    // (the r4 bug) destroyed schedules/grants/workers/dirs/durable while the
    // registry row stayed LIVE — a visible agent whose entire backing state
    // was gone — and then LIED via an unconditional rowDeleted:true. Stop
    // here, report rowDeleted:false + the phases that already ran (the fence
    // + the prompt-override removal; both replay safely on the retry), and
    // leave every later phase untouched.
    try {
      const r = await deleteIdentityRow();
      if (r?.ok === false) {
        markFail("identity row delete", r);
        return { fails, rowDeleted: false, phasesCompleted };
      }
    } catch (e) {
      markFail("identity row delete", e);
      return { fails, rowDeleted: false, phasesCompleted };
    }
  }
  phasesCompleted.push("identity-row");
  // Every schedule OWNED by this agent (owner.agentSurfaceRef ===
  // `named:<slug>`) — not only deterministic recipe:<slug> names.
  try {
    const { listScheduledTasks, cancelScheduledTask } = await import("./scheduler.js");
    const tasks = await listScheduledTasks();
    for (const t of Array.isArray(tasks) ? tasks : []) {
      if (String(t?.owner?.agentSurfaceRef ?? "") !== `named:${slug}`) continue;
      try {
        const c = await cancelScheduledTask(t.name);
        if (c?.ok === false) markFail(`schedule ${t.name}`, c);
      } catch (e) { markFail(`schedule ${t.name}`, e); }
    }
  } catch (e) { markFail("schedule enumeration", e); }
  phasesCompleted.push("schedules");
  // Scoped grants + the shared worker are keyed by EITHER identity string
  // (grants saved pre-instanceId carry the slug; newer state may carry the
  // instanceId), so each injection runs per-namespace.
  for (const ident of namespaces) {
    if (typeof revokeGrants === "function") {
      try {
        const g = await revokeGrants(ident);
        if (g?.ok === false) markFail(`fs-grant revoke ${ident}`, g);
      } catch (e) { markFail(`fs-grant revoke ${ident}`, e); }
    }
    if (typeof closeAgentWorker === "function") {
      try {
        const w = await closeAgentWorker(ident);
        if (w?.ok === false) markFail(`agent-worker close ${ident}`, w);
      } catch (e) { markFail(`agent-worker close ${ident}`, e); }
    }
  }
  // OPFS namespaces: the immutable instanceId dir AND any legacy slug dir
  // must vanish (mem.clear() deliberately preserves dirs for LIVE stores —
  // recursive removal is the deletion semantics). REMOVALS ARE FENCE-GATED
  // (and reached only when the fence held — see the early return above).
  phasesCompleted.push("grants+worker");
  for (const ns of namespaces) {
    const r = await purgeStoreDir(["memory", "agents", encodeURIComponent(ns)]);
    if (!r.ok) markFail(`dir agents/${ns}`, r);
  }
  phasesCompleted.push("dirs");
  // Durable run family, both target spellings (each is a no-op when absent).
  try {
    const { durableRuns } = await import("./durable-runs.js");
    for (const target of namespaces.map((ns) => `agent:${ns}`)) {
      const purged = await durableRuns.purgeForTarget(target);
      if (purged?.ok === false) markFail(`durable purge ${target}`, purged);
    }
  } catch (e) { markFail("durable purge", e); }
  phasesCompleted.push("durable");
  return { fails, rowDeleted: true, phasesCompleted };
}

/** Default `agents.md` — the agent's operating instructions. */
function defaultAgentsMd(agent) {
  return [
    `# ${agent.name}`,
    "",
    agent.role ? `**Role:** ${agent.role}` : "**Role:** (none set)",
    "",
    "You are a persistent agent. You have your own memory (key-value) and your",
    "own run history. Use `memory_grep` to search them. Use `memory_set`/",
    "`memory_get` to store/recall what you learn. You can install skills and",
    "receive delegated tasks.",
    "",
  ].join("\n");
}

/**
 * The PURE grep scan (no `ai`/`zod` — the `memory_grep` TOOL wraps this in
 * agent.js where those are already imported). Search an agent's own memory AND
 * run history (the journal) for a substring (case-insensitive). Returns a
 * bounded excerpt of each match, never the full store.
 */
export async function grepAgentMemory(memory, query) {
  const mem = memory ?? namedAgentMemory("unnamed");
  const needle = String(query).toLowerCase();
  if (!needle) return { query, count: 0, matches: [] };
  const matches = [];
  const keys = await mem.keys().catch(() => []);
  for (const key of keys.slice(0, 200)) {
    const value = await mem.get(key).catch(() => null);
    let haystack = "";
    try { haystack = JSON.stringify(value ?? null); } catch { haystack = String(value); }
    if (haystack.toLowerCase().includes(needle)) {
      matches.push({ source: "memory", key, excerpt: excerpt(haystack, needle, 160) });
    }
  }
  const journal = await mem.get("journal").catch(() => null);
  if (Array.isArray(journal)) {
    for (const entry of journal.slice(-200)) {
      let hs = "";
      try { hs = JSON.stringify(entry ?? null); } catch { hs = String(entry); }
      if (hs.toLowerCase().includes(needle)) {
        matches.push({ source: "history", excerpt: excerpt(hs, needle, 160) });
      }
    }
  }
  return { query, count: matches.length, matches: matches.slice(0, 30) };
}

function excerpt(text, needle, around = 160) {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return text.slice(0, around);
  const start = Math.max(0, idx - Math.floor(around / 2));
  return (start > 0 ? "…" : "") + text.slice(start, start + around) + (start + around < text.length ? "…" : "");
}

// ── name + avatar generation ──────────────────────────────────────────────

const NAME_ADJECTIVES = [
  "tab", "crisp", "quiet", "bright", "swift", "calm", "keen", "merry",
  "wary", "sly", "bold", "tidy", "nimble", "steady", "curious", "dapper",
];
const NAME_NOUNS = [
  "tidy", "penguin", "owl", "ferret", "fox", "rook", "otter", "heron",
  "badger", "wren", "sparrow", "lynx", "puffin", "marten", "hedgehog", "skink",
];

/** A deterministic-but-quirky name for an agent, seeded by its id/role so the
 * SAME agent always gets the SAME name. Returns an alliterative-ish name. */
export function generateAgentName(seed) {
  const s = String(seed ?? "");
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  const adj = NAME_ADJECTIVES[hash % NAME_ADJECTIVES.length];
  const noun = NAME_NOUNS[(hash >>> 5) % NAME_NOUNS.length];
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  return `${cap(adj)} ${cap(noun)}`;
}

/**
 * Generate an avatar for an agent using the Gemini image model (nano banana).
 * `apiKey` is the user's configured Gemini key (never committed). On success
 * returns a data:image/png URL; on any failure returns null (the caller falls
 * back to a deterministic initial/icon). This is async + network-bound, so it
 * runs only on an explicit request (named-agent.avatar), not on every list.
 */
export async function generateAgentAvatar({ name, role, apiKey }) {
  if (!apiKey) return null;
  const prompt =
    `A tiny, distinctive, flat avatar icon for an AI agent named "${name}"` +
    (role ? ` whose role is "${role}"` : "") +
    `. Minimal geometric mascot, friendly but not childish, petrol-teal (#0e6e63) on a warm paper (#f7f6f3) circular badge. No text, no letters, no gradients. Simple + bold, reads at 32px.`;
  try {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    });
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find((p) => p?.inlineData?.data)?.inlineData;
    if (!inline) return null;
    const full = `data:${inline.mimeType || "image/png"};base64,${inline.data}`;
    // Downscale to a bounded avatar (128px) so a generated image can't blow the
    // chrome.storage quota (the Gemini image API returns a large PNG). OffscreenCanvas
    // is available in the SW; when it's not, fall back to the full image.
    return await downscaleAvatar(full, 128);
  } catch {
    return null;
  }
}

/** Downscale a data-URL image to `size` px (JPEG) via OffscreenCanvas. Best-effort:
 * returns the input unchanged when canvas/image decoding is unavailable. */
async function downscaleAvatar(dataURL, size = 128) {
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
      return dataURL;
    }
    const blob = await (await fetch(dataURL)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = "";
    for (const b of buf) bin += String.fromCharCode(b);
    bmp.close();
    return `data:image/jpeg;base64,${btoa(bin)}`;
  } catch {
    return dataURL;
  }
}

/** Creation-time avatar follow-up (CAP-FB-20260823-AGENT-ICON-ON-CREATE-01):
 * the agent's icon is generated as part of creation — a bounded, best-effort
 * immediate follow-up that never blocks the create response. Dependency-
 * injected for testability; persists ONLY when the stored agent still has no
 * avatar (an owner's concurrent edit always wins), so it can never clobber a
 * human choice. Any failure leaves avatar null — every render surface falls
 * back to the deterministic initialAvatar placeholder, never a broken image.
 * Storage stays bounded: generateAgentAvatar downscales to a 128px JPEG. */
export const AGENT_AVATAR_FOLLOWUP_TIMEOUT_MS = 20_000;

export async function generateAvatarForCreatedAgent({
  agent,
  getAgent,
  updateAgent,
  readGeminiKey,
  generate = generateAgentAvatar,
  timeoutMs = AGENT_AVATAR_FOLLOWUP_TIMEOUT_MS,
}) {
  if (!agent || typeof agent.id !== "string" || !agent.id) {
    return { attached: false, reason: "no-agent" };
  }
  if (agent.avatar) return { attached: false, reason: "has-avatar" };
  let key = "";
  try { key = await readGeminiKey(); } catch { return { attached: false, reason: "key-unavailable" }; }
  if (!key) return { attached: false, reason: "no-key" };
  let avatar = null;
  try {
    avatar = await avatarWithTimeout(
      generate({ name: agent.name, role: agent.role, apiKey: key }),
      timeoutMs,
    );
  } catch {
    return { attached: false, reason: "generation-failed" };
  }
  if (!avatar) return { attached: false, reason: "generation-returned-null" };
  let current = null;
  try { current = await getAgent(agent.id); } catch { return { attached: false, reason: "read-failed" }; }
  if (!current) return { attached: false, reason: "agent-gone" };
  if (current.avatar) return { attached: false, reason: "avatar-set-concurrently" };
  try { await updateAgent(agent.id, { avatar }); } catch { return { attached: false, reason: "update-failed" }; }
  return { attached: true };
}

function avatarWithTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("avatar generation timed out")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** A deterministic fallback avatar (an SVG data URL with the agent's initial). */
export { initialAvatar } from "./avatar.js";

/**
 * The ONE agents projection (owner directive 2026-08-28 — the unified agent
 * model): named-agent records and background recipes keyed by agent id, so a
 * same-id record renders EXACTLY ONCE in every surface (main list, sidebar,
 * count, Settings). The named record wins a collision (it carries the persona/
 * skills/memory); a recipe-side schedule fills in only when the named record
 * has none of its own, while both source records remain available to management
 * surfaces. Pure — no store access.
 */
export function projectUnifiedAgents(namedAgents = [], backgroundAgents = []) {
  const byId = new Map();
  for (const a of Array.isArray(namedAgents) ? namedAgents : []) {
    if (!a?.id) continue;
    // Preserve source records so management surfaces can render one conceptual
    // row without losing either store's actions on a same-id collision.
    byId.set(a.id, { ...a, kind: "named", namedAgent: a, backgroundAgent: null });
  }
  for (const b of Array.isArray(backgroundAgents) ? backgroundAgents : []) {
    if (!b?.id) continue;
    const recipeSchedule = b.schedule?.periodInMinutes
      ? { periodInMinutes: b.schedule.periodInMinutes, task: b.schedule?.task ?? "" }
      : null;
    const existing = byId.get(b.id);
    if (existing) {
      existing.backgroundAgent = b;
      if (!existing.schedule?.periodInMinutes && recipeSchedule) {
        existing.schedule = recipeSchedule;
      }
    } else {
      byId.set(b.id, {
        ...b,
        kind: "background",
        schedule: recipeSchedule,
        namedAgent: null,
        backgroundAgent: b,
      });
    }
  }
  return [...byId.values()];
}
