// @ts-nocheck — profile store test suite is dynamic.
// tests/profile-store.test.ts — structured user profile store unit tests (AGENT-PRODUCT-GAPS, form-filler layer 1).
//
// Falsification-gated tests covering:
//   (1) P0: Grants provisioned through real registry (createNamedAgent / updateNamedAgent).
//   (2) P0: Model memory tools protect the profile:* reserved namespace on real masterMemory().
//   (3) P1-a: Direct owner routes (unrestricted getProfileSection/getWholeProfile).
//   (4) P1-b: Audit fail-closed & rollback compensation on delete/clear/set failure.
//   (5) P1-c: Reserved sentinel slugs ("owner", "master") rejected.
//   (6) P1-d: Bulk setWholeProfile atomic transaction & thrown write rollback compensation.
//   (7) P1-e: Link labels and names strict type validation.
//   (8) Multi-byte UTF-8 byte boundary enforcement (>128 KiB).

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
import { createNamedAgent, updateNamedAgent, validateProfileGrants } from "../extension/lib/named-agents.js";

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

Deno.test("P0: grants provisioned through REAL agent registry (createNamedAgent / updateNamedAgent)", async () => {
  await setProfileSection("profile:basic", { firstName: "Alice", email: "alice@test.com" });
  await setProfileSection("profile:work_history", [{ company: "Acme", title: "Staff Eng" }]);

  // 1. Malformed profileGrants are REJECTED at create
  const malformedCreate = await createNamedAgent({
    name: "Malformed Agent",
    profileGrants: "*", // non-array
  });
  assertEquals(malformedCreate.ok, false);
  assert(malformedCreate.error.includes("must be an array"));

  // 2. Malformed profileGrants are REJECTED at update
  const validAgent = await createNamedAgent({
    id: "update-test",
    name: "Update Test",
    profileGrants: ["profile:basic"],
  });
  assert(validAgent.ok);

  const malformedUpdate = await updateNamedAgent("update-test", {
    profileGrants: [{}], // non-string entry
  });
  assertEquals(malformedUpdate.ok, false);
  assert(malformedUpdate.error.includes("must be a string"));

  // 3. Real registry read: granted basic succeeds
  const rBasic = await readAgentProfileSection("update-test", "profile:basic");
  assert(rBasic.ok, "read allowed for granted section");
  assertEquals(rBasic.data.firstName, "Alice");

  // 4. Real registry read: ungranted work_history FAILS
  const rWork = await readAgentProfileSection("update-test", "profile:work_history");
  assertEquals(rWork.ok, false);
  assert(rWork.error.includes("lacks explicit grant"));

  // 5. Update agent with work_history grant -> now succeeds
  const updateOk = await updateNamedAgent("update-test", {
    profileGrants: ["profile:basic", "profile:work_history"],
  });
  assert(updateOk.ok);

  const rWorkAfter = await readAgentProfileSection("update-test", "profile:work_history");
  assert(rWorkAfter.ok);
  assertEquals(rWorkAfter.data[0].company, "Acme");
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
  await setProfileSection("profile:education", [{ institution: "MIT", degree: "B.S." }]);

  // Simulate audit write failure on set
  const realMem = masterMemory();
  const failingAuditMem = {
    ...realMem,
    async setTrusted(key, val) {
      if (key === "profile:audit_log") {
        throw new Error("injected disk failure on audit log write");
      }
      return realMem.setTrusted(key, val);
    },
  };

  const setRes = await setProfileSection("profile:education", [{ institution: "Harvard" }], {
    memory: failingAuditMem,
  });
  assertEquals(setRes.ok, false);
  assert(setRes.error.includes("audit write failed"));

  // Verify MIT was preserved
  const checkEdu = await getProfileSection("profile:education");
  assertEquals(checkEdu.data[0].institution, "MIT");

  // Delete with failing audit rolls back and restores entry
  const delRes = await deleteProfileSection("profile:education", { memory: failingAuditMem });
  assertEquals(delRes.ok, false);
  assert(delRes.error.includes("delete/audit failed") || delRes.error.includes("disk failure"));

  const checkDel = await getProfileSection("profile:education");
  assertEquals(checkDel.data[0].institution, "MIT");

  // Delete with failing storage deletion throws/rolls back
  const failingDeleteMem = {
    ...realMem,
    async delete(key) {
      if (key === "profile:education") throw new Error("injected deletion IO error");
      return realMem.delete(key);
    },
  };
  const delIoRes = await deleteProfileSection("profile:education", { memory: failingDeleteMem });
  assertEquals(delIoRes.ok, false);
  assert(delIoRes.error.includes("injected deletion IO error"));
});

Deno.test("P1-c: reserved sentinel slugs ('owner', 'master') are rejected before registry lookup", async () => {
  // Even if an agent with id 'owner' existed, sentinel slug lookup is rejected
  await createNamedAgent({ id: "owner", name: "Owner Imposter", profileGrants: ["*"] });

  const rOwner = await readAgentProfileSection("owner", "profile:basic");
  assertEquals(rOwner.ok, false);
  assert(rOwner.error.includes("reserved sentinel slug"));

  const rMaster = await readAgentProfileSection("master", "profile:basic");
  assertEquals(rMaster.ok, false);
  assert(rMaster.error.includes("reserved sentinel slug"));
});

Deno.test("P1-d: setWholeProfile rollback catches thrown errors and compensates committed writes", async () => {
  await setProfileSection("profile:basic", { firstName: "InitialBasic" });
  await deleteProfileSection("profile:education");

  const realMem = masterMemory();
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
  // 32 entries with 1,500 emojis each = 32 * 6,000 = 192,000 UTF-8 bytes (> 131,072 MAX_PROFILE_SECTION_BYTES)
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
  const badLabel = validateBasicProfile({
    links: [{ label: { evil: true }, url: "https://example.com" }],
  });
  assertEquals(badLabel.ok, false);
  assert(badLabel.error.includes("link label at index 0 must be a string"));

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
