// lib/artifact-export.js — Save artifact to disk (picker + download fallback)
// and export to granted local folder / agent workspace.
// (chrome-agent-platform-3p3e.7).

const EXT_MAP = {
  ".md": {
    mimeType: "text/markdown",
    description: "Markdown document",
    accept: { "text/markdown": [".md"] },
  },
  ".csv": {
    mimeType: "text/csv",
    description: "CSV spreadsheet",
    accept: { "text/csv": [".csv"] },
  },
  ".json": {
    mimeType: "application/json",
    description: "JSON document",
    accept: { "application/json": [".json"] },
  },
  ".html": {
    mimeType: "text/html",
    description: "HTML document",
    accept: { "text/html": [".html", ".htm"] },
  },
  ".svg": {
    mimeType: "image/svg+xml",
    description: "SVG vector image",
    accept: { "image/svg+xml": [".svg"] },
  },
  ".png": {
    mimeType: "image/png",
    description: "PNG image",
    accept: { "image/png": [".png"] },
  },
  ".txt": {
    mimeType: "text/plain",
    description: "Text document",
    accept: { "text/plain": [".txt"] },
  },
};

const KNOWN_EXTS = Object.keys(EXT_MAP);

/**
 * Suggest a clean filename with the right extension (.md, .csv, .json, .html, .svg, .png, .txt)
 * based on artifact.mimeType / artifact.kind / artifact.title / artifact.name / artifact.type.
 */
export function suggestArtifactFilename(artifact) {
  if (!artifact || typeof artifact !== "object") return "artifact.txt";

  const rawTitle = (
    artifact.title ||
    artifact.name ||
    artifact.filename ||
    artifact.id ||
    "artifact"
  ).trim();

  // Clean title: replace forbidden characters and whitespace, strip slashes/path delimiters
  const cleanTitle = rawTitle
    .replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .trim() || "artifact";

  // Check if cleanTitle already ends with a known extension
  const lower = cleanTitle.toLowerCase();
  for (const ext of KNOWN_EXTS) {
    if (lower.endsWith(ext)) {
      return cleanTitle;
    }
  }
  if (lower.endsWith(".htm")) {
    return cleanTitle.slice(0, -4) + ".html";
  }
  if (lower.endsWith(".jpeg") || lower.endsWith(".jpg")) {
    return cleanTitle;
  }

  // Deduce extension from mimeType / kind / type
  const mime = String(artifact.mimeType || "").toLowerCase();
  const kind = String(artifact.kind || "").toLowerCase();
  const type = String(artifact.type || "").toLowerCase();
  const content = typeof artifact.content === "string" ? artifact.content : "";

  let ext = ".txt";

  if (
    mime === "text/markdown" ||
    mime === "text/x-markdown" ||
    kind === "markdown" ||
    kind === "md" ||
    kind === "report"
  ) {
    ext = ".md";
  } else if (
    mime === "text/csv" ||
    kind === "csv" ||
    kind === "table"
  ) {
    ext = ".csv";
  } else if (
    mime === "application/json" ||
    kind === "json" ||
    type === "json"
  ) {
    ext = ".json";
  } else if (
    mime === "text/html" ||
    kind === "html" ||
    type === "html"
  ) {
    ext = ".html";
  } else if (
    mime === "image/svg+xml" ||
    kind === "svg" ||
    content.startsWith("<svg") ||
    content.startsWith("data:image/svg")
  ) {
    ext = ".svg";
  } else if (
    mime === "image/png" ||
    kind === "png" ||
    type === "image"
  ) {
    ext = ".png";
  } else if (
    mime === "text/plain" ||
    kind === "text" ||
    type === "text"
  ) {
    // If it's markdown-like content, suggest .md
    if (/^\s*#\s+/m.test(content) || /^\s*##\s+/m.test(content)) {
      ext = ".md";
    } else {
      ext = ".txt";
    }
  } else if (type === "data") {
    if (content.trim().startsWith("{") || content.trim().startsWith("[")) {
      ext = ".json";
    } else if (content.includes(",") && content.includes("\n")) {
      ext = ".csv";
    } else {
      ext = ".txt";
    }
  }

  return `${cleanTitle}${ext}`;
}

/**
 * Decode artifact content into a Uint8Array byte buffer and MIME type.
 */
