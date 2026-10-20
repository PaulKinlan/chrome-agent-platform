// options.js — the dedicated settings/configuration page (standalone host for Stage 3a panel modules).

const IS_EMBEDDED_SETTINGS = new URLSearchParams(location.search).get("embedded") === "1" || window.self !== window.top;
if (IS_EMBEDDED_SETTINGS) document.documentElement.dataset.embedded = "1";

import { registerWasmPreviewHost } from "../lib/wasm-preview-host.js";
import {
  SETTINGS_SECTIONS,
  DEVELOPER_SECTIONS_SET,
  DEVELOPER_FEATURES_KEY,
  normalizeSettingsSectionId,
  sleep,
} from "../lib/pure.js";
import { hydrateI18n } from "../shared/i18n.js";
import { devVersionLabel, loadDevBuildIdentity } from "../lib/dev-build-identity.js";
import { consumeSiteActivityFocus, normalizeSiteActivityFocus, SITE_ACTIVITY_FOCUS_KEY } from "../lib/site-activity-focus.js";
import { createNavigationController } from "../lib/navigation-controller.js";
import "../shared/components-settings.js";
import { refreshDiagnostics } from "../shared/diagnostics-client.js";
import { mountSkillsSection } from "../skills/skills-panel.js";
import { mountUserWasmPanel } from "./user-wasm-panel.js";
import { capLog } from "../lib/cap-log.js";
import { createPanelContext } from "./panel-context.js";
import "./panel-registry.js";

import {
  renderServerToolAgents,
  initProvidersStatic,
  mount as mountProvidersPanel,
} from "./panels/providers.js";
import {
  initMcpServersStatic,
  mount as mountMcpServersPanel,
} from "./panels/mcp-servers.js";
import { renderLocalFolders as renderLocalFoldersPanel } from "./panels/local-folders.js";
import "./panels/user-wasm.js";
import {
  renderToolLibrary as renderToolLibraryPanel,
  mount as mountToolLibraryPanel,
} from "./panels/tool-library.js";
import "./panels/skills.js";
let agentsModulePromise = null;
function getAgentsModule() {
  return (agentsModulePromise ??= import("./panels/agents.js").catch((err) => {
    agentsModulePromise = null;
    throw err;
  }));
}

async function mountAgentsPanel(root, ctx) {
  const mod = await getAgentsModule();
  return mod.mount(root, ctx);
}

async function renderSiteToolConsentsPanel(options, ctx) {
  const mod = await getAgentsModule();
  return mod.renderSiteToolConsents(options, ctx);
}

async function hydrateAgentsHeavyListsPanel(ctx) {
  const mod = await getAgentsModule();
  return mod.hydrateAgentsHeavyLists(ctx);
}
import {
  syncBrowserGrantState,
  renderActionPolicy as renderActionPolicyPanel,
  mount as mountBrowserPanel,
} from "./panels/browser.js";
import {
  populateBoardDenyAgents as populateBoardDenyAgentsPanel,
  initBoardDenyUI as initBoardDenyUIPanel,
} from "./panels/board-permissions.js";
import { mount as mountPermissionsPanel } from "./panels/permissions.js";
import {
  initVaultStatic,
  mount as mountWebServicesPanel,
} from "./panels/web-services.js";
import {
  renderHooks as renderHooksPanel,
  mount as mountHooksPanel,
} from "./panels/hooks.js";
import {
  wireObservabilitySettings as wireObservabilitySettingsPanel,
  renderPrompts as renderPromptsPanel,
  mount as mountPromptsPanel,
} from "./panels/prompts.js";
import {
  renderUsage as renderUsagePanel,
  initUsageStatic,
} from "./panels/usage.js";
import {
  wireRunRetentionSettings as wireRunRetentionSettingsPanel,
  renderMemoryExplorer as renderMemoryExplorerPanel,
  renderData as renderDataPanel,
  initDataStatic,
} from "./panels/data.js";
import {
  initAboutStatic,
  mount as mountAboutPanel,
} from "./panels/about.js";

const $ = (sel) => document.querySelector(sel);
const { boundedSend, storage } = createPanelContext();

let developerFeaturesEnabled = false;

async function readDeveloperFeaturesFlag() {
  try {
    const got = await storage.get(DEVELOPER_FEATURES_KEY);
    developerFeaturesEnabled = got?.[DEVELOPER_FEATURES_KEY] === true;
  } catch {
    developerFeaturesEnabled = false;
  }
  return developerFeaturesEnabled;
}

