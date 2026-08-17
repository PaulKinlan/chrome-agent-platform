// artifacts/index.js — the artifact GALLERY: a grid of <artifact-card> for every
// artifact the agents have made. Each card shows a live preview thumbnail (an
// html artifact renders in a sandboxed iframe), the name/type/size/origin/time,
// and actions: open (the full live viewer), reuse (attach to a new task via the
// parent NTP), delete. Mirrors the directory/recipes view pattern (loaded in the
// NTP's in-context view frame; messaging via lib/messages.js).

import { send } from "../lib/messages.js";

const grid = document.getElementById("grid");
const status = document.getElementById("status");
const foot = document.getElementById("foot");

// Bound the live-preview work: preview at most this many artifacts (the most
// recent), so a large gallery stays responsive. The rest render as placeholder
// cards (still openable/deletable).
const MAX_PREVIEWS = 24;

document.getElementById("back").addEventListener("click", () => {
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
    const { id, origin } = e.detail ?? {};
    location.href = `../artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`;
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
  card.addEventListener("reuse", (e) => {
    const { id, name, type, origin } = e.detail ?? {};
    // Ask the parent NTP to attach this artifact to a new task (the NTP owns
    // the composer + the thread surface).
    try {
      window.parent?.postMessage({
        type: "cap:attach-artifact",
        artifact: { id, name, type, origin: origin ?? "master" },
      }, "*");
      status.textContent = `"${name}" sent to the hub — it will attach to a new task.`;
    } catch {
      status.textContent = `Could not reach the hub. Open the artifact + copy it manually.`;
    }
  });
}

render();
