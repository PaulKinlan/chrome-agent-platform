// Unit tests for the continuation-fidelity slice (CAP 2026-08-30): the
// terminal thread row journals a compact per-run tool summary + the resolved
// skill ids + the composed-prompt hash, historyFromThread renders the tool
// summary into the assistant turn the model sees on resume, and continueThread
// re-applies the journaled skills. Falsification-gated: each assertion is RED
// when its mechanism is reverted (see the falsification notes in each test).
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  boundSkillIds,
  boundToolCalls,
  commitThreadTerminal,
  continueThread,
  createThread,
  getThread,
  historyFromThread,
  threadJournaledSkills,
  toolCallsPrefix,
} from "../extension/lib/threads.js";

// ---- minimal in-memory OPFS fake (same shape as tests/threads.test.ts) ----
function dirNode() {
  return { kind: "directory", children: new Map() };
}
function fileNode(content) {
  return { kind: "file", content };
}
class FakeWritable {
  constructor(node) {
    this.node = node;
    this.parts = [];
  }
  async write(s) {
    this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s));
  }
  async close() {
    this.node.content = this.parts.join("");
  }
}
class FakeFileHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "file";
  }
  async getFile() {
    const node = this.node;
    return {
      size: (node.content ?? "").length,
      async text() {
        return node.content ?? "";
      },
    };
  }
  async createWritable() {
    return new FakeWritable(this.node);
  }
}
class FakeDirHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "directory";
  }
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
  async removeEntry(name, opts = {}) {
    this.node.children.delete(name);
  }
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

// ---- pure bound helpers ----

