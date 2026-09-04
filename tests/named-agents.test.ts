// Unit tests for the named-agent layer: the registry (create/update/delete/
// list/get) + the name generator + the memory_grep tool. named-agents.js is
// tested with a minimal chrome.storage.local + OPFS mock (the optional
// "storage" permission drives the kv backend; OPFS is mocked for the sandbox).
// @ts-nocheck — the chrome + OPFS mock is intentionally dynamic (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createNamedAgent,
  deleteNamedAgent,
  generateAgentName,
  getNamedAgent,
  grepAgentMemory,
  initialAvatar,
  listNamedAgents,
  normalizeCoreAssets,
  slugifyAgentId,
  updateNamedAgent,
} from "../extension/lib/named-agents.js";
import { namedAgentMemory, masterMemory } from "../extension/lib/memory.js";

// ---- in-memory chrome + OPFS mock ----
const store = new Map();
const granted = new Set(["storage"]); // the optional "storage" backend is on
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
// A tiny fake OPFS tree: path.join("/") -> Map of name -> (dir|file value).
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
    removeEntry: async (seg, opts) => { node.delete("d:" + seg); node.delete("f:" + seg); },
    entries: async function* () {
      for (const [k, v] of node) {
        yield [k.slice(2), { kind: k.startsWith("d:") ? "directory" : "file", getFile: async () => ({ size: new TextEncoder().encode(v.text ?? "").length }) }];
      }
    },
  };
}

Deno.test("named agents: create → get → update → list → delete", async () => {
  const created = await createNamedAgent({ name: "PR Reviewer", role: "reviews my GitHub PRs" });
  assert(created.ok, "create ok");
  const id = created.agent.id;
  assertEquals(id, "pr-reviewer", "slugified id");

  const got = await getNamedAgent(id);
  assertEquals(got.name, "PR Reviewer");
  assertEquals(got.role, "reviews my GitHub PRs");

  const updated = await updateNamedAgent(id, { name: "PR Penguin", role: "reviews PRs" });
  assert(updated.ok);
  assertEquals(updated.agent.name, "PR Penguin");

  const list = await listNamedAgents();
  assertEquals(list.length, 1);
  assertEquals(list[0].name, "PR Penguin");

  const del = await deleteNamedAgent(id);
  assert(del.ok);
  assertEquals(await getNamedAgent(id), null);
  assertEquals((await listNamedAgents()).length, 0);
});

Deno.test("named agents: full delete clears the agent's memory/OPFS store too", async () => {
  // CAP-FB-20260826-DELETE-AGENT-FOLDER-01: deleting a named agent must remove
  // BOTH the registry record AND the agent's own OPFS sandbox (memory + history
  // + skills + agents.md) — the owner's "delete the named agent folder" ask.
  const created = await createNamedAgent({ name: "Sorting Hat", role: "groups tabs" });
  assert(created.ok, "create ok");
  const id = created.agent.id;
  const mem = namedAgentMemory(id);
  await mem.set("note", { text: "remember this" });
  const before = await mem.keys();
  assert(before.includes("note"), "memory is seeded before delete");

  const del = await deleteNamedAgent(id);
  assert(del.ok, "delete ok");
  assertEquals(await getNamedAgent(id), null, "registry record gone");
  const after = await namedAgentMemory(id).keys();
  assertEquals(after, [], "agent OPFS store fully cleared after delete");
});

Deno.test("named agents: instance identity is non-reusable and revisions advance", async () => {
  const id = "approval-instance-agent";
  const first = await createNamedAgent({ id, name: "Instance", role: "one" });
  const instanceId = first.agent.instanceId;
  const revision = first.agent.revision;
  const updated = await updateNamedAgent(id, { role: "two" });
  assertEquals(updated.agent.instanceId, instanceId);
  assertEquals(updated.agent.revision, revision + 1);
  await deleteNamedAgent(id);
  const recreated = await createNamedAgent({ id, name: "Instance", role: "three" });
  assert(recreated.agent.instanceId !== instanceId, "delete/recreate never reuses authority identity");
  await deleteNamedAgent(id);
});

