// @ts-nocheck
// tests/agent-permission-resume.test.ts — CAP-FB-20260901-APPROVAL-RESUME-REEXECUTES-01.
//
// After the owner clicks Allow on the in-chat permission card, the RUNTIME
// re-runs the paused tool call with its ORIGINAL arguments and hands the model
// that tool's real result — the model never learns a pause happened, never
// reads a "retry with a fresh search_tools selection" instruction, and a
// sibling call issued in the same model step is not invalidated by the grant.
//
// The scenario is the real one: a grant changes the permission/grant digests
// of every live tool record, which changes every stableId and therefore the
// catalog generation, so the old selection references stop resolving while
// calls are still in flight. The fake source below reproduces exactly that
// (its grant digest flips when the owner approves).

import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { tool } from "ai";
import { z } from "zod";
import { createAgent } from "../extension/lib/agent.js";
import { createLocalAssistant } from "../extension/lib/models/local-assistant.js";
import { executableBrowserToolRecords } from "../extension/lib/lazy-tool-protocol.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

function __reset() { resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); clearRunFence(); }

const store = new Map();
const clone = (v: unknown) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
(globalThis as any).chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key: string | string[]) => {
        const out: Record<string, unknown> = {};
        for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = clone(store.get(k));
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) { if (v === undefined) store.delete(k); else store.set(k, clone(v)); }
      },
      remove: async (keys: string | string[]) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
    },
  },
};

function fakeMemory() {
  const m = new Map();
  return {
    async get(key: string) { return m.has(key) ? m.get(key) : undefined; },
    async has(key: string) { return m.has(key); },
    async set(key: string, value: unknown) { m.set(key, value); return value; },
    async list() { return [...m.keys()].map((key) => ({ key, value: m.get(key) })); },
    async keys() { return [...m.keys()]; },
  };
}

const TABS = [
  { id: 12, title: "MDN Fetch", url: "https://developer.mozilla.org/en-US/docs/Web/API/fetch" },
  { id: 13, title: "MDN Streams", url: "https://developer.mozilla.org/en-US/docs/Web/API/Streams_API" },
  { id: 14, title: "Example", url: "https://example.com/" },
];
const HUB_SCOPE = { hub: true, agentId: "hub", origin: "", documentId: "" };

/** A run of the keyless assistant's "group my tabs" plan over a fake browser
 * tool source whose grant digest flips when the owner approves. `decision` is
 * what the owner's card returns. Returns every progress event, the model-facing
 * tool outputs the assistant received, the per-tool call counts and the text. */
async function runGroupTabs(decision: "approved" | "denied") {
  __reset();
  store.clear();
  let granted = false;
  const calls = { list_tabs: 0, group_tabs: 0, create_asset: 0 };
  // The sibling's dispatch parks until the owner has decided, so its
  // after-dispatch revalidation runs against the post-grant catalog — the
  // production race the demo hit (the grant landed ~500 ms before the
  // sibling's after-check and its result was discarded as scope-mismatch).
  let releaseSibling: () => void = () => {};
  const siblingGate = new Promise<void>((r) => { releaseSibling = r; });
  const tools = {
    list_tabs: tool({
      description: "List open tabs",
      inputSchema: z.object({}).strict(),
      execute: async () => { calls.list_tabs++; return { tabs: TABS }; },
    }),
    group_tabs: tool({
      description: "Group the given tabs into a new tab group",
      inputSchema: z.object({ tabIds: z.array(z.number()), title: z.string().optional(), color: z.string().optional() }),
      execute: async ({ tabIds }) => {
        calls.group_tabs++;
        if (!granted) {
          return {
            error: "browser control not granted",
            waitingForPermission: true,
            permissionRequirement: { reason: "group your tabs", permissions: [], grantOrigins: ["https://developer.mozilla.org"], grantGlobal: false },
          };
        }
        return { ok: true, groupId: 7, tabIds };
      },
    }),
    create_asset: tool({
      description: "Create an artifact",
      inputSchema: z.object({ origin: z.string(), type: z.string(), key: z.string().optional(), name: z.string(), content: z.string() }),
      execute: async ({ name }) => {
        calls.create_asset++;
        await siblingGate;
        return { ok: true, id: "a_1", name };
      },
    }),
  };
  // Production-length digests (sha256 hex) and generations: the tool identity
  // the runtime re-keys by is several hundred bytes long, and a fence that
  // truncated it once made every sibling read as source-stale.
  const grantDigest = () => (granted ? "b".repeat(64) : "a".repeat(64));
  const readLazySources = async () => executableBrowserToolRecords(tools, {
    version: "1.0.0",
    sourceGeneration: "extension:0.2.610:orchestrator:1",
    closureGeneration: "extension:0.2.610:orchestrator:1:browser:full",
    packageDigest: "c".repeat(64),
    permissionDigest: "none",
    grantDigest: grantDigest(),
    scope: HUB_SCOPE,
    capabilities: ["browser.tabs"],
    authorizationGuard: async () => ({ ok: true, permissionDigest: "none", grantDigest: grantDigest() }),
  });
  const modelOutputs: string[] = [];
  const assistant = createLocalAssistant();
  const model = {
    ...assistant,
    doStream(options) {
      for (const m of options.prompt ?? []) {
        if (m?.role !== "tool") continue;
        for (const part of m.content ?? []) modelOutputs.push(JSON.stringify(part.output ?? part));
      }
      return assistant.doStream(options);
    },
  };
  const events: any[] = [];
  const denials: any[] = [];
  const agent = createAgent({
    model: { model, modelId: "local-assistant", providerName: "local" },
    id: "hub",
    name: "hub",
    memory: fakeMemory(),
    taskId: `resume-${Math.random().toString(36).slice(2, 8)}`,
    readLazySources,
    onProgress: (e: any) => events.push(e),
    onPermissionRequest: async (denial: any) => {
      denials.push(denial);
      if (decision === "approved") granted = true;
      releaseSibling();
      return decision;
    },
  });
  const text = await agent.run("group my tabs by topic");
  releaseSibling();
  return { events, modelOutputs, calls, denials, text: String(text) };
}

