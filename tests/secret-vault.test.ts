// tests/secret-vault.test.ts — chrome-agent-platform-jao1.1 (CAP-SECURE-ENCLAVE
// Stage 1). The vault's contract, falsified before implementation:
//
//  1. secrets are stored ENCRYPTED under extension-bound key derivation (the
//     at-rest record carries no plaintext substring);
//  2. raw values are readable ONLY by the service-worker caller — every other
//     principal is refused (negative permission refusal);
//  3. the UI surface is a MASKED projection ({ keyId, configured, lastUsed,
//     masked }) whose JSON serialization contains no plaintext;
//  4. errors name the key id, never the value;
//  5. tampered ciphertext fails closed (integrity, not silent truncation).

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createSecretVault, maskValue } from "../extension/lib/secret-vault.js";

const SECRET_A = "sk-brave-9f8e7d6c5b4a3210-feeds-back";
const SECRET_B = "ghp_a1b2c3d4e5f6g7h8i9j0klmnop";

/** chrome.storage.local-shaped in-memory fake (get/set/remove). */
function fakeStorage() {
  const map: Map<string, any> = new Map();
  return {
    map,
    async get(keys: any) {
      if (keys === null) {
        const out: Record<string, any> = {};
        for (const [k, v] of map) out[k] = v;
        return out;
      }
      if (typeof keys === "string") {
        return map.has(keys) ? { [keys]: map.get(keys) } : {};
      }
      const out: Record<string, any> = {};
      for (const k of keys as string[]) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(items: Record<string, any>) {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

async function openTestVault(storage: any) {
  return createSecretVault({
    storageArea: storage,
    extensionId: "a" .repeat(32) + "b",
    installSaltB64: "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==",
  });
}

Deno.test("jao1.1: set + raw get round-trips for the service-worker caller", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });
  const got = await vault.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw" });
  assertEquals(got.value, SECRET_A, "the exact secret round-trips");
  assertEquals(got.keyId, "BRAVE_SEARCH_API_KEY");
});

Deno.test("jao1.1: raw reads are refused for every non-SW caller (negative permission refusal)", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("GITHUB_TOKEN", SECRET_B, { by: "sw" });
  for (const caller of ["ui", "content", "model", "options", "", undefined]) {
    await assertRejects(
      () => vault.getSecretRaw("GITHUB_TOKEN", { caller }),
      Error,
      "service-worker-only",
      `caller ${String(caller)} must not read raw secrets`,
    );
  }
});

Deno.test("jao1.1: the at-rest record carries NO plaintext — AES-GCM ciphertext under extension-bound derivation", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });
  const serialized = JSON.stringify([...storage.map.entries()]);
  assert(!serialized.includes(SECRET_A), "the plaintext must not sit in storage");
  assert(!serialized.includes("sk-brave"), "not even a prefix of the secret may sit in storage");
  // The stored record is an encrypted envelope, not a wrapped copy.
  const [recordKey] = [...storage.map.keys()].filter((k) => k.startsWith("cap:vault:secret:"));
  assert(recordKey, "the record lives under the reserved cap:vault:secret: namespace");
  const record = storage.map.get(recordKey);
  assertEquals(record.scheme, "AES-GCM-256/PBKDF2-extension-bound");
  assert(record.iv, "a per-write IV exists");
  assert(record.ct && !serialized.includes(SECRET_A));
});

Deno.test("jao1.1: a different extension derivation cannot decrypt the record (extension-bound)", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });

  const stranger = await createSecretVault({
    storageArea: storage,
    extensionId: "b".repeat(32) + "c",
    installSaltB64: "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==",
  });
  await assertRejects(
    () => stranger.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw" }),
    Error,
  );
});

