// extension/shared/thread-view.js — the pure, unit-testable rules behind the
// thread view's run state, scroll behaviour and card titles
// (CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01). No DOM here: the components
// call these so the behaviour is falsifiable without a browser.

import { humanToolLabel } from "./permission-language.js";

/** The banner label while a run is live: "Working — <activity>…". The activity
 *  arrives from the progress port (friendlyActivityLabel / "Writing the
 *  answer…" / "Thinking · step 2 of 4"); its first letter is lower-cased so
 *  the sentence reads as one, and a trailing ellipsis is added exactly once.
 *  No activity → the plain "Working…". */
/** @param {unknown} activity */
export function composeWorkingLabel(activity) {
  const raw = typeof activity === "string" ? activity.trim() : "";
  if (!raw) return "Working…";
  const stripped = raw.replace(/[….]+$/u, "").trim();
  if (!stripped) return "Working…";
  const first = [...stripped][0];
  const rest = stripped.slice(first.length);
  // A step label ("Thinking · step 2") keeps its capital when it is a proper
  // noun-like token; everything else joins the sentence in lower case.
  const lowered = first.toLowerCase() + rest;
  return `Working — ${lowered}…`;
}

/** The "stick to bottom" latch: the owner is at (or within `slack` px of) the
 *  bottom of the scroll container, so appended rows may auto-scroll. Scrolled
 *  up beyond the slack → the owner is reading; do not yank the view. A
 *  container that does not scroll at all is always "at the bottom". */
/**
 * @param {{ scrollTop?: number, clientHeight?: number, scrollHeight?: number }} [metrics]
 * @param {number} [slack]
 */
export function isScrolledToBottom(metrics = {}, slack = 24) {
  const { scrollTop, clientHeight, scrollHeight } = metrics ?? {};
  const top = Number(scrollTop) || 0;
  const client = Number(clientHeight) || 0;
  const height = Number(scrollHeight) || 0;
  if (height <= client) return true;
  return top + client >= height - slack;
}

/** Bounded, single-line artifact name for a card head; null when absent. */
function cleanName(value) {
  if (typeof value !== "string") return null;
  const s = value.replace(/\s+/gu, " ").trim();
  return s ? s.slice(0, 120) : null;
}

function parseMaybe(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Unwrap the lazy-protocol / agent-do envelopes (`{modelContent}`,
 *  `{ok, result}`) that wrap a tool's own result. Bounded depth. */
function unwrapEnvelope(value, depth = 0) {
  const v = parseMaybe(value);
  if (!v || typeof v !== "object" || Array.isArray(v) || depth > 4) return v;
  if (typeof v.modelContent === "string" || (v.modelContent && typeof v.modelContent === "object")) {
    const inner = unwrapEnvelope(v.modelContent, depth + 1);
    if (inner && typeof inner === "object") return inner;
  }
  if (v.result !== undefined && (v.selectedTool !== undefined || v.ok !== undefined)) {
    const inner = unwrapEnvelope(v.result, depth + 1);
    if (inner && typeof inner === "object" && !Array.isArray(inner)) return { ...v, ...inner, result: v.result };
  }
  // The lazy CALL shape (execute_tool args as persisted): { selectionRef,
  // arguments: { id, name, content } } — the tool's own arguments sit one
  // level down.
  if (v.arguments && typeof v.arguments === "object" && !Array.isArray(v.arguments)) {
    return { ...v, ...v.arguments, arguments: v.arguments };
  }
  return v;
}

/** Title for a generated-UI / artifact card. Resolution order: an explicit
 *  `name` in the args (create_asset), the asset's name in the result
 *  (update_asset returns the updated asset), a name the conversation already
 *  knows for that id (`lookup(id)` — the create card that came before), and
 *  only then a truthful generic title by tool ("Updated artifact"), never the
 *  meaningless "Generated UI". */
/**
 * @param {{ toolName?: string, args?: unknown, result?: unknown, detail?: unknown, lookup?: ((id: string) => unknown) | null }} [input]
 * @returns {string}
 */
export function artifactCardTitle(input = {}) {
  const { toolName = "", args = null, result = null, detail = null, lookup = null } = input ?? {};
  const candidates = [args, result, detail].map(unwrapEnvelope);
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const name = cleanName(c.name) ?? cleanName(c.asset?.name);
    if (name) return name;
  }
  if (typeof lookup === "function") {
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const id = typeof c.id === "string" ? c.id : (typeof c.asset?.id === "string" ? c.asset.id : null);
      if (!id) continue;
      const known = cleanName(lookup(id));
      if (known) return known;
    }
  }
  switch (toolName) {
    case "update_asset": return "Updated artifact";
    case "patch_asset": return "Edited artifact";
    case "create_asset": return "New artifact";
    default: return "Generated page";
  }
}

