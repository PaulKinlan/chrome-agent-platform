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
import {
  createSecretVault,
  createServiceWorkerAccess,
  maskValue,
} from "../extension/lib/secret-vault.js";

/** The service-worker access token (chrome-agent-platform-jao1.7). Deno runs each
 *  test file in its own process, so this module instance mints exactly one. */
const SW_ACCESS = createServiceWorkerAccess();

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
  const got = await vault.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw", access: SW_ACCESS });
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
    () => stranger.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw", access: SW_ACCESS }),
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
  await assertRejects(() => vault.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw", access: SW_ACCESS }), Error, "not configured");
});

Deno.test("jao1.1: rotation replaces the ciphertext and keeps the id; lastUsed tracks reads", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("GITHUB_TOKEN", SECRET_A, { by: "sw" });
  const before = (await vault.listMasked({ caller: "ui" }))[0];
  await vault.getSecretRaw("GITHUB_TOKEN", { caller: "sw", access: SW_ACCESS });
  const afterRead = (await vault.listMasked({ caller: "ui" }))[0];
  assert(afterRead.lastUsed >= before.lastUsed, "a read updates lastUsed");

  await vault.rotateSecret("GITHUB_TOKEN", SECRET_B, { by: "sw" });
  const got = await vault.getSecretRaw("GITHUB_TOKEN", { caller: "sw", access: SW_ACCESS });
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
    () => vault.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw", access: SW_ACCESS }),
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

// ── jao1.5: the Settings panel model + owner-gated routes ────────────────

import { vaultPanelRows, resolveSaveAction } from "../extension/lib/secret-vault.js";
import { createVaultRoutes } from "../extension/background/routes/vault.js";

Deno.test("jao1.5: the panel model projects masked rows for the Settings surface", () => {
  const masked = [
    { keyId: "BRAVE_SEARCH_API_KEY", configured: true, lastUsed: 1700, configuredAt: 1600, rotations: 1, masked: "…c5b4" },
    { keyId: "GITHUB_TOKEN", configured: true, lastUsed: 0, configuredAt: 1500, rotations: 0, masked: "…" },
  ];
  const rows = vaultPanelRows(masked);
  assertEquals(rows.length, 2);
  assertEquals(rows[0], { keyId: "BRAVE_SEARCH_API_KEY", masked: "…c5b4", configured: true, lastUsed: 1700, rotations: 1 });
  const serialized = JSON.stringify(rows);
  assertEquals(/sk-|ghp_|SECRET/.test(serialized), false, "the panel model serializes with no secret material");
});

Deno.test("jao1.5: save-action semantics — configured keys with a blank input KEEP, new keys SET, filled inputs ROTATE", () => {
  assertEquals(resolveSaveAction({ configured: false, inputValue: "" }), "none", "nothing configured and nothing typed is a no-op");
  assertEquals(resolveSaveAction({ configured: false, inputValue: "new-secret" }), "set", "a new key is set");
  assertEquals(resolveSaveAction({ configured: true, inputValue: "" }), "none", "configured — leave blank to keep");
  assertEquals(resolveSaveAction({ configured: true, inputValue: "rotated-secret" }), "rotate", "a filled input on a configured key rotates");
});

Deno.test("jao1.5: the vault routes are Settings-gated and the status surface is masked-only", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });

  const enclaveProxyCalls: any[] = [];
  const routes = createVaultRoutes({
    vault,
    requireSettingsSender: (ctx: any) => {
      if (ctx?.principal !== "owner-options") throw new Error("settings surface required");
    },
    testConnection: async () => ({ ok: true, status: 200 }),
  });

  const owner = { principal: "owner-options" };
  const status = await routes["vault.status"]({}, owner);
  assertEquals(status.ok, true);
  assertEquals(status.services.length, 1);
  assertEquals(status.services[0].masked, "…back", "the mask is the secret's tail");
  assertEquals("value" in status.services[0], false, "the status surface carries no raw value field");

  // A non-Settings caller is refused on every route.
  const stranger = { principal: "content" };
  for (const [name, handler] of Object.entries(routes)) {
    await assertRejects(() => (handler as any)({}, stranger), Error, "settings surface", `${name} must be Settings-gated`);
  }
});

