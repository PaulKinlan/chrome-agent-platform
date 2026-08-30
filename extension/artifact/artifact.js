// artifact.js — the artifact VIEWER. Opens an artifact (by ?id= + ?origin=) and
// offers Preview | Source | Diff (CAP-FB-20260830-ARTIFACT-VIEWER-SOURCE-DIFF-01):
//   Preview — the live sandboxed render (html) / image / text, with the owner's
//             theme + locale percolated in through the validated postMessage.
//   Source  — the EXACT body, bounded and syntax-highlighted (read-only).
//   Diff    — the change between any two immutable versions (asset.versions /
//             asset.version-get), with a Restore that brings an older version
//             back as a NEW head (asset.restore — the owner's click IS the
//             approval, no card).
// Every dynamic string enters the DOM via textContent / component properties —
// never innerHTML — so an untrusted artifact body can never inject markup.

import { send } from "../lib/messages.js";
import {
  renderHtmlFrame,
  wireHtmlFrameContent,
  wireHtmlFramePreference,
  currentFramePreference,
  inferSourceLanguage,
} from "../shared/components.js";

const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "";
const origin = params.get("origin") ?? "master";

const nameEl = document.getElementById("name");
const metaEl = document.getElementById("meta");
const out = document.getElementById("out");
const copyBtn = document.getElementById("copy-content");
const modes = document.getElementById("modes");

document.getElementById("back").addEventListener("click", () => {
  if (history.length > 1) history.back();
  else location.href = "../ntp/ntp.html";
});

// The copy action is dead until an artifact resolves (no id / not found =
// nothing to copy) — it stays disabled on the failure path (UX-AUDIT UX-009).
let currentAssetContent = "";
copyBtn?.addEventListener("click", async () => {
  if (!currentAssetContent) return;
  try {
    await navigator.clipboard.writeText(currentAssetContent);
    const orig = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = orig; }, 1500);
  } catch {}
});

function renderError(message) {
  const err = document.createElement("div");
  err.className = "error";
  err.textContent = message;
  out.replaceChildren(err);
}

/** Build the three tabpanels once; each is populated on demand. */
function buildPanels() {
  const mk = (mode, label) => {
    const p = document.createElement("div");
    p.className = "panel";
    p.id = `panel-${mode}`;
    p.setAttribute("role", "tabpanel");
    p.setAttribute("aria-label", label);
    p.tabIndex = 0;
    return p;
  };
  const preview = mk("preview", "Preview");
  const source = mk("source", "Source");
  const diff = mk("diff", "Diff");
  source.hidden = true;
  diff.hidden = true;
  out.replaceChildren(preview, source, diff);
  return { preview, source, diff };
}