function resolveArtifactBytes(artifact, filename) {
  const content = artifact?.content ?? "";
  const ext = Object.keys(EXT_MAP).find((e) => filename.toLowerCase().endsWith(e)) || ".txt";
  const config = EXT_MAP[ext] || EXT_MAP[".txt"];
  const mimeType = artifact?.mimeType || config.mimeType;

  let bytes;
  if (content instanceof Uint8Array) {
    bytes = content;
  } else if (content instanceof ArrayBuffer) {
    bytes = new Uint8Array(content);
  } else if (typeof content === "string") {
    if (content.startsWith("data:") && content.includes(";base64,")) {
      const b64 = content.split(";base64,")[1];
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(content);
    }
  } else {
    bytes = new TextEncoder().encode(String(content));
  }

  return { bytes, mimeType, config };
}

/**
 * Save an artifact to local disk.
 * Uses window.showSaveFilePicker on owner gesture when available;
 * falls back to <a download> blob URL when showSaveFilePicker is absent.
 * Returns { ok: true, method: "file-picker" | "download", filename }
 * or { ok: false, cancelled: true } on AbortError.
 */
export async function saveArtifactToDisk(
  artifact,
  { showSaveFilePickerFn, downloadFallbackFn } = {},
) {
  if (!artifact) return { ok: false, error: "invalid_artifact" };

  const filename = suggestArtifactFilename(artifact);
  const { bytes, mimeType, config } = resolveArtifactBytes(artifact, filename);

  const picker =
    showSaveFilePickerFn ??
    (typeof window !== "undefined" && typeof window.showSaveFilePicker === "function"
      ? window.showSaveFilePicker.bind(window)
      : undefined);

  if (typeof picker === "function") {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [
          {
            description: config.description,
            accept: config.accept,
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return {
        ok: true,
        method: "file-picker",
        filename: handle.name || filename,
      };
    } catch (err) {
      if (
        err?.name === "AbortError" ||
        /aborted|cancelled|canceled/i.test(String(err?.message || ""))
      ) {
        return { ok: false, cancelled: true };
      }
      throw err;
    }
  }

  // Fallback: download via blob
  const blob = new Blob([bytes], { type: mimeType });

  if (typeof downloadFallbackFn === "function") {
    await downloadFallbackFn({ blob, filename, content: artifact?.content, mimeType });
    return { ok: true, method: "download", filename };
  }

  if (typeof document !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return { ok: true, method: "download", filename };
  }

  return { ok: true, method: "download", filename, blob };
}

/**
 * Export an artifact directly to a folder handle (FileSystemDirectoryHandle),
 * a granted folder, or an agent workspace writer.
 */
export async function exportAssetToFolder({
  artifact,
  directoryHandle,
  filename,
  grantId,
  workspaceWriter,
}) {
  if (!artifact) {
    return { ok: false, error: "invalid_artifact", message: "artifact is required" };
  }

  const { cleanRelativePath, computeSha256 } = await import("./fs-grants.js");
  const targetName = filename || suggestArtifactFilename(artifact);
  let segments = [];
  try {
    segments = cleanRelativePath(targetName);
  } catch (err) {
    return { ok: false, error: "invalid_file_path", message: String(err?.message || err) };
  }
  if (segments.length === 0) {
    return { ok: false, error: "invalid_file_path", message: "A file name is required" };
  }

  const cleanPath = segments.join("/");
  const { bytes } = resolveArtifactBytes(artifact, cleanPath);
  const sha256 = await computeSha256(bytes.buffer);

  if (directoryHandle && typeof directoryHandle.getFileHandle === "function") {
    let dir = directoryHandle;
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segments[i], { create: true });
    }
    const leaf = segments[segments.length - 1];
    const fileHandle = await dir.getFileHandle(leaf, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return {
      ok: true,
      written: true,
      path: cleanPath,
      name: leaf,
      filename: cleanPath,
      size: bytes.byteLength,
      bytes: bytes.byteLength,
      sha256,
    };
  }

  if (grantId) {
    const { writeFsGrantFile } = await import("./fs-grants.js");
    const res = await writeFsGrantFile(grantId, { relativePath: cleanPath, content: bytes });
    return res;
  }

  if (typeof workspaceWriter === "function") {
    const res = await workspaceWriter(cleanPath, bytes);
    return res;
  }

  return {
    ok: false,
    error: "no_destination",
    message: "No directory handle, grant, or workspace writer provided.",
  };
}
