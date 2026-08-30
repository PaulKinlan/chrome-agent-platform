// lib/models/local-assistant.js — the KEYLESS first result
// (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01).
//
// A fresh profile has no provider configured. Before this model, the first
// thing a new user saw after typing a task was the demo provider's plumbing
// proof ("[demo model] Task received (N chars)…" — the size of the system
// prompt, and no value). This is a deterministic LanguageModelV2 (AI SDK v7)
// that recognises a small set of tab intents by regex and drives the REAL
// lazy tool protocol (search_tools → execute_tool) exactly as a provider model
// would: the same tools, the same grant gating, the same permission cards, the
// same journal rows. No key, no network, no on-device model.
//
// Intents (the last user turn of the current run):
//   group     "group my tabs by topic"    → list_tabs → group_tabs per site → artifact → paragraph
//   list      "list my tabs"              → list_tabs → artifact → paragraph
//   summarise "summarise my open tabs"    → list_tabs → artifact → paragraph
//   dedupe    "find duplicate tabs"       → list_tabs → artifact → paragraph (reports; never closes)
// Anything else gets LOCAL_ASSISTANT_FALLBACK — never a character count, never
// a bracketed model tag.
//
// Every decision is derived from the CURRENT run slice of the prompt (the tool
// history since the last real user turn) — the model holds no state, so
// concurrent runs and consecutive runs can never bleed into each other (the
// same discipline as demo-model.js). A permission denial is handled the way
// the agent loop asks: "Owner approved … retry with a fresh search_tools
// selection" → one bounded retry; "denied"/"expired" → an honest paragraph.

export const LOCAL_ASSISTANT_MODEL_ID = "local-assistant";

export const LOCAL_ASSISTANT_FALLBACK =
  "I can group, list or summarise your tabs without a model. For anything else, connect a model in Settings — it takes two minutes.";

const TAB_LIST_ASSET_KEY = "tab-list";
const TAB_LIST_ASSET_NAME = "Your open tabs";
const MAX_GROUPS = 4; // bounded: four search + four execute calls in one step each
const MAX_TABS_PER_GROUP = 16; // group_tabs' own schema bound
const MAX_RETRIES_PER_TOOL = 1; // one owner-approved retry per tool

// ── prompt reading (stateless, run-scoped) ──────────────────────────────────

function extractText(messages) {
  let out = "";
  for (const msg of messages ?? []) {
    const c = msg?.content;
    if (typeof c === "string") out += c;
    else if (Array.isArray(c)) {
      for (const part of c) if (part?.type === "text") out += part.text;
    }
  }
  return out;
}

function isAgentDoContinuation(msg) {
  return msg?.role === "user" && /^continue working on the task/i.test(extractText([msg]).trim());
}

/** The current run's slice: from the last NON-continuation user turn onward. */
function runSlice(prompt) {
  const msgs = Array.isArray(prompt) ? prompt : [];
  let lastIdx = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role === "user" && !isAgentDoContinuation(msgs[i])) lastIdx = i;
  }
  return lastIdx === -1 ? msgs : msgs.slice(lastIdx);
}

function taskText(prompt) {
  const slice = runSlice(prompt);
  return slice.length && slice[0]?.role === "user" ? extractText([slice[0]]) : "";
}

/** The intent of a task. Exported for the unit tests. */
export function classifyIntent(text) {
  const t = String(text ?? "").toLowerCase();
  if (!/\btabs?\b/.test(t)) return null;
  if (/\b(group|organi[sz]e|sort|cluster|tidy)\b/.test(t)) return "group";
  if (/\b(dedup\w*|duplicate\w*)\b/.test(t)) return "dedupe";
  if (/\b(summari[sz]e|summary|overview|what am i looking at)\b/.test(t)) return "summarise";
  if (/\b(list|show|what|which|open)\b/.test(t)) return "list";
  return null;
}

// ── tool history ────────────────────────────────────────────────────────────

/** Unwrap one tool output: the AI SDK part's output value, the lazy execute
 * envelope ({ ok, selectedTool, result }), the agent-do { modelContent }
 * wrapper, and raw JSON strings. Returns { value, text } where `value` is the
 * best object form and `text` the flattened string used for the permission
 * messages the loop writes into modelContent. */
