// artifacts/index.js — the artifact GALLERY: a grid of <artifact-card> for every
// artifact the agents have made. Each card shows a live preview thumbnail (an
// html artifact renders in a sandboxed iframe), the name/type/size/origin/time,
// and actions: open (the full live viewer), reuse (attach to a new task via the
// parent NTP), delete. Mirrors the directory/recipes view pattern (loaded in the
// NTP's in-context view frame; messaging via lib/messages.js).

import { send } from "../lib/messages.js";
import { renderHtmlFrame, isHtmlDocument, wireHtmlFrameContent } from "../shared/components.js";

const grid = document.getElementById("grid");
const status = document.getElementById("status");
const foot = document.getElementById("foot");

// Bound the live-preview work: preview at most this many artifacts (the most
// recent), so a large gallery stays responsive. The rest render as placeholder
// cards (still openable/deletable).
const MAX_PREVIEWS = 24;

document.getElementById("back")?.addEventListener("click", () => {
  if (history.length > 1) history.back();
  else location.href = "../ntp/ntp.html";
});

async function render() {
  const res = await send("asset.list", { origin: "master" }).catch(() => ({ assets: [] }));
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

function wireCard(card) {
  card.addEventListener("open", (e) => {
    // Item 53/54: open the artifact in an <agent-dialog> (the full live render)
    // instead of navigating to the artifact.html viewer, which doubled up its
    // own back button with the hub's overlay header.
    const { id, origin } = e.detail ?? {};
    openArtifactDialog(id, origin ?? "master");
  });
  card.addEventListener("delete", async (e) => {
    const { id, name, origin } = e.detail ?? {};
    if (!confirm(`Delete "${name}"?`)) return;
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
  body.style.minWidth = "min(76vw, 920px)";
  body.style.minHeight = "200px";
  const type = asset.type ?? "data";
  const content = asset.content ?? "";
  if (type === "html" || (type === "text" && isHtmlDocument(content))) {
    const frame = document.createElement("div");
    frame.style.border = "1px solid var(--border)";
    frame.style.borderRadius = "10px";
    frame.style.overflow = "hidden";
    frame.style.background = "#fff";
    frame.innerHTML = renderHtmlFrame(content);
    const frameCleanup = wireHtmlFrameContent(frame); // deliver the staged guarded HTML to the sandbox host
    frameCleanups.push(frameCleanup); // retained → cleaned on the dialog close
    body.append(frame);
  } else if (type === "image") {
    const img = document.createElement("img");
    img.src = content;
    img.alt = asset.name ?? "artifact";
    img.style.maxWidth = "100%";
    body.append(img);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = content;
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontSize = "13px";
    body.append(pre);
  }
  dialog.append(body);
  document.body.append(dialog);
  dialog.show();
  dialog.addEventListener("close", () => { frameCleanups.forEach((c) => { try { c(); } catch {} }); dialog.remove(); }, { once: true });
}

render();
