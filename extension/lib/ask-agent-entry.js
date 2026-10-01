// lib/ask-agent-entry.js — the product-owned "Ask agent about …" entry points
// (chrome-agent-platform-3p3e.2).
//
// Three gestures land a page, a selection, a link or an image in the composer
// with the page as context:
//   1. the right-click menu — one "Agent" parent with four children, created
//      only once the owner grants `contextMenus` (an optional permission) and
//      removed again when they revoke it;
//   2. the keyboard command `ask-about-page` (Alt+Shift+A) — the page variant;
//   3. the hub fallback — when the side panel cannot open, the hub opens on
//      `#ask-agent=<tabId>` and reads the same prefill.
//
// The hand-off from the gesture to the surface is a PREFILL record in
// chrome.storage.session keyed by tab id — never a URL carrying page text. The
// surface consumes it exactly once (take = get + remove) and it expires after
// a few minutes so a stale click can never resurface. Page-controlled text
// (the selection, the link, the page title) is tagged `untrusted: true`, so
// the run's attachment context fences it with the run's boundary token
// (lib/attachments.js + lib/untrusted-fence.js) and the conversation renders
// it with textContent.
//
// Pure: no chrome.* at module scope. Every function that touches the browser
// takes the API object as an argument so a fake chrome can drive it in tests.

import { textToDataUrl } from "./attachments.js";

export const ASK_AGENT_MENU_PARENT_ID = "cap-ask-agent";
export const ASK_AGENT_MENU_PARENT_TITLE = "Agent";

/** The four children, in menu order. `variant` names the prefill shape. */
export const ASK_AGENT_MENU_ITEMS = Object.freeze([
  Object.freeze({ id: "cap-ask-agent-page", variant: "page", title: "Ask agent about this page", contexts: Object.freeze(["page"]) }),
  Object.freeze({ id: "cap-ask-agent-selection", variant: "selection", title: "Ask agent about selection", contexts: Object.freeze(["selection"]) }),
  Object.freeze({ id: "cap-ask-agent-link", variant: "link", title: "Ask agent about this link", contexts: Object.freeze(["link"]) }),
  Object.freeze({ id: "cap-ask-agent-image", variant: "image", title: "Ask agent about this image", contexts: Object.freeze(["image"]) }),
]);

/** Every menu id the product owns (the parent first). */
export const ASK_AGENT_MENU_IDS = Object.freeze([
  ASK_AGENT_MENU_PARENT_ID,
  ...ASK_AGENT_MENU_ITEMS.map((item) => item.id),
]);

/** The manifest `commands` id for the page variant. */
export const ASK_AGENT_COMMAND = "ask-about-page";

/** The storage.session key prefix for the gesture→surface prefill. */
export const ASK_AGENT_PREFILL_PREFIX = "cap:askAgent:prefill:";
/** A prefill older than this is dropped on read — a stale click never resurfaces. */
export const ASK_AGENT_PREFILL_TTL_MS = 5 * 60_000;
/** The selection is bounded (code points); a whole-page selection still lands. */
export const ASK_AGENT_SELECTION_MAX_CHARS = 20_000;
/** Image bytes are fetched only up to this size (storage.session holds ~10 MB). */
export const ASK_AGENT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** The prefill text per variant — a starting sentence the owner can edit. */
export const ASK_AGENT_PREFILL_TEXT = Object.freeze({
  page: "Summarise this page.",
  selection: "Explain this selection.",
  link: "Summarise what this link points to.",
  image: "Describe this image.",
});

export function askAgentPrefillKey(tabId) {
  if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) return null;
  return `${ASK_AGENT_PREFILL_PREFIX}${tabId}`;
}

