// artifacts/index.js — the artifact GALLERY: a grid of <artifact-card> for every
// artifact the agents have made. Each card shows a live preview thumbnail (an
// html artifact renders in a sandboxed iframe), the name/type/size/origin/time,
// and actions: open (the full live viewer), reuse (attach to a new task via the
// parent NTP), delete. Mirrors the directory/recipes view pattern (loaded in the
// NTP's in-context view frame; messaging via lib/messages.js).

import { send } from "../lib/messages.js";
import { renderHtmlFrame, isHtmlDocument, wireHtmlFrameContent, confirmActionDialog } from "../shared/components.js";

if (new URLSearchParams(location.search).get("embedded") === "1" || window.self !== window.top) {
  document.documentElement.dataset.embedded = "1";
}

const grid = document.getElementById("grid");
const status = document.getElementById("status");
const foot = document.getElementById("foot");
const capacity = document.getElementById("capacity");

// Bound the live-preview work: preview at most this many artifacts (the most
// recent), so a large gallery stays responsive. The rest render as placeholder
// cards (still openable/deletable).
const MAX_PREVIEWS = 24;

document.getElementById("back")?.addEventListener("click", () => {
  if (history.length > 1) history.back();
  else location.href = "../ntp/ntp.html";
});

// CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01 — the library never silently
// evicts the owner's oldest artifact; at capacity a create is refused. This
// indicator tells the owner the library is filling up (and when it is full,
// that they must delete something) BEFORE that refusal is hit. Shown only once
// the library is meaningfully full so it stays out of the way otherwise.
async function renderCapacity() {
  if (!capacity) return;
  const cap = await send("asset.capacity", {}).catch(() => null);
  if (!cap?.ok || !(cap.maxBytes > 0)) { capacity.hidden = true; return; }
  const pct = Math.min(100, Math.round((cap.fraction ?? 0) * 100));
  if (pct < 75 && !cap.full) { capacity.hidden = true; return; }
  const full = cap.full === true;
  capacity.classList.toggle("full", full);
  capacity.classList.toggle("warn", !full);
  const label = full ? "Library full" : "Library filling up";
  const detail = full
    ? "New artifacts will be refused until you delete some. Nothing you made is ever removed automatically."
    : `${pct}% of the artifact index used. When it fills, new artifacts are refused rather than dropping your oldest — delete artifacts to keep room.`;
  capacity.replaceChildren();
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
  capacity.append(row, bar, p);
  capacity.hidden = false;
}

async function render() {
  renderCapacity();
  // The LIBRARY — every artifact the owner has, not just the ones the hub agent
  // made. Passing origin:"master" here is what hid every site-origin artifact
  // (CAP-FB-20260828-ARTIFACT-DURABILITY-01).
  const res = await send("asset.list", { origin: "all" }).catch(() => ({ assets: [] }));
  const assets = (Array.isArray(res.assets) ? res.assets : []).slice().reverse();
  grid.replaceChildren();

  if (!assets.length) {
    grid.innerHTML = `<div class="empty">No artifacts yet. Ask an agent to make something.</div>`;
    status.textContent = "";
    foot.textContent = "";
    return;
  }

  status.textContent = `${assets.length} artifact${assets.length === 1 ? "" : "s"} — newest first.`;
  foot.textContent = assets.length > MAX_PREVIEWS
    ? `Showing live previews for the newest ${MAX_PREVIEWS}; older artifacts are listed without a live preview.`
    : "";

  const cards = [];
  for (const a of assets.slice(0, MAX_PREVIEWS)) {
    const card = document.createElement("artifact-card");
    card.setAttribute("id", a.id ?? "");
    card.setAttribute("name", a.name ?? "Untitled");
    card.setAttribute("type", a.type ?? "data");
    card.setAttribute("size", String(a.size ?? 0));
    card.setAttribute("origin", a.origin ?? "master");
    card.setAttribute("time", String(a.at ?? ""));
    cards.push({ card, a });
  }
  for (const a of assets.slice(MAX_PREVIEWS)) {
    const card = document.createElement("artifact-card");
    card.setAttribute("id", a.id ?? "");
    card.setAttribute("name", a.name ?? "Untitled");
    card.setAttribute("type", a.type ?? "data");
    card.setAttribute("size", String(a.size ?? 0));
    card.setAttribute("origin", a.origin ?? "master");
    card.setAttribute("time", String(a.at ?? ""));
    cards.push({ card, a });
  }

  for (const { card, a } of cards) {
    wireCard(card);
    grid.append(card);
  }

  // Fetch content for the live previews (bounded to MAX_PREVIEWS).
  for (const { card, a } of cards.slice(0, MAX_PREVIEWS)) {
    const full = await send("asset.get", { origin: a.origin ?? "master", id: a.id });
    if (full?.ok && full.asset) {
      card.preview = full.asset.type === "image" ? (full.asset.content ?? "") : (full.asset.content ?? "");
    }
  }
}