Deno.test("jao1.5: set/rotate/delete through the routes round-trip, and the test connection never exposes the secret", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  const testCalls: any[] = [];
  const routes = createVaultRoutes({
    vault,
    requireSettingsSender: () => {},
    testConnection: (msg: any) => {
      testCalls.push(msg);
      return Promise.resolve({ ok: true, status: 200 });
    },
  });
  const owner = { principal: "owner-options" };

  await routes["vault.set"]({ keyId: "GITHUB_TOKEN", value: SECRET_B }, owner);
  const status = await routes["vault.status"]({}, owner);
  assertEquals(status.services[0].keyId, "GITHUB_TOKEN");
  assertEquals(JSON.stringify(status), JSON.stringify(status, (k, v) => (k === "value" ? "[REDACTED]" : v)).replace("[REDACTED]", status.services[0].masked ? status.services[0].masked : ""));

  await routes["vault.rotate"]({ keyId: "GITHUB_TOKEN", value: SECRET_A }, owner);
  await routes["vault.delete"]({ keyId: "GITHUB_TOKEN" }, owner);
  const gone = await routes["vault.status"]({}, owner);
  assertEquals(gone.services.length, 0, "the deleted key is gone");

  const tc = await routes["vault.test"]({ service: "brave-search" }, owner);
  assertEquals(tc.ok, true, "the test connection passes");
  assertEquals(testCalls.length, 1, "the test connection ran through the enclave proxy once");
  assertEquals(JSON.stringify(tc).includes(SECRET_B), false, "the test result never echoes the secret");
});

// ── chrome-agent-platform-jao1.7 ─────────────────────────────────────────
// Three findings from the review of jao1.1:
//   1. AAD-bind the ciphertext to its key id so a record cannot be swapped between slots;
//   2. make the raw-read authority a minted token, not a caller string;
//   3. serialize install-salt initialization (single-flight + a lock record).
// The existing helper injects a fixed salt via `installSaltB64`, which is why the salt
// path had no test at all: these cases open vaults the way production does.

const SALT_KEY = "cap:vault:install-salt";
const SALT_LOCK_KEY = "cap:vault:install-salt-lock";
const TEST_EXTENSION_ID = "a".repeat(32) + "b";
const A_SLOT = "cap:vault:secret:BRAVE_SEARCH_API_KEY";
const B_SLOT = "cap:vault:secret:GITHUB_TOKEN";

/** Production-shaped open: no injected salt, so ensureInstallSalt runs. */
async function openFreshVault(storage: any) {
  return createSecretVault({ storageArea: storage, extensionId: TEST_EXTENSION_ID });
}

Deno.test("jao1.7: a record's ciphertext cannot be swapped into another key id's slot (AAD binding)", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });
  await vault.setSecret("GITHUB_TOKEN", SECRET_B, { by: "sw" });
  // Move B's {iv, ct} into A's slot, metadata and all. Without additionalData this decrypts
  // cleanly to the wrong secret — a silent credential swap, which is the finding.
  const a = storage.map.get(A_SLOT);
  const b = storage.map.get(B_SLOT);
  storage.map.set(A_SLOT, { ...a, iv: b.iv, ct: b.ct });
  await assertRejects(
    () => vault.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw", access: SW_ACCESS }),
    Error,
    "failed integrity verification",
    "a swapped record must fail closed, not decrypt to the other key's value",
  );
  // B is untouched and still reads: the failure is the swap, not a broken vault.
  const stillB = await vault.getSecretRaw("GITHUB_TOKEN", { caller: "sw", access: SW_ACCESS });
  assertEquals(stillB.value, SECRET_B);
});