/** Is `key` one of our prefill keys? Returns the tab id or null. */
export function askAgentPrefillTabId(key) {
  if (typeof key !== "string" || !key.startsWith(ASK_AGENT_PREFILL_PREFIX)) return null;
  const id = Number(key.slice(ASK_AGENT_PREFILL_PREFIX.length));
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/** The hub fallback URL: the tab id only — never page text. */
export function askAgentHubUrl(getURL, tabId) {
  const base = getURL("ntp/ntp.html");
  return askAgentPrefillKey(tabId) ? `${base}#ask-agent=${tabId}` : base;
}

// ── permission + registration ──────────────────────────────────────────────

async function settle(value) {
  try { return await value; } catch { return undefined; }
}

export async function contextMenusGranted(chromeApi) {
  const contains = chromeApi?.permissions?.contains;
  if (typeof contains !== "function") return false;
  let result;
  try { result = await contains.call(chromeApi.permissions, { permissions: ["contextMenus"] }); }
  catch { return false; }
  return result === true;
}

/** Callback-style chrome.contextMenus call → { ok, error }. `create` returns
 * its id synchronously and reports failures ONLY through runtime.lastError in
 * the callback, so every call goes through here. */
function menusCall(chromeApi, method, ...args) {
  return new Promise((resolve) => {
    const menus = chromeApi?.contextMenus;
    const fn = menus?.[method];
    if (typeof fn !== "function") { resolve({ ok: false, error: `contextMenus.${method} unavailable` }); return; }
    try {
      fn.call(menus, ...args, () => {
        const err = chromeApi?.runtime?.lastError;
        resolve(err ? { ok: false, error: String(err.message ?? err) } : { ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e?.message ?? e) });
    }
  });
}

/** Remove the product's own items (and only those — model-created menus from
 * the create_context_menu tool are not ours to clear). Missing ids are not
 * errors. Returns the ids that were actually removed. */
export async function removeProductContextMenus(chromeApi) {
  const removed = [];
  if (typeof chromeApi?.contextMenus?.remove !== "function") return removed;
  // Children first, then the parent (removing a parent also removes its
  // children — doing it in this order keeps every result honest).
  for (const id of [...ASK_AGENT_MENU_IDS].reverse()) {
    const r = await menusCall(chromeApi, "remove", id);
    if (r.ok) removed.push(id);
  }
  return removed.reverse();
}

/** Create the parent + four children. Idempotent: our ids are removed first,
 * so a worker restart or a second grant never duplicates an entry and never
 * trips "duplicate id". Without the permission (or the API) nothing is
 * created and the reason is returned — never thrown, never logged as an error. */
export async function registerProductContextMenus(chromeApi) {
  if (typeof chromeApi?.contextMenus?.create !== "function") {
    return { ok: false, reason: "contextMenus API unavailable", ids: [] };
  }
  if (!(await contextMenusGranted(chromeApi))) {
    return { ok: false, reason: "contextMenus permission not granted", ids: [] };
  }
  await removeProductContextMenus(chromeApi);
  const ids = [];
  const parent = await menusCall(chromeApi, "create", {
    id: ASK_AGENT_MENU_PARENT_ID,
    title: ASK_AGENT_MENU_PARENT_TITLE,
    contexts: [...new Set(ASK_AGENT_MENU_ITEMS.flatMap((item) => [...item.contexts]))],
  });
  if (!parent.ok) return { ok: false, reason: parent.error, ids };
  ids.push(ASK_AGENT_MENU_PARENT_ID);
  for (const item of ASK_AGENT_MENU_ITEMS) {
    const r = await menusCall(chromeApi, "create", {
      id: item.id,
      parentId: ASK_AGENT_MENU_PARENT_ID,
      title: item.title,
      contexts: [...item.contexts],
    });
    if (!r.ok) return { ok: false, reason: r.error, ids };
    ids.push(item.id);
  }
  return { ok: true, ids };
}

// ── the click → prefill projection ─────────────────────────────────────────

function httpUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") ? u.href : "";
  } catch { return ""; }
}

function hostOf(url) {
  try { return new URL(url).host || url; } catch { return url; }
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text ?? "")).length;
}

/** The page itself: the same `tab` attachment shape the composer's tab picker
 * produces, tagged untrusted (the title is page-controlled). */
