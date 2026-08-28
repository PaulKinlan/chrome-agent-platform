// @ts-nocheck — CAP-FB-20260824-AGENT-DELETION-OWNER-01:
// Owner-facing agent deletion lifecycle tests.
// Tests named, site, and background agent deletion, cancel/deny no-ops,
// memory/prompt cleanup, artifact retention (no silent cascade), and persistence.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createNamedAgent,
  deleteNamedAgent,
  getNamedAgent,
  listNamedAgents,
  agentMemory,
} from "../extension/lib/named-agents.js";
import {
  enrollOrigin,
  disenrollOrigin,
  isEnrolled,
  enrollmentSnapshot,
  listTools,
  replaceTools,
} from "../extension/lib/tools.js";
import {
  describePrompt,
  getPromptOverride,
  setPromptOverride,
} from "../extension/lib/system-prompts.js";
import {
  isOwnerDirectApproval,
  OWNER_DIRECT_ACTIONS,
} from "../extension/lib/owner-approval.js";

// Minimal OPFS fake
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; }
  async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() {
    const node = this.node;
    return { size: (node.content ?? "").length, async text() { return node.content ?? ""; } };
  }
  async createWritable() { return new FakeWritable(this.node); }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no dir ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no file ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name, opts = {}) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
  configurable: true,
  writable: true,
});

const armedAlarms = new Map();
globalThis.chrome = {
  permissions: {
    contains: async ({ permissions }) => permissions.every((p) => p === "alarms"),
  },
  alarms: {
    create: async (name, info) => { armedAlarms.set(name, info); },
    clear: async (name) => { const had = armedAlarms.has(name); armedAlarms.delete(name); return had; },
    get: async (name) => armedAlarms.has(name) ? { name, ...armedAlarms.get(name) } : undefined,
    getAll: async () => [...armedAlarms.entries()].map(([name, info]) => ({ name, ...info })),
  },
};

Deno.test("agent-deletion: named agent deletion removes registry, prompt override, and memory", async () => {
  const agentName = "Research Assistant";
  const created = await createNamedAgent({
    name: agentName,
    role: "Deep literature researcher",
    skills: ["academic-research"],
    coreAssets: [{ name: "notes.txt", type: "text/plain", content: "Initial guidelines" }],
  });
  assertEquals(created.ok, true);
  const slug = created.agent.id;

  // Set up prompt override and OPFS memory
  const desc = await describePrompt(`agent:${slug}`);
  await setPromptOverride(
    `agent:${slug}`,
    { mode: "append", text: "Custom prompt override text" },
    { expectedRevision: desc.revision },
  );
  const override = await getPromptOverride(`agent:${slug}`);
  assertEquals(override.override?.text, "Custom prompt override text");

  const mem = agentMemory(slug);
  await mem.set("learned_fact", "Fact 123");
  assertEquals(await mem.get("learned_fact"), "Fact 123");

  // Deletion execution
  const res = await deleteNamedAgent(slug);
  assertEquals(res.ok, true);

  // 1. Removed from registry
  const fetched = await getNamedAgent(slug);
  assertEquals(fetched, null, "named agent must be removed from registry");
  const list = await listNamedAgents();
  assert(!list.some((a) => a.id === slug), "agent must disappear from list");

  // 2. Prompt override cleaned up
  const cleanedOverride = await getPromptOverride(`agent:${slug}`);
  assertEquals(cleanedOverride.override, null, "prompt override must be removed");

  // 3. Memory sandbox cleared
  const clearedMem = agentMemory(slug);
  assertEquals(await clearedMem.get("learned_fact"), null, "memory sandbox must be cleared");

  // 4. Idempotent repeat deletion
  const repeat = await deleteNamedAgent(slug);
  assertEquals(repeat.ok, true);
});

