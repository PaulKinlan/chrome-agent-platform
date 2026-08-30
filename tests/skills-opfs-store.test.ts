// skills-opfs-store.test.ts — CAP-FB-20260830-SKILLS-UNCAPPED-01: the OPFS
// skill-files store (bodies that exceed the memory store's 256KiB per-value
// bound live as real files under cap-skills/<id>/). The OPFS root is INJECTED
// (in-memory fake, the agent-opfs-teardown.test.ts pattern).
// @ts-nocheck — the OPFS handle shape is intentionally dynamic.
import { assertEquals, assertStringIncludes, assert } from "jsr:@std/assert@1";
import {
  writeSkillFiles,
  readSkillFile,
  removeSkillFiles,
  skillPathSegments,
  SKILL_FILE_BUDGET,
} from "../extension/lib/skill-files.js";

// ---- in-memory OPFS fake (pattern from tests/agent-opfs-teardown.test.ts) ----
const fs = new Map(); // "d:seg" → dir Map ; "f:seg" → { text }
function getDir(path) {
  let node = fs;
  for (const seg of path) {
    if (!node.has("d:" + seg)) node.set("d:" + seg, new Map());
    node = node.get("d:" + seg);
  }
  return node;
}
function dirHandle(node, name) {
  return {
    name,
    getDirectoryHandle: async (seg, { create } = {}) => {
      const key = "d:" + seg;
      if (!node.has(key)) {
        if (!create) throw Object.assign(new Error("missing " + seg), { name: "NotFoundError" });
        node.set(key, new Map());
      }
      return dirHandle(node.get(key), seg);
    },
    getFileHandle: async (seg, { create } = {}) => {
      const key = "f:" + seg;
      if (!node.has(key)) {
        if (!create) throw Object.assign(new Error("missing " + seg), { name: "NotFoundError" });
        node.set(key, { text: "" });
      }
      const rec = node.get(key);
      return {
        getFile: async () => ({ text: async () => rec.text, size: new TextEncoder().encode(rec.text).length }),
        createWritable: async () => ({
          write: async (s) => { rec.text = new TextDecoder().decode(s); },
          close: async () => {},
        }),
      };
    },
    removeEntry: async (seg) => {
      node.delete("d:" + seg);
      node.delete("f:" + seg);
    },
  };
}
function rootHandle() {
  return {
    name: "/",
    getDirectoryHandle: async (seg, { create } = {}) => {
      if (!create && !fs.has("d:" + seg)) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return dirHandle(getDir([seg]), seg);
    },
    removeEntry: async (seg) => {
      fs.delete("d:" + seg);
      fs.delete("f:" + seg);
    },
  };
}
const getDirectory = async () => rootHandle();

Deno.test("skillPathSegments rejects traversal, absolute paths, backslashes, NUL", () => {
  assertEquals(skillPathSegments("SKILL.md"), ["SKILL.md"]);
  assertEquals(skillPathSegments("scripts/run.sh"), ["scripts", "run.sh"]);
  assertEquals(skillPathSegments("../etc/passwd"), null);
  assertEquals(skillPathSegments("/etc/passwd"), null);
  assertEquals(skillPathSegments("a\\b"), null);
  assertEquals(skillPathSegments("a\u0000b"), null);
  assertEquals(skillPathSegments(""), null);
  assertEquals(skillPathSegments("a//b"), null);
});

Deno.test("writeSkillFiles + readSkillFile round-trip a multi-file skill (incl. a >256KiB body)", async () => {
  const big = "# Big\n\n" + "lorem ipsum dolor sit amet\n".repeat(20000); // ~560KiB — over the memory value bound
  assert(big.length > 256 * 1024, "fixture must exceed the memory 256KiB per-value bound");
  const { fileCount, totalBytes } = await writeSkillFiles("big-skill", {
    "SKILL.md": big,
    "scripts/run.sh": "#!/bin/sh\necho hi\n",
    "references/guide.md": "# Reference\n\nDetails\n",
  }, { getDirectory });
  assertEquals(fileCount, 3);
  assert(totalBytes > 256 * 1024);
  const readBack = await readSkillFile("big-skill", "SKILL.md", { getDirectory });
  assertEquals(readBack, big);
  assertEquals(await readSkillFile("big-skill", "scripts/run.sh", { getDirectory }), "#!/bin/sh\necho hi\n");
  assertEquals(await readSkillFile("big-skill", "references/guide.md", { getDirectory }), "# Reference\n\nDetails\n");
});

Deno.test("writeSkillFiles rejects an unsafe path BEFORE writing anything", async () => {
  let threw = null;
  try {
    await writeSkillFiles("x", { "SKILL.md": "ok", "../escape.md": "bad" }, { getDirectory });
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  assert(threw !== null && /not safe/.test(threw));
  // nothing was written (the budget check rejects the WHOLE map up front)
  let readErr = null;
  try { await readSkillFile("x", "SKILL.md", { getDirectory }); } catch (e) { readErr = e; }
  assert(readErr !== null, "no partial write");
});

Deno.test("writeSkillFiles rejects a file past the per-file budget", async () => {
  const tooBig = "z".repeat(SKILL_FILE_BUDGET + 1);
  let threw = null;
  try {
    await writeSkillFiles("y", { "SKILL.md": tooBig }, { getDirectory });
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  assert(threw !== null && /per-file budget/.test(threw));
});

Deno.test("removeSkillFiles deletes the skill's bodies (idempotent)", async () => {
  await writeSkillFiles("gone", { "SKILL.md": "body" }, { getDirectory });
  await removeSkillFiles("gone", { getDirectory });
  let err = null;
  try { await readSkillFile("gone", "SKILL.md", { getDirectory }); } catch (e) { err = e; }
  assert(err !== null, "file gone after remove");
  // idempotent — removing an absent skill is a no-op, never a throw
  await removeSkillFiles("never-existed", { getDirectory });
});