Deno.test("named agents: concurrent same-slug first creates cannot produce an ungated replacement", async () => {
  const id = "approval-race-agent";
  await deleteNamedAgent(id);
  let gates = 0;
  const gateOnReplace = async () => {
    gates += 1;
    return { ok: false, error: "owner approval required" };
  };
  const [a, b] = await Promise.all([
    createNamedAgent({ id, name: "First candidate", role: "one" }, { gateOnReplace }),
    createNamedAgent({ id, name: "Second candidate", role: "two" }, { gateOnReplace }),
  ]);
  assertEquals([a.ok, b.ok].filter(Boolean).length, 1, "exactly one first create commits");
  assertEquals(gates, 1, "the serialized second create observes replacement and is gated");
  const saved = await getNamedAgent(id);
  assert(["First candidate", "Second candidate"].includes(saved.name));
  await deleteNamedAgent(id);
});

Deno.test("named agents: replacement gate and mutation share one registry lock", async () => {
  const id = "approval-lock-agent";
  await createNamedAgent({ id, name: "Existing", role: "old" });
  let release;
  const entered = Promise.withResolvers();
  const replacing = createNamedAgent(
    { id, name: "Replacement", role: "new" },
    { gateOnReplace: async () => { entered.resolve(); await new Promise((r) => { release = r; }); return { ok: true }; } },
  );
  await entered.promise;
  let updateFinished = false;
  const queuedUpdate = updateNamedAgent(id, { role: "after" }).then((r) => { updateFinished = true; return r; });
  await Promise.resolve();
  assertEquals(updateFinished, false, "a concurrent mutation cannot enter while the replacement gate holds the lock");
  release();
  assert((await replacing).ok);
  assert((await queuedUpdate).ok);
  assertEquals((await getNamedAgent(id)).role, "after", "queued mutation runs only after replacement commits");
  await deleteNamedAgent(id);
});

Deno.test("named agents: update/delete approval gates hold the authoritative registry lock", async () => {
  const id = "approval-update-lock-agent";
  await createNamedAgent({ id, name: "Existing", role: "old" });
  let release;
  const entered = Promise.withResolvers();
  const updating = updateNamedAgent(id, { role: "approved" }, {
    gateBeforeMutation: async () => { entered.resolve(); await new Promise((r) => { release = r; }); return { ok: true }; },
  });
  await entered.promise;
  let deleteFinished = false;
  const queuedDelete = deleteNamedAgent(id).then((r) => { deleteFinished = true; return r; });
  await Promise.resolve();
  assertEquals(deleteFinished, false, "delete cannot interleave after approval consumption and before update commit");
  release();
  assert((await updating).ok);
  assert((await queuedDelete).ok);
});

Deno.test("named agents: the name generator is deterministic + quirky", () => {
  const a = generateAgentName("pr-reviewer");
  const b = generateAgentName("pr-reviewer");
  assertEquals(a, b, "same seed → same name");
  assert(/[A-Z][a-z]+ [A-Z][a-z]+/.test(a), "an alliterative-ish two-word name");
});

Deno.test("named agents: slugify is safe + initialAvatar returns a UTF-8-safe data URL", () => {
  assertEquals(slugifyAgentId("My  Agent!!"), "my-agent");
  assertEquals(slugifyAgentId("   "), "");
  const av = initialAvatar("PR Penguin");
  assert(av.startsWith("data:image/svg+xml;utf8,"), "a UTF-8 SVG data URL");
  // Non-Latin1 initials (CJK/emoji) must NOT throw — btoa would throw here.
  assert(initialAvatar("Ω-machine").startsWith("data:image/svg+xml;utf8,"), "CJK-safe");
  assert(initialAvatar("🚀 launcher").startsWith("data:image/svg+xml;utf8,"), "emoji-safe");
});

Deno.test("named agents: memory_grep searches the agent's own memory + history", async () => {
  const mem = namedAgentMemory("pr-reviewer");
  await mem.setTrusted("note", "the PR #42 needs a rebase before merge");
  await mem.setTrusted("journal", [
    { type: "task", task: "review PR #42" },
    { type: "result", result: "looks good, needs a rebase" },
  ]);
  const res = await grepAgentMemory(mem, "rebase");
  assert(res.count >= 2, "matches memory + history");
  assert(res.matches.some((m) => m.source === "memory"), "a memory match");
  assert(res.matches.some((m) => m.source === "history"), "a history match");
  const miss = await grepAgentMemory(mem, "zzz-not-present");
  assertEquals(miss.count, 0);
  await mem.clear();
});

