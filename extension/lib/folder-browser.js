// lib/folder-browser.js — the Settings → Local folders "Browse" drawer: a
// real folder-tree navigator over a granted File System Access handle.
// Pure and testable: `send` is injected (the options page's boundedSend),
// and the module touches no browser globals at module load (all DOM work is
// inside mountGrantBrowser, so Deno unit tests import it safely).
//
// Backend contract (extension/lib/fs-grants.js listFsGrantEntries):
//   send("fs-grant.list-entries", { grantId, relativePath }) ->
//     { ok, grantId, kind, path, entries: [{ name, kind }], truncated, total }
//   send("fs-grant.read-file", { grantId, relativePath, asText }) -> { ok, name, size, sha256, content }
//
// The backend already resolves a relativePath into subdirectory segments; the
// owner-facing gap was the drawer never passing one. This module owns the
// whole drawer: breadcrumbs, Up, directory click-through, file View, and the
// loading/empty/error/truncated states.

/** Join a directory path and an entry name, normalising slashes. */
export function joinPath(dir, name) {
  const d = String(dir ?? "").replace(/^\/+|\/+$/g, "");
  const n = String(name ?? "").replace(/^\/+|\/+$/g, "");
  if (!d) return n;
  if (!n) return d;
  return `${d}/${n}`;
}

/** The parent of a relative path ("" for the root). */
export function parentPath(path) {
  const p = String(path ?? "").replace(/\/+$/g, "");
  if (!p) return "";
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

// The file/folder line icons (the product-wide SVG/currentColor rule — the
// emoji rows they replaced ignore the color scheme). Inline SVG elements,
// stroke = currentColor, so they follow the row's own color in both schemes.
const FOLDER_ICON_PATH = "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z";
const FILE_ICON_PATH = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z";
const FILE_ICON_FOLD = "M14 2v6h6";

/** Build the inline SVG line icon for a row ("directory" or "file"). */
export function entryLineIcon(kind) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", kind === "directory" ? FOLDER_ICON_PATH : FILE_ICON_PATH);
  svg.appendChild(path);
  if (kind !== "directory") {
    const fold = document.createElementNS(NS, "path");
    fold.setAttribute("d", FILE_ICON_FOLD);
    svg.appendChild(fold);
  }
  return svg;
}

/** ["", "a", "a/b"] for "a/b" — the root "" first, then each prefix. */
export function breadcrumbParts(path) {
  const p = String(path ?? "").replace(/^\/+|\/+$/g, "");
  const out = [""];
  if (!p) return out;
  let acc = "";
  for (const seg of p.split("/")) {
    acc = acc ? `${acc}/${seg}` : seg;
    out.push(acc);
  }
  return out;
}

/**
 * Mount the Browse drawer into `host`.
 * @param {object} opts
 * @param {HTMLElement} opts.host        the drawer element to fill
 * @param {{grantId:string, name?:string}} opts.grant  the grant being browsed
 * @param {(type:string, payload:object) => Promise<any>} opts.send  message sender (boundedSend)
 * @param {string} [opts.rootLabel]      label for the grant root (defaults to grant.name)
 */
