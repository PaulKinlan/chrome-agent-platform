// lib/split-view.js — Tabs Split View API (Chrome 155+) support for
// agent-opened pages (chrome-agent-platform-gin2, owner direct request).
//
// When an agent needs to open a page — a Web MCP tool target, or a page whose
// context it is about to read — the owner should be able to SEE that page
// beside their own instead of it landing in a background tab. The Split View
// API does exactly that: `chrome.tabs.create({ url, splitWithTabId })` opens
// the new tab paired side-by-side with an existing one, no window management
// and no side-panel iframe constraints.
//
// GRACEFUL FALLBACK is the contract: the API exists from Chrome 155 and can
// also refuse a specific pairing (tabs must be adjacent, in the same window,
// and share pinned/group state, and neither may already be split). Every
// refusal falls back to a PLAIN tab create — the page still opens; only the
// side-by-side pairing is lost, and the reason is reported to the caller so
// the model can tell the owner what happened.
//
// No permissions beyond what open_tab already requires; feature detection is
// by API surface (`typeof tabs.createSplit === "function"`), never by version
// string.

/** True when this Chrome supports the Tabs Split View API. */
export function splitViewSupported(tabs = globalThis.chrome?.tabs) {
  return typeof tabs?.createSplit === "function";
}

/**
 * Create a tab, split side-by-side with `alongsideTabId` when possible.
 *
 * @param {{ url: string, alongsideTabId?: number, tabs?: object }} opts
 * @returns {Promise<{ tab: object, split: boolean, reason?: string }>}
 *   `split: false` always carries a `reason`: "unsupported", "no alongside
 *   tab", or "split refused: <the API's own error>" (a constraint violation —
 *   non-adjacent tabs, different windows, already split, pinned/group
 *   mismatch). Callers report the reason; the page opens either way.
 */
export async function createSplitAware({ url, alongsideTabId, tabs = globalThis.chrome?.tabs } = {}) {
  if (!tabs || typeof tabs.create !== "function") {
    throw new Error("split-view: chrome.tabs.create is unavailable");
  }
  if (typeof alongsideTabId !== "number") {
    const tab = await tabs.create({ url });
    return { tab, split: false, reason: "no alongside tab" };
  }
  if (!splitViewSupported(tabs)) {
    const tab = await tabs.create({ url });
    return { tab, split: false, reason: "unsupported" };
  }
  try {
    const tab = await tabs.create({ url, splitWithTabId: alongsideTabId });
    return { tab, split: true };
  } catch (e) {
    const tab = await tabs.create({ url });
    return { tab, split: false, reason: `split refused: ${e?.message ?? e}` };
  }
}