function applyDeveloperVisibility(on) {
  for (const el of document.querySelectorAll('[data-developer="true"]')) {
    el.hidden = !on;
  }
  if (!on) {
    const agentsPanel = document.getElementById("server-tools-agents");
    if (agentsPanel) agentsPanel.hidden = true;
  }
}

let storageGranted = false;

async function refreshStoragePermission() {
  try {
    storageGranted = await chrome.permissions.contains({ permissions: ["storage"] });
  } catch {
    storageGranted = false;
  }
  return storageGranted;
}

registerWasmPreviewHost();

const admissionHostLog = capLog("options:wasm-package-admission");
const admissionHostReady = (async () => {
  try {
    const runtime = globalThis.chrome?.runtime;
    if (runtime?.getURL && runtime?.onMessage) {
      const { registerWasmPackageAdmissionHost } = await import(runtime.getURL("lib/wasm-package-admission.js"));
      registerWasmPackageAdmissionHost({ runtime });
    }
  } catch (err) {
    admissionHostLog.warn("host registration failed:", err?.message ?? err);
  }
})();

let flashTimer;
function saveFlash(msg) {
  const el = $("#save-status");
  if (!el) return;
  el.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.textContent = "Changes save automatically.";
  }, 2500);
}

function returnToHubComposer() {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "cap:return-to-hub-composer" }, window.location.origin);
      return;
    }
  } catch { /* cross-origin parent — fall through to a full navigation */ }
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    window.location.href = chrome.runtime.getURL("ntp/ntp.html#compose");
  }
}

function openNamedAgentEditor(agent) {
  const message = { type: "cap:edit-named-agent", id: agent.id };
  /* Origin-scoped like returnToHubComposer above (chrome-agent-platform-wfxe):
     the parent that receives this is the extension's own hub page, so its
     origin IS knowable and a wildcard target only widens the audience for a
     message that names an action and an agent id. */
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, window.location.origin);
      return;
    }
  } catch { /* cross-origin parent — fall through to the full navigation */ }
  window.location.href = chrome.runtime.getURL(`ntp/ntp.html#agent=named:${encodeURIComponent(agent.id)}&edit=1`);
}

function goHomeToHub() {
  try { window.parent?.postMessage({ type: "cap:go-home" }, "*"); } catch { /* parent may not be the CAP hub; nothing to notify */ }
}

const sectionContexts = new Map();
const devRendered = new Set();

const hostCallbacks = {
  admissionHostReady,
  onDiagnosticsRevision: () => {
    refreshDiagnostics().catch(() => {});
  },
  goHome: goHomeToHub,
  returnToComposer: returnToHubComposer,
  editNamedAgent: openNamedAgentEditor,
  onFactoryReset: () => {
    if (typeof window !== "undefined") {
      window.location.href = chrome.runtime.getURL("ntp/ntp.html#factory-reset");
    }
  },
  onPermissionsChanged: () => {
    renderActionPolicyPanel(getSectionContext("browser"));
  },
  onEnrolledSitesChanged: () => {
    renderDataPanel(getSectionContext("data"));
  },
  onSiteDataChanged: () => {
    renderDataPanel(getSectionContext("data"));
    renderSiteToolConsentsPanel({ cursor: null }, getSectionContext("agents")).catch(() => {});
  },
  onDeveloperFeaturesChange: async (on) => {
    developerFeaturesEnabled = Boolean(on);
    applyDeveloperVisibility(developerFeaturesEnabled);
    if (developerFeaturesEnabled) {
      for (const [id, fn] of [
        ["tool-library", renderToolLibraryPanel],
        ["hooks", renderHooksPanel],
        ["prompts", renderPromptsPanel],
        ["board-permissions", populateBoardDenyAgentsPanel],
      ]) {
        if (!devRendered.has(id)) {
          devRendered.add(id);
          try { await fn(getSectionContext(id)); } catch { /* section visible; empty */ }
        }
      }
      try {
        const st = await storage.get("cap:providerServerTools");
        await renderServerToolAgents(st?.["cap:providerServerTools"]?.enabled === true, getSectionContext("providers"));
      } catch { /* providers section absent — nothing to reveal */ }
    }
  },
};