export function mountGrantBrowser({ host, grant, send, rootLabel = null }) {
  let path = "";
  let loading = false;
  let view = { ok: true, kind: "directory", entries: [], truncated: false, total: 0 };
  const rootName = rootLabel || grant?.name || "Local folder";

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.gap = "8px";
  header.style.marginBottom = "6px";

  const crumbs = document.createElement("div");
  crumbs.className = "fs-crumbs";
  crumbs.style.display = "flex";
  crumbs.style.flexWrap = "wrap";
  crumbs.style.alignItems = "center";
  crumbs.style.fontWeight = "600";

  const upBtn = document.createElement("button");
  upBtn.type = "button";
  upBtn.className = "btn small fs-up";
  upBtn.style.padding = "1px 8px";
  upBtn.style.fontSize = "11px";
  upBtn.textContent = "↑ Up";

  const count = document.createElement("div");
  count.className = "fs-count muted";
  count.style.fontSize = "11px";
  count.style.marginBottom = "4px";

  const list = document.createElement("div");
  list.className = "fs-entries";
  list.style.display = "flex";
  list.style.flexDirection = "column";
  list.style.gap = "4px";

  const status = document.createElement("div");
  status.className = "fs-status muted";
  status.style.marginTop = "6px";
  status.style.fontSize = "11px";

  header.append(crumbs, upBtn);
  host.replaceChildren(header, count, list, status);

  /** A stable accessible label for a breadcrumb segment. */
  function crumbLabel(part) {
    return part === "" ? rootName : part.split("/").pop();
  }

  function renderCrumbs() {
    crumbs.replaceChildren();
    const parts = breadcrumbParts(path);
    parts.forEach((p, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.setAttribute("aria-hidden", "true");
        sep.textContent = "›";
        sep.style.margin = "0 3px";
        crumbs.append(sep);
      }
      const isLast = i === parts.length - 1;
      const crumb = document.createElement("button");
      crumb.type = "button";
      crumb.className = "fs-crumb";
      crumb.style.border = "0";
      crumb.style.background = "none";
      crumb.style.padding = "0";
      crumb.style.fontSize = "12px";
      crumb.style.cursor = isLast ? "default" : "pointer";
      crumb.style.color = isLast ? "var(--text,#1d1b18)" : "var(--accent,#0e6e63)";
      crumb.textContent = crumbLabel(p);
      if (isLast) {
        crumb.setAttribute("aria-current", "page");
      } else {
        crumb.addEventListener("click", () => { if (!loading) load(p); });
      }
      crumbs.append(crumb);
    });
  }

  function renderCount() {
    if (!view.ok || view.kind === "file") return;
    const n = Array.isArray(view.entries) ? view.entries.length : 0;
    count.textContent = `${n}${view.truncated ? " (truncated at limit)" : ""} item${n === 1 ? "" : "s"}:`;
  }

  function renderList() {
    list.replaceChildren();
    if (loading) {
      const row = document.createElement("div");
      row.className = "muted fs-loading";
      row.textContent = "Loading contents…";
      list.append(row);
      return;
    }
    if (!view.ok) return; // error is shown in status; keep the current view
    const entries = Array.isArray(view.entries) ? view.entries : [];
    if (entries.length === 0) {
      const row = document.createElement("div");
      row.className = "muted fs-empty";
      row.textContent = "This directory is empty.";
      list.append(row);
      return;
    }
    for (const entry of entries) {
      list.append(renderEntry(entry));
    }
  }

  /** Toggle a per-row file viewer (open/close, like the pre-navigation drawer). */
  function openFile(entry, rowWrapper, viewBtn) {
    const rel = joinPath(path, entry.name);
    const viewer = document.createElement("div");
    viewer.className = "fs-file-viewer";
    viewer.style.marginTop = "6px";
    viewer.style.padding = "8px 10px";
    viewer.style.borderRadius = "6px";
    viewer.style.background = "var(--bg,#ffffff)";
    viewer.style.border = "1px solid var(--border,#e3e0d9)";
    viewer.style.fontSize = "11.5px";
    viewer.style.fontFamily = "monospace";
    viewer.style.width = "100%";
    viewer.style.boxSizing = "border-box";
    viewer.textContent = "Reading file…";
    rowWrapper.append(viewer);
    viewBtn.disabled = true;
    send("fs-grant.read-file", { grantId: grant.grantId, relativePath: rel, asText: true })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
      .then((readRes) => {
        viewBtn.disabled = false;
        if (!readRes?.ok) {
          viewer.textContent = `Read failed: ${readRes?.error ?? "unknown"}`;
          viewer.style.color = "var(--danger,#d93025)";
          return;
        }
        viewer.replaceChildren();
        const hdr = document.createElement("div");
        hdr.style.marginBottom = "4px";
        hdr.style.color = "var(--text-muted,#666)";
        hdr.textContent = `${readRes.name} (${readRes.size} bytes, SHA-256: ${readRes.sha256})`;
        const pre = document.createElement("pre");
        pre.style.margin = "0";
        pre.style.padding = "6px 8px";
        pre.style.background = "var(--bg-subtle,#f4f2ed)";
        pre.style.borderRadius = "4px";
        pre.style.overflowX = "auto";
        pre.style.maxHeight = "240px";
        pre.style.whiteSpace = "pre-wrap";
        pre.style.wordBreak = "break-word";
        pre.textContent = readRes.content ?? "[Binary content]";
        viewer.append(hdr, pre);
      });
  }

  function renderEntry(entry) {
    const rowWrapper = document.createElement("div");
    rowWrapper.style.display = "flex";
    rowWrapper.style.flexDirection = "column";
    rowWrapper.style.width = "100%";

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.padding = "3px 6px";
    row.style.borderRadius = "4px";
    row.style.background = "var(--panel,#ffffff)";

    if (entry?.kind === "directory") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fs-dir";
      btn.style.display = "flex";
      btn.style.alignItems = "center";
      btn.style.gap = "6px";
      btn.style.border = "0";
      btn.style.background = "none";
      btn.style.padding = "0";
      btn.style.fontSize = "12px";
      btn.style.cursor = "pointer";
      btn.style.color = "var(--accent,#0e6e63)";
      btn.style.textAlign = "left";
      const dirName = document.createElement("span");
      dirName.textContent = entry.name;
      btn.append(entryLineIcon("directory"), dirName);
      btn.addEventListener("click", () => { if (!loading) load(joinPath(path, entry.name)); });
      row.append(btn);
    } else {
      const left = document.createElement("span");
      left.className = "fs-file";
      left.style.display = "flex";
      left.style.alignItems = "center";
      left.style.gap = "6px";
      const fileName = document.createElement("span");
      fileName.textContent = entry.name;
      left.append(entryLineIcon("file"), fileName);
      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.alignItems = "center";
      right.style.gap = "6px";
      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "btn small fs-view";
      viewBtn.style.padding = "1px 6px";
      viewBtn.style.fontSize = "11px";
      viewBtn.textContent = "View";
      viewBtn.addEventListener("click", () => openFile(entry, rowWrapper, viewBtn));
      right.append(viewBtn);
      row.append(left, right);
    }
    rowWrapper.append(row);
    return rowWrapper;
  }

  function render() {
    renderCrumbs();
    renderCount();
    renderList();
    upBtn.disabled = loading || path === "";
  }

  /** Navigate to a relative path; failures keep the current view (never a blank drawer). */
  async function load(nextPath) {
    if (loading) return;
    loading = true;
    status.textContent = "";
    status.style.color = "";
    render();
    const res = await send("fs-grant.list-entries", {
      grantId: grant.grantId,
      relativePath: String(nextPath ?? ""),
    }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    loading = false;
    if (!res?.ok) {
      if (res?.error === "directory_not_found" && nextPath !== "") {
        // A directory vanished mid-navigation: drop back to the parent of
        // the VANISHED TARGET (the view we were in — `path` still holds the
        // pre-navigation directory, so it must not drive the fallback).
        const parent = parentPath(nextPath);
        path = parent;
        await load(parent);
        status.textContent = "This folder is no longer available.";
        status.style.color = "var(--danger,#d93025)";
        render();
        return;
      }
      status.textContent = `Failed to read entries: ${res?.error ?? "unknown"}`;
      status.style.color = "var(--danger,#d93025)";
      render(); // current view stays; the error is the status line
      return;
    }
    path = String(res.path ?? nextPath ?? "");
    view = {
      ok: true,
      kind: res.kind ?? "directory",
      entries: Array.isArray(res.entries) ? res.entries : [],
      truncated: res.truncated === true,
      total: res.total ?? 0,
    };
    status.textContent = "";
    status.style.color = "";
    render();
  }

  upBtn.addEventListener("click", () => { if (!loading && path !== "") load(parentPath(path)); });

  // Kick off the top-level listing.
  load("");

  return {
    /** The currently displayed relative path ("" = grant root). */
    get currentPath() { return path; },
  };
}