function unwrapOutput(part) {
  let raw = part?.output?.value ?? part?.output ?? part?.result ?? part?.error ?? null;
  let text = "";
  const parse = (v) => {
    if (typeof v !== "string") return v;
    const s = v.trim();
    if (!s.startsWith("{") && !s.startsWith("[")) return v;
    try { return JSON.parse(s); } catch { return v; }
  };
  let value = parse(raw);
  if (typeof value === "string") text = value;
  if (value && typeof value === "object" && typeof value.modelContent === "string") {
    text = value.modelContent;
    const inner = parse(value.modelContent);
    if (inner && typeof inner === "object") value = { ...inner, ...value, modelContent: value.modelContent };
  }
  if (!text) {
    try { text = typeof raw === "string" ? raw : JSON.stringify(raw ?? ""); } catch { text = ""; }
  }
  return { value: value && typeof value === "object" ? value : null, text };
}

/** Every tool call the assistant made and every tool result, in order. */
function ledger(prompt) {
  const calls = []; // { toolCallId, toolName, input }
  const results = []; // { toolCallId, toolName, value, text, failed }
  for (const m of runSlice(prompt)) {
    if (!Array.isArray(m?.content)) continue;
    if (m.role === "assistant") {
      for (const p of m.content) {
        if (p?.type !== "tool-call") continue;
        let input = p.input ?? p.args ?? null;
        if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = null; } }
        calls.push({ toolCallId: p.toolCallId, toolName: p.toolName, input: input && typeof input === "object" ? input : {} });
      }
    } else if (m.role === "tool") {
      for (const p of m.content) {
        if (p?.type !== "tool-result" && p?.type !== "tool-error") continue;
        const { value, text } = unwrapOutput(p);
        results.push({
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          value,
          text,
          failed: p.type === "tool-error" || p?.output?.type === "error-text" || p?.output?.type === "error-json",
        });
      }
    }
  }
  return { calls, results };
}

function selectedToolOf(call, result) {
  const selected = result?.value?.selectedTool;
  if (typeof selected === "string") return selected;
  return null;
}

/** The per-tool view: searches issued, selection refs returned, executes and
 * their outcomes. The search query names the tool; the execute envelope's
 * selectedTool confirms it. */
function toolView(prompt, tool) {
  const { calls, results } = ledger(prompt);
  const byId = new Map(results.map((r) => [r.toolCallId, r]));
  const searchRefs = []; // refs returned by search_tools for THIS tool, in order
  const usedRefs = new Set();
  const executes = []; // { result, denial: null | "approved" | "denied" | "expired", ok }
  for (const call of calls) {
    const result = byId.get(call.toolCallId) ?? null;
    if (call.toolName === "search_tools" && call.input?.query === tool) {
      const ref = String(result?.text ?? "").match(/sel_[a-f0-9]{36}/u)?.[0] ?? null;
      searchRefs.push(ref);
    }
    if (call.toolName === "execute_tool" && typeof call.input?.selectionRef === "string") {
      if (!searchRefs.includes(call.input.selectionRef)) continue;
      usedRefs.add(call.input.selectionRef);
      const selected = selectedToolOf(call, result);
      const text = result?.text ?? "";
      const denial = /Owner approved the requested capability/u.test(text)
        ? "approved"
        : /Owner denied the requested capability/u.test(text)
        ? "denied"
        : /Approval expired/u.test(text)
        ? "expired"
        : result?.value?.result?.waitingForPermission === true || result?.value?.waitingForPermission === true
        ? "pending"
        // the legacy denial shape some tools still return ({ error,
        // permissionRequired }) — no card yet (CAP-FB-20260830-DENIAL-TO-GRANT-
        // CARD-01 owns that), so it reads as a pending permission
        : result?.value?.result?.permissionRequired || result?.value?.permissionRequired
        ? "pending"
        : null;
      const inner = result?.value?.result;
      const ok = !!result && !result.failed && result.value?.ok === true && (selected === null || selected === tool) &&
        denial === null && !(inner && typeof inner === "object" && (inner.ok === false || typeof inner.error === "string"));
      executes.push({ result, inner: inner && typeof inner === "object" ? inner : null, denial, ok });
    }
  }
  const freeRefs = searchRefs.filter((r) => r && !usedRefs.has(r));
  return { searches: searchRefs.length, freeRefs, executes };
}

// ── the tab work (pure; exported for the unit tests) ────────────────────────

function siteOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.replace(/^www\./u, "");
    return u.port ? `${host}:${u.port}` : host;
  } catch {
    return null;
  }
}

/** A short group title from a site: the registrable label, capitalised. */
function titleFor(site) {
  const host = site.split(":")[0];
  const labels = host.split(".");
  const label = /^\d+$/u.test(labels[labels.length - 1] ?? "") || labels.length < 2
    ? site
    : labels[labels.length - 2];
  const t = label.slice(0, 1).toUpperCase() + label.slice(1);
  return t.slice(0, 128);
}