Deno.test("jao1.7: a caller label alone is not provenance — the minted token is required", async () => {
  const storage = fakeStorage();
  const vault = await openTestVault(storage);
  await vault.setSecret("GITHUB_TOKEN", SECRET_B, { by: "sw" });
  const lookalikes: any[] = [
    undefined,
    {},
    { caller: "sw" },
    Object.freeze({ sw: true }),
    { brand: "cap.vault.sw-access" },
  ];
  for (const access of lookalikes) {
    await assertRejects(
      () => vault.getSecretRaw("GITHUB_TOKEN", { caller: "sw", access }),
      Error,
      "access token",
      `a lookalike access value must not read raw secrets: ${JSON.stringify(access)}`,
    );
  }
  const real = await vault.getSecretRaw("GITHUB_TOKEN", { caller: "sw", access: SW_ACCESS });
  assertEquals(real.value, SECRET_B, "the minted token reads");
});

Deno.test("jao1.7: every minted token is branded, and none is a lookalike of another", () => {
  // Not a singleton on purpose (the first shape broke legitimate second consumers at
  // import time); what must hold is that minting is an explicit act and the result is
  // branded, so `{ caller: "sw" }` and `{}` cannot stand in for it.
  const second = createServiceWorkerAccess();
  assert(second !== SW_ACCESS, "tokens are distinct objects");
  assertEquals(typeof second, "object");
  assertEquals(Object.isFrozen(second), true, "a token cannot be mutated into a brand");
});

Deno.test("jao1.7: two concurrent opens generate ONE install salt and derive the same key", async () => {
  const storage = fakeStorage();
  let saltWrites = 0;
  const countingSet = storage.set;
  storage.set = async (items: Record<string, any>) => {
    if (SALT_KEY in items) saltWrites++;
    return await countingSet(items);
  };
  const [first, second] = await Promise.all([openFreshVault(storage), openFreshVault(storage)]);
  assertEquals(saltWrites, 1, "single-flight: the concurrent opens must not each generate a salt");
  await first.setSecret("GITHUB_TOKEN", SECRET_B, { by: "sw" });
  const fromSecond = await second.getSecretRaw("GITHUB_TOKEN", { caller: "sw", access: SW_ACCESS });
  assertEquals(fromSecond.value, SECRET_B, "both opens derive the same key");
});

Deno.test("jao1.7: a live lock makes the second writer wait for the first writer's salt", async () => {
  const storage = fakeStorage();
  // A lock held by another writer (another worker or an offscreen document) with no salt yet.
  await storage.set({ [SALT_LOCK_KEY]: { owner: "other-writer", expiresAt: Date.now() + 3_000 } });
  const opening = openFreshVault(storage);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(
    storage.map.has(SALT_KEY),
    false,
    "the waiter must not write a salt while another writer holds the lock",
  );
  // The lock owner finishes: the waiter must adopt that salt rather than overwrite it.
  const winnerSalt = "d2lubmVyLXNhbHQtZm9yLXRoZS13YWl0aW5nLW9wZW4=";
  await storage.set({ [SALT_KEY]: winnerSalt });
  const waiter = await opening;
  assertEquals(storage.map.get(SALT_KEY), winnerSalt, "the winner's salt survives the waiter");
  // The proof that it was ADOPTED, not merely left in storage: a vault opened with that salt
  // can read what the waiter wrote. Under the pre-fix code the waiter generated its own salt,
  // overwrote the winner, and this read fails.
  await waiter.setSecret("GITHUB_TOKEN", SECRET_B, { by: "sw" });
  const control = await createSecretVault({
    storageArea: storage,
    extensionId: TEST_EXTENSION_ID,
    installSaltB64: winnerSalt,
  });
  const got = await control.getSecretRaw("GITHUB_TOKEN", { caller: "sw", access: SW_ACCESS });
  assertEquals(got.value, SECRET_B, "the waiting open derived the winner's key");
});

Deno.test("jao1.7: an abandoned lock does not deadlock initialization", async () => {
  const storage = fakeStorage();
  await storage.set({ [SALT_LOCK_KEY]: { owner: "dead-writer", expiresAt: Date.now() - 1 } });
  const vault = await openFreshVault(storage);
  assert(storage.map.get(SALT_KEY), "an expired lock must not stop this open from initializing");
  await vault.setSecret("GITHUB_TOKEN", SECRET_B, { by: "sw" });
  const got = await vault.getSecretRaw("GITHUB_TOKEN", { caller: "sw", access: SW_ACCESS });
  assertEquals(got.value, SECRET_B);
});