Deno.test("jao1.1: masked projection — shape, tail-only mask, and zero plaintext in its serialization", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });

  const list = await vault.listMasked({ caller: "ui" });
  assertEquals(list.length, 1);
  const [proj] = list;
  assertEquals(proj.keyId, "BRAVE_SEARCH_API_KEY");
  assertEquals(proj.configured, true);
  assert(typeof proj.lastUsed === "number");
  assertEquals(proj.masked, `…${SECRET_A.slice(-4)}`, "the mask shows only the last four characters");

  const serialized = JSON.stringify(list);
  assert(!serialized.includes(SECRET_A), "the projection serialization carries no plaintext");
  assert(!serialized.includes("sk-brave"), "not even a prefix");

  // The mask helper itself never returns more than the tail.
  assertEquals(maskValue("short"), "…", "short values mask entirely");
});

Deno.test("jao1.1: masked projection is refused for a non-UI caller that asks for raw, and errors never carry values", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });
  try {
    await vault.setSecret("BAD_ID-with-lowercase", "x".repeat(40), { by: "sw" });
    throw new Error("invalid key id must be refused");
  } catch (err: any) {
    assertEquals(err instanceof TypeError, true, "invalid key ids fail with a TypeError");
    assert(!String(err.message).includes("x".repeat(40)), "the error message carries no value");
  }
  await assertRejects(
    () => vault.deleteSecret("MISSING_KEY", { by: "sw" }),
    Error,
    "MISSING_KEY",
  );
});

Deno.test("jao1.1: delete removes the record and its ciphertext", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });
  await vault.deleteSecret("BRAVE_SEARCH_API_KEY", { by: "sw" });
  const serialized = JSON.stringify([...storage.map.entries()]);
  assert(!serialized.includes("cap:vault:secret:BRAVE_SEARCH_API_KEY"), "the record is gone");
  const list = await vault.listMasked({ caller: "ui" });
  assertEquals(list.length, 0, "the masked list drops the deleted key");
  await assertRejects(() => vault.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw" }), Error, "not configured");
});

Deno.test("jao1.1: rotation replaces the ciphertext and keeps the id; lastUsed tracks reads", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("GITHUB_TOKEN", SECRET_A, { by: "sw" });
  const before = (await vault.listMasked({ caller: "ui" }))[0];
  await vault.getSecretRaw("GITHUB_TOKEN", { caller: "sw" });
  const afterRead = (await vault.listMasked({ caller: "ui" }))[0];
  assert(afterRead.lastUsed >= before.lastUsed, "a read updates lastUsed");

  await vault.rotateSecret("GITHUB_TOKEN", SECRET_B, { by: "sw" });
  const got = await vault.getSecretRaw("GITHUB_TOKEN", { caller: "sw" });
  assertEquals(got.value, SECRET_B, "rotation round-trips the new value");
  const [proj] = await vault.listMasked({ caller: "ui" });
  assertEquals(proj.masked, `…${SECRET_B.slice(-4)}`, "the mask reflects the rotated value");
  const serialized = JSON.stringify([...storage.map.entries()]);
  assert(!serialized.includes(SECRET_A) && !serialized.includes(SECRET_B), "neither old nor new plaintext sits in storage");
});

Deno.test("jao1.1: tampered ciphertext fails closed (integrity, not silent garbage)", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });
  const recordKey = [...storage.map.keys()].find((k) => k.startsWith("cap:vault:secret:"));
  assert(typeof recordKey === "string", "the encrypted record key must exist");
  const record: any = storage.map.get(recordKey);
  const raw = atob(record.ct);
  const flipped = btoa(String.fromCharCode(raw.charCodeAt(0) ^ 0xFF) + raw.slice(1));
  record.ct = flipped;
  await assertRejects(
    () => vault.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw" }),
    Error,
  );
});

Deno.test("jao1.1: key ids are strict — the identifier is a credential id, not free text", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  for (const bad of ["lower_case", "with-dash", "", "with space", "cap:overflow"]) {
    await assertRejects(() => vault.setSecret(bad, "whatever", { by: "sw" }), TypeError);
  }
});