Deno.test("approval resume: after Allow the runtime re-runs the paused call with its original arguments and the model receives the tool's real result", async () => {
  const { events, modelOutputs, calls, denials, text } = await runGroupTabs("approved");
  assertEquals(denials.length, 1, "exactly one permission pause");
  // The paused call ran again INSIDE the runtime: denied once, then re-run.
  assertEquals(calls.group_tabs, 2, "group_tabs: denied once, then re-executed by the runtime");
  const paused = events.find((e) => e.type === "tool-result" && e.permissionDecision === "approved");
  assert(paused, "the tool-result event still records the approved requirement");
  assertEquals(paused.reexecuted, true, "the event marks the approved-then-ran outcome");
  assertEquals(paused.ok, true, "the event's outcome is the re-executed tool's success");
  assertEquals(paused.selectedTool, "group_tabs");
  assertStringIncludes(String(paused.result), "groupId", "the event carries the tool's real result");
  // The model was told the real result, never the protocol's retry sentence.
  const joined = modelOutputs.join("\n");
  assert(!joined.includes("search_tools selection"), `the model must not be told to search again: ${joined.slice(0, 400)}`);
  assert(!/Retry group_tabs/u.test(joined), "no retry instruction reaches the model");
  assert(!joined.includes("did not run"), "no 'did not run' error reaches the model");
  assert(/groupId\\?":7/u.test(joined), "the model received the tool's real result");
  // No second search for the tool: the model never had to re-select it.
  const groupSearches = events.filter((e) => e.type === "tool-call" && e.toolName === "search_tools" && e.toolArgs?.query === "group_tabs");
  assertEquals(groupSearches.length, 1, "one search for group_tabs — the approval never forced a fresh selection");
  // The sibling issued in the same step (its ref pre-dates the grant) completed.
  assertEquals(calls.create_asset, 1);
  const sibling = events.find((e) => e.type === "tool-result" && e.selectedTool === "create_asset");
  assert(sibling, "the sibling's result event exists");
  assertEquals(sibling.ok, true, `the sibling is not invalidated by the pause: ${String(sibling.result)}`);
  assert(!text.includes("could not be saved"), `the answer reports the artifact: ${text}`);
  assert(!/selection-|search_tools/u.test(text), "no protocol vocabulary in the answer");
});

Deno.test("approval resume: a denial keeps its terminal sentence and the call is never executed", async () => {
  const { events, modelOutputs, calls } = await runGroupTabs("denied");
  assertEquals(calls.group_tabs, 1, "a denied call is never re-run");
  const denied = events.find((e) => e.type === "tool-result" && e.permissionDecision === "denied");
  assert(denied, "the denied requirement rides on the event");
  assert(denied.reexecuted !== true);
  assertEquals(denied.ok, false);
  assertStringIncludes(modelOutputs.join("\n"), "Owner denied the requested capability. group_tabs was not performed; do not retry it.");
});