/** Preview: the live render (html frame / image / text). */
function renderPreview(host, asset) {
  const type = asset.type;
  const content = asset.content ?? "";
  if (type === "html" || (type === "text" && /^\s*<!doctype html|<html|</i.test(content))) {
    const frame = document.createElement("div");
    frame.className = "frame";
    frame.innerHTML = renderHtmlFrame(content);
    host.replaceChildren(frame);
    const cleanups = [wireHtmlFrameContent(frame)];
    const nonce = frame.querySelector(".html-frame")?.dataset?.frameNonce;
    if (nonce) cleanups.push(wireHtmlFramePreference(frame, { nonce, ...currentFramePreference() }));
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      observer.disconnect();
      for (const dispose of cleanups.splice(0)) {
        try { dispose(); } catch { /* page/frame is already tearing down */ }
      }
    };
    const observer = new MutationObserver(() => { if (!frame.isConnected) cleanup(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("pagehide", cleanup, { once: true });
  } else if (type === "image") {
    const img = document.createElement("img");
    img.className = "artifact-img";
    img.src = content;
    img.alt = asset.name ?? "artifact";
    host.replaceChildren(img);
  } else {
    const pre = document.createElement("pre");
    pre.className = "artifact-pre";
    pre.textContent = content;
    host.replaceChildren(pre);
  }
}

/** Source: the exact body, bounded + highlighted (the shared inspector). */
function renderSource(host, asset) {
  const inspector = document.createElement("artifact-inspector");
  inspector.asset = asset;
  inspector.language = inferSourceLanguage(asset);
  host.replaceChildren(inspector);
}

/** Diff: two version pickers + <artifact-diff> + Restore. */
function buildDiff(host) {
  const controls = document.createElement("div");
  controls.className = "diff-controls";

  const field = (labelText, selectId) => {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const label = document.createElement("label");
    label.textContent = labelText;
    label.htmlFor = selectId;
    const select = document.createElement("select");
    select.id = selectId;
    select.className = "control";
    wrap.append(label, select);
    return { wrap, select };
  };
  const base = field("Base version", "diff-base");
  const compare = field("Compared with", "diff-compare");

  const actions = document.createElement("div");
  actions.className = "diff-actions";
  const restore = document.createElement("button");
  restore.className = "btn";
  restore.id = "diff-restore";
  restore.type = "button";
  restore.textContent = "Restore base version";
  actions.append(restore);

  controls.append(base.wrap, compare.wrap, actions);

  const diff = document.createElement("artifact-diff");
  diff.id = "artifact-diff";
  diff.setAttribute("mode", "unified");

  const status = document.createElement("p");
  status.className = "diff-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const empty = document.createElement("p");
  empty.className = "diff-empty";
  empty.hidden = true;

  host.replaceChildren(controls, empty, diff, status);
  return { base: base.select, compare: compare.select, restore, diff, status, empty };
}

const versionLabel = (v) => {
  const by = v?.by === "owner" ? "you" : (v?.by === "model" ? "agent" : (v?.by ?? ""));
  const when = v?.at ? new Date(v.at).toLocaleString() : "";
  const summary = v?.summary ? ` — ${v.summary}` : "";
  return `v${v.n}${by ? ` · ${by}` : ""}${when ? ` · ${when}` : ""}${summary}`;
};

/** Populate + wire the Diff panel from the artifact's version history. */
async function loadDiff(ui, asset) {
  const res = await send("asset.versions", { origin, id });
  const versions = (res?.ok ? res.versions : []) ?? [];
  if (!res?.ok || versions.length === 0) {
    ui.empty.hidden = false;
    ui.empty.textContent = "No version history yet — this artifact has a single version.";
    ui.diff.hidden = true;
    ui.base.disabled = ui.compare.disabled = ui.restore.disabled = true;
    return;
  }
  ui.empty.hidden = true;
  ui.diff.hidden = false;
  ui.base.disabled = ui.compare.disabled = ui.restore.disabled = false;

  const fill = (select) => {
    const opts = versions.map((v) => {
      const o = document.createElement("option");
      o.value = String(v.n);
      o.textContent = versionLabel(v);
      return o;
    });
    select.replaceChildren(...opts);
  };
  fill(ui.base);
  fill(ui.compare);

  const head = res.head ?? versions[versions.length - 1]?.n;
  // Default: the previous version (base) against the current head (compare) —
  // "what changed to get here". A single version compares to itself (no change).
  const prev = versions.length >= 2 ? versions[versions.length - 2].n : versions[versions.length - 1].n;
  ui.base.value = String(prev);
  ui.compare.value = String(head);

  const bodyCache = new Map();
  const bodyOf = async (n) => {
    if (bodyCache.has(n)) return bodyCache.get(n);
    const r = await send("asset.version-get", { origin, id, n: Number(n) });
    const body = r?.ok ? (r.content ?? "") : "";
    bodyCache.set(n, body);
    return body;
  };

  const language = inferSourceLanguage(asset);
  const refresh = async () => {
    const bn = Number(ui.base.value);
    const cn = Number(ui.compare.value);
    ui.status.textContent = "Loading versions…";
    const [before, after] = await Promise.all([bodyOf(bn), bodyOf(cn)]);
    ui.diff.beforeLabel = `v${bn}`;
    ui.diff.afterLabel = `v${cn}`;
    ui.diff.language = language;
    ui.diff.before = before;
    ui.diff.after = after;
    ui.restore.textContent = `Restore v${bn}`;
    ui.restore.disabled = bn === head; // restoring the current head is a no-op
    ui.status.textContent = "";
  };

  ui.base.addEventListener("change", refresh);
  ui.compare.addEventListener("change", refresh);
  ui.restore.addEventListener("click", async () => {
    const n = Number(ui.base.value);
    ui.restore.disabled = true;
    ui.status.textContent = `Restoring v${n}…`;
    const r = await send("asset.restore", { origin, id, n });
    if (r?.ok) {
      ui.status.textContent = `Restored v${n} as v${r.version}.`;
      // Re-read the whole artifact so Preview + Source + the pickers reflect
      // the new head, then re-open Diff on the fresh history.
      await reload({ keepMode: "Diff" });
    } else {
      ui.status.textContent = r?.error ? `Could not restore: ${r.error}` : "Could not restore this version.";
      ui.restore.disabled = false;
    }
  });

  await refresh();
}

// ── the mode machine ────────────────────────────────────────────────────────
let panels = null;
let diffUi = null;
let diffLoadedFor = null; // asset head the Diff panel was built for
let currentAsset = null;

function showMode(mode) {
  if (!panels) return;
  panels.preview.hidden = mode !== "Preview";
  panels.source.hidden = mode !== "Source";
  panels.diff.hidden = mode !== "Diff";
  if (mode === "Diff" && currentAsset && diffLoadedFor !== currentAsset.updatedAt) {
    diffLoadedFor = currentAsset.updatedAt;
    diffUi = buildDiff(panels.diff);
    loadDiff(diffUi, currentAsset);
  }
}

async function reload({ keepMode } = {}) {
  const res = await send("asset.get", { origin, id });
  const asset = res?.ok ? res.asset : null;
  if (!asset) {
    modes.hidden = true;
    renderError(`Artifact not found: ${id}`);
    return;
  }
  currentAsset = asset;
  nameEl.textContent = asset.name ?? "Artifact";
  metaEl.textContent = `${asset.type ?? "unknown"} · ${asset.size ?? 0} B · ${origin}`;
  currentAssetContent = asset.content ?? "";
  if (copyBtn) copyBtn.disabled = !currentAssetContent;

  panels = buildPanels();
  renderPreview(panels.preview, asset);
  renderSource(panels.source, asset);
  diffUi = null;
  diffLoadedFor = null;

  modes.hidden = false;
  const mode = keepMode ?? modes.value ?? "Preview";
  modes.value = mode;
  showMode(mode);
}

modes?.addEventListener("change", (e) => showMode(e.detail?.value ?? modes.value));

async function main() {
  if (!id) {
    modes.hidden = true;
    renderError("No artifact id given.");
    return;
  }
  await reload();
}

main();
