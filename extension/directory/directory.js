// directory/directory.js — read-only Agent Directory tool explorer.
//
// The Directory shows the canonical production registry, source, schema,
// declaring page and live first-use state. Consent mutations belong only to
// the exact Settings document; this generic extension surface cannot grant,
// deny, reset, or flip a site's policy.

import { send } from "../lib/messages.js";

if (new URLSearchParams(location.search).get("embedded") === "1" || window.self !== window.top) {
  document.documentElement.dataset.embedded = "1";
}

const rowsEl = document.getElementById("rows");

async function render() {
  const [originsRes, policiesRes] = await Promise.all([
    send("tools.allOrigins"),
    send("tools.policies"),
  ]);
  const list = Array.isArray(originsRes) ? originsRes : [];
  const policies = policiesRes?.ok === true && policiesRes.policies && typeof policiesRes.policies === "object"
    ? policiesRes.policies
    : {};
  rowsEl.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No sites yet. When an open page offers tools, the hub shows a chip you can use to add it as a Site Agent.";
    rowsEl.append(empty);
    return;
  }

  for (const [originIndex, origin] of list.entries()) {
    const [tools, consentResult] = await Promise.all([
      send("tools.list", { origin }),
      send("tools.consent.states", { origin }),
    ]);
    const toolList = Array.isArray(tools) ? tools : [];
    const consentStates = new Map(
      (Array.isArray(consentResult?.states) ? consentResult.states : [])
        .filter((state) => state && typeof state.name === "string")
        .map((state) => [state.name, state.state]),
    );
    const policy = policies[origin] === "deny" ? "deny" : "allow";

    const section = document.createElement("section");
    section.className = "site-group";
    const heading = document.createElement("h2");
    heading.className = "site-heading";
    heading.id = `site-${originIndex}`;
    heading.textContent = origin;
    section.setAttribute("aria-labelledby", heading.id);

    const policyRow = document.createElement("div");
    policyRow.className = "policy-row";
    const note = document.createElement("p");
    note.className = "policy-note";
    note.textContent = policy === "deny"
      ? "Site tools are off. Manage this site in Settings."
      : "Each exact tool asks on first model use; allowed tools then run automatically. Manage decisions in Settings.";
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "policy-select";
    manage.textContent = "Open Settings";
    manage.setAttribute("aria-label", `Manage site tool permissions for ${origin} in Settings`);
    manage.addEventListener("click", () => chrome.runtime.openOptionsPage());
    policyRow.append(note, manage);
    section.append(heading, policyRow);

    if (!toolList.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No functions currently available.";
      section.append(empty);
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
        policy,
        consentState: consentStates.get(tool.name) ?? "ask",
        manage: false,
      };
      item.append(card);
      functionList.append(item);
    }
    section.append(functionList);
    rowsEl.append(section);
  }
}

render();
