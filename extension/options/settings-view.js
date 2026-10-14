// extension/options/settings-view.js — Stage 3c (chrome-agent-platform-8v5l.3).
//
// Hub-hosted Settings client view for hub-ok panels (`skills`, `usage`, `about`).
// Panels with `host: "exact-document"` in PANEL_REGISTRY never mount here; they
// route to the exact `options/options.html#<section>` document so
// `isExactOptionsSender` / `SETTINGS_ONLY_DIRECT` authority remains unchanged.

import { PANEL_BY_ID, getPanelEntry } from "./panel-registry.js";
import { createPanelContext } from "./panel-context.js";
import { mount as mountSkillsPanel } from "./panels/skills.js";
import { mount as mountUsagePanel } from "./panels/usage.js";
import { mount as mountAboutPanel } from "./panels/about.js";
import {
  DEVELOPER_FEATURES_KEY,
  DEVELOPER_SECTIONS_SET,
  normalizeSettingsSectionId,
} from "../lib/pure.js";
import { hydrateI18n } from "../shared/i18n.js";

export const HUB_OK_PANEL_MODULES = Object.freeze({
  skills: mountSkillsPanel,
  usage: mountUsagePanel,
  about: mountAboutPanel,
});

let cachedOptionsHtml = null;
let activePanelCleanup = null;
let activeSettingsContainer = null;
let activeSettingsSectionId = null;

export function resetSettingsViewTemplateCache(htmlOverride = null) {
  cachedOptionsHtml = typeof htmlOverride === "string" ? htmlOverride : null;
}

export function isHubOkSettingsSection(sectionId) {
  const canonical = normalizeSettingsSectionId(sectionId) ?? String(sectionId ?? "").trim();
  const entry = getPanelEntry(canonical);
  return Boolean(entry && entry.host === "hub-ok");
}

function normalizeSectionCandidate(cand) {
  if (typeof cand !== "string" || !cand) return null;
  let clean = cand.startsWith("#") ? cand.slice(1).trim() : cand.trim();
  if (clean.startsWith("section-")) clean = clean.slice("section-".length);
  else if (clean.startsWith("section=")) clean = clean.slice("section=".length);
  if (clean === "background-agents" || clean === "background") return "agents";
  if (clean === "provider") return "providers";
  return normalizeSettingsSectionId(clean);
}

export function resolveSettingsViewRoute(rawPath) {
  const str = String(rawPath ?? "").trim();
  if (!str) return null;
  const [beforeHash, rawHash] = str.split("#", 2);
  const [routeBase, rawQuery] = beforeHash.split("?", 2);
  if (routeBase === "recipes/index.html") {
    const isHubOk = isHubOkSettingsSection("skills");
    return {
      isSettings: true,
      sectionId: "skills",
      explicitSection: true,
      isHubOk,
      viewPath: isHubOk ? "settings#skills" : "options/options.html#skills",
      framePath: "options/options.html#skills",
    };
  }
  if (routeBase !== "options/options.html" && routeBase !== "settings") {
    return null;
  }
  let candidateSection = rawHash ?? "";
  if (!candidateSection && rawQuery) {
    for (const part of rawQuery.split("&")) {
      if (part.startsWith("section=")) {
        try {
          candidateSection = decodeURIComponent(part.slice("section=".length));
        } catch {
          candidateSection = part.slice("section=".length);
        }
        break;
      }
    }
  }
  const normalized = normalizeSectionCandidate(candidateSection);
  const explicitSection = Boolean(normalized);
  const sectionId = normalized ?? "providers";
  const isHubOk = isHubOkSettingsSection(sectionId);
  const isSettingsPrefix = routeBase === "settings";
  const framePath = (!explicitSection && !isSettingsPrefix)
    ? "options/options.html"
    : `options/options.html#${sectionId}`;
  const viewPath = isHubOk
    ? `settings#${sectionId}`
    : framePath;
  return {
    isSettings: true,
    sectionId,
    explicitSection,
    isHubOk,
    viewPath,
    framePath,
  };
}

export function extractNavHtml(fullHtml) {
  const startMatch = /<aside\s+class="side"[^>]*>/i.exec(fullHtml);
  if (!startMatch) return "";
  const startIdx = startMatch.index;
  const endIdx = fullHtml.indexOf("</aside>", startIdx);
  if (endIdx < 0) return "";
  const asideHtml = fullHtml.slice(startIdx, endIdx + "</aside>".length);
  // Strip the standalone `.brand` block so the embedded hub Settings view does
  // not duplicate the hub's own brand header.
  return asideHtml.replace(/<div\s+class="brand"[\s\S]*?<\/div>/i, "");
}

