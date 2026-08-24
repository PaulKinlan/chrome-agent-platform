// @ts-nocheck — the OPFS fake is intentionally dynamic.
// tests/task-agent-boundary.test.ts — CAP-FB-20260824-TASK-AGENT-BOUNDARY-01:
// (1) THE DISAPPEARING TASK: an @mention on a new task must create a thread
// that appears in the task list (previously the composer abandoned the thread
// and routed directly to the agent — no thread was ever created).
// (2) THE TASK↔AGENT BOUNDARY: the mention delegates to the agent (its own
// sandbox) and the result is committed BACK into the SAME task thread —
// the task never becomes the agent's own conversation.
import { assert, assertEquals } from "jsr:@std/assert@1";

function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable { constructor(n) { this.node = n; this.parts = []; } async write(s) { this.parts.push(String(s)); } async close() { this.node.content = this.parts.join(""); } }
class FakeFileHandle { constructor(n) { this.node = n; } get kind() { return "file"; } async getFile() { const n = this.node; return { size: (n.content ?? "").length, async text() { return n.content ?? ""; } }; } async createWritable() { return new FakeWritable(this.node); } }
class FakeDirHandle { constructor(n) { this.node = n; } get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no dir ${name}`); this.node.children.set(name, dirNode()); } return new FakeDirHandle(this.node.children.get(name)); }
  async getFileHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no file ${name}`); this.node.children.set(name, fileNode("")); } return new FakeFileHandle(this.node.children.get(name)); }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() { for (const [name, node] of this.node.children) yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; } }
const root = dirNode();
Object.defineProperty(globalThis, "navigator", { value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } }, configurable: true, writable: true });

import { appendThreadMessage, commitThreadTerminal, continueThread, createThread, getThread, listThreads } from "../extension/lib/threads.js";
import { projectThreadMessages } from "../extension/shared/conversation.js";

Deno.test("boundary: a mentioned task PERSISTS — thread created, listed, and re-openable (the disappearing-task fix)", async () => {
  // The exact write sequence the fixed agent.run mention path performs:
  // createThread (the user row) → delegation → durable commitThreadTerminal.
  const thread = await createThread("book a table for 4", []);
  assert(thread?.id, "a thread is created for the mentioned task");
  const listed = await listThreads();
  assert(listed.some((r) => r.id === thread.id), "the mentioned task APPEARS in the task list");
  // The delegation result commits back into the SAME thread.
  await commitThreadTerminal(thread.id, "exec-mention-1", { role: "assistant", content: "Table for 4 booked at 19:00." });
  const reopened = await getThread(thread.id);
  const bubbles = projectThreadMessages(reopened);
  assertEquals(bubbles.map((b) => b.role), ["user", "assistant"], "reopen renders the owner request + the agent's result");
  assertEquals(bubbles[1].content, "Table for 4 booked at 19:00.");
  const after = await listThreads();
  const row = after.find((r) => r.id === thread.id);
  assertEquals(row?.status, "done", "the task closes done, not stuck running");
});

Deno.test("boundary: a mention FOLLOW-UP continues the SAME thread (the task stays the hub's task)", async () => {
  const thread = await createThread("plan dinner", []);
  await commitThreadTerminal(thread.id, "exec-a", { role: "assistant", content: "Where?" });
  // A follow-up that references an agent: continueThread appends the nudge to
  // the SAME thread; the delegation result commits back into it.
  const cont = await continueThread(thread.id, "@le-petit-bistro book us in", []);
  assertEquals(cont.thread?.id, thread.id, "the follow-up continues the same thread");
  await commitThreadTerminal(thread.id, "exec-b", { role: "assistant", content: "Booked for two." });
  const reopened = await getThread(thread.id);
  const bubbles = projectThreadMessages(reopened);
  assertEquals(bubbles.map((b) => b.role), ["user", "assistant", "user", "assistant"]);
  assertEquals(bubbles[2].content, "@le-petit-bistro book us in");
  assertEquals(bubbles[3].content, "Booked for two.");
});

Deno.test("boundary: the terminal commit is idempotent by executionId (durable outbox replay cannot duplicate or flip the outcome)", async () => {
  const thread = await createThread("mention idempotency", []);
  await commitThreadTerminal(thread.id, "exec-idem", { role: "assistant", content: "first wins" });
  await commitThreadTerminal(thread.id, "exec-idem", { role: "error", content: "conflicting replay" });
  const reopened = await getThread(thread.id);
  const terminals = reopened.messages.filter((m) => m.executionId === "exec-idem");
  assertEquals(terminals.length, 1, "one terminal row per execution");
  assertEquals(terminals[0].role, "assistant");
  assertEquals(terminals[0].content, "first wins");
});