function buildHostContext(sectionId, rootOverride) {
  const root = rootOverride ?? (typeof document !== "undefined" ? (document.getElementById(sectionId) ?? document) : null);
  return createPanelContext({
    root,
    send: (type, payload = {}, rawMsg) => chrome.runtime.sendMessage(rawMsg ?? { type, ...payload }),
    boundedSend,
    storage,
    embedded: IS_EMBEDDED_SETTINGS,
    isFirstRunFlow: () => {
      const sp = new URLSearchParams(location.search);
      return IS_EMBEDDED_SETTINGS || location.hash === "#providers" || sp.get("flow") === "first-run" || sp.get("firstRun") === "1" || sp.get("firstRun") === "true";
    },
    developerFeatures: () => developerFeaturesEnabled,
    setDeveloperFeatures: (on) => {
      developerFeaturesEnabled = Boolean(on);
    },
    storageGranted: () => storageGranted,
    refreshStoragePermission,
    navigateSection: (id, { replace = true } = {}) =>
      navigationController.navigate(id.startsWith("#") ? id : `#${id}`, { replace }),
    saveFlash,
    callbacks: hostCallbacks,
  });
}

function getSectionContext(sectionId) {
  let ctx = sectionContexts.get(sectionId);
  const el = typeof document !== "undefined" ? document.getElementById(sectionId) : null;
  if (!ctx) {
    ctx = buildHostContext(sectionId, el);
    sectionContexts.set(sectionId, ctx);
  } else if (el && ctx.root !== el) {
    ctx.root = el;
  }
  return ctx;
}

export async function renderLocalFolders() {
  return renderLocalFoldersPanel(getSectionContext("local-folders"));
}

function ensureDeveloperLockedNotice() {
  let el = document.getElementById("developer-locked-notice");
  if (el) return el;
  const main = document.querySelector("main.content") || document.body;
  el = document.createElement("div");
  el.id = "developer-locked-notice";
  el.className = "panel developer-locked-notice";
  el.setAttribute("role", "status");
  el.hidden = true;
  el.tabIndex = -1;
  const h = document.createElement("h2");
  h.textContent = "Developer feature";
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = "This section is part of the developer features. Turn on “Show developer features” in About to see it.";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn small";
  btn.textContent = "Go to About";
  btn.addEventListener("click", () => navigationController.navigate("#about", { replace: true }));
  el.append(h, p, btn);
  const header = main.querySelector(".head");
  if (header && header.nextSibling) main.insertBefore(el, header.nextSibling);
  else main.appendChild(el);
  return el;
}
function showDeveloperLockedNotice() {
  const el = ensureDeveloperLockedNotice();
  el.hidden = false;
  document.querySelectorAll(".nav-item").forEach((x) => x.removeAttribute("aria-current"));
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.focus({ preventScroll: true });
}
function hideDeveloperLockedNotice() {
  const el = document.getElementById("developer-locked-notice");
  if (el) el.hidden = true;
}

const renderedSections = new Set();
// The claim is taken BEFORE the renderer runs so two overlapping navigations
// never build a section twice — but a renderer that THROWS must not keep the
// claim, or the section stays blank for the life of the page with no way back
// (hy91: a blank Providers panel is indistinguishable from a broken install).
// The claim is released on failure so the next navigation retries.
async function ensureSectionRendered(sectionId) {
  if (renderedSections.has(sectionId)) return;
  renderedSections.add(sectionId);
  try {
    await renderSection(sectionId);
  } catch (e) {
    renderedSections.delete(sectionId);
    throw e;
  }
}

async function renderSection(sectionId) {
  const ctx = getSectionContext(sectionId);
  if (sectionId === "providers") {
    await mountProvidersPanel(ctx.root, ctx);
  } else if (sectionId === "mcp-servers") {
    await mountMcpServersPanel(ctx.root, ctx);
  } else if (sectionId === "local-folders") {
    await renderLocalFolders();
  } else if (sectionId === "tool-library") {
    if (developerFeaturesEnabled) await mountToolLibraryPanel(ctx.root, ctx);
  } else if (sectionId === "user-wasm") {
    await mountUserWasmPanel(document.getElementById("user-wasm-manager"));
  } else if (sectionId === "agents") {
    await mountAgentsPanel(ctx.root, ctx);
  } else if (sectionId === "browser") {
    await mountBrowserPanel(ctx.root, ctx);
  } else if (sectionId === "board-permissions") {
    if (developerFeaturesEnabled) await populateBoardDenyAgentsPanel(ctx);
  } else if (sectionId === "permissions") {
    await mountPermissionsPanel(ctx.root, ctx);
  } else if (sectionId === "web-services") {
    await mountWebServicesPanel(ctx.root, ctx);
  } else if (sectionId === "skills") {
    mountSkillsSection(document.getElementById("skills"));
  } else if (sectionId === "hooks") {
    if (developerFeaturesEnabled) await mountHooksPanel(ctx.root, ctx);
  } else if (sectionId === "prompts") {
    if (developerFeaturesEnabled) await mountPromptsPanel(ctx.root, ctx);
  } else if (sectionId === "usage") {
    await renderUsagePanel(undefined, ctx);
  } else if (sectionId === "data") {
    await renderDataPanel(ctx);
    await renderMemoryExplorerPanel(ctx);
  } else if (sectionId === "about") {
    await mountAboutPanel(ctx.root, ctx);
  }
}

