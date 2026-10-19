// extension/options/panels/about.js — About section panel (Stage 3a, 8v5l.1).

import { DEVELOPER_FEATURES_KEY } from "../../lib/pure.js";
import { isUserFacingEntry, partitionChangelog } from "../changelog-filter.js";
import { withUnmount, bindPanelCtx } from "../panel-context.js";
import { devVersionLabel, loadDevBuildIdentity } from "../../lib/dev-build-identity.js";

export { isUserFacingEntry, partitionChangelog };

const [ensureCtx, $, , byId, send, , storage, saveFlash, , makeUnmount] = bindPanelCtx("about");
const rootState = new WeakMap();

function getState(root) {
  if (!root) return { staticWired: false, aboutRendered: false };
  let s = rootState.get(root);
  if (!s) {
    s = { staticWired: false, aboutRendered: false };
    rootState.set(root, s);
  }
  return s;
}

async function renderShortcuts(ctx) {
  const host = $("#shortcut-list");
  if (!host) return;
  let commands = [];
  try {
    commands = (await chrome.commands?.getAll?.()) ?? [];
  } catch { /* non-extension context (the gallery/browser test) */ }
  host.replaceChildren();
  if (!commands.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Keyboard shortcuts are unavailable in this context.";
    host.append(p);
    return;
  }
  for (const cmd of commands) {
    // `_execute_action` and friends have no description; skip anything unnamed.
    if (!cmd?.description) continue;
    const dt = document.createElement("dt");
    if (cmd.shortcut) {
      const kbd = document.createElement("kbd");
      kbd.textContent = cmd.shortcut;
      dt.append(kbd);
    } else {
      const span = document.createElement("span");
      span.className = "muted unbound";
      span.textContent = "Not set";
      dt.append(span);
    }
    const dd = document.createElement("dd");
    dd.textContent = cmd.description;
    host.append(dt, dd);
  }
}

// ── About / changelog ────────────────────────────────────────────────────────
// Render the bundled CHANGELOG.md into the About section. Each `## [version]`
// becomes a version card with its bullet list (built as DOM nodes, never
// innerHTML, so the markdown stays inert).
function renderChangelog(md, ctx) {
  const host = $("#changelog");
  if (!host) return;
  host.replaceChildren();
  const { recent, rest } = partitionChangelog(md);
  const buildCard = (v, bullets) => {
    const card = document.createElement("div");
    card.className = "changelog-entry";
    const head = document.createElement("div");
    head.className = "changelog-head";
    const vEl = document.createElement("strong");
    vEl.textContent = "v" + v.version;
    const date = document.createElement("span");
    date.className = "muted";
    date.textContent = v.date;
    head.append(vEl, date);
    card.append(head);
    const list = document.createElement("ul");
    list.className = "changelog-items";
    for (const b of bullets) {
      const li = document.createElement("li");
      li.textContent = b;
      list.append(li);
    }
    card.append(list);
    return card;
  };
  for (const r of recent) {
    host.append(buildCard(r, r.bullets));
  }
  if (!recent.length) {
    host.innerHTML = `<p class="muted">No changelog yet.</p>`;
    return;
  }
  const details = document.createElement("details");
  details.className = "changelog-all";
  const summary = document.createElement("summary");
  summary.textContent = "Show all release notes";
  details.append(summary);
  details.addEventListener("toggle", () => {
    if (!details.open || details.querySelector(".changelog-all-body")) return;
    const all = document.createElement("div");
    all.className = "changelog-all-body";
    for (const entry of rest) all.append(buildCard(entry, entry.bullets));
    details.append(all);
  });
  host.append(details);
}

async function renderAbout(ctx) {
  const c = ensureCtx(null, ctx);
  const state = getState(c.root);
  if (state.aboutRendered) return;
  state.aboutRendered = true;
  try {
    const licensesLink = byId("open-about-licenses");
    if (licensesLink) licensesLink.setAttribute("href", chrome.runtime.getURL("about/about.html"));
  } catch { /* non-extension context */ }
  try {
    const full = byId("full-release-notes");
    if (full) full.setAttribute("href", chrome.runtime.getURL("CHANGELOG.md"));
  } catch { /* non-extension context */ }
  try {
    const url = chrome.runtime.getURL("CHANGELOG.md");
    const res = await fetch(url);
    if (!res.ok) throw new Error("changelog fetch " + res.status);
    renderChangelog(await res.text(), c);
  } catch {
    renderChangelog("# Changelog\n\n## [0.0.0] — \n- Changelog unavailable in this context.\n", c);
  }
}

export function initAboutStatic(root, ctx) {
  const c = ensureCtx(root, ctx);
  if (root) c.root = root;
  const state = getState(c.root);
  if (state.staticWired) return;
  state.staticWired = true;

  c.registerCleanup(() => {
    if (c.root) rootState.delete(c.root);
  });

  const devToggle = byId("developer-features");
  if (devToggle) {
    devToggle.checked = Boolean(c.developerFeatures());
    devToggle.addEventListener("toggle", async (e) => {
      const on = e.detail?.checked === true;
      c.setDeveloperFeatures(on);
      await storage.set({ [DEVELOPER_FEATURES_KEY]: on });
      if (typeof c.callbacks?.onDeveloperFeaturesChange === "function") {
        await c.callbacks.onDeveloperFeaturesChange(on);
      } else if (on) {
        try {
          await storage.get("cap:providerServerTools");
        } catch { /* ignore */ }
      }
      try {
        await send({ type: "invalidate-agent" });
      } catch { /* worker idle — the setting still persists */ }
      saveFlash(on ? "Developer features on." : "Developer features off.");
    });
  }

  try {
    const v = chrome.runtime?.getManifest?.()?.version;
    const av = $("#about-version");
    if (av && v) loadDevBuildIdentity().then((identity) => { av.textContent = devVersionLabel(v, identity); });
  } catch { /* non-extension (browser test) — leave the placeholder */ }

  $("#open-shortcut-settings")?.addEventListener("click", () => {
    chrome.tabs?.create?.({ url: "chrome://extensions/shortcuts" });
  });

  renderShortcuts(c);
}

export function mount(root, ctx) {
  const c = ensureCtx(root, ctx);
  const run = (async () => {
    initAboutStatic(root, c);
    await renderAbout(c);
  })();
  return withUnmount(run, makeUnmount(c));
}
