// panels/mcp-servers.js — Remote MCP servers Settings panel module.

import {
  mcpToSavePayload,
  buildMcpServerEditor,
  mcpServerRow as buildMcpServerRow,
} from "../../lib/mcp-server-editor.js";
import { createPanelContext, bindPanelCtx } from "../panel-context.js";

let mcpServers = []; // the REDACTED list (no tokens) mirrored from the SW

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("mcp-servers");

async function mcpPersist(payload, ctx) {
  const res = await boundedSend("mcp.servers.set", { servers: payload }).catch((e) => ({ error: String(e?.message ?? e) }));
  if (res?.error) {
    saveFlash(`Couldn't save MCP servers — ${res.error}`);
    return false;
  }
  mcpServers = Array.isArray(res?.servers) ? res.servers : [];
  mcpRenderList();
  return true;
}

async function renderMcpServers(ctx) {
  const list = byId("mcp-server-list");
  if (!list) return;
  try {
    const res = await boundedSend("mcp.servers.get");
    mcpServers = Array.isArray(res?.servers) ? res.servers : [];
  } catch (e) {
    list.textContent = "";
    const err = document.createElement("p");
    err.className = "muted";
    err.textContent = `Couldn't load MCP servers — the service worker didn't answer (${String(e?.message ?? e)}).`;
    list.append(err);
    return;
  }
  mcpRenderList();
}

function mcpRenderList(ctx) {
  const list = byId("mcp-server-list");
  if (!list) return;
  list.textContent = "";
  if (mcpServers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted mcp-empty";
    empty.textContent = "No MCP servers yet. Add a remote server to give your agents its tools.";
    list.append(empty);
    return;
  }
  for (const s of mcpServers) {
    list.append(buildMcpServerRow(s, {
      onToggle: async (on) => {
        await mcpPersist(mcpToSavePayload(mcpServers, { [s.id]: { enabled: on } }));
        saveFlash(on ? `Enabled ${s.name || s.id}.` : `Disabled ${s.name || s.id}.`);
      },
      onEdit: () => mcpOpenEditor(s),
      onRemove: async () => {
        const rest = mcpServers.filter((x) => x.id !== s.id);
        if (await mcpPersist(mcpToSavePayload(rest))) saveFlash(`Removed ${s.name || s.id}.`);
      },
    }));
  }
}

function mcpOpenEditor(existing, ctx) {
  const editor = byId("mcp-editor");
  if (!editor) return;
  const isEdit = Boolean(existing);
  const close = () => { editor.hidden = true; editor.textContent = ""; };
  editor.textContent = "";
  editor.hidden = false;
  editor.append(buildMcpServerEditor({
    existing,
    showTest: true,
    onTest: (server) => boundedSend("mcp.servers.test", { server }, 20000),
    onSave: async (server) => {
      const others = mcpServers.filter((x) => x.id !== (existing?.id ?? " "));
      const payload = [...mcpToSavePayload(others), server];
      if (await mcpPersist(payload)) {
        close();
        saveFlash(isEdit ? `Saved ${server.name}.` : `Added ${server.name}.`);
      }
    },
    onCancel: close,
  }));
}

export function initMcpServersStatic(ctx) {
  const panelCtx = wireOnce(ctx);
  if (!panelCtx) return;
  byId("mcp-add-btn")?.addEventListener("click", () => mcpOpenEditor(null));
}

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  initMcpServersStatic();
  await renderMcpServers();
  return {
    refresh: () => renderMcpServers(),
    unmount: makeUnmount(panelCtx),
  };
}
