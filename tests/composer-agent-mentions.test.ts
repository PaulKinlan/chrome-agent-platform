// @ts-nocheck — fixture-shaped registry data exercises the public composer contract.
// CAP-FB-20260819-COMPOSER-AGENT-MENTIONS-01: @ mentions must resolve every
// callable agent kind through the same canonical refs used by <agent-picker>.

import {
  candidatesFromGroups,
  selectionFromAgentCandidate,
} from "../extension/shared/agent-registry.js";
import { assert, assertEquals, assertMatch, assertNotMatch } from "jsr:@std/assert@1";

const groups = [
  {
    id: "named",
    label: "Named agents",
    agents: [
      { ref: "named:reader", id: "reader", kind: "named", name: "Reader", summary: "Reads articles", enabled: true },
    ],
  },
  {
    id: "background",
    label: "Background agents",
    agents: [
      { ref: "background:sorting-hat", id: "sorting-hat", kind: "background", name: "Sorting Hat", summary: "Groups tabs", enabled: true },
      { ref: "background:disabled", id: "disabled", kind: "background", name: "Disabled", enabled: false },
    ],
  },
  {
    id: "site",
    label: "Site agents",
    agents: [
      { ref: "site:https://github.com", id: "https://github.com", kind: "site", name: "@github.com", summary: "2 tools", enabled: true },
    ],
  },
];

Deno.test("composer mentions expose named, background, and site agents with canonical routing", () => {
  const mentions = candidatesFromGroups(groups, { callableOnly: true });
  assertEquals(mentions.map((item) => item.ref), [
    "named:reader",
    "background:sorting-hat",
    "site:https://github.com",
  ]);
  assertEquals(mentions.map((item) => item.mentionText), [
    "@Reader",
    "@Sorting Hat",
    "@github.com",
  ]);

  assertEquals(selectionFromAgentCandidate(mentions[0]), {
    ref: "named:reader",
    kind: "named",
    id: "reader",
    name: "Reader",
  });
  assertEquals(selectionFromAgentCandidate(mentions[1]), {
    ref: "background:sorting-hat",
    kind: "background",
    id: "sorting-hat",
    name: "Sorting Hat",
  });
  assertEquals(selectionFromAgentCandidate(mentions[2]), {
    ref: "site:https://github.com",
    kind: "site",
    id: "https://github.com",
    name: "@github.com",
  });
});

Deno.test("composer mention routing rejects malformed or kind/id-confused candidates", () => {
  assertEquals(selectionFromAgentCandidate({ ref: "agent:reader", kind: "named", agentId: "reader" }), null);
  assertEquals(selectionFromAgentCandidate({ ref: "named:reader", kind: "site", agentId: "reader" }), null);
  assertEquals(selectionFromAgentCandidate({ ref: "named:reader", kind: "named", agentId: "someone-else" }), null);
});

Deno.test("shipped composer copy and accessible description promise any agent, never site-only replies", async () => {
  const root = new URL("../", import.meta.url);
  const components = await Deno.readTextFile(new URL("extension/shared/components.js", root));
  const ntp = await Deno.readTextFile(new URL("extension/ntp/ntp.html", root));
  const chat = await Deno.readTextFile(new URL("extension/chat/chat.html", root));
  const chatJs = await Deno.readTextFile(new URL("extension/chat/chat.js", root));
  const shipped = [components, ntp, chat, chatJs].join("\n");

  assertNotMatch(shipped, /@mention a site agent/i);
  assertMatch(ntp, /placeholder="Ask anything, or @mention an agent…"/);
  assertMatch(ntp, /placeholder="Reply, or @mention an agent…"/);
  assertMatch(chat, /placeholder="Reply, or @mention an agent…"/);
  assertMatch(components, /Type @ to mention any named, background, or (?:site agent|Site Agent)\./i);
  assertMatch(chatJs, /Ask a task, @mention an agent, or attach media\./);

  // The @ picker uses the redacted canonical registry, and committing an agent
  // mention selects the same canonical routing chip consumed by send().
  assertMatch(components, /RUNTIME_SEND\("agent\.registry"\)/);
  assertMatch(components, /if \(item\.ref\)[\s\S]*?_setSelectedAgent/);
  const sendMethod = components.slice(
    components.indexOf("async _send()"),
    components.indexOf("customElements.define(\"agent-composer\"")
  );
  assert(sendMethod.includes("const agent = this._selectedAgent ? { ...this._selectedAgent } : null;"));
  assert(sendMethod.includes('this._emit("send", { text, attachments: pending, agent });'));
});
