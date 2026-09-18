// tests/agent-tool-config.test.ts — Per-agent tool config (AGENT-PRODUCT-GAPS G4).
//
// Tests covering:
//   (1) normalizeAgentToolsConfig normalization (lowercasing, deduping, empty array preservation).
//   (2) Named agent create / update / get / set tools config in storage.
//   (3) Bundled WASM filtering via agent tools configuration.
//   (4) WebMCP origin allowlist filtering and delegation guarding.
//   (5) Agent card export and import round-trip with tools configuration.
//
// @ts-nocheck — dynamic mock in Deno runner.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createNamedAgent,
  deleteNamedAgent,
  getNamedAgent,
  getNamedAgentToolsConfig,
  listNamedAgents,
  normalizeAgentToolsConfig,
  setNamedAgentToolsConfig,
  updateNamedAgent,
} from "../extension/lib/named-agents.js";
import {
  exportAgentCard,
  importAgentCard,
  validateAgentCard,
} from "../extension/lib/agent-cards.js";
import { executableBundledToolRecords } from "../extension/lib/lazy-tool-protocol.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { BUNDLED_INVENTORY } from "../extension/lib/bundled-inventory-data.js";
import { canonicalOrigin } from "../extension/lib/memory.js";

// ---- in-memory chrome + OPFS mock (from tests/named-agents.test.ts) ----
const store = new Map();
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
const fs = new Map();
function dirPath(path) {
  return "/" + path.join("/");
}
function getDir(path) {
  let node = fs;
  for (const seg of path) {
    if (!node.has("d:" + seg)) node.set("d:" + seg, new Map());
    node = node.get("d:" + seg);
  }
  return node;
}

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
};

globalThis.navigator = globalThis.navigator ?? {};
Object.defineProperty(globalThis.navigator, "storage", {
  value: {
    getDirectory: async () => ({
      getDirectoryHandle: async (seg, { create } = {}) => {
        const node = create ? getDir([seg]) : (() => { const n = fs.get("d:" + seg); if (!n) throw new Error("missing"); return n; })();
        return dirHandle(node, seg);
      },
    }),
  },
  configurable: true,
});

function dirHandle(node, name) {
  return {
    name,
    getDirectoryHandle: async (seg, { create } = {}) => {
      const key = "d:" + seg;
      if (!node.has(key)) {
        if (!create) throw new Error("missing " + seg);
        node.set(key, new Map());
      }
      return dirHandle(node.get(key), seg);
    },
    getFileHandle: async (seg, { create } = {}) => {
      const key = "f:" + seg;
      if (!node.has(key)) {
        if (!create) throw new Error("missing " + seg);
        node.set(key, { text: "" });
      }
      const rec = node.get(key);
      return {
        getFile: async () => ({ text: async () => rec.text, size: new TextEncoder().encode(rec.text).length }),
        createWritable: async () => ({
          write: async (s) => { rec.text = s; },
          close: async () => {},
        }),
      };
    },
    removeEntry: async (seg) => {
      node.delete("d:" + seg);
      node.delete("f:" + seg);
    },
    entries: async function* () {
      for (const [k, v] of node) {
        yield [k.slice(2), { kind: k.startsWith("d:") ? "directory" : "file", getFile: async () => ({ size: new TextEncoder().encode(v.text ?? "").length }) }];
      }
    },
  };
}

Deno.test("normalizeAgentToolsConfig: normalizes origins and tool names cleanly", () => {
  assertEquals(normalizeAgentToolsConfig(null), null);
  assertEquals(normalizeAgentToolsConfig(undefined), null);
  assertEquals(normalizeAgentToolsConfig("not-an-object"), null);
  assertEquals(normalizeAgentToolsConfig([]), null);

  // Normalizes origins: lowercased, trimmed, deduplicated
  const c1 = normalizeAgentToolsConfig({
    webmcpOrigins: ["https://GitHub.com/", "  https://linear.app  ", "https://github.com/"],
    bundledWasm: ["grep", "  diff ", "grep"],
  });
  assertEquals(c1, {
    webmcpOrigins: ["https://github.com/", "https://linear.app"],
    bundledWasm: ["grep", "diff"],
  });

  // Explicit empty arrays (meaning allowed NONE) are preserved
  const c2 = normalizeAgentToolsConfig({
    webmcpOrigins: [],
    bundledWasm: [],
  });
  assertEquals(c2, {
    webmcpOrigins: [],
    bundledWasm: [],
  });

  // Empty object returns null
  assertEquals(normalizeAgentToolsConfig({}), null);
});

