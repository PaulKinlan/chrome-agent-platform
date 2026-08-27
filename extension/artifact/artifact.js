// artifact.js — the artifact VIEWER. Opens an artifact (by ?id= + ?origin=) and
// renders it LIVE: an html artifact renders in the sandboxed double-iframe with
// the owner's theme/locale percolated in (the validated postMessage down-channel).
// This is the reusable surface for viewing/reusing any generated UI.

import { send } from "../lib/messages.js";
import {
  renderHtmlFrame,
  wireHtmlFrameContent,
  wireHtmlFramePreference,
  currentFramePreference,
} from "../shared/components.js";

const params = new URLSearchParams(location.search);
const id = params.get("id") ?? "";
const origin = params.get("origin") ?? "master";

const nameEl = document.getElementById("name");
const metaEl = document.getElementById("meta");
const out = document.getElementById("out");
const copyBtn = document.getElementById("copy-content");

document.getElementById("back").addEventListener("click", () => {
  if (history.length > 1) history.back();
  else location.href = "../ntp/ntp.html";
});

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

async function main() {
  if (!id) {
    out.innerHTML = `<div class="error">No artifact id given.</div>`;
    return;
  }
  const res = await send("asset.get", { origin, id });
  const asset = res?.ok ? res.asset : null;
  if (!asset) {
    out.innerHTML = `<div class="error">Artifact not found: ${id}</div>`;
    return;
  }
  nameEl.textContent = asset.name ?? "Artifact";
  metaEl.textContent = `${asset.type ?? "unknown"} · ${asset.size ?? 0} B · ${origin}`;
  currentAssetContent = asset.content ?? "";

  if (asset.type === "html" || (asset.type === "text" && /^\s*<!doctype html|<html|</i.test(asset.content ?? ""))) {
    const frame = document.createElement("div");
    frame.className = "frame";
    frame.innerHTML = renderHtmlFrame(asset.content ?? "");
    out.append(frame);
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
  } else if (asset.type === "image") {
    const img = document.createElement("img");
    img.className = "artifact-img";
    img.src = asset.content ?? "";
    img.alt = asset.name ?? "artifact";
    out.append(img);
  } else {
    const pre = document.createElement("pre");
    pre.className = "artifact-pre";
    pre.textContent = asset.content ?? "";
    out.append(pre);
  }
}

main();