export function extractSectionHtml(fullHtml, sectionId) {
  const escaped = String(sectionId ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startRe = new RegExp(`<section\\s+id="${escaped}"[^>]*>`, "i");
  const startMatch = startRe.exec(fullHtml);
  if (!startMatch) return "";
  const startIdx = startMatch.index;
  const endIdx = fullHtml.indexOf("</section>", startIdx);
  if (endIdx < 0) return "";
  return fullHtml.slice(startIdx, endIdx + "</section>".length);
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
  "path", "circle", "rect", "line", "polyline", "polygon",
]);

function decodeEntities(text) {
  return String(text ?? "")
    .replace(/&larr;/g, "←")
    .replace(/&rarr;/g, "→")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

function parseHtmlWithCreateElement(html, doc) {
  const roots = [];
  const stack = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let lastIdx = 0;
  let m;

  while ((m = tagRe.exec(html)) !== null) {
    const textBefore = decodeEntities(html.slice(lastIdx, m.index).trim());
    if (textBefore && stack.length > 0) {
      const top = stack[stack.length - 1];
      top.textContent = (top.textContent ? `${top.textContent} ` : "") + textBefore;
    }
    lastIdx = tagRe.lastIndex;
    const rawTag = m[0];
    const tagName = m[1].toLowerCase();
    const attrStr = m[2] ?? "";

    if (rawTag.startsWith("</")) {
      if (stack.length > 0 && stack[stack.length - 1].tagName?.toLowerCase() === tagName) {
        stack.pop();
      }
      continue;
    }

    const el = doc.createElement(tagName);
    for (const attr of attrStr.matchAll(/([a-zA-Z0-9_:-]+)(?:="([^"]*)")?/g)) {
      const k = attr[1];
      if (k === "/") continue;
      const v = decodeEntities(attr[2] ?? "");
      el.setAttribute?.(k, v);
      if (k === "id") el.id = v;
      if (k === "class") el.className = v;
      if (k === "hidden") el.hidden = true;
      if (k === "checked") el.checked = true;
      if (k === "disabled") el.disabled = true;
      if (k === "value") el.value = v;
      if (k.startsWith("data-") && el.dataset) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.dataset[camel] = v;
      }
    }

    if (stack.length > 0) {
      stack[stack.length - 1].append(el);
    } else {
      roots.push(el);
    }

    if (!rawTag.endsWith("/>") && !VOID_TAGS.has(tagName)) {
      stack.push(el);
    }
  }
  return roots;
}

function buildFragmentNodes(html, doc) {
  if (!html) return [];
  if (typeof DOMParser !== "undefined" && typeof doc?.importNode === "function") {
    try {
      const parsed = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
      if (parsed?.body?.children?.length) {
        return Array.from(parsed.body.children).map((child) => doc.importNode(child, true));
      }
    } catch {
      // Fall back to createElement parser in stubbed DOM environments.
    }
  }
  return parseHtmlWithCreateElement(html, doc);
}

export async function loadOptionsTemplate({ fetchImpl, optionsHtml } = {}) {
  if (typeof optionsHtml === "string" && optionsHtml.length > 0) {
    cachedOptionsHtml = optionsHtml;
    return cachedOptionsHtml;
  }
  if (typeof cachedOptionsHtml === "string" && cachedOptionsHtml.length > 0) {
    return cachedOptionsHtml;
  }
  const fetcher = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!fetcher) return "";
  const url = typeof chrome !== "undefined" && typeof chrome.runtime?.getURL === "function"
    ? chrome.runtime.getURL("options/options.html")
    : "../options/options.html";
  const res = await fetcher(url);
  if (!res?.ok && typeof res?.text !== "function") return "";
  const text = await res.text();
  if (typeof text === "string" && text.length > 0) {
    cachedOptionsHtml = text;
  }
  return cachedOptionsHtml ?? "";
}

function applyDeveloperFeaturesVisibility(root, on) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const el of root.querySelectorAll('[data-developer="true"]')) {
    el.hidden = !on;
  }
}

function syncActiveNavState(root, sectionId) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const item of root.querySelectorAll(".nav-item")) {
    const itemSec = item.dataset?.section ||
      item.getAttribute?.("data-section") ||
      (item.getAttribute?.("href") || "").replace(/^#/, "");
    if (itemSec === sectionId) {
      item.setAttribute?.("aria-current", "true");
      const group = item.closest?.(".nav-group");
      if (group) {
        const header = group.querySelector?.(".nav-group-header");
        const items = group.querySelector?.(".nav-group-items");
        if (header) header.setAttribute?.("aria-expanded", "true");
        if (items) items.hidden = false;
      }
    } else {
      item.removeAttribute?.("aria-current");
    }
  }
}

