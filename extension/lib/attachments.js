// lib/attachments.js — pure, testable attachment→model-input helpers.
//
// The image-attachment fix (Paul 2026-08-17): an attached image's BYTES must
// reach the model as a MULTIMODAL vision part, and the attachment must be
// persisted + rendered in the conversation. These are the pure building blocks.

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
        parts.push("--- text content ---\n" + body.slice(0, 4000) + "\n---");
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
 * Persistable attachment shape: keep the metadata + a bounded dataURL (the
 * image bytes for the inline thumbnail) but strip the live File object. Cap
 * the dataURL so a huge screenshot can't blow the OPFS journal/thread quota.
 * Returns undefined when there is nothing persistable.
 */
export function sanitizeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  const MAX_URL = 2 * 1024 * 1024; // 2MB base64 — ample for a thumbnail
  const out = [];
  for (const a of attachments) {
    if (!a) continue;
    const url = typeof a.dataURL === "string" ? a.dataURL : "";
    out.push({
      name: typeof a.name === "string" ? a.name : "attachment",
      type: typeof a.type === "string" ? a.type : "",
      size: typeof a.size === "number" ? a.size : 0,
      kind: typeof a.kind === "string" ? a.kind : "file",
      dataURL: url.length > MAX_URL ? "" : url,
    });
  }
  return out.length ? out : undefined;
}