/** Cluster http(s) tabs by site. Only sites with two or more tabs become a
 * group (a single tab has nothing to be grouped with); at most MAX_GROUPS
 * groups, largest first. */
export function clusterTabs(tabs) {
  const bySite = new Map();
  for (const t of Array.isArray(tabs) ? tabs : []) {
    const id = Number(t?.id);
    if (!Number.isInteger(id) || id < 1) continue;
    const site = siteOf(t?.url);
    if (!site) continue;
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push({ id, title: String(t?.title ?? ""), url: String(t?.url ?? "") });
  }
  return [...bySite.entries()]
    .filter(([, list]) => list.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_GROUPS)
    .map(([site, list]) => ({
      site,
      title: titleFor(site),
      tabIds: list.slice(0, MAX_TABS_PER_GROUP).map((t) => t.id),
      tabs: list.slice(0, MAX_TABS_PER_GROUP),
    }));
}

const GROUP_COLORS = ["blue", "green", "yellow", "purple", "cyan", "orange", "pink", "red"];

/** Duplicate URLs (exact match after stripping the fragment). */
export function duplicateTabs(tabs) {
  const seen = new Map();
  for (const t of Array.isArray(tabs) ? tabs : []) {
    const key = String(t?.url ?? "").split("#")[0];
    if (!key || !siteOf(key)) continue;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(t);
  }
  return [...seen.entries()].filter(([, list]) => list.length >= 2).map(([url, list]) => ({ url, count: list.length }));
}

/** Escape untrusted text for the artifact HTML (tab titles and URLs are
 * page-controlled). Local on purpose: this file runs in the agent worker,
 * where the components module (a DOM custom-element file) cannot load. */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** The tab-list artifact: every http(s) tab, by site. Exported for tests. */