export function expandNavGroup(groupEl) {
  if (!groupEl) return;
  const btn = groupEl.querySelector(".nav-group-header");
  const items = groupEl.querySelector(".nav-group-items");
  if (btn) btn.setAttribute("aria-expanded", "true");
  if (items) items.hidden = false;
}

export function collapseNavGroup(groupEl) {
  if (!groupEl) return;
  const btn = groupEl.querySelector(".nav-group-header");
  const items = groupEl.querySelector(".nav-group-items");
  if (btn) btn.setAttribute("aria-expanded", "false");
  if (items) items.hidden = true;
}

export function toggleNavGroup(groupEl) {
  if (!groupEl) return;
  const btn = groupEl.querySelector(".nav-group-header");
  const isExpanded = btn?.getAttribute("aria-expanded") === "true";
  if (isExpanded) {
    collapseNavGroup(groupEl);
  } else {
    expandNavGroup(groupEl);
  }
}

export function wireNavGroupAccordions(root = document) {
  if (!root) return;
  const isNav = root.tagName === "NAV" || (typeof root.matches === "function" && (root.matches("nav.settings-nav") || root.matches("nav[aria-label='Settings categories']")));
  const nav = isNav ? root : (root.querySelector ? root.querySelector("nav.settings-nav, nav[aria-label='Settings categories']") : null);

  const container = nav || root;
  if (container.querySelectorAll) {
    container.querySelectorAll(".nav-group").forEach((group) => {
      const btn = group.querySelector(".nav-group-header");
      if (!btn) return;
      btn.addEventListener("click", () => {
        toggleNavGroup(group);
      });
    });
  }

  if (nav) {
    nav.addEventListener("keydown", (e) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
      const visibleLinks = Array.from(nav.querySelectorAll(".nav-item")).filter((a) => {
        const group = a.closest ? a.closest(".nav-group") : null;
        if (group) {
          if (group.hidden) return false;
          const items = a.closest ? a.closest(".nav-group-items") : null;
          if (items && items.hidden) return false;
        }
        return true;
      });
      if (!visibleLinks.length) return;
      const activeDoc = nav.ownerDocument || (root && root.ownerDocument) || (typeof document !== "undefined" ? document : null);
      const currentActive = activeDoc ? activeDoc.activeElement : null;
      const currentIndex = visibleLinks.indexOf(currentActive);
      let targetIndex = -1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        targetIndex = currentIndex >= 0 ? (currentIndex + 1) % visibleLinks.length : 0;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        targetIndex = currentIndex >= 0 ? (currentIndex - 1 + visibleLinks.length) % visibleLinks.length : visibleLinks.length - 1;
      } else if (e.key === "Home") {
        e.preventDefault();
        targetIndex = 0;
      } else if (e.key === "End") {
        e.preventDefault();
        targetIndex = visibleLinks.length - 1;
      }
      if (targetIndex >= 0 && visibleLinks[targetIndex]) {
        visibleLinks[targetIndex].focus();
        if (activeDoc) {
          try {
            activeDoc.activeElement = visibleLinks[targetIndex];
          } catch {
            // standard document.activeElement is updated by focus()
          }
        }
      }
    });
  }
}

