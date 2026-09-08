// tests/skill-batch-import.test.ts — batch skill and command storage and indexing in OPFS/memory.
// @ts-nocheck
import { assertEquals, assertStringIncludes, assert } from "jsr:@std/assert@1";
import {
  installImportedCommand,
  removeImportedCommand,
  loadAllImportedCommands,
  installBatchSkillsAndCommands,
  installImportedSkill,
} from "../extension/lib/skill-import.js";

function fakeMemory() {
  const data = new Map();
  return {
    async get(k) { return data.get(k); },
    async set(k, v) { data.set(k, v); },
    _data: data,
  };
}

function fakeSkillFiles() {
  const files = new Map();
  return {
    async writeSkillFiles(id, map) {
      files.set(id, Object.fromEntries(Object.entries(map)));
      const totalBytes = Object.values(map).reduce(
        (n, v) => n + new TextEncoder().encode(String(v ?? "")).byteLength,
        0,
      );
      return { fileCount: Object.keys(map).length, totalBytes };
    },
    async removeSkillFiles(id) { files.delete(id); },
    async readSkillFile(id, path) {
      const f = files.get(id);
      if (!f || !(path in f)) throw new Error("NotFoundError");
      return f[path];
    },
    _files: files,
  };
}

Deno.test("installImportedCommand persists a command record in memory index", async () => {
  const mem = fakeMemory();
  const cmd = {
    id: "pm-ai-shipping-ship-check",
    name: "ship-check",
    description: "Turn a vibe-coded repo into a reviewer-ready shipping packet",
    argumentHint: "<repo path>",
    prompt: "# /ship-check -- Is This Safe to Ship?\nRun shipping sequence on $ARGUMENTS.",
    plugin: "pm-ai-shipping",
    category: "product-management",
  };

  const saved = await installImportedCommand(mem, cmd);
  assertEquals(saved.id, "pm-ai-shipping-ship-check");
  assertEquals(saved.name, "ship-check");
  assertEquals(saved.argumentHint, "<repo path>");
  assertEquals(saved.plugin, "pm-ai-shipping");
  assert(saved.importedAt > 0);

  const list = await loadAllImportedCommands(mem);
  assertEquals(list.length, 1);
  assertEquals(list[0].id, "pm-ai-shipping-ship-check");
  assertEquals(list[0].prompt, "# /ship-check -- Is This Safe to Ship?\nRun shipping sequence on $ARGUMENTS.");

  // Idempotent re-save updates existing row
  const updated = await installImportedCommand(mem, {
    ...cmd,
    description: "Updated description",
  });
  assertEquals(updated.description, "Updated description");
  const list2 = await loadAllImportedCommands(mem);
  assertEquals(list2.length, 1);
  assertEquals(list2[0].description, "Updated description");
});

Deno.test("removeImportedCommand deletes command by id", async () => {
  const mem = fakeMemory();
  await installImportedCommand(mem, { id: "cmd-1", name: "cmd-1", prompt: "prompt 1" });
  await installImportedCommand(mem, { id: "cmd-2", name: "cmd-2", prompt: "prompt 2" });

  let list = await loadAllImportedCommands(mem);
  assertEquals(list.length, 2);

  const removed = await removeImportedCommand(mem, "cmd-1");
  assertEquals(removed.ok, true);

  list = await loadAllImportedCommands(mem);
  assertEquals(list.length, 1);
  assertEquals(list[0].id, "cmd-2");

  const notFound = await removeImportedCommand(mem, "cmd-missing");
  assertEquals(notFound.ok, false);
});