Deno.test("named agents: create with tools config persists and getNamedAgentToolsConfig retrieves it", async () => {
  store.clear();
  const created = await createNamedAgent({
    id: "site-specialist",
    name: "Site Specialist",
    role: "Dedicated agent for GitHub",
    tools: {
      webmcpOrigins: ["https://github.com"],
      bundledWasm: ["grep", "diff", "cap.bundled.csvtool"],
    },
  });
  assert(created.ok, "createNamedAgent succeeded");
  assertEquals(created.agent.tools, {
    webmcpOrigins: ["https://github.com"],
    bundledWasm: ["grep", "diff", "cap.bundled.csvtool"],
  });

  const fetched = await getNamedAgent("site-specialist");
  assertEquals(fetched.tools, {
    webmcpOrigins: ["https://github.com"],
    bundledWasm: ["grep", "diff", "cap.bundled.csvtool"],
  });

  const toolsConfig = await getNamedAgentToolsConfig("site-specialist");
  assertEquals(toolsConfig, {
    webmcpOrigins: ["https://github.com"],
    bundledWasm: ["grep", "diff", "cap.bundled.csvtool"],
  });
});

Deno.test("named agents: updateNamedAgent updates or clears tools configuration", async () => {
  store.clear();
  await createNamedAgent({
    id: "data-wrangler",
    name: "Data Wrangler",
    tools: {
      webmcpOrigins: ["https://sheets.google.com"],
      bundledWasm: ["csvtool"],
    },
  });

  // Update tools
  const updated = await updateNamedAgent("data-wrangler", {
    tools: {
      webmcpOrigins: ["https://sheets.google.com", "https://airtable.com"],
      bundledWasm: ["csvtool", "sqlite3_query_bounded"],
    },
  });
  assert(updated.ok);
  assertEquals(updated.agent.tools, {
    webmcpOrigins: ["https://sheets.google.com", "https://airtable.com"],
    bundledWasm: ["csvtool", "sqlite3_query_bounded"],
  });

  // Convenience helper setNamedAgentToolsConfig
  const setRes = await setNamedAgentToolsConfig("data-wrangler", {
    webmcpOrigins: ["https://example.com"],
    bundledWasm: [],
  });
  assert(setRes.ok);
  assertEquals(setRes.agent.tools, {
    webmcpOrigins: ["https://example.com"],
    bundledWasm: [],
  });

  // Clearing tools (null) removes restrictions
  const cleared = await updateNamedAgent("data-wrangler", { tools: null });
  assert(cleared.ok);
  assertEquals(cleared.agent.tools, null);
  const clearedConfig = await getNamedAgentToolsConfig("data-wrangler");
  assertEquals(clearedConfig, null);
});

Deno.test("bundled wasm filtering: respects agent tools allowlist", () => {
  const scope = { hub: true, agentId: "hub", origin: "", documentId: "" };

  // 1. Unfiltered (null): all 28 bundled packages admitted
  const allRecords = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
    scope,
    sourceGeneration: `bundled-inventory:${BUNDLED_INVENTORY.release}`,
    closureGeneration: "task-execution-core",
  });
  // The contract is completeness against the SHIPPED INVENTORY, not a literal
  // count — a hardcoded 28 rotted when the catalogue grew to 38
  // (chrome-agent-platform-1frz). Derive the expectation from the inventory.
  assertEquals(
    allRecords.length,
    BUNDLED_TOOL_PACKAGE_ROWS.length,
    "an unconfigured agent admits every bundled package row in the shipped inventory",
  );
  assertEquals(
    allRecords.map((r) => r.descriptorInput.toolId).sort(),
    BUNDLED_TOOL_PACKAGE_ROWS.map((row) => row.toolId).sort(),
    "admitted tool ids are exactly the shipped inventory's",
  );

  // 2. Filtered allowlist by toolId
  const toolAllowList = new Set(["grep", "diff"]);
  const filteredRows1 = BUNDLED_TOOL_PACKAGE_ROWS.filter((row) =>
    toolAllowList.has(row.packageId) || toolAllowList.has(row.toolId)
  );
  const filteredRecords1 = executableBundledToolRecords(filteredRows1, {
    scope,
    sourceGeneration: `bundled-inventory:${BUNDLED_INVENTORY.release}`,
    closureGeneration: "task-execution-core",
  });
  assertEquals(filteredRecords1.length, 2);
  const names1 = filteredRecords1.map((r) => r.descriptorInput.toolId).sort();
  assertEquals(names1, ["diff", "grep"]);

  // 3. Filtered allowlist by packageId
  const packageAllowList = new Set(["cap.bundled.csvtool", "cap.bundled.awk.filter.bounded"]);
  const filteredRows2 = BUNDLED_TOOL_PACKAGE_ROWS.filter((row) =>
    packageAllowList.has(row.packageId) || packageAllowList.has(row.toolId)
  );
  const filteredRecords2 = executableBundledToolRecords(filteredRows2, {
    scope,
    sourceGeneration: `bundled-inventory:${BUNDLED_INVENTORY.release}`,
    closureGeneration: "task-execution-core",
  });
  assertEquals(filteredRecords2.length, 2);
  const names2 = filteredRecords2.map((r) => r.descriptorInput.toolId).sort();
  assertEquals(names2, ["awk_filter_bounded", "csvtool"]);

  // 4. Empty allowlist: zero tools
  const emptyRows = BUNDLED_TOOL_PACKAGE_ROWS.filter((row) => false);
  const emptyRecords = executableBundledToolRecords(emptyRows, {
    scope,
    sourceGeneration: `bundled-inventory:${BUNDLED_INVENTORY.release}`,
    closureGeneration: "task-execution-core",
  });
  assertEquals(emptyRecords.length, 0);
});

