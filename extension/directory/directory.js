// directory/directory.js — render the agent directory + per-tool approval.

import { send } from "../lib/messages.js";

const rowsEl = document.getElementById("rows");

async function render() {
  const origins = await send("tools.allOrigins");
  const list = Array.isArray(origins) ? origins : [];
  rowsEl.replaceChildren();
  if (!list.length) {
    rowsEl.append(Object.assign(document.createElement("p"), { textContent: "No sites enrolled yet. Browse the web with the extension installed; each origin becomes a sub-agent.", style: "color:var(--muted)" }));
    return;
  }
  for (const origin of list) {
    const tools = await send("tools.list", { origin });
    const toolList = Array.isArray(tools) ? tools : [];
    const pending = await send("tools.pending", { origin });

    const row = document.createElement("div");
    row.className = "row";
    const o = document.createElement("span");
    o.className = "origin";
    o.textContent = origin;
    const t = document.createElement("span");
    t.className = "tools";
    t.textContent = toolList.map((x) => x.name).join(" · ") || "(no tools)";
    row.append(o, t);

    for (const tool of toolList) {
      const src = document.createElement("span");
      src.className = "src " + (tool.source ?? "inferred");
      src.textContent = tool.source ?? "inferred";
      row.append(src);
      const approved = !(pending.some((p) => p.name === tool.name));
      if (!approved) {
        const btn = document.createElement("button");
        btn.className = "approve";
        btn.textContent = "approve";
        btn.onclick = async () => { await send("tools.approve", { origin, name: tool.name, decision: true }); render(); };
        row.append(btn);
      }
    }
    rowsEl.append(row);
  }
}

render();
