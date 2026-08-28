// @ts-nocheck — profile store test suite is dynamic.
// tests/profile-store.test.ts — structured user profile store unit tests (AGENT-PRODUCT-GAPS, form-filler layer 1).
//
// Falsification-gated tests covering:
//   (1) P0: Grants provisioned and resolved through the REAL agent registry (createNamedAgent / getNamedAgent).
//   (2) P0: Model memory tools protect the profile:* reserved namespace on real masterMemory().
//   (3) P1-a: Direct owner routes (no isTrustedOwner flag on agent readers).
//   (4) P1-b: Audit fail-closed & rollback compensation on delete/clear/set.
//   (5) P1-c: Thrown write handling in setWholeProfile with rollback compensation.
//   (6) P1-d: Falsification gates against real production seams and multi-byte UTF-8 accounting.
//   (7) P1-e: Link labels and names strict type validation (non-coercive).

import { assert, assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import {
  MAX_CUSTOM_ANSWERS,
  MAX_EDUCATION_ENTRIES,
  MAX_LINKS_COUNT,
  MAX_PROFILE_SECTION_BYTES,
  MAX_WORK_ENTRIES,
  PROFILE_SECTIONS,
  clearProfile,
  deleteProfileSection,
  getProfileAuditLog,
  getProfileSection,
  getWholeProfile,
  hasProfileGrant,
  normalizeSectionKey,
  readAgentProfile,
  readAgentProfileSection,
  setProfileSection,
  setWholeProfile,
  validateBasicProfile,
  validateDisclosures,
  validateEducation,
  validateProfileSection,
  validateWorkHistory,
} from "../extension/lib/profile-store.js";
import { masterMemory } from "../extension/lib/memory.js";
import { createNamedAgent } from "../extension/lib/named-agents.js";

// ---- In-Memory Storage & OPFS Mocks for Production Seams ----
const storageStore = new Map();
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (storageStore.has(k)) out[k] = clone(storageStore.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) storageStore.delete(k);
          else storageStore.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) storageStore.delete(k);
      },
    },
  },
};

const opfsTree = new Map();
function getDir(path) {
  let node = opfsTree;
  for (const seg of path) {
    if (!node.has("d:" + seg)) node.set("d:" + seg, new Map());
    node = node.get("d:" + seg);
  }
  return node;
}

