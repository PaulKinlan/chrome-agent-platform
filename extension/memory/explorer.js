// memory/explorer.js — render master + per-origin memory + usage.

import { send } from "../lib/messages.js";

const masterEl = document.getElementById("master");
const agentsEl = document.getElementById("agents");
const usageSummary = document.getElementById("usage-summary");
const usageBody = document.querySelector("#usage-table tbody");

function kv(label, value) {
  const row = document.createElement("div");
  row.className = "kv";
  row.innerHTML = `<span>${escapeHtml(label)}</span><b>${escapeHtml(String(value))}</b>`;
  return row;
}

async function renderMaster() {
  const keys = await send("memory.list", { origin: "master" });
  const list = Array.isArray(keys) ? keys : [];
  const h = document.createElement("h2");
  h.textContent = "Master memory (extension agent)";
  masterEl.replaceChildren(h);
  for (const k of list) {
    const v = await send("memory.get", { origin: "master", key: k });
    const preview = JSON.stringify(v)?.slice(0, 80) ?? "";
    masterEl.append(kv(k, preview));
  }
}

async function renderAgents() {
  const origins = await send("memory.origins");
  const list = Array.isArray(origins) ? origins : [];
  agentsEl.replaceChildren();
  if (!list.length) {
    agentsEl.append(Object.assign(document.createElement("p"), { textContent: "No site agents yet.", style: "color:var(--muted)" }));
    return;
  }
  for (const origin of list) {
    const box = document.createElement("div");
    box.className = "mem";
    const title = document.createElement("div");
    title.className = "origin";
    title.textContent = origin;
    box.append(title);
    const keys = await send("memory.list", { origin });
    for (const k of (Array.isArray(keys) ? keys : []).slice(0, 6)) {
      const v = await send("memory.get", { origin, key: k });
      box.append(kv(k, JSON.stringify(v)?.slice(0, 60) ?? ""));
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    const clearBtn = document.createElement("button");
    clearBtn.className = "btn ghost";
    clearBtn.textContent = "clear";
    clearBtn.onclick = async () => { await send("memory.clear", { origin }); renderAgents(); };
    actions.append(clearBtn);
    box.append(actions);
    agentsEl.append(box);
  }
}

async function renderUsage() {
  const u = await send("usage.get");
  usageSummary.textContent = `${u.calls ?? 0} calls · ${u.totalTokensIn ?? 0} tokens in · ${u.totalTokensOut ?? 0} out · $${(u.totalCost ?? 0).toFixed(4)}`;
  usageBody.replaceChildren();
  for (const [model, m] of Object.entries(u.byModel ?? {})) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(model)}</td><td>${m.calls}</td><td>${m.tokensIn}</td><td>${m.tokensOut}</td><td>$${m.costUsd.toFixed(4)}</td>`;
    usageBody.append(tr);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

renderMaster();
renderAgents();
renderUsage();