/** The artifact identity (id + name) a tool payload carries, unwrapping the
 *  lazy / agent-do envelopes; null when the payload names no asset. Lets a
 *  conversation remember id → name from the create card so the later update
 *  card (id only) can be titled. */
/** @param {unknown[]} payloads */
export function artifactIdentityFromPayloads(payloads = []) {
  for (const raw of Array.isArray(payloads) ? payloads : []) {
    const c = unwrapEnvelope(raw);
    if (c && typeof c === "object") {
      const asset = c.asset && typeof c.asset === "object" ? c.asset : null;
      const id = typeof asset?.id === "string" && asset.id ? asset.id : (typeof c.id === "string" && c.id ? c.id : null);
      const name = cleanName(asset?.name) ?? cleanName(c.name);
      if (id && name) return { id, name };
      continue;
    }
    // The progress port bounds a tool result to ~300 characters, so the live
    // payload is often a TRUNCATED, no-longer-parseable JSON string (nested
    // envelopes escape their quotes). Read the asset's own id + name out of
    // the `asset` object's text — the identity sits at its head — without
    // trusting anything else in it.
    const text = typeof raw === "string" ? raw : "";
    const at = text.search(/\\*"asset\\*"\s*:\s*\{/u);
    if (at < 0) continue;
    const head = text.slice(at, at + 400);
    const id = head.match(/\\*"id\\*"\s*:\s*\\*"([A-Za-z0-9_.:-]{1,80})\\*"/u)?.[1] ?? null;
    const name = head.match(/\\*"name\\*"\s*:\s*\\*"((?:[^"\\]|\\[^"])(?:[^"\\]|\\[^"]){0,119})\\*"/u)?.[1] ?? null;
    const clean = cleanName(name);
    if (id && clean) return { id, name: clean };
  }
  return null;
}

/** The per-turn time label: `<time datetime>` gets the ISO instant, the
 *  visible text is short and local ("just now", "3m ago", "14:05", or
 *  "Aug 30 14:05" on another day). `now` is injectable for tests. */
/** @param {unknown} ts @param {number} [now] */
export function turnTime(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = new Date(t);
  const delta = now - t;
  let label;
  if (delta < 60 * 1000 && delta > -60 * 1000) label = "just now";
  else if (delta < 60 * 60 * 1000 && delta > 0) label = `${Math.max(1, Math.round(delta / 60000))}m ago`;
  else {
    const sameDay = new Date(now).toDateString() === d.toDateString();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    label = sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  }
  return { iso: d.toISOString(), label, full: d.toLocaleString() };
}

/** Strip model-addressed instructions and third-person capability denials
 * from owner-facing text rendering. Pure. */
export function stripModelAddressedText(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/Owner denied the requested capability\.\s*/gi, "")
    .replace(/(?:[a-zA-Z0-9_-]+\s+)?was not performed;\s*do not retry it\.?/gi, "")
    .replace(/The user declined this tool call[^\n.]*\.?\s*/gi, "")
    .replace(/Do not retry (?:the same call|it)\.?\s*/gi, "")
    .replace(/do not retry it\.?\s*/gi, "")
    .trim();
}

/** Whether a tool result signals that the tool call was declined by the owner. */
export function isToolResultDeclined(raw) {
  if (raw == null) return false;
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  return /Owner denied the requested capability|user declined this tool call|declined\b|user denied|do not retry/i.test(s);
}

export function isProtocolTool(name) {
  return name === "search_tools" || name === "list_tools";
}