Deno.test("agent cards: export and import round-trip with tools configuration", () => {
  const agent = {
    name: "Specialist",
    role: "Focused worker",
    skills: ["page-summary"],
    tools: {
      webmcpOrigins: ["https://github.com", "https://gitlab.com"],
      bundledWasm: ["grep", "diff"],
    },
  };

  const exported = exportAgentCard(agent);
  assertEquals(exported.tools, {
    webmcpOrigins: ["https://github.com", "https://gitlab.com"],
    bundledWasm: ["grep", "diff"],
  });

  const imported = importAgentCard(exported);
  assert(imported.ok, "card imported successfully");
  assertEquals(imported.agent.tools, {
    webmcpOrigins: ["https://github.com", "https://gitlab.com"],
    bundledWasm: ["grep", "diff"],
  });

  // Malformed tools in card fails closed
  const invalidCard = {
    version: 1,
    name: "Bad",
    tools: "not-an-object",
  };
  const resBad = validateAgentCard(invalidCard);
  assert(!resBad.ok, "malformed tools rejected");
  assert(resBad.error.includes("tools must be an object"));
});

Deno.test("WebMCP origin allowlist filtering: enforces allowed origins and rejects unauthorized delegations", () => {
  const allOrigins = ["https://github.com", "https://linear.app", "https://notion.so"];
  
  // 1. Unrestricted agent (tools == null)
  const agentToolsNull = null;
  const allowedNull = agentToolsNull?.webmcpOrigins != null
    ? new Set(agentToolsNull.webmcpOrigins.map((o) => canonicalOrigin(o) || o.toLowerCase()))
    : null;
  const originsNull = allowedNull == null
    ? allOrigins
    : allOrigins.filter((o) => allowedNull.has(o) || allowedNull.has(canonicalOrigin(o)));
  assertEquals(originsNull, allOrigins, "unrestricted agent sees all enrolled origins");

  // 2. Restricted agent (webmcpOrigins = ["https://github.com"])
  const agentToolsGithub = { webmcpOrigins: ["https://github.com"] };
  const allowedGithub = new Set(agentToolsGithub.webmcpOrigins.map((o) => canonicalOrigin(o) || o.toLowerCase()));
  const originsGithub = allOrigins.filter((o) => allowedGithub.has(o) || allowedGithub.has(canonicalOrigin(o)));
  assertEquals(originsGithub, ["https://github.com"], "restricted agent sees only allowed origins");

  // 3. Delegation guard simulation
  const checkDelegate = (origin, allowedSet) => {
    if (allowedSet != null && !allowedSet.has(origin) && !allowedSet.has(canonicalOrigin(origin))) {
      return { ok: false, error: `origin ${origin} is not in this agent's WebMCP origin allow-list` };
    }
    return { ok: true };
  };

  assertEquals(checkDelegate("https://github.com", allowedGithub), { ok: true });
  const linearRes = checkDelegate("https://linear.app", allowedGithub);
  assertEquals(linearRes.ok, false);
  assert(linearRes.error.includes("not in this agent's WebMCP origin allow-list"));

  // 4. Empty allowlist (webmcpOrigins = [])
  const agentToolsEmpty = { webmcpOrigins: [] };
  const allowedEmpty = new Set(agentToolsEmpty.webmcpOrigins.map((o) => canonicalOrigin(o) || o.toLowerCase()));
  const originsEmpty = allOrigins.filter((o) => allowedEmpty.has(o) || allowedEmpty.has(canonicalOrigin(o)));
  assertEquals(originsEmpty.length, 0, "agent with empty webmcpOrigins sees zero site origins");
  const githubDenied = checkDelegate("https://github.com", allowedEmpty);
  assertEquals(githubDenied.ok, false);
});

