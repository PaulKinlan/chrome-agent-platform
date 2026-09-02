// lib/privacy-statement.js — the text of "What this extension sends and
// stores" (CAP-FB-20260830-PRIVACY-STATEMENT-01), built from the SAME
// constants the code runs on so the page cannot drift from the product:
//
//   sent    — the hosted provider hosts come from OUTBOUND_HOSTS
//             (lib/provider.js, derived from the presets); the skill-import
//             hosts are pinned to lib/skill-import.js by the unit test; the
//             script-fetch line describes the cap:fetch gate
//             (background/service-worker.js "cap:fetch", lib/fetch-policy.js).
//   stored  — one row per FACTORY_RESET_STORAGE_CLASSES entry
//             (lib/factory-reset.js), each with its own reader-language copy;
//             a class without copy throws rather than rendering blank.
//   wipe    — Settings → Data & memory, and the factory reset.
//
// This module is PURE (no chrome.*, no fetch) so the privacy page can import
// it unbundled and the unit suite can pin every line.

import { FACTORY_RESET_STORAGE_CLASSES } from "./factory-reset.js";

/** The settled host-access posture (open question Q18, resolved (a) on
 * 2026-08-31 by CAP-FB-20260830-HOST-ACCESS-STORY-01). ONE constant; the
 * README and the vocabulary rule carry the same sentence. */
export const HOST_ACCESS_SENTENCE =
  "This extension can read every page in order to notice when a site offers tools; it acts on a site only after you allow it.";

/** The hosts an explicit skill import can reach for a GitHub repository
 * (lib/skill-import.js). A direct URL import fetches the address you typed. */
export const SKILL_IMPORT_HOSTS = Object.freeze(["api.github.com", "raw.githubusercontent.com"]);

/** One reader-language description per storage class the factory reset
 * wipes. Keys are FACTORY_RESET_STORAGE_CLASSES, in the same order. The
 * `{perThread}`, `{globalExecutions}` and `{globalBytes}` holes are filled
 * from the live run-log policy (lib/durable-runs.js RUN_RETENTION_POLICY /
 * `run.list`.retentionPolicy). */
export const STORAGE_CLASS_COPY = Object.freeze({
  "chrome.storage.local": {
    description:
      "Your settings: the model you chose and its key — kept as you typed it, not encrypted, so anyone who can open this Chrome profile can read it — plus the sites and servers you allowed, your agents, tasks, schedules and the rules you set in Settings.",
  },
  "chrome.storage.session": {
    description: "Short-lived working state that Chrome drops when it closes.",
  },
  "in-memory-session-kv": {
    description: "The same settings held in memory while Chrome runs, for the moments Chrome cannot store them.",
  },
  "origin-private-file-system": {
    description:
      "Each agent's memory, kept apart per site so one site never reads another's; the run logs ({retention}); artifacts; screenshots an agent took; models you downloaded.",
  },
  "indexed-db": {
    description:
      "The folders and files you gave an agent access to — the access itself, not copies of the files — and the running count of what your model use has cost.",
  },
  "cache-storage": {
    description: "Files the extension fetched and kept for reuse.",
  },
  "chrome.alarms": {
    description: "The timers behind your schedules.",
  },
});

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v % (1024 * 1024) === 0) return `${v / (1024 * 1024)} MiB`;
  return `${Math.round(v / 1024)} KiB`;
}

/** The run-log sentence for the current policy (the bounded default, or the
 * owner's "keep every run log" opt-in). */
export function retentionSentence(policy) {
  if (policy && policy.mode === "retain-all") return "you chose to keep every run log in full";
  const perThread = Number(policy?.perThread);
  const globalExecutions = Number(policy?.globalExecutions);
  const bytes = formatBytes(policy?.globalBytes);
  if (Number.isInteger(perThread) && perThread > 0 && Number.isInteger(globalExecutions) && globalExecutions > 0) {
    return `full detail for the newest ${perThread} runs per task and ${globalExecutions} overall${bytes ? `, up to ${bytes}` : ""}; older runs keep a one-line summary`;
  }
  return "full detail for the newest runs; older runs keep a one-line summary";
}

function hostsSentence(outboundHosts) {
  const named = (outboundHosts ?? []).map((h) => `${h.name} (${h.host})`);
  return named.length ? `${named.join(", ")}, or an address you typed yourself` : "an address you typed yourself";
}

/**
 * Build the statement.
 * @param {{ outboundHosts?: Array<{id:string,name:string,host:string}>,
 *           retentionPolicy?: object|null,
 *           storageClasses?: readonly string[] }} input
 * @returns {{ sent: Array<{id:string,text:string}>, stored: Array<{id:string,text:string}>,
 *             wipe: Array<{id:string,text:string}>, keyHandling: Array<{id:string,text:string}>,
 *             hostAccess: string }}
 */
export function buildPrivacyStatement({ outboundHosts = [], retentionPolicy = null, storageClasses = FACTORY_RESET_STORAGE_CLASSES } = {}) {
  const sent = [
    {
      id: "provider",
      description:
        `Your messages, the page text you share and any screenshot you ask an agent to look at go to the model you chose in Settings, together with your key. The choices that leave this computer: ${hostsSentence(outboundHosts)}.`,
    },
    {
      id: "local-models",
      description: "Ollama, LM Studio and Chrome's built-in model run on this computer. With one of those chosen, nothing leaves it.",
    },
    {
      id: "model-list",
      description: "When you enter a key in Settings, that provider's list of models is fetched with it.",
    },
    {
      id: "mcp-servers",
      description: "An MCP server you add in Settings receives the tool calls an agent makes through it, with the headers you typed for it.",
    },
    {
      id: "site-tools",
      description: "A site whose tools you allowed receives the tool calls an agent makes on that page, inside the page.",
    },
    {
      id: "skill-import",
      description:
        `Importing a skill fetches its files from the address you gave — for a GitHub repository, through ${SKILL_IMPORT_HOSTS.join(" and ")}.`,
    },
    {
      id: "script-fetch",
      description: "A script an agent writes can fetch only the web addresses you approved on its card, and sends no cookies or logins with them.",
    },
    {
      id: "nothing-else",
      description: "Nothing else leaves this computer. There is no analytics and no usage reporting.",
    },
  ];

  const retention = retentionSentence(retentionPolicy);
  const stored = [];
  for (const id of storageClasses) {
    const copy = STORAGE_CLASS_COPY[id];
    if (!copy || typeof copy.description !== "string" || !copy.description.trim()) {
      throw new Error(`privacy statement: no copy for storage class ${id}`);
    }
    stored.push({ id, description: copy.description.replace("{retention}", retention) });
  }

  const wipe = [
    {
      id: "per-agent",
      description: "Settings → Data & memory shows what each agent holds and clears one at a time.",
    },
    {
      id: "factory-reset",
      description: "Reset all data, at the bottom of the same section, removes everything listed above and puts the extension back to its first run.",
    },
  ];

  const keyHandling = [
    {
      id: "write-only",
      description: "The key box in Settings is write-only: a saved key is never shown back.",
    },
    {
      id: "error-reports",
      description: "Error reports blank out anything that looks like a key or token before you see them.",
    },
    {
      id: "storage-hook",
      description: "An agent watching storage changes never sees your key or the extension's own settings.",
    },
  ];

  const row = ({ id, description }) => ({ id, text: description });
  return Object.freeze({
    sent: sent.map(row),
    stored: stored.map(row),
    wipe: wipe.map(row),
    keyHandling: keyHandling.map(row),
    hostAccess: HOST_ACCESS_SENTENCE,
  });
}