function visibleSiteToolLabel(value, maxInputChars) {
  if (typeof value !== "string" || !value || value.length > maxInputChars) return "";
  try {
    const label = value.normalize("NFC").replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, (char) =>
      `\\u{${char.codePointAt(0).toString(16).toUpperCase()}}`
    );
    return label.length <= maxInputChars ? label : "";
  } catch {
    return "";
  }
}

function boundSiteToolActivity(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  let keys;
  try {
    const proto = Object.getPrototypeOf(detail);
    if (proto !== Object.prototype && proto !== null) return undefined;
    keys = Reflect.ownKeys(detail);
  } catch { return undefined; }
  if (keys.length !== 2 || !keys.includes("origin") || !keys.includes("tool")) return undefined;
  const originDescriptor = Object.getOwnPropertyDescriptor(detail, "origin");
  const toolDescriptor = Object.getOwnPropertyDescriptor(detail, "tool");
  if (!originDescriptor?.enumerable || !("value" in originDescriptor) || !toolDescriptor?.enumerable || !("value" in toolDescriptor)) return undefined;
  const origin = originDescriptor.value;
  const tool = toolDescriptor.value;
  if (typeof origin !== "string" || origin.length > 240 || typeof tool !== "string" || !tool || tool.length > 128 || visibleSiteToolLabel(tool, 128) !== tool) return undefined;
  try {
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) return undefined;
  } catch { return undefined; }
  return { origin, tool };
}

function unwrapLazy(value, structured = false, depth = 0) {
  if (depth > 6 || value == null) return value;
  let v = value;
  for (let i = 0; i < 4; i++) {
    if (typeof v === "string") {
      const trimmed = v.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try { v = JSON.parse(v); } catch { return v; }
      } else {
        return v;
      }
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    let first = null;
    let second = null;
    if ("modelContent" in v && v.modelContent !== undefined) {
      first = v.modelContent;
    }
    if ("result" in v && v.result !== undefined && (v.selectedTool !== undefined || v.ok !== undefined)) {
      second = v.result;
    }
    if (structured && second != null) { v = second; continue; }
    if (first != null) { v = first; continue; }
    if (second != null) { v = second; continue; }
    return v;
  }
  return v;
}

function unwrapLazyEnvelope(value) { return unwrapLazy(value, false); }

function effectiveToolCall(toolName, args, result) {
  const name = String(toolName ?? "");
  if (name !== "execute_tool" && name !== "search_tools") {
    return { name, args, lazy: false };
  }
  const outer = unwrapLazyEnvelope(result);
  const selected = outer && typeof outer === "object" && typeof outer.selectedTool === "string"
    ? outer.selectedTool
    : null;
  const rawArgs = unwrapLazyEnvelope(args);
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) &&
      rawArgs.arguments !== undefined && "selectionRef" in rawArgs) {
    return { name: selected || name, args: rawArgs.arguments, lazy: true };
  }
  return { name: selected || name, args, lazy: true };
}