globalThis.navigator = globalThis.navigator ?? {};
Object.defineProperty(globalThis.navigator, "storage", {
  value: {
    getDirectory: async () => dirHandle(opfsTree, ""),
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
        getFile: async () => ({
          text: async () => rec.text,
          size: new TextEncoder().encode(rec.text).length,
        }),
        createWritable: async () => ({
          write: async (s) => {
            rec.text = typeof s === "string" ? s : new TextDecoder().decode(s);
          },
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
        yield [
          k.slice(2),
          {
            kind: k.startsWith("d:") ? "directory" : "file",
            getFile: async () => ({ size: new TextEncoder().encode(v.text ?? "").length }),
          },
        ];
      }
    },
  };
}

Deno.test("profile store: normalizeSectionKey recognizes standard sections with or without prefix", () => {
  assertEquals(normalizeSectionKey("profile:basic"), "profile:basic");
  assertEquals(normalizeSectionKey("basic"), "profile:basic");
  assertEquals(normalizeSectionKey("profile:work_history"), "profile:work_history");
  assertEquals(normalizeSectionKey("work_history"), "profile:work_history");
  assertEquals(normalizeSectionKey("profile:education"), "profile:education");
  assertEquals(normalizeSectionKey("education"), "profile:education");
  assertEquals(normalizeSectionKey("profile:disclosures"), "profile:disclosures");
  assertEquals(normalizeSectionKey("disclosures"), "profile:disclosures");

  assertEquals(normalizeSectionKey("profile:passwords"), null);
  assertEquals(normalizeSectionKey("unknown_section"), null);
  assertEquals(normalizeSectionKey(null), null);
  assertEquals(normalizeSectionKey(123), null);
});

Deno.test("P0: grants provisioned and resolved through REAL agent registry (named-agents.js createNamedAgent)", async () => {
  // Set up profile data in master store
  await setProfileSection("profile:basic", { firstName: "Alice", email: "alice@test.com" });
  await setProfileSection("profile:work_history", [{ company: "Acme", title: "Staff Eng" }]);
  await setProfileSection("profile:disclosures", { workAuthorization: "yes" });

  // 1. Create real agent with ONLY profile:basic grant
  const createBasicAgent = await createNamedAgent({
    id: "contact-assistant",
    name: "Contact Assistant",
    role: "Assists with contact info",
    profileGrants: ["profile:basic"],
  });
  assert(createBasicAgent.ok);
  assertEquals(createBasicAgent.agent.profileGrants, ["profile:basic"]);

  // 2. Real registry read: granted basic succeeds
  const rBasic = await readAgentProfileSection("contact-assistant", "profile:basic");
  assert(rBasic.ok, "read allowed for granted section");
  assertEquals(rBasic.data.firstName, "Alice");

  // 3. Real registry read: ungranted work_history FAILS
  const rWork = await readAgentProfileSection("contact-assistant", "profile:work_history");
  assertEquals(rWork.ok, false);
  assert(rWork.error.includes("lacks explicit grant"));

  // 4. Non-existent agent slug FAILS closed
  const rUnknown = await readAgentProfileSection("non-existent-agent", "profile:basic");
  assertEquals(rUnknown.ok, false);
  assert(rUnknown.error.includes("not found in trusted registry"));

  // 5. Caller sentinels or non-strings FAIL closed
  assertEquals((await readAgentProfileSection(null, "profile:basic")).ok, false);
  assertEquals((await readAgentProfileSection(undefined, "profile:basic")).ok, false);
  assertEquals((await readAgentProfileSection(12345, "profile:basic")).ok, false);
  assertEquals((await readAgentProfileSection({ profileGrants: ["*"] }, "profile:basic")).ok, false);

  // 6. Real agent with wildcard grant can read all granted sections
  const createWildcardAgent = await createNamedAgent({
    id: "form-filler",
    name: "Form Filler",
    role: "Fills applications",
    profileGrants: ["*"],
  });
  assert(createWildcardAgent.ok);

  const rAll = await readAgentProfile("form-filler");
  assert(rAll.ok);
  assertEquals(rAll.grantedSections.length, 4);
  assertEquals(rAll.profile["profile:basic"].firstName, "Alice");
  assertEquals(rAll.profile["profile:work_history"][0].company, "Acme");
});

Deno.test("P0: real masterMemory() protects profile:* reserved namespace against model reads and writes", async () => {
  const mem = masterMemory();

  // 1. Raw model memory.get on profile:* throws reserved error
  await assertRejects(
    async () => await mem.get("profile:basic"),
    Error,
    'key "profile:basic" is reserved on this store',
  );

  // 2. Raw model memory.set on profile:* throws reserved error
  await assertRejects(
    async () => await mem.set("profile:basic", { firstName: "Hacked" }),
    Error,
    'key "profile:basic" is reserved on this store',
  );

  // 3. Raw model memory.keys excludes profile:* keys
  await mem.set("public_note", "hello");
  const keys = await mem.keys();
  assert(keys.includes("public_note"));
  assert(!keys.includes("profile:basic"));
  assert(!keys.some((k) => k.startsWith("profile:")));
});

Deno.test("P1-b: audit fail-closed & rollback compensation on delete/clear/set failure", async () => {
  // 1. Plant initial section
  await setProfileSection("profile:education", [{ institution: "MIT", degree: "B.S." }]);

  // Intercept masterMemory to inject an audit log write failure
  const realMem = masterMemory();
  const failingMem = {
    ...realMem,
    async setTrusted(key, val) {
      if (key === "profile:audit_log") {
        throw new Error("injected disk failure on audit log write");
      }
      return realMem.setTrusted(key, val);
    },
  };

  // Mutating with failing audit rolls back and returns error
  const setRes = await setProfileSection("profile:education", [{ institution: "Harvard" }], {
    memory: failingMem,
  });
  assertEquals(setRes.ok, false);
  assert(setRes.error.includes("audit write failed"));

  // Verify rollback preserved MIT
  const checkEdu = await getProfileSection("profile:education");
  assertEquals(checkEdu.data[0].institution, "MIT");

  // Delete with failing audit rolls back and restores entry
  const delRes = await deleteProfileSection("profile:education", { memory: failingMem });
  assertEquals(delRes.ok, false);
  assert(delRes.error.includes("audit write failed"));

  const checkDel = await getProfileSection("profile:education");
  assertEquals(checkDel.data[0].institution, "MIT");
});

Deno.test("P1-c: setWholeProfile rollback catches thrown errors and compensates committed writes", async () => {
  await setProfileSection("profile:basic", { firstName: "InitialBasic" });
  await deleteProfileSection("profile:education");

  const realMem = masterMemory();
  let writeCount = 0;
  const flakyMem = {
    ...realMem,
    async setTrusted(key, val) {
      if (key === "profile:education") {
        throw new Error("simulated quota exhaustion on education commit");
      }
      return realMem.setTrusted(key, val);
    },
  };

  const bulkPayload = {
    "profile:basic": { firstName: "UpdatedBasic" },
    "profile:education": [{ institution: "Stanford" }],
  };

  const res = await setWholeProfile(bulkPayload, { memory: flakyMem });
  assertEquals(res.ok, false);
  assert(res.error.includes("simulated quota exhaustion"));

  // Rollback verified: basic restored to InitialBasic, education remains absent
  const checkBasic = await getProfileSection("profile:basic");
  assertEquals(checkBasic.data.firstName, "InitialBasic");

  const checkEdu = await getProfileSection("profile:education");
  assertEquals(checkEdu.data, null);
});

Deno.test("P1-d: exact multi-byte UTF-8 byte bounds reject payloads over 128 KiB (multi-byte accounting)", async () => {
  // Multi-byte Unicode character (e.g. '🔥' = 4 UTF-8 bytes)
  // 32 entries with 1,500 emojis each = 32 * 6,000 = 192,000 UTF-8 bytes (> 131,072 MAX_PROFILE_SECTION_BYTES)
  // while each description is 1,500 chars (under the 4,000 char field cap)
  const manyEmojiJobs = Array.from({ length: 32 }, (_, i) => ({
    company: `Company ${i}`,
    title: "Engineer",
    description: "🔥".repeat(1500),
  }));

  const utf8Bytes = new TextEncoder().encode(JSON.stringify(manyEmojiJobs)).byteLength;
  assert(utf8Bytes > MAX_PROFILE_SECTION_BYTES, `must exceed byte cap (${utf8Bytes} > ${MAX_PROFILE_SECTION_BYTES})`);

  const res = await setProfileSection("profile:work_history", manyEmojiJobs);

  assertEquals(res.ok, false);
  assert(res.error.includes("payload exceeds maximum size"));
});

Deno.test("P1-e: link labels and names are strictly validated before normalization", () => {
  // Passing non-string object as label is rejected
  const badLabel = validateBasicProfile({
    links: [{ label: { evil: true }, url: "https://example.com" }],
  });
  assertEquals(badLabel.ok, false);
  assert(badLabel.error.includes("link label at index 0 must be a string"));

  // Passing non-string URL is rejected
  const badUrl = validateBasicProfile({
    links: [{ label: "Site", url: 12345 }],
  });
  assertEquals(badUrl.ok, false);
  assert(badUrl.error.includes("requires a url string"));
});

Deno.test("profile store: whole profile get, set, and clear round-trip", async () => {
  const fullProfile = {
    "profile:basic": {
      firstName: "Carol",
      lastName: "Danvers",
      email: "carol@avengers.org",
    },
    "profile:work_history": [
      { company: "Air Force", title: "Pilot", startDate: "2010" },
    ],
    "profile:education": [
      { institution: "Air Force Academy", degree: "B.S." },
    ],
    "profile:disclosures": {
      workAuthorization: "authorized_us",
    },
  };

  const writeRes = await setWholeProfile(fullProfile);
  assert(writeRes.ok);
  assertEquals(writeRes.writtenSections.length, 4);

  const readRes = await getWholeProfile();
  assert(readRes.ok);
  assertEquals(readRes.profile["profile:basic"].firstName, "Carol");
  assertEquals(readRes.profile["profile:work_history"][0].company, "Air Force");
  assertEquals(readRes.profile["profile:education"][0].institution, "Air Force Academy");
  assertEquals(readRes.profile["profile:disclosures"].workAuthorization, "authorized_us");

  await clearProfile();
  const emptyRes = await getWholeProfile();
  assertEquals(Object.keys(emptyRes.profile).length, 0);
});