Deno.test("installBatchSkillsAndCommands installs multiple skills and commands with OPFS bodies", async () => {
  const mem = fakeMemory();
  const fs = fakeSkillFiles();

  const skills = [
    {
      id: "plugin-skill-1",
      name: "skill-1",
      description: "First skill",
      files: {
        "SKILL.md": "---\nname: skill-1\n---\nBody of skill 1",
        "scripts/helper.py": "print('hello')",
      },
    },
    {
      id: "plugin-skill-2",
      name: "skill-2",
      description: "Second skill",
      files: {
        "SKILL.md": "---\nname: skill-2\n---\nBody of skill 2",
      },
    },
  ];

  const commands = [
    {
      id: "plugin-cmd-1",
      name: "cmd-1",
      description: "First command",
      argumentHint: "<arg>",
      prompt: "Execute cmd 1 on $ARGUMENTS",
    },
    {
      id: "plugin-cmd-2",
      name: "cmd-2",
      description: "Second command",
      prompt: "Execute cmd 2",
    },
  ];

  const result = await installBatchSkillsAndCommands(mem, { skills, commands }, fs);
  assertEquals(result.ok, true);
  assertEquals(result.skills.length, 2);
  assertEquals(result.commands.length, 2);
  assertEquals(result.errors.length, 0);

  // Verify memory indexes
  const savedSkills = (await mem.get("importedSkills")) ?? [];
  assertEquals(savedSkills.length, 2);
  assertEquals(savedSkills[0].id, "plugin-skill-1");
  assertEquals(savedSkills[1].id, "plugin-skill-2");

  const savedCommands = await loadAllImportedCommands(mem);
  assertEquals(savedCommands.length, 2);
  assertEquals(savedCommands[0].id, "plugin-cmd-1");
  assertEquals(savedCommands[1].id, "plugin-cmd-2");

  // Verify OPFS files written for multi-file skill
  const skill1Files = fs._files.get("plugin-skill-1");
  assert(skill1Files);
  assertEquals(skill1Files["SKILL.md"], "---\nname: skill-1\n---\nBody of skill 1");
  assertEquals(skill1Files["scripts/helper.py"], "print('hello')");
});

Deno.test("installBatchSkillsAndCommands fetches downloadUrl when files/prompt not provided", async () => {
  const mem = fakeMemory();
  const fs = fakeSkillFiles();

  const mockFetcher = async (url) => {
    if (url === "https://raw.githubusercontent.com/test/repo/main/skills/s1/SKILL.md") {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "40" }),
        arrayBuffer: async () => new TextEncoder().encode("---\nname: fetched-skill\n---\nSkill content").buffer,
      };
    }
    if (url === "https://raw.githubusercontent.com/test/repo/main/commands/c1.md") {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "45" }),
        arrayBuffer: async () => new TextEncoder().encode("---\nargument-hint: [file]\n---\nCommand template").buffer,
      };
    }
    return { ok: false, status: 404 };
  };

  const batch = {
    fetch: mockFetcher,
    skills: [
      {
        id: "repo-fetched-skill",
        name: "fetched-skill",
        downloadUrl: "https://raw.githubusercontent.com/test/repo/main/skills/s1/SKILL.md",
      },
    ],
    commands: [
      {
        id: "repo-fetched-cmd",
        name: "fetched-cmd",
        downloadUrl: "https://raw.githubusercontent.com/test/repo/main/commands/c1.md",
      },
    ],
  };

  const result = await installBatchSkillsAndCommands(mem, batch, fs);
  assertEquals(result.ok, true);
  assertEquals(result.skills.length, 1);
  assertEquals(result.commands.length, 1);
  assertEquals(result.skills[0].id, "repo-fetched-skill");
  assertEquals(result.commands[0].id, "repo-fetched-cmd");
  assertEquals(result.commands[0].argumentHint, "[file]");
  assertStringIncludes(result.commands[0].prompt, "Command template");
});

Deno.test("installBatchSkillsAndCommands handles partial failures with granular error reporting", async () => {
  const mem = fakeMemory();
  const fs = fakeSkillFiles();

  const mockFetcher = async (url) => {
    if (url === "https://example.com/ok-skill") {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new TextEncoder().encode("# Ok Skill").buffer,
      };
    }
    return { ok: false, status: 500 };
  };

  const batch = {
    fetch: mockFetcher,
    skills: [
      { id: "good-skill", name: "good", downloadUrl: "https://example.com/ok-skill" },
      { id: "bad-skill", name: "bad", downloadUrl: "https://example.com/fail-skill" },
    ],
    commands: [
      { id: "good-cmd", name: "good-cmd", prompt: "Hello" },
    ],
  };

  const result = await installBatchSkillsAndCommands(mem, batch, fs);
  assertEquals(result.ok, false);
  assertEquals(result.skills.length, 1);
  assertEquals(result.commands.length, 1);
  assertEquals(result.errors.length, 1);
  assertEquals(result.errors[0].id, "bad-skill");
  assertStringIncludes(result.errors[0].error, "500");
});

Deno.test("service-worker source declares skill.discover, skill.importBatch, command.list, command.delete", async () => {
  const sw = await Deno.readTextFile("extension/background/service-worker.js");
  assert(sw.includes('async "skill.discover"('), "sw declares skill.discover");
  assert(sw.includes('async "skill.importBatch"('), "sw declares skill.importBatch");
  assert(sw.includes('async "command.list"('), "sw declares command.list");
  assert(sw.includes('async "command.delete"('), "sw declares command.delete");
});