Deno.test("named agents: the agent's run history lives in its OWN journal (isolated)", async () => {
  const created = await createNamedAgent({ name: "Summarizer" });
  assert(created.ok, "create ok");
  const mem = namedAgentMemory(created.agent.id);
  // The named-agent.run history (the named-agent.history route's data source):
  // task/result/tool-call rows in the agent's OWN journal.
  await mem.setTrusted("journal", [
    { type: "task", task: "summarise the page" },
    { type: "tool-call", tool: "open_tab", args: '{"url":"https://x.example"}' },
    { type: "result", result: "here is the summary" },
  ]);
  const journal = (await mem.get("journal")) ?? [];
  assertEquals(journal.length, 3, "the agent's journal holds its run history");
  assert(journal.some((e) => e.type === "tool-call"), "the run history includes tool calls");
  assert(journal.some((e) => e.type === "result"), "the run history includes the result");
  // Isolation: the MASTER journal is unaffected (the agent runs read/write their
  // own tier, never the master's).
  const masterJournal = (await masterMemory().get("journal")) ?? [];
  assertEquals(Array.isArray(masterJournal) ? masterJournal.length : 0, 0, "the master journal is separate");
  await deleteNamedAgent(created.agent.id);
});

Deno.test("named agents: create with an explicit id keeps the id", async () => {
  const created = await createNamedAgent({ id: "reader", name: "My Reader", role: "summarises articles" });
  assert(created.ok);
  assertEquals(created.agent.id, "reader");
  await deleteNamedAgent("reader");
});

Deno.test("named agents (dptw): normalizeCoreAssets keeps huge assets WHOLE, no count bound", () => {
  const big200 = "x".repeat(200_000);
  const assets = normalizeCoreAssets([
    { name: "guide.md", type: "text/markdown", content: "# Guide\nSome instructions" },
    { name: "big.txt", type: "text/plain", content: big200 },
    null,
    "garbage",
  ]);
  assertEquals(assets.length, 2, "only valid assets survive");
  assertEquals(assets[0].content, "# Guide\nSome instructions", "normal content untouched");
  assertEquals(assets[1].content, big200, "dptw: past-cap content kept WHOLE (no ellipsis clip)");
  const many = normalizeCoreAssets(Array.from({ length: 20 }, (_, i) => ({ name: `a${i}`, content: "x" })));
  assertEquals(many.length, 20, "dptw: no asset count bound");
});

Deno.test("named agents: create + update persist coreAssets", async () => {
  const created = await createNamedAgent({ name: "Asset Agent", role: "reads the asset", coreAssets: [{ name: "guide.md", type: "text/markdown", content: "# guide" }] });
  assert(created.ok, "create ok");
  assertEquals(created.agent.coreAssets.length, 1, "the core asset is stored");
  const updated = await updateNamedAgent(created.agent.id, { coreAssets: [{ name: "x.txt", type: "text/plain", content: "hello" }] });
  assert(updated.ok, "update ok");
  assertEquals(updated.agent.coreAssets[0].name, "x.txt", "the core asset updates");
  const fetched = await getNamedAgent(created.agent.id);
  assertEquals(fetched.coreAssets[0].content, "hello", "the core asset persists on get");
  await deleteNamedAgent(created.agent.id);
});

// ──────────────────────────────────────────────────────────────────────────
// CAP-FB-20260824-AGENT-ROLE-TRUNCATION-01 (+ owner scope expansion): the
// bounds family is generous, finite, and HONEST — roles round-trip verbatim
// up to 32000 chars; over-cap input is REJECTED with a clear error, never
// silently clipped (the 200-char slice destroyed detailed roles).

Deno.test("role bounds: a ~30KB detailed role round-trips create → save → reopen VERBATIM", async () => {
  const role = "You are the Sorting Hat.\n" + "Detailed duty with unicode — héllo ✓ 42.\n".repeat(750) + "end."; // ≈30.7KB, trim-safe
  assert(role.length > 30_000 && role.length <= 32_000, `fixture is ~30KB (${role.length})`);
  const created = await createNamedAgent({ name: "Sorting Hat", role });
  assertEquals(created.ok, true);
  assertEquals(created.agent.role, role, "stored VERBATIM at create — zero truncation");
  const reopened = await getNamedAgent(created.agent.id);
  assertEquals(reopened.role, role, "round-trips byte-for-byte through the registry");
  const listed = (await listNamedAgents()).find((a) => a.id === created.agent.id);
  assertEquals(listed.role, role, "the list surface returns the full role");
  // edit/patch preserves the full role verbatim
  const role2 = role + "\nOne more duty. end";
  const updated = await updateNamedAgent(created.agent.id, { role: role2 });
  assertEquals(updated.ok, true);
  assertEquals((await getNamedAgent(created.agent.id)).role, role2, "edit preserves the full role");
});