export function tabListHtml(tabs) {
  const bySite = new Map();
  for (const t of Array.isArray(tabs) ? tabs : []) {
    const site = siteOf(t?.url);
    if (!site) continue;
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(t);
  }
  const sites = [...bySite.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const total = sites.reduce((n, [, l]) => n + l.length, 0);
  const sections = sites.map(([site, list]) => {
    const items = list.map((t) => {
      const title = String(t?.title ?? "").trim() || String(t?.url ?? "");
      return `<li><a href="${escapeHtml(t?.url)}" rel="noreferrer">${escapeHtml(title)}</a></li>`;
    }).join("");
    return `<section><h2>${escapeHtml(site)} <small>(${list.length})</small></h2><ul>${items}</ul></section>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(TAB_LIST_ASSET_NAME)}</title>` +
    `<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#1d1b18;background:#fff}h1{font-size:18px}h2{font-size:14px;margin:18px 0 4px}small{font-weight:400;color:#635e56}ul{margin:0;padding-left:20px}a{color:#0e6e63}</style>` +
    `<h1>${escapeHtml(TAB_LIST_ASSET_NAME)}</h1><p>${total} ${total === 1 ? "tab" : "tabs"} across ${sites.length} ${sites.length === 1 ? "site" : "sites"}.</p>${sections}`;
}

/** The paragraph the run ends in. Exported for tests. */
export function resultParagraph({ intent, tabs, clusters, grouped, groupDenied, artifactOk, duplicates }) {
  const sentences = [];
  const total = (Array.isArray(tabs) ? tabs : []).filter((t) => siteOf(t?.url)).length;
  const sites = new Set((Array.isArray(tabs) ? tabs : []).map((t) => siteOf(t?.url)).filter(Boolean));
  const tabWord = (n) => `${n} ${n === 1 ? "tab" : "tabs"}`;
  const siteWord = (n) => `${n} ${n === 1 ? "site" : "sites"}`;
  if (intent === "group") {
    const made = (clusters ?? []).filter((_, i) => grouped?.[i] === true);
    if (made.length > 0) {
      const names = made.map((c) => `${c.title} (${c.tabIds.length})`).join(", ");
      const inGroups = made.reduce((n, c) => n + c.tabIds.length, 0);
      sentences.push(`Grouped ${tabWord(inGroups)} into ${made.length === 1 ? "one group" : `${made.length} groups`} by site: ${names}.`);
      const rest = total - inGroups;
      if (rest > 0) sentences.push(`${tabWord(rest)} stayed ungrouped because ${rest === 1 ? "it was" : "each was"} the only tab on ${rest === 1 ? "its" : "their"} site.`);
    } else if (groupDenied) {
      sentences.push(`Your ${tabWord(total)} across ${siteWord(sites.size)} were not grouped because the tab-groups permission was not granted — allow it when asked and run this again.`);
    } else if ((clusters ?? []).length === 0) {
      sentences.push(`Your ${tabWord(total)} are each on a different site, so there was nothing to group together — open two tabs on the same site and run this again.`);
    } else {
      sentences.push(`Your ${tabWord(total)} across ${siteWord(sites.size)} could not be grouped this time.`);
    }
  } else if (intent === "dedupe") {
    const dups = duplicates ?? [];
    if (dups.length === 0) sentences.push(`No duplicate tabs: your ${tabWord(total)} across ${siteWord(sites.size)} all have different addresses.`);
    else sentences.push(`Found ${dups.length === 1 ? "one duplicated address" : `${dups.length} duplicated addresses`} among your ${tabWord(total)}: ${dups.map((d) => `${d.url} (${d.count})`).join(", ")}. I did not close anything — closing tabs is yours to decide.`);
  } else {
    const top = [...sites].slice(0, 5).join(", ");
    sentences.push(`You have ${tabWord(total)} open across ${siteWord(sites.size)}${top ? `: ${top}` : ""}.`);
  }
  sentences.push(artifactOk
    ? `The full list is saved as the artifact "${TAB_LIST_ASSET_NAME}".`
    : "The tab list could not be saved as an artifact this time.");
  return sentences.join(" ");
}

const NO_TABS_PERMISSION =
  "I could not see your tabs because the tabs permission was not granted. Allow it when asked and run this again.";

// ── the model ───────────────────────────────────────────────────────────────

function priorFinalText(prompt) {
  const texts = runSlice(prompt)
    .filter((m) => m?.role === "assistant" && Array.isArray(m?.content))
    .flatMap((m) => m.content)
    .filter((p) => p?.type === "text" && String(p.text ?? "").trim())
    .map((p) => p.text);
  return texts.length ? texts[texts.length - 1] : null;
}

function searchCall(id, query) {
  return { id, name: "search_tools", input: { query, limit: 1 } };
}

function executeCall(id, selectionRef, args) {
  return { id, name: "execute_tool", input: { selectionRef, arguments: args } };
}

/** The tabs from a successful list_tabs execute (http(s) and other). */
function listedTabs(view) {
  const ok = [...view.executes].reverse().find((e) => e.ok && Array.isArray(e.inner?.tabs));
  return ok ? ok.inner.tabs : null;
}

/** One step of the plan: an array of tool calls, or { text } for the answer. */
export function planStep(prompt) {
  const prior = priorFinalText(prompt);
  if (prior) return { text: prior }; // continuation after the answer: re-emit it, never restart
  const intent = classifyIntent(taskText(prompt));
  if (!intent) return { text: LOCAL_ASSISTANT_FALLBACK };

  // 1. list_tabs
  const list = toolView(prompt, "list_tabs");
  const tabs = listedTabs(list);
  if (!tabs) {
    const last = list.executes[list.executes.length - 1] ?? null;
    if (last?.denial === "denied" || last?.denial === "expired") return { text: NO_TABS_PERMISSION };
    if (last?.denial === "pending") return { text: NO_TABS_PERMISSION };
    const retries = list.executes.filter((e) => e.denial === "approved").length;
    if (last && !last.ok && last.denial !== "approved") {
      return { text: "I could not read your tabs this time — open Settings → Permissions to check the tabs permission, then run this again." };
    }
    if (retries > MAX_RETRIES_PER_TOOL) return { text: NO_TABS_PERMISSION };
    if (list.freeRefs.length > 0) return [executeCall("execute_list_tabs", list.freeRefs[0], {})];
    if (list.searches > list.executes.length) return { text: "The tool catalogue did not offer list_tabs this time — try again in a moment." };
    return [searchCall("search_list_tabs", "list_tabs")];
  }

  // 2. group_tabs (group intent only) + create_asset, searched and executed together
  const clusters = intent === "group" ? clusterTabs(tabs) : [];
  const group = toolView(prompt, "group_tabs");
  const asset = toolView(prompt, "create_asset");
  // A round is one execute per cluster. The LAST round settles the grouping
  // unless the owner approved a permission mid-round (then one bounded retry).
  const rounds = clusters.length ? Math.floor(group.executes.length / clusters.length) : 0;
  const lastRound = rounds > 0 ? group.executes.slice((rounds - 1) * clusters.length) : [];
  const groupSettled = clusters.length === 0 ||
    (lastRound.length > 0 && !lastRound.some((e) => e.denial === "approved")) ||
    rounds > MAX_RETRIES_PER_TOOL;
  const assetSettled = asset.executes.length > 0;
  const wantGroupRound = !groupSettled;
  const wantAssetRound = !assetSettled;
  if (wantGroupRound || wantAssetRound) {
    const needGroupRefs = wantGroupRound ? clusters.length : 0;
    const needAssetRefs = wantAssetRound ? 1 : 0;
    const haveGroup = group.freeRefs.length >= needGroupRefs;
    const haveAsset = asset.freeRefs.length >= needAssetRefs;
    if (!haveGroup || !haveAsset) {
      const calls = [];
      if (!haveGroup) for (let i = group.freeRefs.length; i < needGroupRefs; i++) calls.push(searchCall(`search_group_tabs_${i}`, "group_tabs"));
      if (!haveAsset) calls.push(searchCall("search_create_asset", "create_asset"));
      // A search that came back without a ref means the catalogue refused the
      // tool: never loop on it — settle with what there is.
      const emptySearch = (!haveGroup && group.searches > group.executes.length + group.freeRefs.length) ||
        (!haveAsset && asset.searches > asset.executes.length + asset.freeRefs.length);
      if (!emptySearch) return calls;
    } else {
      const calls = [];
      if (wantGroupRound) {
        clusters.forEach((c, i) => {
          calls.push(executeCall(`execute_group_tabs_${i}`, group.freeRefs[i], {
            tabIds: c.tabIds,
            title: c.title,
            color: GROUP_COLORS[i % GROUP_COLORS.length],
          }));
        });
      }
      if (wantAssetRound) {
        calls.push(executeCall("execute_create_asset", asset.freeRefs[0], {
          origin: "master",
          type: "html",
          key: TAB_LIST_ASSET_KEY,
          name: TAB_LIST_ASSET_NAME,
          content: tabListHtml(tabs),
        }));
      }
      if (calls.length) return calls;
    }
  }

  // 3. the answer
  // The LATEST execute per cluster decides (a denied first attempt followed by
  // an approved retry must read as grouped).
  const grouped = clusters.map((_, i) => {
    const mine = group.executes.filter((e, idx) => idx % Math.max(1, clusters.length) === i);
    return mine.some((e) => e.ok);
  });
  const groupDenied = group.executes.some((e) => e.denial === "denied" || e.denial === "expired" || e.denial === "pending") &&
    !group.executes.some((e) => e.ok);
  const artifactOk = asset.executes.some((e) => e.ok);
  return {
    text: resultParagraph({
      intent,
      tabs,
      clusters,
      grouped,
      groupDenied,
      artifactOk,
      duplicates: intent === "dedupe" ? duplicateTabs(tabs) : [],
    }),
  };
}

export function createLocalAssistant() {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const toContent = (step) => Array.isArray(step)
    ? step.map((call) => ({
      type: "tool-call",
      toolCallId: `call_local_${call.id}_${crypto.randomUUID?.().slice(0, 8) ?? Math.random().toString(16).slice(2, 10)}`,
      toolName: call.name,
      input: JSON.stringify(call.input),
    }))
    : [{ type: "text", text: step.text }];
  return {
    specificationVersion: "v2",
    provider: "local",
    modelId: LOCAL_ASSISTANT_MODEL_ID,
    supportedUrls: {},

    doGenerate(options) {
      const step = planStep(options.prompt);
      const content = toContent(step);
      return Promise.resolve({
        content,
        finishReason: Array.isArray(step) ? "tool-calls" : "stop",
        usage,
        warnings: [],
      });
    },

    doStream(options) {
      const step = planStep(options.prompt);
      const id = `local-${crypto.randomUUID?.() ?? Math.random()}`;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (Array.isArray(step)) {
            for (const part of toContent(step)) controller.enqueue(part);
            controller.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
            controller.close();
            return;
          }
          controller.enqueue({ type: "text-start", id });
          for (const chunk of step.text.match(/.{1,24}/gs) ?? [step.text]) {
            controller.enqueue({ type: "text-delta", id, delta: chunk });
          }
          controller.enqueue({ type: "text-end", id });
          controller.enqueue({ type: "finish", usage, finishReason: "stop" });
          controller.close();
        },
      });
      return Promise.resolve({ stream });
    },
  };
}
