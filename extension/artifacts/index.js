// artifacts/index.js — the artifact GALLERY: a grid of <artifact-card> for every
// artifact the agents have made. Each card shows a live preview thumbnail (an
// html artifact renders in a sandboxed iframe), the name/type/size/origin/time,
// and actions: open (the full live viewer / side inspector), reuse (attach to a new task via the
// parent NTP), delete.
//
// Stage 2 view-frame collapse (chrome-agent-platform-5r5s):
// - Renders natively inside the Hub document under #view-client-host #artifacts-view.
// - Directly integrates cards grid, kind pill filter bar, search input, capacity meter,
//   and responsive split inspector.
// - Directly attaches artifacts to composer on Reuse without postMessage bridges.
// - Retains standalone execution for artifacts/index.html.

import { send } from "../lib/messages.js";
import { saveArtifactToDisk } from "../lib/artifact-export.js";
import {
  renderHtmlFrame,
  isHtmlDocument,
  wireHtmlFrameContent,
  confirmActionDialog,
  formatArtifactSize,
  formatArtifactType,
} from "../shared/components.js";
import { t, hydrateI18n } from "../shared/i18n.js";

// Bound the live-preview work: preview at most this many artifacts (the most
// recent), so a large gallery stays responsive. The rest render as placeholder
// cards (still openable/deletable).
const MAX_PREVIEWS = 24;

let allAssets = [];
let filterKind = "";
let searchQuery = "";
let selectedAssetId = null;
let inspectorCleanup = null;
let activeContainer = null;
let activeOptions = {};
let activeRefresh = null;

// CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01 — the library never silently
// evicts the owner's oldest artifact; at capacity a create is refused. This
// indicator tells the owner the library is filling up (and when it is full,
// that they must delete something) BEFORE that refusal is hit. Shown only once
// the library is meaningfully full so it stays out of the way otherwise.
export async function renderCapacity(capacityEl) {
  if (!capacityEl) return;
  const cap = await send("asset.capacity", {}).catch(() => null);
  if (!cap?.ok || !(cap.maxBytes > 0)) { capacityEl.hidden = true; return; }
  const pct = Math.min(100, Math.round((cap.fraction ?? 0) * 100));
  if (pct < 75 && !cap.full) { capacityEl.hidden = true; return; }
  const full = cap.full === true;
  capacityEl.classList.toggle("full", full);
  capacityEl.classList.toggle("warn", !full);
  const label = full ? "Library full" : "Library filling up";
  const detail = full
    ? "New artifacts will be refused until you delete some. Nothing you made is ever removed automatically."
    : `${pct}% of the artifact index used. When it fills, new artifacts are refused rather than dropping your oldest — delete artifacts to keep room.`;
  capacityEl.replaceChildren();
  const row = document.createElement("div");
  row.className = "cap-row";
  const l = document.createElement("span");
  l.className = "cap-label";
  l.textContent = label;
  const c = document.createElement("span");
  c.textContent = `${cap.count} artifact${cap.count === 1 ? "" : "s"} · ${pct}%`;
  row.append(l, c);
  const bar = document.createElement("div");
  bar.className = "cap-bar";
  const fill = document.createElement("div");
  fill.className = "cap-fill";
  fill.style.width = `${pct}%`;
  bar.append(fill);
  const p = document.createElement("div");
  p.style.marginTop = "6px";
  p.textContent = detail;
  capacityEl.append(row, bar, p);
  capacityEl.hidden = false;
}

