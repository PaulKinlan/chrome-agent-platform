// One exact, immutable HTML file is used for the preview, picker and share.
// The service worker alone selects source data and redacts known credentials.
import { send } from "../lib/messages.js";
import { saveArtifactToDisk } from "../lib/artifact-export.js";

export function exportHtmlFile(response) {
  const filename = response?.filename;
  if (response?.ok !== true || response?.mimeType !== "text/html" ||
      typeof response.html !== "string" || !response.html.startsWith("<!DOCTYPE html>") ||
      typeof filename !== "string" || !/^[^/\\\u0000-\u001f\u007f]+\.html$/i.test(filename) ||
      filename.includes("..")) {
    throw new Error("The exported HTML file is unavailable. Try again.");
  }
  return new File([response.html], filename, { type: "text/html" });
}

/** @param {File} file
 * @param {string} html
 * @param {(asset: {name: string, mimeType: string, content: string}) => Promise<{ok: boolean, method?: string, cancelled?: boolean, filename?: string}>} [save] */
export function saveHtmlFile(file, html, save = saveArtifactToDisk) {
  // The picker must be invoked in the same user gesture. Never await File.text()
  // or a route request before opening it; html is the immutable file source.
  return save({ name: file.name, mimeType: "text/html", content: html });
}

/** @typedef {{share?: (data: {files: File[], title?: string}) => Promise<void>, canShare?: (data: {files: File[]}) => boolean}} FileShareNavigation */
/** @param {File} file @param {FileShareNavigation} [navigation] */
export function canShareHtmlFile(file, navigation = /** @type {FileShareNavigation} */ (navigator)) {
  try { return typeof navigation?.share === "function" && navigation.canShare?.({ files: [file] }) === true; }
  catch { return false; }
}

/** @param {File} file @param {FileShareNavigation} [navigation] */
export function shareHtmlFile(file, navigation = /** @type {FileShareNavigation} */ (navigator)) {
  if (!canShareHtmlFile(file, navigation)) return Promise.resolve({ ok: false, error: "share_unavailable" });
  // No await or other asynchronous step before navigator.share: it needs the
  // real click/keyboard gesture of this exact button.
  return navigation.share({ files: [file], title: file.name }).then(() => ({ ok: true }));
}

/** Open a native modal; the sandboxed blob frame displays the SAME File bytes
 * the owner can subsequently Save or Share, with no scripts or same-origin grant. */
export async function openThreadExportPreview({ kind, id, origin = "master", opener = null, stillCurrent = null, sendRoute = send } = {}) {
  const response = await sendRoute("thread-export.html", { kind, id, origin }, 60_000);
  if (typeof stillCurrent === "function" && !stillCurrent()) return null;
  const file = exportHtmlFile(response);
  const url = URL.createObjectURL(file);
  const dialog = document.createElement("agent-dialog");
  dialog.setAttribute("title", `Review ${kind === "artifact" ? "artifact" : "thread"} export`);

  const style = document.createElement("style");
  style.textContent = `
    .export-intro { margin:0 0 12px; line-height:1.45; max-width:65ch; }
    .export-frame { display:block; width:min(72vw,840px); max-width:100%; height:min(58vh,620px); min-height:260px; border:1px solid var(--border,#e3e0d9); border-radius:8px; background:var(--panel,#fff); }
    .export-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:10px; margin-top:14px; }
    .export-actions button { min-height:40px; border:1px solid var(--border,#e3e0d9); border-radius:8px; padding:8px 14px; background:var(--panel,#fff); color:var(--text,#1d1b18); cursor:pointer; }
    .export-actions button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
    .export-status { min-height:1.5em; margin:8px 0 0; }`;
  const intro = document.createElement("p");
  intro.className = "export-intro";
  intro.textContent = "Review the exact redacted HTML below before saving or sharing. Known credentials are removed; other personal information may remain.";
  const frame = document.createElement("iframe");
  frame.className = "export-frame";
  frame.title = "Static HTML export preview";
  frame.setAttribute("sandbox", ""); // no scripts, forms, popups or same-origin authority
  frame.src = url;
  const actions = document.createElement("div");
  actions.className = "export-actions";
  const button = (text) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = text;
    return el;
  };
  const save = button("Save HTML…");
  const share = button("Share HTML…");
  const close = button("Close");
  const status = document.createElement("p");
  status.className = "export-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  if (!canShareHtmlFile(file)) {
    share.hidden = true;
    status.textContent = "Sharing files is unavailable here. You can save the HTML file instead.";
  }
  save.addEventListener("click", async () => {
    try {
      const result = await saveHtmlFile(file, response.html);
      status.textContent = result?.ok ? "HTML saved." : result?.cancelled ? "Save cancelled." : "Could not save HTML. Try again.";
    } catch { status.textContent = "Could not save HTML. Try again."; }
  });
  share.addEventListener("click", async () => {
    try {
      const result = await shareHtmlFile(file);
      status.textContent = result?.ok ? "HTML shared." : "Sharing files is unavailable. Save the HTML file instead.";
    } catch (error) {
      status.textContent = error?.name === "AbortError" ? "Share cancelled." : "Could not share HTML. Try saving it instead.";
    }
  });
  close.addEventListener("click", () => dialog.close());
  actions.append(save, share, close);
  dialog.append(style, intro, frame, actions, status);
  dialog.addEventListener("close", () => {
    URL.revokeObjectURL(url);
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  }, { once: true });
  document.body.append(dialog);
  try { dialog.show(); }
  catch (error) { URL.revokeObjectURL(url); dialog.remove(); throw error; }
  return { dialog, frame, file };
}
