// panels/usage.js — Usage Settings panel module.

import {
  USAGE_RANGES,
  dayBuckets,
  filterRowsByRange,
  formatCost,
  formatTokens,
  shareBars,
  svgDailyBars,
  svgShareBars,
  topTools,
} from "../../lib/usage-viz.js";
import { escapeHtml } from "../../shared/components-core.js";
import { createPanelContext, bindPanelCtx } from "../panel-context.js";

let currentUsageRange = "7d"; // hoisted above renderUsage — no TDZ on section open

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("usage");

export async function renderUsage(range = currentUsageRange, ctx) {
  if (ctx) ensureCtx(null, ctx);
  currentUsageRange = USAGE_RANGES[range] ? range : "7d";
  // Usage is shared state — read it through the SW (single authority), not the
  // page-local usage.js kv* (the round-16 split-authority finding).
  // BOUNDED read — a killed worker must not leave the Usage section blank.
  let u;
  try {
    u = await boundedSend("usage.get");
  } catch (e) {
    const cards = $("#usage-cards");
    if (cards) cards.innerHTML = `<div class="muted">Couldn't load usage — the agent worker didn't answer (${escapeHtml(String(e?.message ?? e))}).</div><button class="btn small" type="button" id="retry-usage">Retry</button>`;
    cards?.querySelector("#retry-usage")?.addEventListener("click", () => renderUsage(currentUsageRange));
    return;
  }
  // Defensive: usage.get may return an error envelope or a shape missing
  // totals (e.g. storage permission not yet granted, SW cold-start race) —
  // render the empty state instead of crashing the Settings page.
  const totals = u?.ok === false || !u?.totals ? null : u.totals;
  const safe = {
    calls: Number(totals?.calls ?? 0),
    inputTokens: Number(totals?.inputTokens ?? 0),
    outputTokens: Number(totals?.outputTokens ?? 0),
    estimatedCost: Number(totals?.estimatedCost ?? 0),
  };
  const tok = safe.inputTokens + safe.outputTokens;
  const cards = $("#usage-cards");
  if (cards) {
    cards.replaceChildren();
    const stats = [
      [formatTokens(tok), "total tokens"],
      [formatTokens(safe.inputTokens), "input"],
      [formatTokens(safe.outputTokens), "output"],
    ];
    if (safe.estimatedCost > 0) {
      stats.push([formatCost(safe.estimatedCost), "est. cost"]);
    }
    stats.push([String(safe.calls), "calls"]);
    for (const [n, l] of stats) {
      const s = document.createElement("div");
      s.className = "usage-stat";
      const nEl = document.createElement("div");
      nEl.className = "n";
      nEl.textContent = n;
      const lEl = document.createElement("div");
      lEl.className = "l";
      lEl.textContent = l;
      s.append(nEl, lEl);
      cards.appendChild(s);
    }
  }

  // ── Charts (FolioLM-style, SVG, aggregated at read time) ──
  // The ledger aggregates arrive pre-aggregated from the SW; the range filter
  // slices byDay entries + raw rows without re-scanning anything unbounded.
  const byDay = Array.isArray(u?.byDay) ? u.byDay : [];
  const byModel = Array.isArray(u?.byModel) ? u.byModel : [];
  const byAgent = Array.isArray(u?.byAgent) ? u.byAgent : [];
  const rows = Array.isArray(u?.rows) ? u.rows : [];
  const tools = Array.isArray(u?.tools) ? u.tools : [];
  // byDay entries carry `day`; for the 24h view the day buckets would collapse
  // to one bar, so slice the RAW rows for the daily chart when range is 24h.
  const dailySource = currentUsageRange === "24h"
    ? filterRowsByRange(rows, "24h")
    : byDay;
  const dayMount = $("#usage-chart-days");
  if (dayMount) dayMount.innerHTML = svgDailyBars(dayBuckets(dailySource, currentUsageRange));
  const modelMount = $("#usage-chart-models");
  if (modelMount) modelMount.innerHTML = svgShareBars(shareBars(byModel, "totalTokens", 6), { kind: "models", valueLabel: "tokens by model" });
  const agentMount = $("#usage-chart-agents");
  if (agentMount) agentMount.innerHTML = svgShareBars(shareBars(byAgent, "estimatedCost", 6), { kind: "agents", valueLabel: "estimated cost by agent" });
  const toolMount = $("#usage-chart-tools");
  if (toolMount) toolMount.innerHTML = svgShareBars(topTools(tools, 6), { kind: "tools", valueLabel: "tool calls" });

  // Range tabs reflect the active range.
  $$(".usage-range").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.range === currentUsageRange));
  });

  // The full breakdown: by provider, by model, by agent, by day. Each is a
  // textContent-built table (never interpolate into innerHTML — untrusted).
  const detail = $("#usage-detail");
  if (!detail) return;
  detail.replaceChildren();

  const mk = (title, headings, rows) => {
    const h = document.createElement("h3");
    h.textContent = title;
    detail.appendChild(h);
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "No usage recorded yet.";
      detail.appendChild(p);
      return;
    }
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const h of headings) {
      const th = document.createElement("th");
      th.textContent = h;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      for (const v of r) {
        const td = document.createElement("td");
        td.textContent = v; // textContent — never interpolate into innerHTML
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    detail.appendChild(table);
  };

  const fmtTok = (m) => String((m.inputTokens ?? 0) + (m.outputTokens ?? 0));
  const fmtCost = (m) => "$" + Number(m.estimatedCost ?? 0).toFixed(4);
  const sortCost = (a, b) => (b.estimatedCost ?? 0) - (a.estimatedCost ?? 0);

  const detailByProvider = Array.isArray(u?.byProvider) ? u.byProvider : [];
  const detailByModel = Array.isArray(u?.byModel) ? u.byModel : [];
  const detailByAgent = Array.isArray(u?.byAgent) ? u.byAgent : [];
  const detailByDay = Array.isArray(u?.byDay) ? u.byDay : [];

  mk("By provider", ["Provider", "Calls", "Tokens", "Cost"],
    detailByProvider.slice().sort(sortCost).map((p) => [p.provider, String(p.calls), fmtTok(p), fmtCost(p)]));
  mk("By model", ["Provider", "Model", "Calls", "Tokens", "Cost"],
    detailByModel.slice().sort(sortCost).map((m) => [m.provider, m.model, String(m.calls), fmtTok(m), fmtCost(m)]));
  mk("By agent", ["Agent", "Model", "Calls", "Tokens", "Cost"],
    detailByAgent.slice().sort(sortCost).map((a) => [a.agentId, `${a.provider}/${a.model}`, String(a.calls), fmtTok(a), fmtCost(a)]));
  mk("By day", ["Day", "Calls", "Tokens", "Cost"],
    detailByDay.slice().sort((a, b) => String(a.day).localeCompare(String(b.day))).map((d) => [d.day, String(d.calls), fmtTok(d), fmtCost(d)]));

  // Provider server tools (Gemini google_search, Anthropic web_search): per-run executed-query
  // counts + the ESTIMATED spend (the provider's free-tier meter is invisible
  // to CAP — every figure here is labelled an estimate).
  const serverToolDays = Array.isArray(u?.serverTools) ? u.serverTools : [];
  const serverToolRows = serverToolDays.flatMap(({ day, rows }) =>
    (Array.isArray(rows) ? rows : []).map((r) => [
      day,
      `${String(r.provider ?? "")}/${String(r.tool ?? "")}`,
      String(r.queries ?? 0),
      `est. $${(Number(r.estimatedUsd) || 0).toFixed(4)}`,
    ]));
  mk("Provider server tools (estimates)", ["Day", "Tool", "Queries", "Est. cost"], serverToolRows);
}