// nav active state
export async function handleSettingsHashNavigation(hash, isTraverse = false) {
  let cleanId = typeof hash === "string" ? (hash.startsWith("#") ? hash.slice(1).trim() : hash.trim()) : "";
  if (cleanId.startsWith("section-")) cleanId = cleanId.slice("section-".length);
  else if (cleanId.startsWith("section=")) cleanId = cleanId.slice("section=".length);
  if (cleanId === "provider") cleanId = "providers";
  const sectionId = normalizeSettingsSectionId(cleanId) || normalizeSettingsSectionId(hash) || "providers";
  if (!sectionId) return false;

  const section = document.getElementById(sectionId);
  if (!section) return false;

  if (!developerFeaturesEnabled && DEVELOPER_SECTIONS_SET.has(sectionId)) {
    document.querySelectorAll("section.panel").forEach((s) => {
      s.classList.remove("active");
      s.dataset.active = "false";
    });
    showDeveloperLockedNotice();
    return true;
  }
  hideDeveloperLockedNotice();

  const wasActive = section.classList.contains("active");

  document.querySelectorAll("section.panel").forEach((s) => {
    s.classList.toggle("active", s.id === sectionId);
    s.dataset.active = s.id === sectionId ? "true" : "false";
  });

  document.querySelectorAll(".nav-item").forEach((x) => {
    const match = x.dataset.section === sectionId ||
      x.getAttribute("href") === `#${sectionId}`;
    if (match) {
      x.setAttribute("aria-current", "true");
      const group = x.closest(".nav-group");
      if (group) expandNavGroup(group);
    } else {
      x.removeAttribute("aria-current");
    }
  });

  if (sectionId === "local-folders") renderLocalFolders();
  await ensureSectionRendered(sectionId);
  if (sectionId === "usage") await renderUsagePanel(undefined, getSectionContext("usage"));

  if (!wasActive || isTraverse) {
    section.scrollIntoView({
      behavior: isTraverse ? "auto" : "smooth",
      block: "start",
    });

    const heading = section.querySelector("h2, h3");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }

  return true;
}

export const navigationController = createNavigationController({
  win: window,
  normalizeHash: (h) => normalizeSettingsSectionId(h) || "providers",
  isAllowedHash: (id) => SETTINGS_SECTIONS.includes(id),
  defaultHash: "#providers",
  onNavigate: async ({ hash, sectionId, isTraverse }) => {
    return handleSettingsHashNavigation(hash || `#${sectionId}`, isTraverse);
  },
});

async function showSiteActivityFocus(activity, { replace = false } = {}) {
  if (!activity) return false;
  const focus = () => document.getElementById("webmcp-consent-manager")?.focusSiteActivity?.(activity) === true;
  let focused = focus();
  try { await navigationController.navigate("#agents", { replace }); } catch { /* retain the immediate owner focus */ }
  try { await renderSiteToolConsentsPanel({ cursor: null }, getSectionContext("agents")); } catch { /* the manager exposes its normal error/retry state */ }
  focused = focus() || focused;
  return focused;
}

try {
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && changes && ("cap:browserGrant" in changes || "cap:browserAutoGrant" in changes)) {
      syncBrowserGrantState(
        changes["cap:browserGrant"] ? changes["cap:browserGrant"].newValue === true : undefined,
        changes["cap:browserAutoGrant"] ? changes["cap:browserAutoGrant"].newValue !== false : undefined,
        getSectionContext("browser"),
      );
    }
    if (!IS_EMBEDDED_SETTINGS && areaName === "session") {
      const activity = normalizeSiteActivityFocus(changes?.[SITE_ACTIVITY_FOCUS_KEY]?.newValue);
      if (!activity) return;
      showSiteActivityFocus(activity)
        .finally(() => chrome.storage?.session?.remove?.(SITE_ACTIVITY_FOCUS_KEY))
        .catch(() => {});
    }
  });
} catch { /* non-extension test context */ }

function sectionLinkUrl(sectionId) {
  return `${location.origin}${location.pathname}#${sectionId}`;
}

function flashCopied(anchorEl, url) {
  const original = anchorEl.getAttribute("aria-label") ?? "Copy section link";
  anchorEl.classList.add("copied");
  anchorEl.textContent = "✓";
  anchorEl.setAttribute("aria-label", `Copied ${url}`);
  clearTimeout(anchorEl._copyTimer);
  anchorEl._copyTimer = setTimeout(() => {
    anchorEl.classList.remove("copied");
    anchorEl.textContent = "#";
    anchorEl.setAttribute("aria-label", original);
  }, 1500);
}

async function copySectionLink(sectionId, anchorEl) {
  const url = sectionLinkUrl(sectionId);
  try {
    await navigator.clipboard.writeText(url);
    flashCopied(anchorEl, url);
  } catch {
    anchorEl.classList.add("copied");
    anchorEl.textContent = url;
    anchorEl.setAttribute("aria-label", `Section link: ${url}`);
  }
}

