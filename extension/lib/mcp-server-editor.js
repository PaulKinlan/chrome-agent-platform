// extension/lib/mcp-server-editor.js — the SHARED add/edit MCP-server editor and
// its field helpers. CAP-FB-20260831-MCP-AGENT-UI-01.
//
// One editor for both owner surfaces so they can never drift:
//   - the GLOBAL "MCP servers" section in Settings (options.js), and
//   - the PER-AGENT "MCP servers" section in the agent create/edit dialog
//     (ntp.js).
// Pure DOM builders (MV3-CSP-safe: no eval, no innerHTML — every remote-supplied
// string is set with textContent). Each surface supplies its own persistence and
// (optionally) its own Test-connection sender via callbacks; this module owns the
// form shape, the field labels, the token-redaction UX, and validation so both
// surfaces stay identical. The token input is NEVER pre-filled (redacted reads
// carry only `auth.hasToken`); a blank token on a server that already has one is
// the "leave blank to keep" signal, carried as `auth.token:""`.

export function mcpTransportLabel(t) {
  return t === "sse" ? "SSE" : "HTTP";
}

export function mcpField(label, type, value, placeholder) {
  const field = document.createElement("label");
  field.className = "field";
  const span = document.createElement("span");
  span.className = "field-label";
  span.textContent = label;
  const input = document.createElement("input");
  input.type = type;
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  field.append(span, input);
  return { field, input };
}

export function mcpSelectField(label, value) {
  const field = document.createElement("label");
  field.className = "field";
  const span = document.createElement("span");
  span.className = "field-label";
  span.textContent = label;
  const input = document.createElement("select");
  input.className = "input-select";
  for (const [val, text] of [["http", "Streamable HTTP"], ["sse", "SSE (legacy)"]]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = text;
    if (val === value) opt.selected = true;
    input.append(opt);
  }
  field.append(span, input);
  return { field, input };
}

export function mcpSetStatus(el, kind, text) {
  el.hidden = false;
  el.className = "test-status " + kind;
  el.textContent = text;
}

// Map a REDACTED list back to a set/save payload. A redacted server carries
// { auth:{headerName, hasToken} } — send it as { headerName, token:"" } so the
// SW's blank-token preservation keeps the stored credential (the page never sees
// or resends it). A server with no auth stays auth-less. `overrides[id]` merges
// per-server changes (e.g. { enabled }).
export function mcpToSavePayload(list, overrides = {}) {
  return (Array.isArray(list) ? list : []).map((s) => {
    const base = {
      id: s.id,
      name: s.name,
      transport: s.transport,
      url: s.url,
      enabled: s.enabled !== false,
    };
    if (s.auth && s.auth.headerName) base.auth = { headerName: s.auth.headerName, token: "" };
    return { ...base, ...(overrides[s.id] ?? {}) };
  });
}

/**
 * Build the add/edit editor element (a detached node the caller places). The
 * caller owns placement + teardown: `onSave(server)` and `onCancel()` should
 * remove/hide the editor. `onTest`, when provided, wires a "Test connection"
 * button that calls `onTest(server) => Promise<{ok,toolCount?,toolNames?,error?}>`.
 *
 * @param {{
 *   existing?: object|null,
 *   showTest?: boolean,
 *   onTest?: (server:object)=>Promise<{ok:boolean,toolCount?:number,toolNames?:string[],error?:string}>,
 *   onSave: (server:object)=>(Promise<boolean>|boolean),
 *   onCancel?: ()=>void,
 *   addLabel?: string,
 *   hint?: string,
 * }} opts
 */
