// lib/usage-viz.js — pure SVG chart builders for the Settings → Usage panel.
//
// FolioLM-style visualizations (docs/USAGE-VIZ-DESIGN.md): stat cards are
// rendered by the caller; this module builds the four charts as SVG STRING
// builders so they are pure and Deno-testable. Colors come from theme.css
// custom properties (var(--…)) so the dark scheme applies without JS. All
// dynamic text is escaped — tool/model/agent names are untrusted-adjacent
// (site-derived) and must never inject markup.

export const USAGE_RANGES = Object.freeze({
  "24h": { label: "24 hours", ms: 24 * 60 * 60 * 1000, days: 1 },
  "7d": { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000, days: 7 },
});

export function escapeSvgText(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatTokens(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return String(v);
}

export function formatCost(usd) {
  const v = Number(usd) || 0;
  if (v > 0 && v < 0.01) return "<$0.01";
  return `$${v.toFixed(2)}`;
}

/** Rows in [nowMs - range.ms, nowMs]. */
export function filterRowsByRange(rows, rangeName, nowMs = Date.now()) {
  const range = USAGE_RANGES[rangeName] ?? USAGE_RANGES["7d"];
  const cutoff = nowMs - range.ms;
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    const t = Date.parse(r?.timestamp ?? "");
    return Number.isFinite(t) && t >= cutoff && t <= nowMs + 60_000;
  });
}

/** Continuous per-day buckets (zero-filled) with in/out/calls/cost totals.
 * Rows may be raw ledger rows or the pre-aggregated byDay entries ({day,…}). */
export function dayBuckets(rows, rangeName, nowMs = Date.now()) {
  const days = USAGE_RANGES[rangeName]?.days ?? 7;
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(nowMs - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { day: key, inputTokens: 0, outputTokens: 0, calls: 0, estimatedCost: 0 });
  }
  for (const r of Array.isArray(rows) ? rows : []) {
    let key = typeof r?.day === "string" ? r.day.slice(0, 10) : null;
    if (!key) {
      const t = Date.parse(r?.timestamp ?? "");
      if (!Number.isFinite(t)) continue;
      key = new Date(t).toISOString().slice(0, 10);
    }
    const b = buckets.get(key);
    if (!b) continue;
    b.inputTokens += Number(r.inputTokens) || 0;
    b.outputTokens += Number(r.outputTokens) || 0;
    b.calls += Number(r.calls) || (r.inputTokens != null ? 1 : 0);
    b.estimatedCost += Number(r.estimatedCost) || 0;
  }
  return [...buckets.values()];
}

/** Top-N entries by `field`, each with its share of the listed total (0-100). */
export function shareBars(entries, field, topN = 6) {
  const list = (Array.isArray(entries) ? entries : [])
    .map((e) => ({ label: String(e?.label ?? e?.model ?? e?.agentId ?? e?.tool ?? "?"), value: Number(e?.[field]) || 0, calls: Number(e?.calls) || 0 }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const top = list.slice(0, topN);
  const total = top.reduce((s, e) => s + e.value, 0) || 1;
  for (const e of top) e.share = Math.round((e.value / total) * 100);
  return top;
}

/** Top-N tools by call count (already rolled up by getToolUsage). */
export function topTools(tools, topN = 6) {
  return (Array.isArray(tools) ? tools : [])
    .map((t) => ({ label: String(t?.tool ?? "?"), value: Number(t?.calls) || 0, calls: Number(t?.calls) || 0 }))
    .filter((t) => t.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, topN);
}

const ESC = escapeSvgText;

/** Stacked daily bars (input over output), gridlines + value labels.
 * Colors: var(--usage-in)/var(--usage-out) — themed by options.css. */
export function svgDailyBars(buckets, { width = 560, height = 180 } = {}) {
  const bs = Array.isArray(buckets) ? buckets : [];
  const pad = { top: 14, right: 8, bottom: 22, left: 8 };
  const iw = Math.max(60, width - pad.left - pad.right);
  const ih = Math.max(40, height - pad.top - pad.bottom);
  if (!bs.length) {
    return `<svg class="usage-chart" role="img" aria-label="Token usage per day: no data" width="${width}" height="${height}"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="usage-chart-empty">No usage recorded yet</text></svg>`;
  }
  const max = Math.max(...bs.map((b) => b.inputTokens + b.outputTokens), 1);
  if (max <= 1) {
    return `<svg class="usage-chart" role="img" aria-label="Token usage per day: no data" width="${width}" height="${height}"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" class="usage-chart-empty">No usage recorded yet</text></svg>`;
  }
  const n = bs.length;
  const slot = iw / n;
  const bw = Math.max(4, Math.min(36, slot * 0.6));
  let out = `<svg class="usage-chart" role="img" aria-label="Token usage per day, input and output stacked" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  for (let g = 0; g <= 2; g++) {
    const y = pad.top + (ih * g) / 2;
    out += `<line x1="${pad.left}" y1="${y}" x2="${pad.left + iw}" y2="${y}" class="usage-grid"/>`;
  }
  bs.forEach((b, i) => {
    const x = pad.left + slot * i + (slot - bw) / 2;
    const hIn = (b.inputTokens / max) * ih;
    const hOut = (b.outputTokens / max) * ih;
    const yOut = pad.top + ih - hOut;
    const yIn = yOut - hIn;
    const label = ESC(b.day.slice(5));
    if (b.inputTokens + b.outputTokens > 0) {
      out += `<g><rect x="${x}" y="${yOut}" width="${bw}" height="${Math.max(hOut, 0)}" class="usage-bar-out"><title>${label}: ${ESC(formatTokens(b.outputTokens))} output</title></rect><rect x="${x}" y="${yIn}" width="${bw}" height="${Math.max(hIn, 0)}" class="usage-bar-in"><title>${label}: ${ESC(formatTokens(b.inputTokens))} input</title></rect></g>`;
    }
    if (n <= 8 || i % Math.ceil(n / 8) === 0) {
      out += `<text x="${x + bw / 2}" y="${height - 8}" text-anchor="middle" class="usage-axis">${label}</text>`;
    }
  });
  out += `</svg>`;
  return out;
}

/** Horizontal share bars for a shareBars()/topTools() result.
 * kind is a CSS class hook (usage-share-models / -agents / -tools). */
export function svgShareBars(entries, { kind = "models", valueLabel = "tokens" } = {}) {
  const es = Array.isArray(entries) ? entries : [];
  if (!es.length) {
    return `<div class="usage-share usage-share-${ESC(kind)}" role="img" aria-label="${ESC(valueLabel)} by ${ESC(kind)}: no data"><p class="muted">No usage recorded yet.</p></div>`;
  }
  const rows = es.map((e) => {
    const label = ESC(e.label);
    const value = ESC(formatTokens(e.value));
    const calls = Number(e.calls) || 0;
    return `<div class="usage-share-row"><span class="usage-share-label" title="${label}">${label}</span><span class="usage-share-track"><span class="usage-share-fill usage-share-fill-${ESC(kind)}" style="flex:0 0 ${Math.max(e.share ?? 0, 2)}%"></span></span><span class="usage-share-value">${value}</span><span class="usage-share-calls">${calls} call${calls === 1 ? "" : "s"}</span></div>`;
  });
  return `<div class="usage-share usage-share-${ESC(kind)}" role="img" aria-label="${ESC(valueLabel)} by ${ESC(kind)}, top ${es.length}">${rows.join("")}</div>`;
}
