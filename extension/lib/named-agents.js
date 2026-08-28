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
import { namedAgentMemory, purgeStoreDir } from "./memory.js";
import { deleteAgentPromptOverride } from "./system-prompts.js";

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
    .map((a) => a.provider ? { ...a, provider: redactAgentProvider(a.provider) } : a);
}

/** Fetch one named agent by id (or name). Returns null when absent. The
 * per-agent provider override is REDACTED (no apiKey). */
export async function getNamedAgent(id) {
  const map = await agentsMap();
  const slug = slugifyAgentId(id);
  const agent = map[slug] ?? null;
  if (!agent) return null;
  return agent.provider ? { ...agent, provider: redactAgentProvider(agent.provider) } : agent;
}

/** Fetch a named agent's FULL provider override (WITH the apiKey) — the SW
 * model-resolution path ONLY. Never surfaced to the UI/model/console. */
export async function getNamedAgentProvider(id) {
  const map = await agentsMap();
  const slug = slugifyAgentId(id);
  return map[slug]?.provider ?? null;
}

/**
 * Create (or replace) a named agent. `id` is optional — when omitted a slug is
 * derived from the name. Returns `{ ok, agent }` or `{ ok:false, error }`.
 * This is the AUTHORITATIVE create path (the UI + the master's tool + the
 * natural-language path all land here); it also provisions the agent's own OPFS
 * sandbox (its `agents.md` operating instructions).
 */
export async function createNamedAgent(
  { id, name, role = "", avatar = null, skills = [], coreAssets = [], agentsMd = null, provider = null },
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
      provider: normalizeAgentProvider(provider) ?? (existing?.provider ?? null),
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
    // live in its store, distinct from every other agent.
    const mem = namedAgentMemory(slug);
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
    if (patch.provider !== undefined) {
      // `null` clears the override (inherit the global); a complete config sets it.
      next.provider = normalizeAgentProvider(patch.provider);
    }
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

async function takePendingTeardowns() {
  try {
    const store = (await kvGet(PENDING_KEY))?.[PENDING_KEY];
    const list = Array.isArray(store) ? store : [];
    if (list.length) await kvSet({ [PENDING_KEY]: [] });
    return list;
  } catch { return []; }
}
const PENDING_KEY = "agents-pending-teardown";

export async function deleteNamedAgent(id, { gateBeforeDelete = null, revokeGrants = null, closeAgentWorker = null } = {}) {
  const slug = slugifyAgentId(id);
  return await withAgentsLock(async () => {
    const map = await agentsMap();
    const existing = map[slug];
    if (!existing) {
      // RETRY-REPAIR: the row may already be gone while namespaces from a
      // partially-failed teardown remain. Consume the pending-teardown
      // record (which carries the instanceId the row no longer can) and
      // purge those dirs + their durable families now. Absent state is
      // fine (idempotent). Returns ok either way — the deletion stands.
      const pending = await takePendingTeardowns();
      const mine = pending.filter((p) => p?.slug === slug);
      const fails = [];
      for (const entry of mine) {
        for (const ns of [entry.instanceId, entry.slug].filter(Boolean)) {
          const r = await purgeStoreDir(["memory", "agents", encodeURIComponent(ns)]);
          if (!r.ok) fails.push(`${ns}: ${r.error}`);
        }
      }
      if (mine.length === 0) {
        // No record (pre-fix leftover): best-effort legacy slug purge so a
        // plain retry can still repair the common case.
        const r = await purgeStoreDir(["memory", "agents", encodeURIComponent(slug)]);
        if (!r.ok) fails.push(`${slug}: ${r.error}`);
      }
      return fails.length ? { ok: false, retryable: true, error: `teardown repair incomplete: ${fails.join("; ")}` } : { ok: true };
    }
    if (typeof gateBeforeDelete === "function") {
      const gate = await gateBeforeDelete({ slug, existing });
      if (!gate?.ok) return gate ?? { ok: false, error: "owner approval required" };
    }
    // Prompt cleanup first: a failure aborts the deletion honestly (the
    // agent row stays, the override stays consistent with it).
    const cleanup = await deleteAgentPromptOverride(slug)
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (cleanup?.ok === false) {
      return {
        ok: false,
        retryable: true,
        error: `prompt-override cleanup failed (${cleanup.error ?? "unknown"}) — the agent was NOT deleted; retry`,
      };
    }
    // Namespace identity FIRST: the immutable instanceId (NOT the reusable
    // slug) keys this agent's OPFS dir and its durable run family, so a
    // later same-name agent can never inherit state.
    const instanceId = String(existing.instanceId || "");
    delete map[slug];
    await writeAgents(map);
    // If anything below fails, remember BOTH namespaces so a retry of the
    // delete (absent row) can finish the teardown.
    let fail = null;
    const markFail = (what, e) => {
      const msg = `${what}: ${String(e?.message ?? e?.error ?? e ?? "failed")}`;
      fail = fail ? `${fail}; ${msg}` : msg;
    };
    try { await recordPendingTeardown(slug, instanceId); } catch { /* sweep is the net */ }
    // P1-2a: cancel EVERY schedule owned by this agent (owner.agentSurfaceRef
    // === `named:<slug>`), not only the deterministic recipe:<slug> one —
    // schedules the agent created at runtime with generated names survive
    // otherwise and keep firing as orphans.
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
    // P1-2b: revoke persistent file-system grants scoped to this agent
    // (injected: fs-grants revocation stays out of this module's graph).
    if (typeof revokeGrants === "function") {
      try {
        const g = await revokeGrants(slug);
        if (g?.ok === false) markFail("fs-grant revoke", g);
      } catch (e) { markFail("fs-grant revoke", e); }
    }
    // P1-2c: detach the agent's shared worker (host port drop + alive-set
    // prune) so a deleted agent's worker cannot be resurrected.
    if (typeof closeAgentWorker === "function") {
      try {
        const w = await closeAgentWorker(slug);
        if (w?.ok === false) markFail("agent-worker close", w);
      } catch (e) { markFail("agent-worker close", e); }
    }
    // P1-1: RECURSIVELY REMOVE the OPFS dirs. mem.clear() deliberately
    // PRESERVES the directory + generation authority for ABA safety — that is
    // the right semantics for a LIVE store, but a DELETED agent's namespace is
    // dead: both the instanceId dir and any legacy slug dir must vanish.
    for (const ns of [...(instanceId ? [instanceId] : []), slug]) {
      const r = await purgeStoreDir(["memory", "agents", encodeURIComponent(ns)]);
      if (!r.ok) markFail(`dir agents/${ns}`, r);
    }
    // Durable run family: post-fix runs live under agent:<instanceId>;
    // pre-fix runs under agent:<slug>. Purge BOTH (each is a no-op when
    // absent). A refusal here leaves registry rows behind — fail the
    // teardown so retry + sweep finish it; the row is already gone so the
    // agent cannot run again either way.
    try {
      const { durableRuns } = await import("./durable-runs.js");
      for (const target of [...(instanceId ? [`agent:${instanceId}`] : []), `agent:${slug}`]) {
        const purged = await durableRuns.purgeForTarget(target);
        if (purged?.ok === false) markFail(`durable purge ${target}`, purged);
      }
    } catch (e) { markFail("durable purge", e); }
    if (fail) {
      return {
        ok: false,
        retryable: true,
        error: `teardown incomplete (${fail}) — the agent row was removed; retry the delete to finish cleanup`,
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
 * slug is known. */
export function agentMemory(id) {
  return namedAgentMemory(slugifyAgentId(id));
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(apiKey)}`;
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
