// panels/board-permissions.js — Board deny-rules Settings panel module.

import { createPanelContext, bindPanelCtx } from "../panel-context.js";

let boardAgents = [];
const boardWired = new WeakSet();

const [ensureCtx, $, $$, byId, send, boundedSend, storage, saveFlash, on, makeUnmount, wireOnce] = bindPanelCtx("board-permissions");

const boardAgentName = (id) => (id === "hub" ? "Hub" : (boardAgents.find((a) => a?.id === id)?.name ?? id));

function boardRuleSentence(rule) {
  const verb = rule.action === "claim" ? "claim jobs from" : "post jobs targeting";
  return `${boardAgentName(rule.agentId)} cannot ${verb} ${boardAgentName(rule.peerId)}`;
}

async function renderBoardDenyRules(ctx) {
  const list = byId("board-deny-list");
  if (!list) return;
  const res = await send({ type: "board.deny.list" }).catch(() => null);
  list.replaceChildren();
  if (!res?.ok || !Array.isArray(res.rules)) {
    if (res?.error) {
      const err = document.createElement("p");
      err.className = "muted";
      err.textContent = `Rules unavailable: ${res.error}`;
      list.append(err);
    }
    return;
  }
  if (!res.rules.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.id = "board-deny-empty";
    empty.textContent = "No rules — every named agent and the hub can post and claim.";
    list.append(empty);
    return;
  }
  for (const rule of res.rules) {
    const row = document.createElement("div");
    row.className = "perm-row";
    row.setAttribute("role", "listitem");
    const name = document.createElement("span");
    name.className = "perm-name";
    name.textContent = boardRuleSentence(rule);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small ghost";
    btn.textContent = "Remove";
    btn.setAttribute("aria-label", `Remove rule: ${name.textContent}`);
    btn.addEventListener("click", async () => {
      await send({ type: "board.deny.remove", ruleId: rule.id }).catch(() => {});
      await renderBoardDenyRules();
    });
    row.append(name, btn);
    list.appendChild(row);
  }
}

export async function populateBoardDenyAgents(ctx) {
  if (ctx) ensureCtx(null, ctx);
  const agentSelect = byId("board-deny-agent");
  const peerSelect = byId("board-deny-peer");
  if (!agentSelect || !peerSelect) return;
  const namedAgentRes = await send({ type: "named-agent.list" }).catch(() => null);
  boardAgents = Array.isArray(namedAgentRes?.agents) ? namedAgentRes.agents.filter((a) => a && typeof a.id === "string") : [];
  const options = boardAgents.map((a) => ({ id: a.id, name: a.name ?? a.id, icon: "user" }));
  const keepAgent = agentSelect.value;
  const keepPeer = peerSelect.value;
  agentSelect.providers = [...options, { id: "hub", name: "Hub", icon: "terminal" }];
  peerSelect.providers = [...options, { id: "hub", name: "Hub", icon: "terminal" }];
  if (keepAgent) agentSelect.value = keepAgent;
  if (keepPeer) peerSelect.value = keepPeer;
  // Names in the rule rows come from the same registry — re-render them too.
  await renderBoardDenyRules();
}

export function initBoardDenyUI(ctx, { skipInitialPopulate = false } = {}) {
  const panelCtx = ensureCtx(null, ctx);
  const key = panelCtx.root ?? panelCtx;
  if (boardWired.has(key)) return;
  const form = byId("board-deny-form");
  if (!form) return;
  boardWired.add(key);
  panelCtx.registerCleanup(() => boardWired.delete(key));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const action = byId("board-deny-action")?.value || "claim";
    const agentId = byId("board-deny-agent")?.value ?? "";
    const peerId = byId("board-deny-peer")?.value ?? "";
    if (!agentId || !peerId) return;
    const res = await send({ type: "board.deny.add", action, agentId, peerId }).catch(() => null);
    if (res?.ok) await renderBoardDenyRules();
  });
  if (!skipInitialPopulate && panelCtx.developerFeatures()) {
    void populateBoardDenyAgents();
  }
  const port = panelCtx.connectPort({ name: "agent-progress" });
  port?.onMessage?.addListener?.((msg) => {
    const type = msg?.type === "progress" ? msg.event?.type : null;
    if (type === "agent-registry-changed" || type === "named-agent-changed") {
      void populateBoardDenyAgents();
    }
  });
}

export async function mount(root, ctx) {
  const panelCtx = ensureCtx(root, ctx);
  initBoardDenyUI(panelCtx, { skipInitialPopulate: true });
  await populateBoardDenyAgents();
  return {
    refresh: () => populateBoardDenyAgents(),
    unmount: makeUnmount(panelCtx),
  };
}
