// lib/attachments.js — pure, testable attachment→model-input helpers.
//
// The image-attachment fix (Paul 2026-08-17): an attached image's BYTES must
// reach the model as a MULTIMODAL vision part, and the attachment must be
// persisted + rendered in the conversation. These are the pure building blocks.

export function isTextLikeAttachment({ name = "", type = "" } = {}) {
  const mime = String(type).toLowerCase().split(";", 1)[0];
  const filename = String(name).toLowerCase();
  return mime.startsWith("text/") ||
    /(?:json|xml|yaml|toml|csv|markdown|javascript|typescript|x-sh)$/.test(mime) ||
    /\.(?:c|cc|cpp|css|csv|go|h|hpp|html?|ini|java|js|json|jsx|log|md|mjs|py|rs|sh|toml|ts|tsx|txt|xml|ya?ml|wat)$/.test(filename);
}

export function textToDataUrl(text, type = "text/plain") {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const mime = String(type || "text/plain").split(";", 1)[0];
  return `data:${mime};charset=utf-8;base64,${btoa(binary)}`;
}

/**
 * Build the model-facing user turn for a task + its attachments.
 *
 * agent-do's run(task, context, history) pushes `{ role: 'user', content: task }`
 * straight into the AI SDK streamText messages. When `task` is a STRING the
 * content is text; when it is an ARRAY of parts the AI SDK treats it as a
 * MULTIMODAL message (text + image parts). So an attached image is passed as a
 * proper vision part — the bytes actually reach the model.
 *
 * Returns the task string when there are no image attachments, or a
 * `[{type:'text',text},{type:'image',image:dataURL},…]` array when there are.
 */
export function attachmentContext(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const parts = [];
  for (const a of attachments) {
    if (a.kind === "local-folder") {
      // A granted folder reference: the grantId is the handle the model-facing
      // local-file tools resolve against (CAP-FB-20260831-FS-GRANT-TASK-USE-01).
      // The tools default to the single attached folder, so the model rarely
      // needs the id — but it is named here for the multi-folder case.
      parts.push(
        `[attached folder: ${a.folderName ?? a.name ?? "folder"} (grant id ${a.grantId ?? "unknown"}) — use the file tools to work with it: list_files, find_files, read_file, and grep_files (content search) all operate over this folder. Call list_folders if you need to choose between folders.]`,
      );
      continue;
    }
    if (a.kind === "tab" || a.url) {
      parts.push(`[tab: ${a.name ?? "tab"} — ${a.url ?? "(no url)"}]`);
      continue;
    }
    parts.push(
      `[attachment: ${a.name ?? "unnamed"} (${a.kind ?? "file"}, ${
        a.type ?? "unknown"
      }, ${a.size ?? "?"} bytes)]`,
    );
    const type = String(a.type ?? "").toLowerCase();
    const name = String(a.name ?? "").toLowerCase();
    const textish =
      type.startsWith("text/") ||
      /json|xml|yaml|yml|toml|csv|markdown|\.md$/.test(type) ||
      /\.(json|xml|yaml|yml|toml|csv|md|txt|log)$/.test(name);
    if (a.dataURL && textish) {
      try {
        const binary = atob(a.dataURL.split(",")[1] ?? "");
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        const body = new TextDecoder().decode(bytes);
        parts.push("--- text content ---\n" + body + "\n---");
      } catch { /* not decodable */ }
    } else if (a.dataURL && type.startsWith("image/")) {
      parts.push("  (image attached — provided to the model as a vision input)");
    } else if (!textish) {
      parts.push(
        "  (media attached — not transcribed/described in this build)",
      );
    }
  }
  return "Attachments:\n" + parts.join("\n");
}

/**
 * Validate agent.run attachments. Only the dataURL SHAPE is enforced — a
 * malformed dataURL, bad base64 padding, or a declared-type/parsed-MIME
 * mismatch is dropped AND REPORTED (never silently accepted; that validation
 * is the security boundary, not a size limit). There are deliberately no
 * size or count caps (dptw): the message transport and the OPFS quota surface
 * their own honest errors when they are truly exceeded.
 *
 * Returns { kept, dropped } — kept preserves the original fields; dropped
 * entries carry { name, reason }.
 */
export function validateRunAttachments(attachments) {
  const kept = [];
  const dropped = [];
  for (const a of (Array.isArray(attachments) ? attachments : [])) {
    const name = String(a?.name ?? "unnamed");
    const type = String(a?.type ?? "unknown");
    if (!validAttachmentDataUrl(a)) {
      dropped.push({ name, reason: "malformed dataURL or type/mime mismatch" });
      continue;
    }
    kept.push({ ...a, name, type });
  }
  return { kept, dropped };
}

/** Accept only data:<mime>;base64,<payload> whose declared type matches the
 * parsed MIME essence (an image must not be relabelled text/plain). An
 * attachment with no dataURL has nothing to validate. */
function validAttachmentDataUrl(a) {
  if (!a?.dataURL) return true;
  const m =
    /^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*)(?:;\s*[a-z0-9-]+=(?:"[^"]*"|[^;,\s]*))*;base64,([A-Za-z0-9+/]*={0,2})\s*$/
      .exec(String(a.dataURL));
  if (!m) return false;
  const mime = m[1].toLowerCase();
  const payload = m[2];
  if (payload.length % 4 !== 0) return false;
  const declaredBase = String(a?.type ?? "").toLowerCase().split(";")[0].trim();
  return !declaredBase || declaredBase === mime;
}

export function buildMultimodalTask(task, attachments) {
  const images = (Array.isArray(attachments) ? attachments : [])
    .filter((a) => {
      if (!a || !a.dataURL) return false;
      const type = String(a.type ?? "").toLowerCase();
      const url = String(a.dataURL);
      return type.startsWith("image/") || url.startsWith("data:image/");
    })
    .map((a) => ({ type: "image", image: a.dataURL }));
  if (images.length === 0) return task;
  return [{ type: "text", text: String(task) }, ...images];
}

/**
 * Persistable attachment shape: keep the metadata + the dataURL (the image
 * bytes for the inline thumbnail) but strip the live File object. No size
 * cap (dptw) — OPFS quota failures surface honestly from the store write.
 * Returns undefined when there is nothing persistable.
 */
export function sanitizeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  const out = [];
  for (const a of attachments) {
    if (!a) continue;
    const url = typeof a.dataURL === "string" ? a.dataURL : "";
    out.push({
      name: typeof a.name === "string" ? a.name : "attachment",
      type: typeof a.type === "string" ? a.type : "",
      size: typeof a.size === "number" ? a.size : 0,
      kind: typeof a.kind === "string" ? a.kind : "file",
      dataURL: url,
      // local-folder references: the grant identity is the reference — it must
      // survive persistence so the model-facing local-file tools can resolve
      // it (CAP-FB-20260831-FOLDER-COMMAND-01). Bounded like every other field.
      ...(typeof a.grantId === "string" && a.grantId ? { grantId: a.grantId.slice(0, 128) } : {}),
      ...(typeof a.folderName === "string" && a.folderName ? { folderName: a.folderName.slice(0, 256) } : {}),
    });
  }
  return out.length ? out : undefined;
}
