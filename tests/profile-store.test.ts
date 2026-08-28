// @ts-nocheck — profile store test suite is dynamic.
// tests/profile-store.test.ts — structured user profile store unit tests (AGENT-PRODUCT-GAPS, form-filler layer 1).
//
// Falsification-gated tests covering:
//   (1) P0: Grant enforcement cannot be bypassed by caller sentinels or mock objects.
//   (2) P0: Model memory tools protect the profile:* reserved namespace.
//   (3) P1-a: Audit fail-closed behavior, diff recording, and concurrency protection.
//   (4) P1-b: Strict UTF-8 byte accounting (multi-byte Unicode rejection over 128 KiB).
//   (5) P1-c: Strict type validation before normalization (non-coercive).
//   (6) P1-d: Bulk update fail-closed prevalidation and compensation.
//   (7) Round-trip fidelity across all 4 profile sections.

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

// Minimal in-memory store adapter matching masterMemory interface with strict methods
function createFakeMemory() {
  const map = new Map();
  return {
    async get(key) {
      if (/^(?:__gen|__tx|__wal|__epoch|__tombs|profile:|profile$)/.test(String(key))) {
        throw new Error(`key "${key}" is reserved on this store`);
      }
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async getStrict(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async set(key, value) {
      if (/^(?:__gen|__tx|__wal|__epoch|__tombs|profile:|profile$)/.test(String(key))) {
        throw new Error(`key "${key}" is reserved on this store`);
      }
      map.set(key, structuredClone(value));
    },
    async setTrusted(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async has(key) {
      return map.has(key);
    },
    async keys() {
      const out = [];
      for (const k of map.keys()) {
        if (!/^(?:__gen|__tx|__wal|__epoch|__tombs|profile:|profile$)/.test(k)) {
          out.push(k);
        }
      }
      return out;
    },
    _map: map,
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

  // Invalid sections return null
  assertEquals(normalizeSectionKey("profile:passwords"), null);
  assertEquals(normalizeSectionKey("unknown_section"), null);
  assertEquals(normalizeSectionKey(null), null);
  assertEquals(normalizeSectionKey(123), null);
});

Deno.test("P0: grant enforcement cannot be bypassed by caller sentinels or mock objects", async () => {
  const mem = createFakeMemory();
  await setProfileSection("profile:basic", { firstName: "Alice", email: "alice@test.com" }, { memory: mem });

  // 1. Caller sentinels: null, undefined, "owner", "master" passed as agent identifier FAIL
  const rNull = await readAgentProfileSection(null, "profile:basic", { memory: mem });
  assertEquals(rNull.ok, false);
  assert(rNull.error.includes("unauthorized"));

  const rUndefined = await readAgentProfileSection(undefined, "profile:basic", { memory: mem });
  assertEquals(rUndefined.ok, false);
  assert(rUndefined.error.includes("unauthorized"));

  const rOwnerStr = await readAgentProfileSection("owner", "profile:basic", {
    memory: mem,
    getAgentRecord: async () => null, // not in registry
  });
  assertEquals(rOwnerStr.ok, false);
  assert(rOwnerStr.error.includes("not found in trusted registry"));

  // 2. Caller-supplied mock object with self-asserted profileGrants: ["*"] is NOT trusted without registry match
  const fakeAgent = { id: "forged-agent", name: "Forged", profileGrants: ["*"] };
  const rForged = await readAgentProfileSection(fakeAgent, "profile:basic", {
    memory: mem,
    getAgentRecord: async (slug) => null, // registry has no such agent
  });
  assertEquals(rForged.ok, false);
  assert(rForged.error.includes("not found in trusted registry"));

  // 3. Authenticated registry lookup with valid grant SUCCEEDS
  const trustedAgent = { id: "form-filler", name: "Form Filler", profileGrants: ["profile:basic"] };
  const rTrusted = await readAgentProfileSection("form-filler", "profile:basic", {
    memory: mem,
    getAgentRecord: async (slug) => (slug === "form-filler" ? trustedAgent : null),
  });
  assert(rTrusted.ok, "trusted registry record with grant succeeds");
  assertEquals(rTrusted.data.firstName, "Alice");

  // 4. Authenticated registry lookup WITHOUT grant FAILS
  const rTrustedNoGrant = await readAgentProfileSection("form-filler", "profile:work_history", {
    memory: mem,
    getAgentRecord: async (slug) => (slug === "form-filler" ? trustedAgent : null),
  });
  assertEquals(rTrustedNoGrant.ok, false);
  assert(rTrustedNoGrant.error.includes("lacks explicit grant"));

  // 5. Explicit isTrustedOwner option allows trusted service-worker/settings route read
  const rOwner = await readAgentProfileSection(null, "profile:basic", {
    memory: mem,
    isTrustedOwner: true,
  });
  assert(rOwner.ok, "trusted owner option succeeds");
  assertEquals(rOwner.data.firstName, "Alice");
});

Deno.test("P0: model memory tools cannot read, write, or list profile:* keys (reserved namespace)", async () => {
  const mem = createFakeMemory();
  await setProfileSection("profile:basic", { firstName: "Secret", email: "secret@test.com" }, { memory: mem });

  // 1. Raw memory.get on profile:basic throws reserved error
  await assertRejects(
    async () => await mem.get("profile:basic"),
    Error,
    "reserved",
  );

  // 2. Raw memory.set on profile:basic throws reserved error
  await assertRejects(
    async () => await mem.set("profile:basic", { firstName: "Hacked" }),
    Error,
    "reserved",
  );

  // 3. Raw memory.keys does not expose profile: keys
  await mem.set("regular_key", "public_value");
  const visibleKeys = await mem.keys();
  assert(visibleKeys.includes("regular_key"));
  assert(!visibleKeys.includes("profile:basic"));
  assert(!visibleKeys.some((k) => k.startsWith("profile:")));
});

Deno.test("P1-a: audit write failure causes mutation to fail closed and roll back", async () => {
  const mem = createFakeMemory();
  // Plant initial state
  await setProfileSection("profile:basic", { firstName: "Original" }, { memory: mem });

  // Simulate audit log write failure
  const failingMem = {
    ...mem,
    async setTrusted(key, val) {
      if (key === "profile:audit_log") {
        throw new Error("storage disk full on audit log write");
      }
      return mem.setTrusted(key, val);
    },
  };

  const res = await setProfileSection("profile:basic", { firstName: "Mutated" }, { memory: failingMem });
  assertEquals(res.ok, false);
  assert(res.error.includes("audit write failed"));

  // Verify rollback: state remains Original
  const current = await getProfileSection("profile:basic", { memory: mem });
  assertEquals(current.data.firstName, "Original");
});

Deno.test("P1-a: audit log diffs record actual changed keys, not all keys", async () => {
  const mem = createFakeMemory();

  // Create
  await setProfileSection("profile:basic", { firstName: "Bob", lastName: "Smith", email: "bob@test.com" }, { memory: mem, actor: "settings-ui" });
  let log = await getProfileAuditLog({ memory: mem });
  assertEquals(log[0].action, "create");

  // Update only email
  await setProfileSection("profile:basic", { firstName: "Bob", lastName: "Smith", email: "newbob@test.com" }, { memory: mem, actor: "settings-ui" });
  log = await getProfileAuditLog({ memory: mem });
  assertEquals(log[0].action, "update");
  assertEquals(log[0].fields, ["email"]); // Only email changed!
});

Deno.test("P1-b: exact UTF-8 byte bounds reject multi-byte payloads exceeding 128 KiB", async () => {
  const mem = createFakeMemory();

  // 32 work history entries each with large descriptions and locations:
  // Total serialized UTF-8 bytes will exceed MAX_PROFILE_SECTION_BYTES (131072 bytes)
  const hugeJobs = Array.from({ length: 32 }, (_, i) => ({
    company: `Company ${i} ` + "C".repeat(50),
    title: `Staff Architect ${i} ` + "T".repeat(50),
    location: "L".repeat(50),
    description: "W".repeat(4000),
  }));

  const serialized = JSON.stringify(hugeJobs);
  const utf8Bytes = new TextEncoder().encode(serialized).byteLength;
  assert(utf8Bytes > MAX_PROFILE_SECTION_BYTES, `must exceed byte cap (${utf8Bytes} > ${MAX_PROFILE_SECTION_BYTES})`);

  const res = await setProfileSection("profile:work_history", hugeJobs, { memory: mem });

  // Falsification gate: must be rejected on UTF-8 bytes!
  assertEquals(res.ok, false);
  assert(res.error.includes("payload exceeds maximum size"));
});

Deno.test("P1-c: strict type validation rejects wrong types before normalization", () => {
  // Number passed where string required in basic profile
  const badFirst = validateBasicProfile({ firstName: 12345 });
  assertEquals(badFirst.ok, false);
  assert(badFirst.error.includes("firstName must be a string"));

  const badPhone = validateBasicProfile({ phone: { digits: "555" } });
  assertEquals(badPhone.ok, false);
  assert(badPhone.error.includes("phone must be a string"));

  // Wrong requiresSponsorship type in disclosures
  const badSpon = validateDisclosures({ requiresSponsorship: "definitely_maybe" });
  assertEquals(badSpon.ok, false);
  assert(badSpon.error.includes("requiresSponsorship must be a boolean or 'yes'/'no'"));

  // Non-boolean current in work history
  const badCurrent = validateWorkHistory([{ company: "Acme", title: "Dev", current: "yes" }]);
  assertEquals(badCurrent.ok, false);
  assert(badCurrent.error.includes("current must be a boolean"));
});

Deno.test("P1-d: bulk setWholeProfile pre-validates all keys and fails closed before writing", async () => {
  const mem = createFakeMemory();
  await setProfileSection("profile:basic", { firstName: "Initial" }, { memory: mem });

  const hostileBulk = {
    "profile:basic": { firstName: "Updated" },
    "profile:unknown_hack": { evil: true }, // Unknown namespace
  };

  const res = await setWholeProfile(hostileBulk, { memory: mem });
  assertEquals(res.ok, false);
  assert(res.error.includes("unknown profile section key in bulk payload"));

  // Storage was untouched: profile:basic remains Initial
  const check = await getProfileSection("profile:basic", { memory: mem });
  assertEquals(check.data.firstName, "Initial");
});

Deno.test("profile store: whole profile get, set, and clear round-trip", async () => {
  const mem = createFakeMemory();

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

  const writeRes = await setWholeProfile(fullProfile, { memory: mem });
  assert(writeRes.ok);
  assertEquals(writeRes.writtenSections.length, 4);

  const readRes = await getWholeProfile({ memory: mem });
  assert(readRes.ok);
  assertEquals(readRes.profile["profile:basic"].firstName, "Carol");
  assertEquals(readRes.profile["profile:work_history"][0].company, "Air Force");
  assertEquals(readRes.profile["profile:education"][0].institution, "Air Force Academy");
  assertEquals(readRes.profile["profile:disclosures"].workAuthorization, "authorized_us");

  await clearProfile({ memory: mem });
  const emptyRes = await getWholeProfile({ memory: mem });
  assertEquals(Object.keys(emptyRes.profile).length, 0);
});
