// directory/directory.js — render the canonical production tool registry with
// per-function source, schema metadata, and approval state.

import { send } from "../lib/messages.js";

const rowsEl = document.getElementById("rows");

async function render() {
  const origins = await send("tools.allOrigins");
  const list = Array.isArray(origins) ? origins : [];
  rowsEl.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    // What actually happens (CAP-FB-20260825-SITE-AGENT-SHOWCASE-01): the
    // passive detector notices a page's tools, the hub offers them as a chip,
    // and the owner's one click makes the site a Site Agent listed here.
    empty.textContent = "No sites yet. When a page you have open offers tools, the hub shows a chip — choose it to add the site here.";
    rowsEl.append(empty);
    return;
  }

  for (const [originIndex, origin] of list.entries()) {
    const [tools, pending] = await Promise.all([
      send("tools.list", { origin }),
      send("tools.pending", { origin }),
    ]);
    const toolList = Array.isArray(tools) ? tools : [];
    const pendingNames = new Set(
      (Array.isArray(pending) ? pending : []).map((tool) => tool?.name).filter(Boolean),
    );

    const section = document.createElement("section");
    section.className = "site-group";
    const heading = document.createElement("h2");
    heading.className = "site-heading";
    heading.id = `site-${originIndex}`;
    heading.textContent = origin;
    section.setAttribute("aria-labelledby", heading.id);

    if (!toolList.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No functions currently available.";
      section.append(heading, empty);
      rowsEl.append(section);
      continue;
    }

    const functionList = document.createElement("ul");
    functionList.className = "tool-list";
    for (const tool of toolList) {
      const item = document.createElement("li");
      const card = document.createElement("tool-directory-card");
      card.tool = {
        ...tool,
        origin,
        approved: !pendingNames.has(tool.name),
      };
      card.addEventListener("approve", async (event) => {
        const { origin: approvedOrigin, name } = event.detail ?? {};
        if (!approvedOrigin || !name) return;
        await send("tools.approve", {
          origin: approvedOrigin,
          name,
          decision: true,
        });
        await render();
      });
      item.append(card);
      functionList.append(item);
    }
    section.append(heading, functionList);
    rowsEl.append(section);
  }
}

render();