function pairToolJournal(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const byCall = new Map();
  const order = [];
  const legacyCallSeq = new Map();
  const legacyResultSeq = new Map();
  const legacyId = (r) => {
    const k = `${r.id ?? ""}::${r.tool ?? ""}`;
    if (r.type === "tool-call") {
      const n = legacyCallSeq.get(k) ?? 0;
      legacyCallSeq.set(k, n + 1);
      return `legacy:${k}:${n}`;
    }
    const n = legacyResultSeq.get(k) ?? 0;
    legacyResultSeq.set(k, n + 1);
    return `legacy:${k}:${n}`;
  };
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    if (r.type === "tool-call" || r.type === "tool-result") {
      const id = typeof r.callId === "string" && r.callId
        ? `${r.run ?? ""}::${r.callId}`
        : legacyId(r);
      const entry = byCall.get(id);
      if (!entry) {
        byCall.set(id, { call: null, result: null, ts: typeof r.ts === "number" ? r.ts : null, duplicate: false });
        order.push(id);
      }
      if (r.type === "tool-call") {
        if (!byCall.get(id).call) byCall.get(id).call = r;
        else byCall.get(id).duplicate = true;
      } else {
        if (!byCall.get(id).result) byCall.get(id).result = r;
        else byCall.get(id).duplicate = true;
      }
    }
  }
  const out = [];
  for (const id of order) {
    const { call, result, ts } = byCall.get(id);
    const ok = result?.ok;
    let status;
    if (!result) status = "done";
    else if (ok === false) status = "error";
    else if (ok === true) status = "success";
    else {
      const s = String(result.result ?? "");
      status = /^\s*failed\b/i.test(s) || /^\s*\[[^\]]+\]\s*DENIED/i.test(s) ? "error" : "success";
    }
    const rawTool = call?.tool ?? result?.tool ?? "tool";
    const eff = effectiveToolCall(rawTool, call?.args ?? null, result?.result ?? null);
    const resolvedTool = typeof result?.selectedTool === "string" && result.selectedTool
      ? result.selectedTool
      : (eff.lazy && eff.name !== rawTool ? eff.name : rawTool);
    out.push({
      type: "tool",
      tool: resolvedTool,
      status,
      selectedTool: typeof result?.selectedTool === "string" && result.selectedTool ? result.selectedTool : null,
      callId: call?.callId ?? result?.callId ?? id,
      args: call?.args ?? result?.args ?? null,
      result: result?.result ?? null,
      resultFull: typeof result?.resultFull === "string" && result.resultFull ? result.resultFull : null,
      resultFullTruncated: result?.resultFullTruncated === true,
      resultFullBytes: Number.isFinite(result?.resultFullBytes) ? result.resultFullBytes : null,
      ok: result?.ok ?? null,
      permissionRequirement: result?.permissionRequirement ?? null,
      permissionDecision: result?.permissionDecision ?? null,
      siteActivity: boundSiteToolActivity(result?.siteActivity),
      reexecuted: result?.reexecuted === true,
      ts,
      duplicate: byCall.get(id)?.duplicate === true,
    });
  }
  return out;
}

function extractVersionFromResultText(result) {
  const text = typeof result === "string" ? result : "";
  const m = text.match(/\\*"version\\*"\s*:\s*(\d{1,9})/u);
  return m ? Number(m[1]) : null;
}

function isImageTool(name) {
  return name === "generate_image" || name === "create_image_asset" || name === "edit_image";
}

function artifactFromToolResult(toolName, result, selectedTool, args) {
  const tool = selectedTool || toolName;
  if (!tool) return null;
  const unwrapEnvelopeLocal = (val) => {
    try { return typeof val === "string" ? JSON.parse(val) : val; } catch { return null; }
  };
  const cand = unwrapEnvelopeLocal(result);
  if (!cand || typeof cand !== "object") return null;
  const asset = cand.asset && typeof cand.asset === "object" ? cand.asset : cand;
  if (asset && typeof asset.id === "string" && asset.id) {
    return {
      id: asset.id,
      name: typeof asset.name === "string" ? asset.name : "Artifact",
      type: typeof asset.type === "string" ? asset.type : "file",
      version: typeof asset.version === "number" ? asset.version : (extractVersionFromResultText(result) ?? 1),
    };
  }
  return null;
}

function imageItemsFromToolCards(cards) {
  const out = [];
  for (const c of cards) {
    if (c.artifact && c.artifact.type === "image" && c.status !== "error") {
      out.push({ id: c.artifact.id, label: c.artifact.name, kind: "image" });
    }
  }
  return out;
}