export function askAgentPageAttachment(pageUrl, tab) {
  const url = httpUrl(pageUrl ?? tab?.url);
  if (!url) return null;
  const title = typeof tab?.title === "string" && tab.title.trim() ? tab.title.trim().slice(0, 200) : "";
  return {
    kind: "tab",
    name: title || hostOf(url),
    url,
    type: "tab",
    size: 0,
    ...(Number.isInteger(tab?.id) ? { tabId: tab.id } : {}),
    untrusted: true,
  };
}

/** The selection: a text/plain attachment whose bytes the run inlines inside
 * the untrusted fence. The chip reads "Selection (N chars)". */
export function askAgentSelectionAttachment(selectionText) {
  const chars = [...String(selectionText ?? "")];
  if (chars.join("").trim() === "") return null;
  const text = chars.slice(0, ASK_AGENT_SELECTION_MAX_CHARS).join("");
  const truncated = chars.length > ASK_AGENT_SELECTION_MAX_CHARS;
  const count = [...text].length;
  return {
    kind: "text",
    name: `Selection (${count} chars${truncated ? ", truncated" : ""})`,
    type: "text/plain",
    size: utf8Bytes(text),
    dataURL: textToDataUrl(text, "text/plain"),
    source: "selection",
    untrusted: true,
  };
}

export function askAgentLinkAttachment(linkUrl) {
  const url = httpUrl(linkUrl);
  if (!url) return null;
  return {
    kind: "link",
    name: `Link: ${hostOf(url)}`,
    url,
    type: "text/uri-list",
    size: 0,
    untrusted: true,
  };
}

/** The image reference. `srcUrl` (not `url`) so the attachment context never
 * mistakes it for a tab; the bytes are hydrated separately (bounded fetch). */
export function askAgentImageAttachment(srcUrl) {
  const raw = String(srcUrl ?? "").trim();
  if (!raw) return null;
  const isData = raw.startsWith("data:image/");
  const url = isData ? raw : httpUrl(raw);
  if (!url) return null;
  return {
    kind: "image",
    name: `Image: ${isData ? "embedded" : hostOf(url)}`,
    srcUrl: url,
    type: "",
    size: 0,
    untrusted: true,
  };
}

function prefill(variant, attachments, tab, pageUrl, now) {
  return {
    variant,
    text: ASK_AGENT_PREFILL_TEXT[variant],
    attachments: attachments.filter(Boolean),
    tabId: Number.isInteger(tab?.id) ? tab.id : null,
    pageUrl: pageUrl || "",
    createdAt: now,
  };
}

/** The page variant for a tab (the keyboard command, or a page click). */
export function askAgentPrefillForTab(tab, { now = Date.now() } = {}) {
  const pageUrl = httpUrl(tab?.url);
  return prefill("page", [askAgentPageAttachment(pageUrl, tab)], tab, pageUrl, now);
}

/** chrome.contextMenus.onClicked (info, tab) → the composer prefill, or null
 * when the click was not one of the product's items (a model-created menu
 * item belongs to the hook path, not here). */
export function askAgentPrefillFromClick(info, tab, { now = Date.now() } = {}) {
  const item = ASK_AGENT_MENU_ITEMS.find((candidate) => candidate.id === info?.menuItemId);
  if (!item) return null;
  const pageUrl = httpUrl(info?.pageUrl ?? tab?.url);
  const page = askAgentPageAttachment(pageUrl, tab);
  if (item.variant === "selection") {
    const selection = askAgentSelectionAttachment(info?.selectionText);
    // An empty selection degrades to the page variant rather than a dead chip.
    if (!selection) return prefill("page", [page], tab, pageUrl, now);
    return prefill("selection", [selection, page], tab, pageUrl, now);
  }
  if (item.variant === "link") {
    const link = askAgentLinkAttachment(info?.linkUrl);
    if (!link) return prefill("page", [page], tab, pageUrl, now);
    return prefill("link", [link, page], tab, pageUrl, now);
  }
  if (item.variant === "image") {
    const image = askAgentImageAttachment(info?.srcUrl);
    if (!image) return prefill("page", [page], tab, pageUrl, now);
    return prefill("image", [image, page], tab, pageUrl, now);
  }
  return prefill("page", [page], tab, pageUrl, now);
}

