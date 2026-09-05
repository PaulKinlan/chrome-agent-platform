// directory/directory.js — the Agent Directory tool explorer: render the
// canonical production tool registry with per-function source, schema,
// provenance (declaring page), and approval state — plus the per-site
// enrollment policy control (allow / ask / deny) that decides whether each
// site's tools are available to agents (CAP-FB-20260819-DIRECTORY-TOOL-
// EXPLORER-01). The Directory is the OWNER surface: a blocked site's tools
// still render here (with truthful provenance) so the owner can review and
// flip the policy back; they are excluded from agent toolsets by the service
// worker (readSiteLazySources), not by hiding them from the owner.

import { send } from "../lib/messages.js";

if (new URLSearchParams(location.search).get("embedded") === "1" || window.self !== window.top) {
  document.documentElement.dataset.embedded = "1";
}

const rowsEl = document.getElementById("rows");

// The three policy states, in Directory order. The vocabulary matches the
// service worker's registry (lib/tools.js SITE_TOOL_POLICIES).
const POLICY_OPTIONS = [
  { value: "allow", label: "Allow tools", note: "This site's tools are available to agents." },
  { value: "ask", label: "Ask before use", note: "This site's tools are available, but each use asks you first." },
  { value: "deny", label: "Blocked", note: "This site's tools are blocked — not available to any agent." },
];
const POLICY_NOTE = Object.fromEntries(POLICY_OPTIONS.map((o) => [o.value, o.note]));

function policyLabel(value) {
  return POLICY_OPTIONS.find((o) => o.value === value)?.label ?? "Allow tools";
}

function policyNote(value) {
  return POLICY_NOTE[value] ?? POLICY_NOTE.allow;
}

async function setPolicy(origin, value) {
  const res = await send("tools.policy.set", { origin, policy: value });
  if (!res?.ok) throw new Error(res?.error ?? "policy update failed");
  return res;
}

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
    const policy = policies[origin] === "deny" || policies[origin] === "ask" ? policies[origin] : "allow";

    const section = document.createElement("section");
    section.className = "site-group";
    const heading = document.createElement("h2");
    heading.className = "site-heading";
    heading.id = `site-${originIndex}`;
    heading.textContent = origin;
    section.setAttribute("aria-labelledby", heading.id);

    const policyRow = document.createElement("div");
    policyRow.className = "policy-row";
    const select = document.createElement("select");
    select.className = "policy-select";
    select.setAttribute("aria-label", `Tool-use policy for ${origin}`);
    for (const option of POLICY_OPTIONS) {
      const el = document.createElement("option");
      el.value = option.value;
      el.textContent = option.label;
      select.append(el);
    }
    select.value = policy;
    const note = document.createElement("p");
    note.className = "policy-note";
    note.id = `site-policy-note-${originIndex}`;
    note.textContent = policyNote(policy);
    select.setAttribute("aria-describedby", note.id);
    policyRow.append(select, note);

    section.append(heading, policyRow);

    if (!toolList.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = policy === "deny"
        ? "No functions currently available (blocked sites keep no live tool set)."
        : "No functions currently available.";
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
    section.append(functionList);
    rowsEl.append(section);

    // The enrollment-policy control. A change is a revocation fence on the
    // service worker side (generation bump) — re-render from the applied
    // state so the UI can never show a policy the registry did not commit.
    select.addEventListener("change", async () => {
      const value = select.value === "deny" || select.value === "ask" ? select.value : "allow";
      const previous = policy;
      try {
        await setPolicy(origin, value);
      } catch (error) {
        select.value = previous;
        note.textContent = `Could not update the policy — ${String(error?.message ?? error)}`;
        note.setAttribute("role", "alert");
        return;
      }
      await render();
    });
  }
}

render();