function wireSectionAnchors() {
  for (const section of document.querySelectorAll("section.panel[id]")) {
    const h2 = section.querySelector(":scope > h2");
    if (!h2) continue;
    const anchor = document.createElement("button");
    anchor.type = "button";
    anchor.className = "section-anchor";
    anchor.textContent = "#";
    anchor.setAttribute("aria-label", `Copy link to ${h2.textContent.trim()}`);
    anchor.title = "Copy section link";
    anchor.addEventListener("click", () => copySectionLink(section.id, anchor));
    h2.append(anchor);
    h2.addEventListener("click", (e) => {
      if (e.target === anchor) return;
      copySectionLink(section.id, anchor);
    });
  }
}
wireSectionAnchors();

{
  const brand = document.getElementById("about-brand-home");
  brand?.addEventListener("click", goHomeToHub);
  brand?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHomeToHub(); }
  });
}

document.querySelectorAll(".nav-item").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const targetHash = a.getAttribute("href") || `#${a.dataset.section}`;
    navigationController.navigate(targetHash, { replace: true });
  });
});
wireNavGroupAccordions();

initProvidersStatic(getSectionContext("providers"));
initDataStatic(getSectionContext("data"));
initVaultStatic(getSectionContext("web-services"));
await refreshStoragePermission();
await readDeveloperFeaturesFlag();
if (developerFeaturesEnabled) {
  devRendered.add("tool-library");
  devRendered.add("hooks");
  devRendered.add("prompts");
  devRendered.add("board-permissions");
}
applyDeveloperVisibility(developerFeaturesEnabled);

await navigationController.syncCurrent();
await sleep(0);

await renderLocalFolders();
mountSkillsSection(document.getElementById("skills"));
if (developerFeaturesEnabled) await renderToolLibraryPanel(getSectionContext("tool-library"));

refreshDiagnostics().catch(() => {});
initUsageStatic(getSectionContext("usage"));
initMcpServersStatic(getSectionContext("mcp-servers"));

async function hydrateBelowFoldHeavyLists() {
  if (!renderedSections.has("agents")) {
    await hydrateAgentsHeavyListsPanel(getSectionContext("agents")).catch(() => {});
  }
  if (!renderedSections.has("data")) {
    const dataCtx = getSectionContext("data");
    await renderDataPanel(dataCtx).catch(() => {});
    await renderMemoryExplorerPanel(dataCtx).catch(() => {});
  }
  if (!renderedSections.has("user-wasm")) {
    const wasmHost = document.getElementById("user-wasm-manager");
    if (wasmHost) await mountUserWasmPanel(wasmHost).catch(() => {});
  }
}

if (typeof IntersectionObserver !== "undefined") {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        io.unobserve(entry.target);
        if (entry.target.id === "agents") {
          hydrateAgentsHeavyListsPanel(getSectionContext("agents")).catch(() => {});
        } else if (entry.target.id === "data") {
          const dataCtx = getSectionContext("data");
          renderDataPanel(dataCtx).then(() => renderMemoryExplorerPanel(dataCtx)).catch(() => {});
        } else if (entry.target.id === "user-wasm") {
          const wasmHost = document.getElementById("user-wasm-manager");
          if (wasmHost) mountUserWasmPanel(wasmHost).catch(() => {});
        }
      }
    }
  }, { rootMargin: "200px" });
  for (const id of ["agents", "data", "user-wasm"]) {
    const el = document.getElementById(id);
    if (el) io.observe(el);
  }
}

if (typeof requestIdleCallback === "function") {
  requestIdleCallback(() => hydrateBelowFoldHeavyLists().catch(() => {}));
} else {
  setTimeout(() => hydrateBelowFoldHeavyLists().catch(() => {}), 50);
}

try {
  const v = chrome.runtime.getManifest().version;
  const el = $("#app-version");
  if (el && v) el.textContent = devVersionLabel(v, await loadDevBuildIdentity());
} catch { /* non-extension (browser test) — leave the placeholder */ }
initAboutStatic(document.getElementById("about"), getSectionContext("about"));

await wireObservabilitySettingsPanel(getSectionContext("prompts"));
await wireRunRetentionSettingsPanel(getSectionContext("data"));
const initialSiteActivityFocus = IS_EMBEDDED_SETTINGS
  ? null
  : await consumeSiteActivityFocus(chrome.storage?.session);
if (initialSiteActivityFocus) {
  await showSiteActivityFocus(initialSiteActivityFocus, { replace: true });
} else {
  await navigationController.syncCurrent();
}

if (typeof document !== "undefined" && document.getElementById("board-deny-list")) {
  initBoardDenyUIPanel(getSectionContext("board-permissions"));
}
hydrateI18n(document);
