// extension/lib/thread-export-html.js — Standalone static HTML generator for thread exports.
// Part of chrome-agent-platform-3p3e.12.
//
// Produces a self-contained, CSP-safe, zero-script HTML file containing
// the complete thread narrative and embedded artifacts, with prominent privacy
// notice and exact-value secret scrubbing.

import { escapeHtml } from "./pure.js";
import { redactExportText, redactExportValue } from "./thread-export-redact.js";

/**
 * Notice required on all exported artifacts per hub privacy ruling.
 */
export const EXPORT_PRIVACY_CAVEAT =
  "Notice: This exported thread was automatically redacted to scrub known provider credentials and common credential patterns. Review before forwarding to ensure no personal or sensitive data remains.";

const BASE_CSS = `
  :root {
    --bg: #ffffff;
    --text: #1f2328;
    --border: #d0d7de;
    --subtle-bg: #f6f8fa;
    --user-bg: #e8f0fe;
    --user-border: #c2e7ff;
    --assistant-bg: #ffffff;
    --tool-bg: #f8fafc;
    --tool-border: #e2e8f0;
    --notice-bg: #fff8c5;
    --notice-border: #d4a72c;
    --notice-text: #4d2d00;
    --code-bg: #f6f8fa;
    --link: #0969da;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --text: #e6edf3;
      --border: #30363d;
      --subtle-bg: #161b22;
      --user-bg: #102a45;
      --user-border: #1f4268;
      --assistant-bg: #0d1117;
      --tool-bg: #161b22;
      --tool-border: #30363d;
      --notice-bg: #3b2300;
      --notice-border: #9e6a03;
      --notice-text: #ffd37a;
      --code-bg: #161b22;
      --link: #4493f8;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--text);
    background-color: var(--bg);
    line-height: 1.5;
    margin: 0;
    padding: 24px 16px;
    display: flex;
    justify-content: center;
  }
  .container {
    max-width: 840px;
    width: 100%;
  }
  .privacy-caveat {
    background-color: var(--notice-bg);
    border: 1px solid var(--notice-border);
    color: var(--notice-text);
    padding: 12px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 24px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .header {
    border-bottom: 1px solid var(--border);
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  .header h1 {
    font-size: 24px;
    margin: 0 0 8px 0;
  }
  .metadata {
    font-size: 12px;
    color: var(--text);
    opacity: 0.75;
  }
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .turn {
    border-radius: 8px;
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .turn-user {
    background-color: var(--user-bg);
    border-color: var(--user-border);
  }
  .turn-assistant {
    background-color: var(--assistant-bg);
  }
  .turn-system {
    background-color: var(--subtle-bg);
    border-color: var(--border);
    opacity: 0.85;
  }
  .turn-header {
    padding: 8px 16px;
    font-size: 12px;
    font-weight: 600;
    opacity: 0.7;
    background-color: var(--subtle-bg);
    border-bottom: 1px solid var(--border);
  }
  .turn-body {
    padding: 16px;
    font-size: 14px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tool-block {
    background-color: var(--tool-bg);
    border: 1px solid var(--tool-border);
    border-radius: 6px;
    margin: 12px 16px;
    font-size: 13px;
  }
  .tool-summary {
    padding: 8px 12px;
    font-weight: 600;
    border-bottom: 1px solid var(--tool-border);
    display: flex;
    justify-content: space-between;
  }
  .tool-content {
    padding: 10px 12px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .artifacts-section {
    margin-top: 32px;
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }
  .artifacts-section h2 {
    font-size: 18px;
    margin: 0 0 16px 0;
  }
  .artifact-card {
    border: 1px solid var(--border);
    border-radius: 6px;
    background-color: var(--subtle-bg);
    margin-bottom: 16px;
    overflow: hidden;
  }
  .artifact-head {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    display: flex;
    justify-content: space-between;
    font-size: 13px;
  }
  .artifact-body {
    padding: 16px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    background-color: var(--bg);
  }
  .footer {
    margin-top: 40px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    text-align: center;
    opacity: 0.6;
  }
`;

/**
 * Format a value for safe tool input or output display.
 * Employs redactExportValue to recursively strip HMACs and secret keys.
 */
function formatToolPayload(val, knownSecrets) {
  if (val == null) return null;
  const cleaned = redactExportValue(val, { knownSecrets });
  if (typeof cleaned === "string") return cleaned;
  try {
    return JSON.stringify(cleaned, null, 2);
  } catch {
    return String(cleaned);
  }
}

/**
 * Render a projected thread view to a self-contained, script-free HTML string.
 *
 * @param {object} projectedThread Projected thread representation (with messages or turns).
 * @param {object} [options]
 * @param {string} [options.title="Exported Task Narrative"]
 * @param {number|string|Date} [options.exportedAt]
 * @param {string[]} [options.knownSecrets=[]]
 * @param {Array<object>} [options.artifacts=[]]
 * @returns {string} Self-contained HTML document.
 */