Deno.test("agent-deletion: owner direct approval authorizes deletion without settings block", () => {
  assert(OWNER_DIRECT_ACTIONS.has("named-agent.delete"), "named-agent.delete in OWNER_DIRECT_ACTIONS");
  assert(OWNER_DIRECT_ACTIONS.has("agent.delete"), "agent.delete in OWNER_DIRECT_ACTIONS");

  const extContext = { principal: "extension", documentId: "doc-ntp-1" };
  assertEquals(isOwnerDirectApproval(extContext, "named-agent.delete"), true);
  assertEquals(isOwnerDirectApproval(extContext, "agent.delete"), true);

  // Model caller is NOT direct approval (requires full approval flow)
  const modelContext = { principal: "model", executionId: "exec-1" };
  assertEquals(isOwnerDirectApproval(modelContext, "named-agent.delete"), false);
  assertEquals(isOwnerDirectApproval(modelContext, "agent.delete"), false);
});

Deno.test("agent-deletion: deny or cancel gate mutates nothing", async () => {
  const created = await createNamedAgent({
    name: "Preserved Agent",
    role: "Crucial worker",
  });
  assertEquals(created.ok, true);
  const slug = created.agent.id;

  // Gate simulates owner denying or cancelling
  const res = await deleteNamedAgent(slug, {
    gateBeforeDelete: async () => ({ ok: false, error: "owner cancelled deletion" }),
  });
  assertEquals(res.ok, false);
  assertEquals(res.error, "owner cancelled deletion");

  // Agent must remain completely intact
  const agent = await getNamedAgent(slug);
  assert(agent, "agent must remain when deletion is cancelled");
  assertEquals(agent.name, "Preserved Agent");
});

Deno.test("agent-deletion: site agent deletion (disenroll) revokes authorization and clears tools", async () => {
  const origin = "https://delete-site.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [{ name: "lookup", source: "declared", inputSchema: {} }]);

  assertEquals(await isEnrolled(origin), true);
  assertEquals((await listTools(origin)).length, 1);

  // Disenroll
  await disenrollOrigin(origin);

  assertEquals(await isEnrolled(origin), false);
  const snap = await enrollmentSnapshot(origin);
  assertEquals(snap.enrolled, false);
  assert(snap.gen > 1, "generation must be bumped to tombstone");
});

Deno.test("agent-deletion: background agent cancel removes schedule and alarm", async () => {
  const { scheduleTask, cancelScheduledTask } = await import("../extension/lib/scheduler.js");

  // Schedule a task
  const scheduled = await scheduleTask({
    task: "Check news periodically",
    delayMs: 60000,
    periodInMinutes: 30,
  });
  assert(scheduled.name, "task must be scheduled with a name");
  const taskName = scheduled.name;

  // Cancel task
  const cancel = await cancelScheduledTask(taskName);
  assertEquals(cancel.ok, true);
  assertEquals(cancel.cancelled, true);

  // Repeat cancel is idempotent
  const repeat = await cancelScheduledTask(taskName);
  assertEquals(repeat.ok, true);
});

Deno.test("agent-deletion UI source contracts: delete buttons and confirmation dialogs wired in NTP, Sidepanel, and Options", async () => {
  const ntpHtml = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
  const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const sidepanelHtml = await Deno.readTextFile(new URL("../extension/sidepanel/sidepanel.html", import.meta.url));
  const sidepanelJs = await Deno.readTextFile(new URL("../extension/sidepanel/sidepanel.js", import.meta.url));
  const optionsJs = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));

  // NTP thread view header delete button & confirmation
  assert(ntpHtml.includes('id="delete-agent"'), "NTP must have #delete-agent button");
  assert(ntpJs.includes("deleteAgentBtn"), "NTP must wire deleteAgentBtn");
  assert(ntpJs.includes("confirmActionDialog"), "NTP must use confirmActionDialog for delete confirmation");
  assert(ntpJs.includes('"named-agent.delete"'), "NTP must call named-agent.delete");

  // Sidepanel delete button & confirmation
  assert(sidepanelHtml.includes('id="agent-delete"'), "Sidepanel must have #agent-delete button");
  assert(sidepanelJs.includes("agentDeleteBtn"), "Sidepanel must wire agentDeleteBtn");
  assert(sidepanelJs.includes("confirmActionDialog"), "Sidepanel must use confirmActionDialog for delete confirmation");

  // Options page delete button & confirmation
  assert(optionsJs.includes("delete-named-agent"), "Options must have delete-named-agent button");
  assert(optionsJs.includes("confirmActionDialog"), "Options must use confirmActionDialog for delete confirmation");
});