export function initUsageStatic(ctx) {
  const panelCtx = wireOnce(ctx);
  if (!panelCtx) return;

  const $ = (sel) => panelCtx.$(sel) ?? { addEventListener() {}, hidden: false, textContent: "" };
  // The detail-toggle is a STATIC control — wire its click EXACTLY ONCE (outside
  // renderUsage, which runs per page-load + nav + poll), so repeated renders never
  // stack listeners and never produce parity-dependent dead/inverted toggles.
  $("#usage-detail-toggle").addEventListener("click", () => {
    const d = $("#usage-detail");
    d.hidden = !d.hidden;
    $("#usage-detail-toggle").textContent = d.hidden ? "Show detail" : "Hide detail";
  });
  // Usage range tabs (24h / 7d) — re-render the panel on switch.
  $$(".usage-range").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.range && b.dataset.range !== currentUsageRange) {
        renderUsage(b.dataset.range);
      }
    });
  });
  panelCtx.subscribeDiagnosticsRevision(() => {
    const usageRoot = panelCtx.root ?? byId("usage");
    if (!usageRoot || usageRoot.classList?.contains("active") !== false) {
      renderUsage(currentUsageRange);
    }
    panelCtx.callbacks?.onDiagnosticsRevision?.();
  });
}

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  initUsageStatic();
  await renderUsage(currentUsageRange);
  return {
    refresh: (range = currentUsageRange) => renderUsage(range),
    unmount: makeUnmount(panelCtx),
  };
}