// ── image bytes (bounded) ──────────────────────────────────────────────────

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Fill `attachment.dataURL` from `srcUrl` so the image reaches the model as a
 * vision part (lib/attachments.js buildMultimodalTask). Bounded by content
 * type and size; any failure leaves the attachment as a URL reference and
 * returns the reason — the click still lands, just without pixels. */
export async function hydrateAskAgentImage(attachment, { fetchImpl = globalThis.fetch, maxBytes = ASK_AGENT_IMAGE_MAX_BYTES } = {}) {
  if (!attachment || attachment.kind !== "image" || !attachment.srcUrl) return { ok: false, reason: "not an image attachment" };
  if (typeof fetchImpl !== "function") return { ok: false, reason: "fetch unavailable" };
  try {
    const res = await fetchImpl(attachment.srcUrl, { credentials: "omit", redirect: "follow" });
    if (!res?.ok) return { ok: false, reason: `image fetch failed (${res?.status ?? "no response"})` };
    const type = String(res.headers?.get?.("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!type.startsWith("image/")) return { ok: false, reason: `not an image (${type || "unknown type"})` };
    const declared = Number(res.headers?.get?.("content-length") ?? 0);
    if (declared > maxBytes) return { ok: false, reason: `image is ${declared} bytes (limit ${maxBytes})` };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return { ok: false, reason: `image is ${buf.byteLength} bytes (limit ${maxBytes})` };
    attachment.type = type;
    attachment.size = buf.byteLength;
    attachment.dataURL = `data:${type};base64,${bytesToBase64(buf)}`;
    return { ok: true, bytes: buf.byteLength, type };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

// ── the storage.session hand-off ───────────────────────────────────────────

export async function storeAskAgentPrefill(chromeApi, record) {
  const key = askAgentPrefillKey(record?.tabId);
  const session = chromeApi?.storage?.session;
  if (!key) return { ok: false, error: "prefill needs a tab id" };
  if (typeof session?.set !== "function") return { ok: false, error: "storage.session unavailable" };
  try {
    await session.set({ [key]: record });
    return { ok: true, key };
  } catch (e) {
    // Quota (an image's bytes): keep the references, drop the bytes, retry once.
    const slim = {
      ...record,
      attachments: (record.attachments ?? []).map((a) => (a?.dataURL && a.kind === "image" ? { ...a, dataURL: "", size: 0, type: "" } : a)),
    };
    try {
      await session.set({ [key]: slim });
      return { ok: true, key, degraded: String(e?.message ?? e) };
    } catch (e2) {
      return { ok: false, error: String(e2?.message ?? e2) };
    }
  }
}

/** Read AND remove the prefill for a tab. Expired or malformed → null. */
export async function takeAskAgentPrefill(chromeApi, tabId, { now = Date.now() } = {}) {
  const key = askAgentPrefillKey(tabId);
  const session = chromeApi?.storage?.session;
  if (!key || typeof session?.get !== "function") return null;
  const stored = await settle(session.get(key));
  const record = stored?.[key];
  if (!record) return null;
  await settle(session.remove?.(key));
  if (typeof record !== "object" || !Array.isArray(record.attachments)) return null;
  if (typeof record.createdAt === "number" && now - record.createdAt > ASK_AGENT_PREFILL_TTL_MS) return null;
  return record;
}

/** Apply a prefill to an <agent-composer>: the text goes in the input, each
 * attachment becomes a removable chip, and the composer takes focus. Nothing
 * is sent — the owner reviews and presses Run. */
export function applyAskAgentPrefill(composer, record) {
  if (!composer || !record) return false;
  if (typeof record.text === "string" && record.text) composer.value = record.text;
  for (const attachment of record.attachments ?? []) {
    if (attachment && typeof composer.addAttachment === "function") composer.addAttachment(attachment);
  }
  if (typeof composer.focusInput === "function") composer.focusInput();
  else composer.focus?.();
  return true;
}