export function parseArtifactParams(path) {
  let kind = "";
  let id = "";
  let search = "";
  if (!path) return { kind, id, search };
  const rawParams = path.includes("?")
    ? path.slice(path.indexOf("?") + 1)
    : path.includes("&")
    ? path.slice(path.indexOf("&") + 1)
    : path.includes("#")
    ? path.slice(path.indexOf("#") + 1)
    : "";

  if (rawParams) {
    const sp = new URLSearchParams(rawParams.replace(/^#/, ""));
    kind = sp.get("kind") || "";
    id = sp.get("id") || "";
    search = sp.get("q") || sp.get("search") || "";
    if (!kind && !id) {
      const bare = rawParams.trim();
      if (["html", "markdown", "md", "data", "image"].includes(bare.toLowerCase())) {
        kind = bare.toLowerCase();
      } else if (bare.startsWith("a_") || bare.length > 5) {
        id = bare;
      }
    }
  }
  return { kind, id, search };
}

export function matchesFilter(a, kind, query) {
  if (kind) {
    const t = String(a.type || "").toLowerCase();
    if (kind === "html" && t !== "html") return false;
    if (kind === "markdown" && t !== "markdown" && t !== "md") return false;
    if (kind === "data" && !["data", "json", "csv", "text"].includes(t)) return false;
    if (kind === "image" && t !== "image") return false;
  }
  if (query) {
    const q = query.toLowerCase();
    const nameMatch = String(a.name || "").toLowerCase().includes(q);
    const originMatch = String(a.origin || "").toLowerCase().includes(q);
    const typeMatch = String(a.type || "").toLowerCase().includes(q);
    if (!nameMatch && !originMatch && !typeMatch) return false;
  }
  return true;
}

// Artifact deletion uses the SHARED confirm (CAP-FB-20260827-DIALOG-CONSOLIDATION-01).
export function confirmDeleteDialog(name, type) {
  return confirmActionDialog({
    title: "Delete artifact",
    body: `Delete "${name ?? "Untitled"}" (${type ?? "data"})? This permanently removes it from the artifact store.`,
    confirmLabel: "Delete",
    destructive: true,
  });
}

export async function openArtifactInspector(id, origin, opts = {}) {
  const container = opts.container || activeContainer || (typeof document !== "undefined" ? document : null);
  if (!container) return;
  const grid = container.querySelector("#artifacts-grid, #grid, .grid");
  const inspector = container.querySelector("#artifact-inspector, .inspector") || document.getElementById("artifact-inspector");
  const status = opts.statusEl || container.querySelector("#artifacts-status, #status, .status");
  const onAttachArtifact = opts.onAttachArtifact || activeOptions.onAttachArtifact;

  selectedAssetId = id;
  grid?.querySelectorAll("artifact-card").forEach((c) => {
    c.classList.toggle("selected", c.getAttribute("id") === id);
  });

  if (!inspector) return;
  const res = await send("asset.get", { origin: origin ?? "master", id }).catch(() => ({ ok: false }));
  const asset = res?.ok ? res.asset : null;
  if (!asset) {
    closeArtifactInspector(container);
    return;
  }

  inspectorCleanup?.();
  inspectorCleanup = null;
  inspector.hidden = false;
  inspector.replaceChildren();

  const head = document.createElement("div");
  head.className = "insp-head";

  const metaBlock = document.createElement("div");
  metaBlock.className = "insp-meta-block";
  const title = document.createElement("span");
  title.className = "insp-title";
  title.textContent = asset.name ?? "Untitled";
  title.title = asset.name ?? "Untitled";
  const meta = document.createElement("span");
  meta.className = "insp-meta";
  meta.textContent = `${formatArtifactType(asset.type)} · ${formatArtifactSize(asset.size)} · ${origin ?? "master"}`;
  metaBlock.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "insp-actions";

  // New Tab button
  const openTabBtn = document.createElement("button");
  openTabBtn.type = "button";
  openTabBtn.className = "insp-btn";
  openTabBtn.title = "Open in new tab";
  openTabBtn.setAttribute("aria-label", "Open in new tab");
  openTabBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg><span>New tab</span>`;
  openTabBtn.addEventListener("click", () => {
    const url = typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL(`artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`)
      : `../artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`;
    if (typeof chrome !== "undefined" && chrome.tabs?.create) chrome.tabs.create({ url });
    else window.open(url, "_blank");
  });

  // Reuse button
  const reuseBtn = document.createElement("button");
  reuseBtn.type = "button";
  reuseBtn.className = "insp-btn";
  reuseBtn.title = "Reuse artifact";
  reuseBtn.setAttribute("aria-label", "Reuse artifact");
  reuseBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg><span>Reuse</span>`;
  reuseBtn.addEventListener("click", async () => {
    if (onAttachArtifact) {
      await onAttachArtifact({ id, name: asset.name, type: asset.type, origin: origin ?? "master" });
      if (status) status.textContent = `"${asset.name}" sent to the hub — it will attach to a new task.`;
      return;
    }
    const inOverlay = window.parent && window.parent !== window;
    if (inOverlay) {
      try {
        window.parent.postMessage({
          type: "cap:attach-artifact",
          artifact: { id, name: asset.name, type: asset.type, origin: origin ?? "master" },
        }, "*");
        if (status) status.textContent = `"${asset.name}" sent to the hub — it will attach to a new task.`;
        return;
      } catch { /* fallback */ }
    }
    try {
      await navigator.clipboard.writeText(asset.content ?? asset.name ?? "");
      if (status) status.textContent = `"${asset.name}" copied — paste it into a new task on the hub.`;
    } catch {
      if (status) status.textContent = `Could not reach the hub.`;
    }
  });

  // Save button
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "insp-btn";
  saveBtn.title = "Save to disk";
  saveBtn.setAttribute("aria-label", `Save ${asset.name ?? "artifact"} to disk`);
  saveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Save</span>`;
  saveBtn.addEventListener("click", async () => {
    try { await saveArtifactToDisk(asset); } catch { /* cancelled */ }
  });

  // Delete button
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "insp-btn danger";
  delBtn.title = "Delete artifact";
  delBtn.setAttribute("aria-label", "Delete artifact");
  delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span>Delete</span>`;
  delBtn.addEventListener("click", async () => {
    if (!(await confirmDeleteDialog(asset.name, asset.type))) return;
    const delRes = await send("asset.delete", { origin: origin ?? "master", id });
    if (delRes?.ok === false && delRes.error) {
      if (status) status.textContent = `Delete failed: ${delRes.error}`;
      return;
    }
    closeArtifactInspector(container);
    if (activeRefresh) await activeRefresh();
  });

  // Close button
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "insp-close";
  closeBtn.id = "inspector-close";
  closeBtn.title = "Close inspector";
  closeBtn.setAttribute("aria-label", "Close inspector");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => closeArtifactInspector(container));

  actions.append(openTabBtn, reuseBtn, saveBtn, delBtn, closeBtn);
  head.append(metaBlock, actions);

  const body = document.createElement("div");
  body.className = "insp-body";

  const type = asset.type ?? "data";
  const content = asset.content ?? "";

  if (type === "html" || (type === "text" && isHtmlDocument(content))) {
    body.innerHTML = renderHtmlFrame(content);
    const frameEl = body.querySelector(".html-frame");
    if (frameEl) {
      inspectorCleanup = wireHtmlFrameContent(frameEl);
    }
  } else if (type === "image") {
    const img = document.createElement("img");
    img.src = content;
    img.alt = asset.name ?? "artifact";
    body.append(img);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = content;
    body.append(pre);
  }

  inspector.append(head, body);
}

export function closeArtifactInspector(container) {
  inspectorCleanup?.();
  inspectorCleanup = null;
  selectedAssetId = null;
  const c = container || activeContainer || (typeof document !== "undefined" ? document : null);
  if (!c) return;
  const inspector = c.querySelector("#artifact-inspector, .inspector") || document.getElementById("artifact-inspector");
  const grid = c.querySelector("#artifacts-grid, #grid, .grid") || document.getElementById("grid");
  if (inspector) inspector.hidden = true;
  grid?.querySelectorAll("artifact-card.selected").forEach((el) => el.classList.remove("selected"));
}

export async function openArtifactDialog(id, origin, opts = {}) {
  const onAttachArtifact = opts.onAttachArtifact || activeOptions.onAttachArtifact;
  const status = opts.statusEl || (activeContainer ? activeContainer.querySelector("#artifacts-status, #status, .status") : document.getElementById("status"));
  const res = await send("asset.get", { origin: origin ?? "master", id }).catch(() => ({ ok: false }));
  const asset = res?.ok ? res.asset : null;
  if (!asset) {
    if (status) status.textContent = "Artifact not found.";
    return false;
  }
  const frameCleanups = [];
  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", asset.name ?? "Artifact");
  const body = document.createElement("div");
  body.style.minWidth = "min(92vw, 1280px)";
  body.style.width = "100%";
  body.style.height = "80vh";
  body.style.minHeight = "min(80vh, 850px)";
  body.style.display = "flex";
  body.style.flexDirection = "column";

  const headActions = document.createElement("div");
  headActions.style.display = "flex";
  headActions.style.justifyContent = "space-between";
  headActions.style.alignItems = "center";
  headActions.style.marginBottom = "8px";
  headActions.style.flex = "0 0 auto";

  const metaSpan = document.createElement("span");
  metaSpan.style.fontSize = "12px";
  metaSpan.style.color = "var(--muted)";
  metaSpan.textContent = `${formatArtifactType(asset.type)} · ${formatArtifactSize(asset.size)} · ${origin ?? "master"}`;

  const openTabBtn = document.createElement("button");
  openTabBtn.type = "button";
  openTabBtn.className = "btn";
  openTabBtn.style.padding = "4px 10px";
  openTabBtn.style.fontSize = "12px";
  openTabBtn.style.cursor = "pointer";
  openTabBtn.style.display = "inline-flex";
  openTabBtn.style.alignItems = "center";
  openTabBtn.style.gap = "4px";
  openTabBtn.style.border = "1px solid var(--border)";
  openTabBtn.style.borderRadius = "var(--radius-sm, 6px)";
  openTabBtn.style.background = "transparent";
  openTabBtn.style.color = "var(--text)";
  openTabBtn.innerHTML = `<span>Open in new tab</span> <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="12" y2="3"/></svg>`;
  openTabBtn.addEventListener("click", () => {
    const url = typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL(`artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`)
      : `../artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`;
    if (typeof chrome !== "undefined" && chrome.tabs?.create) chrome.tabs.create({ url });
    else window.open(url, "_blank");
  });
  headActions.append(metaSpan, openTabBtn);
  body.append(headActions);

  const type = asset.type ?? "data";
  const content = asset.content ?? "";
  if (type === "html" || (type === "text" && isHtmlDocument(content))) {
    const frame = document.createElement("div");
    frame.style.border = "1px solid var(--border)";
    frame.style.borderRadius = "10px";
    frame.style.overflow = "hidden";
    frame.style.background = "var(--bg-elevated)";
    frame.style.flex = "1 1 auto";
    frame.style.display = "flex";
    frame.style.flexDirection = "column";
    frame.style.height = "100%";
    frame.style.minHeight = "min(72vh, 760px)";
    frame.innerHTML = renderHtmlFrame(content);
    const htmlFrameEl = frame.querySelector(".html-frame");
    if (htmlFrameEl) {
      htmlFrameEl.style.flex = "1";
      htmlFrameEl.style.display = "flex";
      htmlFrameEl.style.flexDirection = "column";
      htmlFrameEl.style.height = "100%";
      const iframe = htmlFrameEl.querySelector("iframe");
      if (iframe) {
        iframe.style.flex = "1";
        iframe.style.width = "100%";
        iframe.style.height = "100%";
        iframe.style.minHeight = "min(72vh, 760px)";
        iframe.style.maxHeight = "none";
      }
    }
    const frameCleanup = wireHtmlFrameContent(frame); // deliver the staged guarded HTML to the sandbox host
    frameCleanups.push(frameCleanup); // retained → cleaned on the dialog close
    body.append(frame);
  } else if (type === "image") {
    const img = document.createElement("img");
    img.src = content;
    img.alt = asset.name ?? "artifact";
    img.style.maxWidth = "100%";
    img.style.maxHeight = "72vh";
    img.style.objectFit = "contain";
    img.style.display = "block";
    body.append(img);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = content;
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontSize = "13px";
    pre.style.flex = "1 1 auto";
    pre.style.overflow = "auto";
    pre.style.maxHeight = "72vh";
    body.append(pre);
  }
  dialog.append(body);
  document.body.append(dialog);
  dialog.show();
  dialog.addEventListener("close", () => {
    frameCleanups.forEach((c) => {
      try { c(); } catch { /* one cleanup failing must not skip the rest */ }
    });
    dialog.remove();
  }, { once: true });
  return true;
}

function wireCard(card, { container, onAttachArtifact, onGoHome, refresh } = {}) {
  const status = container?.querySelector("#artifacts-status, #status, .status");
  card.addEventListener("open-tab", (e) => {
    const { id, origin } = e.detail ?? {};
    const url = typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL(`artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`)
      : `../artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`;
    if (typeof chrome !== "undefined" && chrome.tabs?.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank");
    }
  });
  card.addEventListener("open", (e) => {
    const { id, origin } = e.detail ?? {};
    if (window.innerWidth >= 960) {
      openArtifactInspector(id, origin ?? "master", { container, onAttachArtifact, statusEl: status });
    } else {
      openArtifactDialog(id, origin ?? "master", { onAttachArtifact, statusEl: status });
    }
  });
  card.addEventListener("dblclick", () => {
    const id = card.getAttribute("id") || "";
    const origin = card.getAttribute("origin") || "master";
    openArtifactDialog(id, origin, { onAttachArtifact, statusEl: status });
  });
  card.addEventListener("save", async (e) => {
    const { id, origin } = e.detail ?? {};
    if (!id) return;
    try {
      const full = await send("asset.get", { origin: origin ?? "master", id });
      if (full?.ok && full.asset) {
        await saveArtifactToDisk(full.asset);
      }
    } catch { /* save cancelled or failed */ }
  });
  card.addEventListener("delete", async (e) => {
    const { id, name, type, origin } = e.detail ?? {};
    if (!(await confirmDeleteDialog(name, type))) return;
    const res = await send("asset.delete", { origin: origin ?? "master", id });
    if (res?.ok === false && res.error) {
      if (status) status.textContent = `Delete failed: ${res.error}`;
      return;
    }
    if (selectedAssetId === id) {
      closeArtifactInspector(container);
    }
    if (refresh) await refresh();
  });
  card.addEventListener("reuse", async (e) => {
    const { id, name, type, origin } = e.detail ?? {};
    if (onAttachArtifact) {
      await onAttachArtifact({ id, name, type, origin: origin ?? "master" });
      if (status) status.textContent = `"${name}" sent to the hub — it will attach to a new task.`;
      return;
    }
    const inOverlay = window.parent && window.parent !== window;
    if (inOverlay) {
      try {
        window.parent.postMessage({
          type: "cap:attach-artifact",
          artifact: { id, name, type, origin: origin ?? "master" },
        }, "*");
        if (status) status.textContent = `"${name}" sent to the hub — it will attach to a new task.`;
        return;
      } catch { /* fall through to the copy fallback */ }
    }
    // Standalone fallback: copy the artifact content to the clipboard.
    try {
      const full = await send("asset.get", { origin: origin ?? "master", id }).catch(() => ({ ok: false }));
      const asset = full?.ok ? full.asset : null;
      await navigator.clipboard.writeText(asset?.content ?? name ?? "");
      if (status) status.textContent = `"${name}" copied — paste it into a new task on the hub.`;
    } catch {
      if (status) status.textContent = `Could not reach the hub. Open the artifact + copy it manually.`;
    }
  });
}

export async function renderArtifactsView(containerEl, options = {}) {
  activeContainer = containerEl;
  activeOptions = options;

  const grid = containerEl.querySelector("#artifacts-grid, #grid, .grid");
  const status = containerEl.querySelector("#artifacts-status, #status, .status");
  const foot = containerEl.querySelector("#artifacts-foot, #foot, .foot");
  const capacity = containerEl.querySelector("#artifacts-capacity, #capacity, .capacity");
  const searchInput = containerEl.querySelector("#artifacts-q, #q, .search-input");
  const kindFilter = containerEl.querySelector("#artifacts-kind, #kind, .kind-pills");
  const inspector = containerEl.querySelector("#artifact-inspector, .inspector");

  const { path = "", onAttachArtifact, onGoHome } = options;
  const initialParams = parseArtifactParams(path);
  if (initialParams.kind) filterKind = initialParams.kind;
  if (initialParams.search) searchQuery = initialParams.search;
  if (initialParams.id) selectedAssetId = initialParams.id;

  if (kindFilter && filterKind) {
    kindFilter.querySelectorAll(".kind-pill").forEach((b) => {
      const active = (b.dataset.kind || "").toLowerCase() === filterKind.toLowerCase();
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  if (searchInput && searchQuery) {
    searchInput.value = searchQuery;
  }

  const updateFilteredView = async () => {
    const filtered = allAssets.filter((a) => matchesFilter(a, filterKind, searchQuery));
    if (!grid) return;
    grid.replaceChildren();

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No artifacts match your filter.";
      grid.append(empty);
      if (status) status.textContent = `0 of ${allAssets.length} artifacts match.`;
      if (foot) foot.textContent = "";
      return;
    }

    const isFiltering = filterKind !== "" || searchQuery !== "";
    if (status) {
      status.textContent = isFiltering
        ? `Showing ${filtered.length} of ${allAssets.length} artifacts.`
        : `${allAssets.length} artifact${allAssets.length === 1 ? "" : "s"} — newest first.`;
    }

    if (foot) {
      foot.textContent = filtered.length > MAX_PREVIEWS
        ? `Showing live previews for the newest ${MAX_PREVIEWS}; older artifacts are listed without a live preview.`
        : "";
    }

    const cards = [];
    for (const a of filtered.slice(0, MAX_PREVIEWS)) {
      const card = document.createElement("artifact-card");
      card.setAttribute("id", a.id ?? "");
      card.setAttribute("name", a.name ?? "Untitled");
      card.setAttribute("type", a.type ?? "data");
      card.setAttribute("size", String(a.size ?? 0));
      card.setAttribute("origin", a.origin ?? "master");
      card.setAttribute("time", String(a.at ?? ""));
      if (a.id === selectedAssetId) card.classList.add("selected");
      cards.push({ card, a });
    }
    for (const a of filtered.slice(MAX_PREVIEWS)) {
      const card = document.createElement("artifact-card");
      card.setAttribute("id", a.id ?? "");
      card.setAttribute("name", a.name ?? "Untitled");
      card.setAttribute("type", a.type ?? "data");
      card.setAttribute("size", String(a.size ?? 0));
      card.setAttribute("origin", a.origin ?? "master");
      card.setAttribute("time", String(a.at ?? ""));
      if (a.id === selectedAssetId) card.classList.add("selected");
      cards.push({ card, a });
    }

    for (const { card, a } of cards) {
      wireCard(card, { container: containerEl, onAttachArtifact, onGoHome, refresh: refreshAll });
      grid.append(card);
    }

    // Fetch content for the live previews (bounded to MAX_PREVIEWS).
    for (const { card, a } of cards.slice(0, MAX_PREVIEWS)) {
      const full = await send("asset.get", { origin: a.origin ?? "master", id: a.id });
      if (full?.ok && full.asset) {
        card.preview = full.asset.type === "image" ? (full.asset.content ?? "") : (full.asset.content ?? "");
      }
    }
  };

  const refreshAll = async () => {
    if (capacity) await renderCapacity(capacity);
    const res = await send("asset.list", { origin: "all" }).catch(() => ({ assets: [] }));
    const assets = (Array.isArray(res.assets) ? res.assets : []).slice().reverse();
    allAssets = assets;

    if (kindFilter) kindFilter.hidden = !assets.length;
    if (searchInput) searchInput.hidden = !assets.length;

    if (!assets.length) {
      closeArtifactInspector(containerEl);
      if (grid) {
        grid.replaceChildren();
        const emptyState = document.createElement("empty-state");
        emptyState.setAttribute("title", t("artifacts_empty_title"));
        emptyState.setAttribute("description", t("artifacts_empty_desc"));
        emptyState.setAttribute("action-label", t("artifacts_empty_action"));
        emptyState.setAttribute("action-href", "../ntp/ntp.html");
        emptyState.addEventListener("action", () => {
          if (onGoHome) {
            onGoHome();
            return;
          }
          if (window.parent && window.parent !== window) {
            try {
              window.parent.postMessage({ type: "cap:go-home" }, "*");
              return;
            } catch { /* fallback */ }
          }
          location.href = "../ntp/ntp.html";
        });
        grid.append(emptyState);
      }
      if (status) status.textContent = "";
      if (foot) foot.textContent = "";
      return;
    }

    await updateFilteredView();

    if (selectedAssetId) {
      if (window.innerWidth >= 960) {
        openArtifactInspector(selectedAssetId, "master", { container: containerEl, onAttachArtifact, statusEl: status });
      } else {
        openArtifactDialog(selectedAssetId, "master", { onAttachArtifact, statusEl: status });
      }
    }
  };

  activeRefresh = refreshAll;

  // Wire input listeners once on containerEl
  if (!containerEl.dataset.capWired) {
    containerEl.dataset.capWired = "1";
    searchInput?.addEventListener("input", (e) => {
      searchQuery = e.target.value.trim();
      updateFilteredView();
    });

    kindFilter?.addEventListener("click", (e) => {
      const pill = e.target.closest(".kind-pill");
      if (!pill) return;
      kindFilter.querySelectorAll(".kind-pill").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      pill.classList.add("active");
      pill.setAttribute("aria-selected", "true");
      filterKind = pill.dataset.kind || "";
      if (typeof history !== "undefined" && history.replaceState) {
        const hash = filterKind ? `#view=artifacts&kind=${encodeURIComponent(filterKind)}` : "#view=artifacts";
        try { history.replaceState(history.state, "", hash); } catch { /* test env */ }
      }
      updateFilteredView();
    });
  }

  await refreshAll();
}

export const render = async () => {
  if (activeRefresh) await activeRefresh();
};

// Standalone execution when loaded directly in artifacts/index.html
if (typeof document !== "undefined" && typeof location !== "undefined") {
  const isStandaloneArtifacts =
    (location.pathname?.endsWith("/artifacts/index.html") || location.pathname?.endsWith("/artifacts/")) &&
    document.getElementById("grid") !== null;
  if (isStandaloneArtifacts) {
    if (new URLSearchParams(location.search).get("embedded") === "1" || window.self !== window.top) {
      if (document.documentElement?.dataset) {
        document.documentElement.dataset.embedded = "1";
      } else {
        document.documentElement?.setAttribute?.("data-embedded", "1");
      }
    }
    hydrateI18n();
    document.getElementById("back")?.addEventListener("click", () => {
      if (history.length > 1) history.back();
      else location.href = "../ntp/ntp.html";
    });
    const wrap = document.querySelector(".wrap") || document.body;
    renderArtifactsView(wrap);
  }
}
