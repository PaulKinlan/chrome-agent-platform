// tests/hub-run-ux.test.ts — falsification tests for chrome-agent-platform-d885.6
// [CAP-FB-20260928-HUB-RUN-UX-01] Fix Hub starter chips on keyless/NTP profiles,
// mid-run Queue/Steer with attachments, slide-over Settings routing,
// boot RPC deduplication, and private workspace file list.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { providerReadyForFirstTask } from "../extension/lib/first-run-onboarding.js";
import {
  createRunControl,
  createThreadQueue,
} from "../extension/lib/run-control.js";
import {
  measureWorkspace,
  getWorkspaceUsageByKey,
  writeWorkspaceFile,
} from "../extension/lib/agent-workspace.js";

const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));

// ── Part A: Local keyless provider onboarding readiness ───────────────────
Deno.test("d885.6 Part A: providerReadyForFirstTask allows configured ollama and lm-studio", () => {
  // Demo and prompt-api are never ready for first task.
  assertEquals(providerReadyForFirstTask({ provider: "demo" }), false);
  assertEquals(providerReadyForFirstTask({ provider: "prompt-api" }), false);

  // Unconfigured ollama / lm-studio is false.
  assertEquals(providerReadyForFirstTask({ provider: "ollama" }), false);
  assertEquals(providerReadyForFirstTask({ provider: "lm-studio" }), false);

  // Configured or model-holding / tested ollama / lm-studio is ready.
  assertEquals(providerReadyForFirstTask({ provider: "ollama", configured: true }), true);
  assertEquals(providerReadyForFirstTask({ provider: "lm-studio", configured: true }), true);
  assertEquals(providerReadyForFirstTask({ selectedProvider: "ollama", model: "llama3" }), true);
  assertEquals(providerReadyForFirstTask({ selectedProvider: "lm-studio", tested: true }), true);

  // Keyed providers still require apiKey and model.
  assertEquals(providerReadyForFirstTask({ provider: "openai", hasApiKey: false, model: "gpt-4" }), false);
  assertEquals(providerReadyForFirstTask({ provider: "openai", hasApiKey: true, model: "gpt-4" }), true);
});

// ── Part B: Hub starter chip routing on chrome-extension pages ────────────
Deno.test("d885.6 Part B: starter chips on Hub rewrite Summarise this page and Watch this price", () => {
  assert(
    ntpJs.includes('text.toLowerCase() === "summarise this page"'),
    "ntp.js must detect 'Summarise this page' chip click",
  );
  assert(
    ntpJs.includes('composer.value = "Summarise my open tabs"') ||
    ntpJs.includes("composer.value = `Summarise ${target.url}`"),
    "ntp.js must rewrite Summarise this page when on the Hub",
  );
  assert(
    ntpJs.includes('text.toLowerCase() === "watch this price"'),
    "ntp.js must detect 'Watch this price' chip click",
  );
});

// ── Part C: #provider-status & fix-settings slide-over routing + refresh ──
Deno.test("d885.6 Part C: provider-status and fix-settings route to options slide-over and refresh on visibility/storage", () => {
  assert(
    ntpJs.includes('openView("options/options.html#providers", "Provider settings"'),
    "provider-status and fix-settings must open options/options.html#providers in-context",
  );
  assert(
    ntpJs.includes('"fix-settings"'),
    "ntp.js must handle fix-settings custom events",
  );
  assert(
    ntpJs.includes('"visibilitychange"') &&
    ntpJs.includes('renderProviderStatus()'),
    "ntp.js must refresh provider status on visibilitychange",
  );
  assert(
    ntpJs.includes('chrome.storage?.onChanged') &&
    ntpJs.includes('renderProviderStatus()'),
    "ntp.js must refresh provider status on storage changes",
  );
});