export function renderThreadToHtml(projectedThread, {
  title = "Exported Task Narrative",
  exportedAt = Date.now(),
  knownSecrets = [],
  artifacts = [],
} = {}) {
  const redact = (text) => redactExportText(text, { knownSecrets });
  const dateStr = new Date(exportedAt).toISOString();
  const safeTitle = escapeHtml(redact(title));

  // Accept canonical messages array (thread-run-view / conversation) or turns array
  const rawRows = Array.isArray(projectedThread?.messages)
    ? projectedThread.messages
    : Array.isArray(projectedThread?.turns)
      ? projectedThread.turns
      : [];

  let rowsHtml = "";
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row) continue;
    const role = String(row.role ?? "turn").toLowerCase();

    // 1. Tool execution row ({ role: "tool", toolName, args, result, toolStatus })
    if (role === "tool") {
      const toolName = escapeHtml(row.toolName ?? row.tool ?? row.name ?? "tool");
      const status = row.toolStatus === "error" ? " (error)" : "";
      const rawArgs = row.toolArgs ?? row.args;
      const rawResult = row.toolResult ?? row.toolDetail ?? row.result;

      const safeArgs = formatToolPayload(rawArgs, knownSecrets);
      const safeResult = formatToolPayload(rawResult, knownSecrets);

      rowsHtml += `
        <div class="tool-block">
          <div class="tool-summary">
            <span>Tool Call: ${toolName}${status}</span>
          </div>
          ${safeArgs != null ? `<div class="tool-content">Input: ${escapeHtml(safeArgs)}</div>` : ""}
          ${safeResult != null ? `<div class="tool-content" style="border-top:1px dashed var(--tool-border);">Output: ${escapeHtml(safeResult)}</div>` : ""}
        </div>`;
      continue;
    }

    // 2. User turn
    if (role === "user") {
      const rawContent = typeof row.content === "string" ? row.content : JSON.stringify(row.content, null, 2);
      rowsHtml += `
        <div class="turn turn-user">
          <div class="turn-header">User</div>
          <div class="turn-body">${escapeHtml(redact(rawContent))}</div>
        </div>`;
      continue;
    }

    // 3. System turn or notice
    if (role === "system") {
      const rawContent = typeof row.content === "string" ? row.content : JSON.stringify(row.content, null, 2);
      rowsHtml += `
        <div class="turn turn-system">
          <div class="turn-header">System</div>
          <div class="turn-body">${escapeHtml(redact(rawContent))}</div>
        </div>`;
      continue;
    }

    // 4. Assistant / Agent turn
    const isAssistant = role === "assistant" || role === "agent";
    const label = isAssistant
      ? (row.name ? escapeHtml(redact(row.name)) : "Assistant")
      : escapeHtml(role);

    let contentHtml = "";
    if (row.content != null) {
      const rawContent = typeof row.content === "string" ? row.content : JSON.stringify(row.content, null, 2);
      contentHtml = `<div class="turn-body">${escapeHtml(redact(rawContent))}</div>`;
    }

    // Nested tool calls if formatted as turns with child toolCalls
    let toolHtml = "";
    if (Array.isArray(row.toolCalls)) {
      for (const call of row.toolCalls) {
        const toolName = escapeHtml(call.tool ?? call.name ?? "tool");
        const safeArgs = formatToolPayload(call.args, knownSecrets);
        const safeResult = formatToolPayload(call.result, knownSecrets);

        toolHtml += `
          <div class="tool-block">
            <div class="tool-summary">
              <span>Tool Call: ${toolName}</span>
            </div>
            ${safeArgs != null ? `<div class="tool-content">Input: ${escapeHtml(safeArgs)}</div>` : ""}
            ${safeResult != null ? `<div class="tool-content" style="border-top:1px dashed var(--tool-border);">Output: ${escapeHtml(safeResult)}</div>` : ""}
          </div>`;
      }
    }

    rowsHtml += `
      <div class="turn turn-assistant">
        <div class="turn-header">${label}</div>
        ${contentHtml}
        ${toolHtml}
      </div>`;
  }

  // Collect attached artifacts
  const rawArtifacts = Array.isArray(artifacts) && artifacts.length > 0
    ? artifacts
    : Array.isArray(projectedThread?.artifacts) ? projectedThread.artifacts : [];

  let artifactsHtml = "";
  if (rawArtifacts.length > 0) {
    let cardList = "";
    for (const a of rawArtifacts) {
      if (!a) continue;
      const artName = escapeHtml(redact(a.name ?? a.title ?? a.id ?? "Untitled Artifact"));
      const artKind = escapeHtml(a.kind ?? a.type ?? "text");
      const rawBody = a.content ?? a.body ?? a.text ?? "";
      const safeBody = formatToolPayload(rawBody, knownSecrets);

      cardList += `
        <div class="artifact-card">
          <div class="artifact-head">
            <span>${artName}</span>
            <span style="opacity:0.7;font-weight:normal;">[${artKind}]</span>
          </div>
          <div class="artifact-body">${escapeHtml(safeBody ?? "")}</div>
        </div>`;
    }

    artifactsHtml = `
      <section class="artifacts-section">
        <h2>Attached Artifacts (${rawArtifacts.length})</h2>
        ${cardList}
      </section>`;
  }

  // Construct final self-contained HTML
  // Note: strict CSP disallows script execution and form actions completely
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none';">
  <title>${safeTitle}</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="container">
    <div class="privacy-caveat" role="note">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true" style="flex-shrink:0;margin-top:1px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <div>${escapeHtml(EXPORT_PRIVACY_CAVEAT)}</div>
    </div>
    <header class="header">
      <h1>${safeTitle}</h1>
      <div class="metadata">Exported: ${escapeHtml(dateStr)} • Chrome Agent Platform</div>
    </header>
    <main class="timeline">
      ${rowsHtml}
    </main>
    ${artifactsHtml}
    <footer class="footer">
      Self-contained export generated by Chrome Agent Platform. Static CSP-enforced document.
    </footer>
  </div>
</body>
</html>`;
}