export function buildMcpServerEditor(opts) {
  const { existing = null, showTest = false, onTest, onSave, onCancel, addLabel, hint } = opts;
  const isEdit = Boolean(existing);

  const editor = document.createElement("div");
  editor.className = "mcp-editor";

  const heading = document.createElement("h3");
  heading.textContent = isEdit ? "Edit MCP server" : (addLabel || "Add MCP server");
  heading.className = "mcp-editor-title";

  const grid = document.createElement("div");
  grid.className = "mcp-editor-grid";

  const nameField = mcpField("Name", "text", existing?.name ?? "", "e.g. My tools");
  const transportField = mcpSelectField("Transport", existing?.transport ?? "http");
  const urlField = mcpField("Server URL", "text", existing?.url ?? "", "https://example.com/mcp");
  const headerField = mcpField("Auth header (optional)", "text", existing?.auth?.headerName ?? "", "Authorization");
  const tokenField = mcpField(
    "Auth token (optional)",
    "password",
    "",
    existing?.auth?.hasToken ? "Token set — leave blank to keep" : "Bearer …",
  );
  tokenField.input.autocomplete = "off";

  grid.append(nameField.field, transportField.field, urlField.field, headerField.field, tokenField.field);

  const testStatus = document.createElement("div");
  testStatus.className = "test-status";
  testStatus.setAttribute("role", "status");
  testStatus.hidden = true;

  const readForm = () => {
    const headerName = headerField.input.value.trim();
    const token = tokenField.input.value;
    const server = {
      name: nameField.input.value.trim(),
      transport: transportField.input.value,
      url: urlField.input.value.trim(),
      enabled: existing ? existing.enabled !== false : true,
    };
    if (existing?.id) server.id = existing.id;
    if (headerName) server.auth = { headerName, token };
    else if (existing?.auth?.hasToken && !token) server.auth = { headerName: existing.auth.headerName, token: "" };
    return server;
  };

  const bar = document.createElement("div");
  bar.className = "mcp-editor-actions";

  if (showTest && typeof onTest === "function") {
    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.className = "btn ghost";
    testBtn.textContent = "Test connection";
    testBtn.addEventListener("click", async () => {
      const server = readForm();
      if (!server.url) { mcpSetStatus(testStatus, "err", "Enter a server URL first."); return; }
      testBtn.disabled = true;
      mcpSetStatus(testStatus, "testing", "Testing…");
      let res;
      try {
        res = await onTest(server);
      } catch (e) {
        res = { ok: false, error: String(e?.message ?? e) };
      }
      testBtn.disabled = false;
      if (res?.ok) {
        const n = res.toolCount ?? (res.toolNames?.length ?? 0);
        const names = (res.toolNames ?? []).slice(0, 8).join(", ");
        const suffix = n === 0 ? "no tools exposed" : `${n} tool${n === 1 ? "" : "s"}${names ? `: ${names}` : ""}`;
        mcpSetStatus(testStatus, "ok", `Connected — ${suffix}`);
      } else {
        mcpSetStatus(testStatus, "err", `Failed — ${res?.error ?? "unknown error"}`);
      }
    });
    bar.append(testBtn);
  }

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn primary";
  saveBtn.textContent = isEdit ? "Save changes" : (addLabel || "Add server");
  saveBtn.addEventListener("click", async () => {
    const server = readForm();
    if (!server.name) { mcpSetStatus(testStatus, "err", "Give the server a name."); return; }
    if (!server.url) { mcpSetStatus(testStatus, "err", "Enter a server URL."); return; }
    saveBtn.disabled = true;
    let r;
    try {
      r = await onSave(server);
    } finally {
      saveBtn.disabled = false;
    }
    // A caller that rejects the save (false or {ok:false}) keeps the editor open;
    // it may pass an {error} to explain (e.g. a validation or persistence error).
    if (r === false || (r && typeof r === "object" && r.ok === false)) {
      if (r && r.error) mcpSetStatus(testStatus, "err", String(r.error));
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn ghost";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => { if (typeof onCancel === "function") onCancel(); });

  bar.append(saveBtn, cancelBtn);

  editor.append(heading, grid);
  if (hint) {
    const hintEl = document.createElement("p");
    hintEl.className = "muted mcp-editor-hint";
    hintEl.textContent = hint;
    editor.append(hintEl);
  }
  editor.append(testStatus, bar);
  // Focus the first field once the caller has placed the editor in the document.
  queueMicrotask(() => { try { nameField.input.focus(); } catch { /* not yet placed */ } });
  return editor;
}

/**
 * One server row: name, transport badge + url, and an actions cluster. Every
 * control is optional — pass only the callbacks the surface needs.
 *   - `onToggle(on)`  renders a <switch-toggle>; omit for a static row.
 *   - `onEdit()`      renders an Edit button.
 *   - `onRemove()`    renders a Remove button.
 *   - `tag`           optional small label (e.g. "Inherited", "Disabled").
 */
export function mcpServerRow(server, { onToggle, onEdit, onRemove, tag } = {}) {
  const card = document.createElement("div");
  card.className = "mcp-server-card";
  if (server.enabled === false) card.classList.add("is-disabled");
  card.dataset.id = server.id;

  const head = document.createElement("div");
  head.className = "mcp-server-head";

  const idBlock = document.createElement("div");
  idBlock.className = "mcp-server-id";
  const nameEl = document.createElement("span");
  nameEl.className = "mcp-server-name";
  nameEl.textContent = server.name || server.id;
  if (tag) {
    const tagEl = document.createElement("span");
    tagEl.className = "mcp-server-tag";
    tagEl.textContent = tag;
    nameEl.append(" ");
    nameEl.append(tagEl);
  }
  const meta = document.createElement("span");
  meta.className = "muted mcp-server-meta";
  const badge = document.createElement("span");
  badge.className = "mcp-badge";
  badge.textContent = mcpTransportLabel(server.transport);
  const urlEl = document.createElement("span");
  urlEl.className = "mcp-server-url";
  urlEl.textContent = server.url;
  meta.append(badge, urlEl);
  idBlock.append(nameEl, meta);

  const actions = document.createElement("div");
  actions.className = "mcp-server-actions";

  if (typeof onToggle === "function") {
    const toggle = document.createElement("switch-toggle");
    toggle.setAttribute("label", `Enable ${server.name || server.id}`);
    if (server.enabled !== false) toggle.setAttribute("checked", "");
    toggle.addEventListener("toggle", (e) => onToggle(e.detail?.checked === true));
    actions.append(toggle);
  }

  if (typeof onEdit === "function") {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn small ghost";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", `Edit ${server.name || server.id}`);
    edit.addEventListener("click", () => onEdit());
    actions.append(edit);
  }

  if (typeof onRemove === "function") {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn small ghost mcp-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${server.name || server.id}`);
    remove.addEventListener("click", () => onRemove());
    actions.append(remove);
  }

  head.append(idBlock, actions);
  card.append(head);
  return card;
}