Deno.test("role bounds (dptw): NO cap — a >32000-char role saves at create AND update, whole", async () => {
  const tooLong = "x".repeat(32_001);
  const created = await createNamedAgent({ name: "Over Cap", role: tooLong });
  assertEquals(created.ok, true, "dptw: past-cap create admitted");
  assertEquals(created.agent.role, tooLong, "the role is stored WHOLE");
  const ok = await createNamedAgent({ name: "Cap Target", role: "short" });
  assertEquals(ok.ok, true);
  const updated = await updateNamedAgent(ok.agent.id, { role: tooLong });
  assertEquals(updated.ok, true, "dptw: past-cap update admitted");
  assertEquals((await getNamedAgent(ok.agent.id)).role, tooLong, "the updated role persists whole");
});

Deno.test("bounds family REMOVED (dptw): name >120, skills >128, core asset >128 KiB all admitted WHOLE", async () => {
  const named = await createNamedAgent({ name: "n".repeat(121), role: "r" });
  assertEquals(named.ok, true, "dptw: a 121-char name is admitted");
  assertEquals(named.agent.name, "n".repeat(121), "the name is stored whole");
  const skills = Array.from({ length: 200 }, (_, i) => `skill-${i}`);
  const skilled = await createNamedAgent({ name: "Skilled", role: "r", skills });
  assertEquals(skilled.ok, true);
  assertEquals(skilled.agent.skills.length, 200, "dptw: 200 skills kept");
  const over = "a".repeat(131_073);
  const [whole] = normalizeCoreAssets([{ name: "over.txt", type: "text/plain", content: over }]);
  assertEquals(whole.content, over, "dptw: past-cap asset kept WHOLE (no marker, no clip)");
  const mapProbe = await createNamedAgent({ name: "probe", role: "r" });
  assertEquals(mapProbe.ok, true);
});

Deno.test("role bounds r2 (Gemini review): the SW update-route normalization layer canNOT silently clip — source pins", async () => {
  // The P0's edit path flows NTP Edit → named-agent.update → normalizedNamedPatch
  // → updateNamedAgent. r1 fixed the authority; r2 removes the SW layer's
  // hardcoded slices that defeated it. Behavioral coverage of the flow lives in
  // the authority KATs above (the SW route table has no behavioral harness —
  // repo precedent); these pins close the class at the SW layer.
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const patchFn = sw.slice(sw.indexOf("function normalizedNamedPatch"), sw.indexOf("function namedPatchPayload"));
  assert(!patchFn.includes("trim().slice(0, 200)"), "no hardcoded 200-char role slice remains in the update-route normalization");
  assert(!patchFn.includes("skills.slice(0, 32)"), "no hardcoded 32-skill slice remains");
  assert(patchFn.includes("skills.slice(0, MAX_SKILLS)"), "the skills bound references the IMPORTED constant (drift-proof)");
  assert(/import\s*\{[^}]*MAX_ROLE_LEN[^}]*MAX_SKILLS[^}]*\}\s*from "\.\.\/lib\/named-agents\.js"/s.test(sw)
      || /MAX_ROLE_LEN,[\s\S]{0,400}from "\.\.\/lib\/named-agents\.js"/.test(sw),
    "the SW imports the bounds from the single authority");
  // end-to-end through the authority with the exact patch shape the route builds
  const created = await createNamedAgent({ name: "Route Shape", role: "v1" });
  assertEquals(created.ok, true);
  const bigRole = "route-level role. ".repeat(1700); // ≈30.6KB — under the 32000 cap; the old layer would clip to 200
  const updated = await updateNamedAgent(created.agent.id, { name: "Route Shape", role: bigRole, skills: Array.from({ length: 64 }, (_, i) => `s${i}`) });
  assertEquals(updated.ok, true);
  const after = await getNamedAgent(created.agent.id);
  assertEquals(after.role, bigRole.trim(), "the full role survives the update-route patch shape VERBATIM (modulo the intentional edge trim)");
  assertEquals(after.skills.length, 64, ">32 skills survive the route patch shape");
});