Deno.test("boundToolCalls caps at 16, truncates names, drops empty, keeps newest", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}`, ok: i % 2 === 0 }));
  const bounded = boundToolCalls(many);
  assertEquals(bounded.length, 16, "17th+ dropped");
  assertEquals(bounded[0].name, "tool_4", "newest kept (oldest shifted off)");
  assertEquals(bounded[15].name, "tool_19");

  const long = boundToolCalls([{ name: "x".repeat(100), ok: true }]);
  assertEquals(long[0].name.length, 64, "oversized name truncated");

  assertEquals(boundToolCalls([{ name: "", ok: true }, { name: "ok-tool", ok: false }]).length, 1);
  assertEquals(boundToolCalls(null), [], "null input -> []");
  // Falsification: boundToolCalls no-oping (returning input verbatim) makes the
  // cap assertions RED.
});

Deno.test("boundSkillIds dedupes, caps at 24, keeps newest", () => {
  const many = Array.from({ length: 30 }, (_, i) => `skill-${i}`);
  const bounded = boundSkillIds([...many, ...many]);
  assertEquals(bounded.length, 24, "24 cap");
  assertEquals(bounded[0], "skill-6", "newest kept after dedupe shift");
  assertEquals(new Set(bounded).size, bounded.length, "no dups");
  assertEquals(boundSkillIds([""]).length, 0, "empty dropped");
  assertEquals(boundSkillIds(null), [], "null -> []");
});

Deno.test("toolCallsPrefix renders compact [tools: name(ok|failed)] only when calls exist", () => {
  assertEquals(toolCallsPrefix([]), "", "no calls -> no prefix");
  assertEquals(toolCallsPrefix(null), "");
  assertEquals(
    toolCallsPrefix([{ name: "screenshot", ok: true }, { name: "click", ok: false }]),
    "[tools: screenshot(ok), click(failed)]",
    "names + outcomes only, never args/results",
  );
  // Falsification: a prefix that embedded results (or no prefix at all) breaks
  // the exact-string assertion.
});

// ---- journaling on terminal commit ----

Deno.test("commitThreadTerminal journals toolCalls/skills/promptHash on the assistant row", async () => {
  const t = await createThread("Do the thing");
  const id = t.id;

  await commitThreadTerminal(id, "exec_1", {
    role: "assistant",
    content: "Done.",
    toolCalls: [{ name: "screenshot", ok: true }, { name: "click", ok: false }, { name: "", ok: true }],
    skills: ["reader-mode", "reader-mode", "writer"],
    promptHash: "aabbccddeeff00112233445566778899",
  });

  const thread = await getThread(id);
  const terminal = thread.messages[thread.messages.length - 1];
  assertEquals(terminal.role, "assistant");
  assertEquals(terminal.toolCalls, [{ name: "screenshot", ok: true }, { name: "click", ok: false }], "toolCalls journaled, empty name dropped");
  assertEquals(terminal.skills, ["reader-mode", "writer"], "skills journaled + deduped");
  assertEquals(terminal.promptHash, "aabbccddeeff0011", "promptHash bounded to 16 chars");
  // Falsification: dropping the toolCalls/skills/promptHash spread on the
  // pushed row makes these assertions RED (undefined).
});

Deno.test("commitThreadTerminal journals NO toolCalls/skills on an error row", async () => {
  const t = await createThread("Try something");
  const id = t.id;
  await commitThreadTerminal(id, "exec_err", {
    role: "error",
    content: "failed",
    toolCalls: [{ name: "screenshot", ok: true }],
    skills: ["reader-mode"],
    promptHash: "aabbccddeeff0011",
  });
  const thread = await getThread(id);
  const terminal = thread.messages[thread.messages.length - 1];
  assertEquals(terminal.role, "error");
  assertEquals(terminal.toolCalls, undefined, "error rows carry no tool summary");
  assertEquals(terminal.skills, undefined);
  assertEquals(terminal.promptHash, undefined);
});

// ---- replay into model history ----

Deno.test("historyFromThread renders the tool prefix into the assistant turn", async () => {
  const t = await createThread("First question");
  const id = t.id;
  await commitThreadTerminal(id, "exec_1", {
    role: "assistant",
    content: "First answer",
    toolCalls: [{ name: "screenshot", ok: true }],
    skills: ["reader-mode"],
    promptHash: "aabbccddeeff0011",
  });

  const cont = await continueThread(id, "Second question", []);
  const history = cont.history;
  assertEquals(history.length, 2, "user + assistant prior turns");
  assertEquals(history[0], { role: "user", content: "First question" });
  assertEquals(
    history[1].content,
    "[tools: screenshot(ok)]\nFirst answer",
    "assistant turn carries the compact tool summary",
  );
  // Falsification: historyFromThread returning the raw content (no prefix)
  // makes the exact-content assertion RED.
});

Deno.test("continueThread returns journaled skills union for re-application", async () => {
  const t = await createThread("Turn one");
  const id = t.id;
  await commitThreadTerminal(id, "exec_1", {
    role: "assistant",
    content: "Answer one",
    skills: ["reader-mode"],
    promptHash: "aabbccddeeff0011",
  });
  const cont1 = await continueThread(id, "Turn two", []);
  assertEquals(cont1.skills, ["reader-mode"], "skills from terminal row surfaced");
  await commitThreadTerminal(id, "exec_2", {
    role: "assistant",
    content: "Answer two",
    skills: ["writer", "reader-mode"],
    promptHash: "bbccddeeff001122",
  });
  const cont2 = await continueThread(id, "Turn three", []);
  assertEquals(cont2.skills, ["writer", "reader-mode"], "union across terminal rows, deduped");
  // Falsification: continueThread not returning `skills` makes cont.skills
  // undefined -> RED.
});

Deno.test("threadJournaledSkills unions across terminal rows and drops empties", async () => {
  const t = await createThread("One");
  const id = t.id;
  await commitThreadTerminal(id, "exec_1", { role: "assistant", content: "A", skills: ["a"] });
  await continueThread(id, "Two", []);
  await commitThreadTerminal(id, "exec_2", { role: "assistant", content: "B", skills: ["b", "a"] });
  const union = threadJournaledSkills((await getThread(id)));
  assertEquals(union, ["b", "a"], "union, deduped, newest first");
});