Deno.test("boundary: a pre-admission delegation refusal commits an ERROR terminal (never stuck running)", async () => {
  const thread = await createThread("mention a ghost agent", []);
  // The SW fallback: handler returned ok:false WITHOUT an executionId.
  await commitThreadTerminal(thread.id, `mention-refusal:${thread.id}:x`, {
    role: "error", content: "no agent ghost", category: "error",
  });
  const reopened = await getThread(thread.id);
  assertEquals(reopened.status, "error");
  const bubbles = projectThreadMessages(reopened);
  assertEquals(bubbles.map((b) => b.role), ["user", "error"]);
});

Deno.test("boundary WIRING (source pins): the composer keeps the hub task; the SW threads the mention end-to-end", async () => {
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const conv = await Deno.readTextFile(new URL("../extension/shared/conversation.js", import.meta.url));
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const chat = await Deno.readTextFile(new URL("../extension/chat/chat.js", import.meta.url));

  // (1) The hub composer no longer abandons the thread for a mention.
  const composerSend = ntp.split('composer.addEventListener("send"')[1] ?? "";
  assert(composerSend.includes('runThreadTurn(task, attachments, { kind: agent.kind, id: agent.id, name: agent.name })'),
    "the composer runs the mention as a HUB TASK");
  assert(!composerSend.split("threadComposer.addEventListener")[0].includes("openAgentSurface({ kind: agent.kind"),
    "the composer NEVER switches to the agent's surface for a mention");
  // The task-thread follow-up composer delegates within the same thread.
  assert(ntp.includes('if (agent?.ref && !currentAgentKind)'), "a task follow-up mention stays in the thread");

  // (2) conversation.js routes a mention through agent.run (the thread route),
  // NEVER the direct agent-kind routes (those remain for the agent-chat surface).
  const mentionIdx = conv.indexOf("if (mention?.id) {");
  const siteIdx = conv.indexOf('agentKind === "site"');
  assert(mentionIdx > 0 && mentionIdx < siteIdx, "the mention branch precedes the agent-chat branches");
  assert(conv.includes('mention: { kind: mention.kind ?? null, id: mention.id, name: mention.name ?? mention.id }'));

  // (3) The SW: agent.run dispatches the mention to the delegation handlers
  // WITH the threadId; the delegation routes carry threadId into their durable
  // admission (so the outbox commits the terminal into the thread, crash-safe);
  // both resume replays restore threadId.
  assert(sw.includes("m.mention") && sw.includes('handlers["agent.delegate"]({ origin: mention.id, task: m.task, threadId })'),
    "agent.run dispatches a site mention with the threadId");
  assert(sw.includes('async "agent.delegate"({ origin, task, threadId = null'), "agent.delegate accepts threadId");
  assert(sw.includes('async "named-agent.run"({ id, task, attachments, runId, threadId = null'), "named-agent.run accepts threadId");
  assert(sw.includes('async "background-agent.run"({ id, task, attachments, runId, threadId = null'), "background-agent.run accepts threadId");
  const threadIdAdmission = sw.match(/kind: "delegate",[\s\S]{0,400}?threadId: threadId \?\? null/);
  assert(threadIdAdmission, "the delegate durable admission carries threadId (outbox → thread terminal)");
  assert(sw.includes("resumeRouteArgs: { id, runId: runTag, threadId: threadId ?? null }"), "named/background resume args carry threadId");
  assertEquals((sw.match(/threadId: request.threadId \?\? null/g) ?? []).length, 2, "BOTH resume replay sites restore threadId");
  // The pre-admission refusal fallback (never stuck running).
  assert(sw.includes("mention-refusal:") && sw.includes("commitThreadTerminal(threadId,"), "a pre-admission refusal commits an error terminal");

  // (4) chat.js: a mention keeps the thread (the old strand line is gone).
  assert(chat.includes("mention: agent?.ref ? { kind: agent.kind"), "chat routes a mention as a delegation");
  assert(!chat.includes("threadId: agent?.ref ? null"), "chat no longer strands mentioned tasks");
});

Deno.test("boundary WIRING on the BROKEN shape (the pins discriminate): the old abandon-the-thread pattern is absent", async () => {
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  // The exact pre-fix composer pattern: switch to the agent's surface, THEN run
  // (threadId null → no thread → the disappearing task).
  assert(!ntp.includes("await openAgentSurface({ kind: agent.kind, id: agent.id, name: agent.name });\n    await runThreadTurn(task, attachments);"),
    "the abandon-the-thread composer pattern is gone");
});