// Artifact deletion uses the SHARED confirm (CAP-FB-20260827-DIALOG-CONSOLIDATION-01).
// This was a hand-rolled <dialog> duplicating confirmActionDialog — the exact
// pattern the project rules forbid, and why dialogs behaved inconsistently: each
// copy owned its own focus, dismiss and sizing behaviour, so a fix to one never
// reached the others. The shared one is also strictly better here: it adds
// backdrop light-dismiss, an aria-label, and a settled guard, and it already
// implements the rule this dialog cared about — a destructive confirm focuses
// Cancel, not the destructive button.
function confirmDeleteDialog(name, type) {
  return confirmActionDialog({
    title: "Delete artifact",
    body: `Delete "${name ?? "Untitled"}" (${type ?? "data"})? This permanently removes it from the artifact store.`,
    confirmLabel: "Delete",
    destructive: true,
  });
}

function wireCard(card) {
  card.addEventListener("open-tab", (e) => {
    const { id, origin } = e.detail ?? {};
    const url = chrome.runtime.getURL(`artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`);
    if (typeof chrome !== "undefined" && chrome.tabs?.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank");
    }
  });
  card.addEventListener("open", (e) => {
    // Item 53/54: open the artifact in an <agent-dialog> (the full live render)
    // instead of navigating to the artifact.html viewer, which doubled up its
    // own back button with the hub's overlay header.
    const { id, origin } = e.detail ?? {};
    openArtifactDialog(id, origin ?? "master");
  });
  card.addEventListener("delete", async (e) => {
    const { id, name, type, origin } = e.detail ?? {};
    // Direct owner action: the modal names the artifact; confirming deletes it
    // with NO permission grant (the owner's click is the approval).
    if (!(await confirmDeleteDialog(name, type))) return;
    const res = await send("asset.delete", { origin: origin ?? "master", id });
    if (res?.ok === false && res.error) {
      status.textContent = `Delete failed: ${res.error}`;
      return;
    }
    await render();
  });
  card.addEventListener("reuse", async (e) => {
    const { id, name, type, origin } = e.detail ?? {};
    // Ask the parent NTP to attach this artifact to a new task (the NTP owns
    // the composer + the thread surface). When the gallery is NOT in the NTP
    // overlay (standalone), the postMessage goes nowhere — fall back to copying
    // the artifact content so the action always does something.
    const inOverlay = window.parent && window.parent !== window;
    if (inOverlay) {
      try {
        window.parent.postMessage({
          type: "cap:attach-artifact",
          artifact: { id, name, type, origin: origin ?? "master" },
        }, "*");
        status.textContent = `"${name}" sent to the hub — it will attach to a new task.`;
        return;
      } catch { /* fall through to the copy fallback */ }
    }
    // Standalone fallback: copy the artifact content to the clipboard.
    try {
      const full = await send("asset.get", { origin: origin ?? "master", id }).catch(() => ({ ok: false }));
      const asset = full?.ok ? full.asset : null;
      await navigator.clipboard.writeText(asset?.content ?? name ?? "");
      status.textContent = `"${name}" copied — paste it into a new task on the hub.`;
    } catch {
      status.textContent = `Could not reach the hub. Open the artifact + copy it manually.`;
    }
  });
}

// Item 53/54: the artifact expand dialog — the full live render (html in the
// sandboxed iframe, image inline, or text) in an <agent-dialog>, without the
// artifact.html viewer's doubled-up header.
async function openArtifactDialog(id, origin) {
  const res = await send("asset.get", { origin: origin ?? "master", id }).catch(() => ({ ok: false }));
  const asset = res?.ok ? res.asset : null;
  if (!asset) { status.textContent = "Artifact not found."; return; }
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
  metaSpan.textContent = `${asset.type ?? "data"} · ${asset.size ?? 0} B · ${origin ?? "master"}`;

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
  openTabBtn.innerHTML = `<span>Open in new tab</span> <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
  openTabBtn.addEventListener("click", () => {
    const url = chrome.runtime.getURL(`artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`);
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
    frame.style.background = "#fff";
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
  dialog.addEventListener("close", () => { frameCleanups.forEach((c) => { try { c(); } catch {} }); dialog.remove(); }, { once: true });
}

render();