export function getActiveSettingsViewState() {
  return {
    isOpen: Boolean(activeSettingsContainer && !activeSettingsContainer.hidden),
    sectionId: activeSettingsSectionId,
    container: activeSettingsContainer,
  };
}

export function teardownSettingsView() {
  if (activePanelCleanup) {
    const cleanup = activePanelCleanup;
    activePanelCleanup = null;
    try { cleanup(); } catch { /* best-effort teardown */ }
  }
  if (activeSettingsContainer) {
    try { activeSettingsContainer.replaceChildren?.(); } catch { /* best-effort */ }
    activeSettingsContainer = null;
  }
  activeSettingsSectionId = null;
}

export async function renderSettingsView(containerEl, options = {}) {
  if (!containerEl) return { mounted: false, reason: "no-container" };

  const routeInfo = resolveSettingsViewRoute(
    options.path ?? (options.sectionId ? `settings#${options.sectionId}` : "settings#skills"),
  );
  const targetSectionId = normalizeSettingsSectionId(options.sectionId) ?? routeInfo?.sectionId ?? "skills";

  // Hard authority boundary (F2): exact-document panels never mount in the hub DOM.
  if (!isHubOkSettingsSection(targetSectionId)) {
    teardownSettingsView();
    if (typeof options.onNavigateSection === "function") {
      options.onNavigateSection(targetSectionId, { replace: true, exactDocument: true });
    }
    return { mounted: false, reason: "exact-document", sectionId: targetSectionId };
  }

  const mountFn = HUB_OK_PANEL_MODULES[targetSectionId];
  if (typeof mountFn !== "function") {
    teardownSettingsView();
    return { mounted: false, reason: "missing-module", sectionId: targetSectionId };
  }

  const wasAlreadyOpen = activeSettingsContainer === containerEl && activeSettingsSectionId !== null;
  if (activePanelCleanup) {
    const prevCleanup = activePanelCleanup;
    activePanelCleanup = null;
    try { prevCleanup(); } catch { /* best-effort */ }
  }

  const fullHtml = await loadOptionsTemplate({
    fetchImpl: options.fetchImpl,
    optionsHtml: options.optionsHtml,
  });
  const navHtml = extractNavHtml(fullHtml);
  const sectionHtml = extractSectionHtml(fullHtml, targetSectionId);
  if (!sectionHtml) {
    teardownSettingsView();
    return { mounted: false, reason: "missing-markup", sectionId: targetSectionId };
  }

  const doc = containerEl.ownerDocument ?? (typeof document !== "undefined" ? document : null);
  if (!doc || typeof doc.createElement !== "function") {
    return { mounted: false, reason: "no-document", sectionId: targetSectionId };
  }

  const shell = doc.createElement("div");
  shell.className = "options-shell";

  const navNodes = buildFragmentNodes(navHtml, doc);
  for (const n of navNodes) shell.append(n);

  const contentWrap = doc.createElement("div");
  contentWrap.className = "content settings-content";

  const saveStatus = doc.createElement("p");
  saveStatus.id = "save-status";
  saveStatus.className = "save-status visually-hidden";
  saveStatus.setAttribute?.("role", "status");
  saveStatus.setAttribute?.("aria-live", "polite");
  saveStatus.textContent = "Changes save automatically.";
  contentWrap.append(saveStatus);

  const sectionNodes = buildFragmentNodes(sectionHtml, doc);
  const sectionEl = sectionNodes[0] ?? null;
  if (!sectionEl) {
    return { mounted: false, reason: "parse-failed", sectionId: targetSectionId };
  }
  sectionEl.id = targetSectionId;
  sectionEl.className = "panel active";
  sectionEl.setAttribute?.("class", "panel active");
  sectionEl.setAttribute?.("data-active", "true");
  contentWrap.append(sectionEl);
  shell.append(contentWrap);

  containerEl.replaceChildren(shell);
  try { hydrateI18n(containerEl); } catch { /* best-effort in tests */ }

  activeSettingsContainer = containerEl;
  activeSettingsSectionId = targetSectionId;

  let devFeaturesEnabled = Boolean(
    typeof options.developerFeatures === "function"
      ? options.developerFeatures()
      : options.developerFeatures,
  ) || DEVELOPER_SECTIONS_SET.has(targetSectionId);

  const setDevFeatures = (on) => {
    devFeaturesEnabled = Boolean(on);
    applyDeveloperFeaturesVisibility(containerEl, devFeaturesEnabled);
    options.onDeveloperFeaturesChange?.(devFeaturesEnabled);
  };

  let statusTimer = null;
  const panelCtx = createPanelContext({
    root: containerEl,
    embedded: true,
    send: options.send,
    boundedSend: options.boundedSend,
    storage: options.storage,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    developerFeatures: () => devFeaturesEnabled,
    setDeveloperFeatures: setDevFeatures,
    navigateSection: async (nextSec) => {
      const canonical = normalizeSettingsSectionId(nextSec) ?? String(nextSec ?? "").trim();
      if (!canonical || !PANEL_BY_ID.has(canonical)) return false;
      if (typeof options.onNavigateSection === "function") {
        await options.onNavigateSection(canonical, {
          replace: true,
          exactDocument: !isHubOkSettingsSection(canonical),
        });
        return true;
      }
      return false;
    },
    saveFlash: (msg = "Saved") => {
      const statusEl = panelCtx.byId("save-status");
      if (!statusEl) return;
      statusEl.textContent = msg;
      if (statusTimer !== null) panelCtx.clearTimeout(statusTimer);
      statusTimer = panelCtx.setTimeout(() => {
        statusEl.textContent = "Changes save automatically.";
      }, 1500);
    },
    callbacks: {
      useSkill: (ref) => options.onUseSkill?.(ref),
      onUseSkill: (ref) => options.onUseSkill?.(ref),
      goHome: () => options.onGoHome?.(),
      returnToComposer: () => options.onGoHome?.(),
    },
  });

  // Read persisted developer-features flag if storage is available and not overridden.
  if (options.developerFeatures === undefined) {
    try {
      const stored = await panelCtx.storage.get(DEVELOPER_FEATURES_KEY);
      if (stored && typeof stored === "object" && DEVELOPER_FEATURES_KEY in stored) {
        devFeaturesEnabled = stored[DEVELOPER_FEATURES_KEY] === true || DEVELOPER_SECTIONS_SET.has(targetSectionId);
      }
    } catch { /* ignore storage error */ }
  }
  applyDeveloperFeaturesVisibility(containerEl, devFeaturesEnabled);
  syncActiveNavState(containerEl, targetSectionId);

  // Wire collapsible nav groups inside #settings-view.
  for (const header of panelCtx.$$(".nav-group-header")) {
    panelCtx.on(header, "click", () => {
      const expanded = header.getAttribute?.("aria-expanded") === "true";
      const next = !expanded;
      header.setAttribute?.("aria-expanded", String(next));
      const group = header.closest?.(".nav-group");
      const items = group?.querySelector?.(".nav-group-items");
      if (items) items.hidden = !next;
    });
  }

  // Wire Settings nav links: intra-Settings switches replace history (1 entry total).
  for (const item of panelCtx.$$(".nav-item")) {
    panelCtx.on(item, "click", (ev) => {
      ev?.preventDefault?.();
      const rawSec = item.dataset?.section ||
        item.getAttribute?.("data-section") ||
        (item.getAttribute?.("href") || "").replace(/^#/, "");
      const canonical = normalizeSettingsSectionId(rawSec);
      if (!canonical) return;
      if (typeof options.onNavigateSection === "function") {
        options.onNavigateSection(canonical, {
          replace: true,
          exactDocument: !isHubOkSettingsSection(canonical),
        });
      }
    });
  }

  // Wire Escape inside #settings-view to close the view and restore focus to the opener.
  panelCtx.on(containerEl, "keydown", (ev) => {
    if (ev?.key === "Escape" && !ev.defaultPrevented) {
      ev.stopPropagation?.();
      options.onClose?.();
    }
  });

  // Wire #about-brand-home link in the About section.
  const aboutBrandHome = panelCtx.byId("about-brand-home");
  if (aboutBrandHome) {
    panelCtx.on(aboutBrandHome, "click", () => options.onGoHome?.());
    panelCtx.on(aboutBrandHome, "keydown", (ev) => {
      if (ev?.key === "Enter" || ev?.key === " ") {
        ev.preventDefault?.();
        options.onGoHome?.();
      }
    });
  }

  const handle = await mountFn(sectionEl, panelCtx);
  activePanelCleanup = () => {
    try { handle?.unmount?.(); } catch { /* ignore */ }
    try { panelCtx.unmount(); } catch { /* ignore */ }
  };

  // Focus management (C10, 716s.13): section heading has tabindex="-1" and takes
  // programmatic focus on intra-Settings section switch or explicit request.
  const heading = sectionEl.querySelector?.("h2, h3");
  if (heading) {
    heading.setAttribute?.("tabindex", "-1");
    if (options.focusHeading === true || wasAlreadyOpen) {
      try {
        heading.focus?.({ preventScroll: true });
      } catch {
        heading.focus?.();
      }
    }
  }

  return {
    mounted: true,
    sectionId: targetSectionId,
    sectionEl,
    unmount: teardownSettingsView,
  };
}