/** The REOPEN projection for a persisted task thread. Pure. */
export function projectThreadMessages(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  if (!messages.length) return [];

  const bodyArtifactsByCall = new Map();
  for (const m of messages) {
    if (m && m.role === "artifact" && m.artifact && typeof m.artifact === "object" && m.artifact.id && m.toolCallId) {
      if (!bodyArtifactsByCall.has(m.toolCallId)) bodyArtifactsByCall.set(m.toolCallId, m);
    }
  }

  const rawTools = messages.filter((m) => m && m.role === "tool" && m.protocol !== true && !isProtocolTool(m.toolName));
  const pairedTools = pairToolJournal(
    rawTools.map((m) => ({
      type: m.toolStatus === "running" ? "tool-call" : "tool-result",
      callId: m.toolCallId ?? null,
      run: null,
      tool: m.toolName ?? "tool",
      selectedTool: m.selectedTool ?? null,
      args: m.toolArgs ?? null,
      result: m.toolResult ?? null,
      resultFull: typeof m.toolDetail === "string" && m.toolDetail ? m.toolDetail : null,
      ok: m.toolOk ?? null,
      siteActivity: boundSiteToolActivity(m.siteActivity),
      ts: typeof m.ts === "number" ? m.ts : null,
      executionId: m.executionId ?? null,
    })),
  );
  const noteByCall = new Map();
  for (const m of rawTools) if (m.toolCallId && typeof m.toolDetailNote === "string" && m.toolDetailNote) noteByCall.set(m.toolCallId, m.toolDetailNote);

  const toolCards = pairedTools.map((t) => {
    const orig = rawTools.find((m) =>
      (t.callId && m.toolCallId === t.callId) ||
      (m.toolName === t.tool && (m.toolResult === t.result || m.toolArgs === t.args))
    );
    return {
      role: "tool",
      name: t.tool,
      status: t.status,
      args: t.args ?? null,
      result: t.result ?? null,
      detail: t.resultFull ?? null,
      detailNote: (t.callId && noteByCall.get(t.callId)) || null,
      selectedTool: t.selectedTool ?? null,
      siteActivity: t.siteActivity && visibleSiteToolLabel(t.tool, 128) === t.siteActivity.tool
        ? t.siteActivity
        : null,
      ts: t.ts ?? null,
      executionId: t.executionId ?? orig?.executionId ?? null,
      callId: t.callId,
    };
  });

  const emittedTools = new Set();
  const seenApprovalKeys = new Set();
  const turns = [];
  let currentTurn = { user: null, systems: [], tools: [], approvals: [], terminals: [], execId: null };

  const flushTurn = () => {
    if (currentTurn.user || currentTurn.systems.length || currentTurn.tools.length || currentTurn.approvals.length || currentTurn.terminals.length) {
      turns.push(currentTurn);
    }
    currentTurn = { user: null, systems: [], tools: [], approvals: [], terminals: [], execId: null };
  };

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;

    if (role === "user") {
      if (currentTurn.user || currentTurn.terminals.length || currentTurn.tools.length) {
        flushTurn();
      }
      currentTurn.user = {
        role: "user",
        content: m.content,
        ts: m.ts ?? null,
        attachments: Array.isArray(m.attachments) ? m.attachments : (m.attachments ? [m.attachments] : null),
        executionId: m.executionId ?? null,
      };
      if (m.executionId) currentTurn.execId = m.executionId;
    } else if (role === "system" || role === "thinking") {
      currentTurn.systems.push({
        role,
        content: m.content,
        ts: m.ts ?? null,
      });
    } else if (role === "assistant" || role === "error" || role === "agent") {
      if (currentTurn.terminals.length && m.executionId && currentTurn.execId && m.executionId !== currentTurn.execId) {
        flushTurn();
      }
      currentTurn.terminals.push({
        role,
        content: m.content,
        ts: m.ts ?? null,
        reason: m.reason ?? null,
        action: m.action ?? null,
        executionId: m.executionId ?? null,
      });
      if (m.executionId && !currentTurn.execId) currentTurn.execId = m.executionId;
    } else if (role === "approval") {
      const req = m.requirement;
      const key = typeof req?.key === "string" && req.key ? req.key : null;
      if (req && typeof req === "object" && (!key || !seenApprovalKeys.has(key))) {
        if (key) seenApprovalKeys.add(key);
        currentTurn.approvals.push({
          role: "approval",
          requirement: req,
          executionId: m.executionId ?? null,
          toolCallId: m.toolCallId ?? null,
          ts: m.ts ?? null,
          ...(typeof m.state === "string" && m.state ? { state: m.state } : {}),
          ...(typeof m.detail === "string" && m.detail ? { detail: m.detail } : {}),
        });
        if (m.executionId && !currentTurn.execId) currentTurn.execId = m.executionId;
      }
    } else if (role === "tool") {
      if (m.protocol === true || isProtocolTool(m.toolName)) continue;
      const callId = m.toolCallId;
      const idx = toolCards.findIndex((tc, i) =>
        !emittedTools.has(i) && (
          (callId && tc.callId === callId) ||
          (m.executionId && tc.executionId === m.executionId && tc.name === m.toolName) ||
          (tc.name === m.toolName)
        )
      );
      if (idx >= 0 && !emittedTools.has(idx)) {
        currentTurn.tools.push(toolCards[idx]);
        emittedTools.add(idx);
        if (toolCards[idx].executionId && !currentTurn.execId) {
          currentTurn.execId = toolCards[idx].executionId;
        }
      }
    }
  }
  flushTurn();

  for (let i = 0; i < toolCards.length; i++) {
    if (emittedTools.has(i)) continue;
    const tc = toolCards[i];
    if (tc.executionId) {
      const matchTurn = turns.find((t) => t.execId === tc.executionId);
      if (matchTurn) {
        matchTurn.tools.push(tc);
        emittedTools.add(i);
      }
    }
  }

  const remainingTools = [];
  for (let i = 0; i < toolCards.length; i++) {
    if (!emittedTools.has(i)) {
      remainingTools.push(toolCards[i]);
      emittedTools.add(i);
    }
  }

  const output = [];
  for (const turn of turns) {
    if (turn.systems.length) output.push(...turn.systems);
    if (turn.user) output.push(turn.user);

    const hasDeniedApproval = turn.approvals.some((a) => a.state === "denied");
    const deniedTools = new Set();
    for (const a of turn.approvals) {
      if (a.state === "denied") {
        const t = a.requirement?.tool || a.requirement?.toolName || a.tool;
        if (t) deniedTools.add(t);
        if (Array.isArray(a.requirement?.permissions) && a.requirement.permissions.includes("tabs")) {
          deniedTools.add("list_tabs");
          deniedTools.add("browser_list_tabs");
        }
      }
    }

    if (turn.tools.length) {
      turn.tools.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      const imageCards = [];
      for (const tc of turn.tools) {
        const isDeclined = tc.status === "declined" || tc.status === "skipped" ||
          isToolResultDeclined(tc.result) || isToolResultDeclined(tc.detail);

        if (isDeclined) {
          if (hasDeniedApproval || deniedTools.has(tc.name)) {
            // Suppress duplicate role: "tool" declined card when a denied approval row is already present
            continue;
          }
          // Render declined role: "tool" without an approval card as the same quiet inline line
          output.push({
            role: "tool",
            name: tc.name,
            status: "done",
            skipped: true,
            content: `You skipped ${humanToolLabel(tc.name).toLowerCase()}.`,
            ts: tc.ts ?? null,
            executionId: tc.executionId ?? null,
          });
          continue;
        }

        output.push(tc);
        const persisted = tc.callId ? bodyArtifactsByCall.get(tc.callId) : null;
        const artifact = persisted?.artifact
          ?? (tc.status === "error" ? null : artifactFromToolResult(tc.name, tc.detail ?? tc.result, tc.selectedTool, tc.args));
        if (artifact) {
          output.push({
            role: "artifact",
            artifact,
            toolCallId: tc.callId ?? null,
            executionId: tc.executionId ?? null,
            ts: persisted?.ts ?? tc.ts ?? null,
            derived: true,
          });
        }
        imageCards.push({ status: tc.status === "error" ? "error" : "success", result: tc.detail ?? tc.result, artifact });
      }
      const imageItems = imageItemsFromToolCards(imageCards);
      if (imageItems.length) {
        output.push({ role: "images", items: imageItems, executionId: turn.execId ?? null, ts: null, derived: true });
      }
    }
    if (turn.approvals.length) {
      turn.approvals.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      output.push(...turn.approvals);
    }
    if (turn.terminals.length) {
      turn.terminals.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      output.push(...turn.terminals);
    }
  }

  if (remainingTools.length) {
    remainingTools.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    for (const tc of remainingTools) {
      const isDeclined = tc.status === "declined" || tc.status === "skipped" ||
        isToolResultDeclined(tc.result) || isToolResultDeclined(tc.detail);
      if (isDeclined) {
        output.push({
          role: "tool",
          name: tc.name,
          status: "done",
          skipped: true,
          content: `You skipped ${humanToolLabel(tc.name).toLowerCase()}.`,
          ts: tc.ts ?? null,
          executionId: tc.executionId ?? null,
        });
      } else {
        output.push(tc);
      }
    }
  }

  return output;
}