// ── Part D: Mid-run Queue / Send-now with attachments & agent ─────────────
Deno.test("d885.6 Part D: threadQueue preserves attachments and agent metadata", async () => {
  const store = {};
  const kvGet = async (k) => ({ [k]: store[k] });
  const kvSet = async (obj) => Object.assign(store, obj);
  const queue = createThreadQueue({ kvGet, kvSet });

  const enq = await queue.enqueue("thread-1", "Check this", {
    attachments: [{ name: "doc.txt", size: 12 }],
    agent: { id: "researcher", name: "Researcher", kind: "named" },
  });
  assertEquals(enq.ok, true);
  assertEquals(enq.item.text, "Check this");
  assertEquals(enq.item.attachments?.length, 1);
  assertEquals(enq.item.agent?.name, "Researcher");

  const head = await queue.claimHead("thread-1", "run-101");
  assertEquals(head.ok, true);
  assertEquals(head.item.attachments?.[0]?.name, "doc.txt");
  assertEquals(head.item.agent?.id, "researcher");

  // In ntp.js, enqueueTurn, queuedTurns, drainQueuedTurns, and sendNowAndStop exist
  assert(ntpJs.includes("export let queuedTurns = []"), "ntp.js must export queuedTurns");
  assert(ntpJs.includes("export async function enqueueTurn("), "ntp.js must export enqueueTurn");
  assert(ntpJs.includes("export async function drainQueuedTurns("), "ntp.js must export drainQueuedTurns");
  assert(ntpJs.includes("export async function sendNowAndStop("), "ntp.js must export sendNowAndStop");

  // In ntp.js, mid-run checks don't block turns with attachments or agent from runControlSend
  assert(!ntpJs.includes("liveSurfaceRun && !attachments?.length && !agent?.ref"), "runControlBar check must not reject attachments/agent");
});

// ── Part E: Cold-boot deduplication, ambient progress, & panelFrameFor ─────
Deno.test("d885.6 Part E: boot RPC deduplication, ambient progress filtering, and panelFrameFor basePath keying", () => {
  // Redundant renderBackgroundAgents() at boot must be gone
  const bootLines = ntpJs.slice(ntpJs.indexOf("renderNamedAgents();"), ntpJs.indexOf("renderTasks();"));
  assert(
    !bootLines.includes("renderBackgroundAgents();"),
    "redundant renderBackgroundAgents() must be removed from cold boot",
  );

  // Ambient progress must not scheduleRunLogRefresh on text or text-delta
  const ambientProgress = ntpJs.slice(ntpJs.indexOf("const subscribeAmbientProgress ="), ntpJs.indexOf("subscribeRunRegistry("));
  assert(
    !ambientProgress.includes('"text"'),
    "subscribeAmbientProgress must not schedule refresh on text progress",
  );

  // panelFrameFor keys by basePath
  assert(
    ntpJs.includes('const [basePath, hash] = String(path ?? "").split("#");'),
    "panelFrameFor and openView must parse basePath and hash",
  );
});

// ── Part F: Private workspace files list in usage ─────────────────────────
Deno.test("d885.6 Part F: measureWorkspace and getWorkspaceUsageByKey return files array", async () => {
  // In-memory OPFS mock for testing agent workspace
  function dirNode() { return { kind: "directory", children: new Map() }; }
  function fileNode(size = 0) { return { kind: "file", size }; }
  class MockFileHandle {
    constructor(node, name) { this.node = node; this.name = name; this.kind = "file"; }
    async getFile() { return { size: this.node.size, name: this.name }; }
  }
  class MockDirHandle {
    constructor(node, name = "") { this.node = node; this.name = name; this.kind = "directory"; }
    async *values() {
      for (const [name, child] of this.node.children) {
        if (child.kind === "file") yield new MockFileHandle(child, name);
        else yield new MockDirHandle(child, name);
      }
    }
  }

  const root = dirNode();
  root.children.set("file1.txt", fileNode(100));
  root.children.set("file2.json", fileNode(250));
  const dir = new MockDirHandle(root);

  const res = await measureWorkspace(dir, { collectFiles: true });
  assertEquals(res.filesUsed, 2);
  assertEquals(res.bytesUsed, 350);
  assertEquals(res.files.length, 2);
  assertEquals(res.files[0].path, "file1.txt");
  assertEquals(res.files[0].size, 100);

  // In ntp.js, #agent-workspace-usage renders the files
  assert(ntpJs.includes('wsUsage.id = "agent-workspace-usage"'), "agent workspace usage must have id agent-workspace-usage");
  assert(ntpJs.includes('wsFileList.className = "agent-workspace-files"'), "agent workspace file list container must be rendered");
});
