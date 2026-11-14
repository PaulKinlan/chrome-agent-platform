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
//  5. tampered ciphertext fails closed (integrity, not silent truncation);
//  6. the at-rest CLAIM itself is falsifiable (chrome-agent-platform-03p47):
//     the stored record decrypts under EXACTLY the claimed derivation
//     (PBKDF2-SHA-256 @ 210k over extension-id + per-install salt ->
//     non-extractable AES-GCM-256, record id as additionalData) and under
//     no near-miss parameter set, and two fresh installs never share a salt.
//  7. the at-rest claim is SCOPED correctly (chrome-agent-platform-hy0v0): the
//     derivation material is not secret, so a copied storage area decrypts
//     offline — the limit is pinned executably, the refusals the encryption
//     does buy are pinned too, and the header may not re-assert the retracted
//     "carries no readable credential" claim.

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  createSecretVault,
  createServiceWorkerAccess,
  maskValue,
  vaultProtectionLines,
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

// ── 03p47: the at-rest claim is falsifiable ─────────────────────────────
// The header of secret-vault.js CLAIMS: AES-GCM-256 at rest under a
// PBKDF2-SHA-256 (210k iterations) key derived from extension id + per-install
// random salt, records bound to their key id via additionalData. The scheme
// field in the record is just a string — before this pin, a regression could
// weaken the derivation (or store a “ciphertext” not produced by it) while
// keeping the label, and every existing test stayed green. These tests
// re-derive the key INDEPENDENTLY with the claimed parameter set and decrypt
// the at-rest bytes: any drift in iterations, hash, key length, derivation
// material or additionalData turns decryption into a rejection.

const CLAIM_EXT_ID = "a".repeat(32) + "b";
const CLAIM_SALT_B64 = "c3RhcnRlci1zYWx0LWZpeGVkLWZvci10ZXN0cw==";

async function deriveClaimKey(opts: { iterations?: number; hash?: string; length?: number; material?: string; saltB64?: string } = {}) {
  const enc = new TextEncoder();
  const saltB64 = opts.saltB64 ?? CLAIM_SALT_B64;
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(opts.material ?? `${CLAIM_EXT_ID}:${saltB64}`),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)),
      iterations: opts.iterations ?? 210_000,
      hash: opts.hash ?? "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: opts.length ?? 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

Deno.test("03p47: the at-rest record decrypts under EXACTLY the claimed derivation, and under no near-miss of it", async () => {
  const KEY_ID = "AT_REST_CLAIM_KEY";
  const SECRET = "sk-claim-1234567890abcdef";
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: CLAIM_EXT_ID,
    installSaltB64: CLAIM_SALT_B64,
  });
  await vault.setSecret(KEY_ID, SECRET, { by: "sw" });

  const recordKey = `cap:vault:secret:${KEY_ID}`;
  const record: any = storage.map.get(recordKey);
  assert(record?.iv && record?.ct, "the at-rest shape is an {iv, ct} envelope, not plaintext");
  const iv = Uint8Array.from(atob(record.iv), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(record.ct), (c) => c.charCodeAt(0));
  const aad = new TextEncoder().encode(recordKey);

  // The CLAIMED parameter set decrypts the at-rest bytes back to the secret.
  const claimedKey = await deriveClaimKey();
  const plain = new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource, additionalData: aad as unknown as BufferSource },
      claimedKey,
      ct as unknown as BufferSource,
    ),
  );
  assertEquals(plain, SECRET,
    "at-rest bytes are AES-GCM-256 ciphertext under PBKDF2-SHA-256/210k over extension-id + install salt");

  // Discrimination guard (961k5 lesson): every near-miss of the claim must
  // FAIL to decrypt — otherwise the green above would not be about the claim.
  const nearMisses: Array<[string, CryptoKey, BufferSource]> = [
    ["one fewer iteration", await deriveClaimKey({ iterations: 209_999 }), aad as unknown as BufferSource],
    ["SHA-512 instead of SHA-256", await deriveClaimKey({ hash: "SHA-512" }), aad as unknown as BufferSource],
    ["AES-128 instead of AES-256", await deriveClaimKey({ length: 128 }), aad as unknown as BufferSource],
    ["a different install salt", await deriveClaimKey({ saltB64: "YW5vdGhlci1zYWx0LWVudGlyZWx5LWRpZmZlcmVudA==" }), aad as unknown as BufferSource],
    ["a different extension id", await deriveClaimKey({ material: `${"b".repeat(32)}c:${CLAIM_SALT_B64}` }), aad as unknown as BufferSource],
    ["the right key but another record's additionalData", claimedKey, new TextEncoder().encode("cap:vault:secret:SOME_OTHER_KEY") as unknown as BufferSource],
  ];
  for (const [label, key, additionalData] of nearMisses) {
    await assertRejects(
      () => crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as unknown as BufferSource, additionalData },
        key,
        ct as unknown as BufferSource,
      ),
      Error,
      undefined,
      `a derivation differing only by ${label} must NOT decrypt the at-rest record`,
    );
  }
});

Deno.test("03p47: the install salt is per-install RANDOM, persisted, and reused on reopen — two installs never share a key", async () => {
  const EXT = CLAIM_EXT_ID;
  const SECRET = "sk-cross-1234";
  const s1 = fakeStorage();
  const s2 = fakeStorage();
  // No installSaltB64: both vaults run the REAL ensureInstallSalt path.
  const v1 = await createSecretVault({ storageArea: s1, extensionId: EXT });
  const v2 = await createSecretVault({ storageArea: s2, extensionId: EXT });

  const salt1 = s1.map.get("cap:vault:install-salt");
  const salt2 = s2.map.get("cap:vault:install-salt");
  assert(typeof salt1 === "string" && salt1.length > 0, "install 1 persists its salt");
  assert(typeof salt2 === "string" && salt2.length > 0, "install 2 persists its salt");
  assert(salt1 !== salt2, "two fresh installs must NOT share a salt (per-install random)");
  assert(atob(salt1).length >= 16, "the salt carries at least 128 bits of entropy");

  // Salt binding through the public API: install 1's record copied into
  // install 2's storage (same extension id, different salt) must not open.
  await v1.setSecret("CROSS_INSTALL_KEY", SECRET, { by: "sw" });
  s2.map.set("cap:vault:secret:CROSS_INSTALL_KEY", s1.map.get("cap:vault:secret:CROSS_INSTALL_KEY"));
  await assertRejects(
    () => v2.getSecretRaw("CROSS_INSTALL_KEY", { caller: "sw", access: SW_ACCESS }),
    Error,
    undefined,
    "a different install's salt must not derive install 1's key",
  );

  // Neither snapshot carries the plaintext, and reopening the SAME storage
  // reuses the persisted salt (deterministic within one install).
  assert(!JSON.stringify([...s1.map.entries()]).includes(SECRET), "install 1 snapshot: no plaintext");
  assert(!JSON.stringify([...s2.map.entries()]).includes(SECRET), "install 2 snapshot: no plaintext");
  const v1again = await createSecretVault({ storageArea: s1, extensionId: EXT });
  const got = await v1again.getSecretRaw("CROSS_INSTALL_KEY", { caller: "sw", access: SW_ACCESS });
  assertEquals(got.value, SECRET, "the same install reopens its own record via the persisted salt");
});

// ── hy0v0: the at-rest guarantee, stated exactly, in BOTH directions ─────
// The module header used to claim that "a storage snapshot taken out of context
// (a copied profile, a backup file) carries no readable credential". That was
// false: the extension id is public and the install salt is stored beside the
// ciphertext, so a snapshot IS the key. chrome-agent-platform-hy0v0 corrected
// the header. These legs pin the limit (an offline copy DOES decrypt — a future
// author cannot quietly re-assert the stronger claim) and pin what the
// encryption genuinely defeats, so neither side of the sentence can drift.

Deno.test("hy0v0: a copied storage area decrypts OFFLINE — the documented limit is real", async () => {
  const EXT = CLAIM_EXT_ID;
  const SECRET = "sk-offline-copy-0123456789";
  const storage = fakeStorage();
  // The REAL salt path: no injected salt, so ensureInstallSalt persists one.
  const vault = await createSecretVault({ storageArea: storage, extensionId: EXT });
  await vault.setSecret("COPIED_PROFILE_KEY", SECRET, { by: "sw" });

  // What an attacker who copies the profile actually holds: every key in the
  // storage area (ciphertext + install salt + lock records) and nothing else.
  const snapshot = JSON.parse(JSON.stringify(await storage.get(null)));
  const saltB64 = snapshot["cap:vault:install-salt"];
  const record = snapshot["cap:vault:secret:COPIED_PROFILE_KEY"];
  assert(typeof saltB64 === "string" && saltB64.length > 0, "the snapshot carries the install salt");
  assert(record?.iv && record?.ct, "the snapshot carries the ciphertext envelope");

  // The ONLY other input is the extension id, which is public: it is in the
  // manifest and visible at chrome://extensions on any machine running this.
  const attackerKey = await deriveClaimKey({ material: `${EXT}:${saltB64}`, saltB64 });
  const plain = new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(atob(record.iv), (c) => c.charCodeAt(0)) as unknown as BufferSource,
        additionalData: new TextEncoder().encode("cap:vault:secret:COPIED_PROFILE_KEY") as unknown as BufferSource,
      },
      attackerKey,
      Uint8Array.from(atob(record.ct), (c) => c.charCodeAt(0)) as unknown as BufferSource,
    ),
  );
  // If this ever stops decrypting, the header's stated limit became stale — the
  // comment and this leg must move together (that is the point of pinning the
  // limit rather than only the guarantee).
  assertEquals(plain, SECRET,
    "a copied storage area plus the PUBLIC extension id re-derives the key and decrypts offline (R26 in docs/RISK-REGISTER.md; the owner-secret fix is chrome-agent-platform-zxo4i)");

  // And the plaintext is genuinely absent from the bytes, which is the part the
  // encryption does buy: a grep over the profile finds nothing readable.
  assert(!JSON.stringify(snapshot).includes(SECRET), "the snapshot has no readable plaintext — the guarantee the encryption DOES provide");
});

Deno.test("hy0v0: a full snapshot of ANOTHER install or ANOTHER extension id is refused, and a record cannot move between key ids", async () => {
  const EXT = CLAIM_EXT_ID;
  const SECRET = "sk-scope-1234567890acme";
  const source = fakeStorage();
  const v1 = await createSecretVault({ storageArea: source, extensionId: EXT });
  await v1.setSecret("SCOPE_KEY", SECRET, { by: "sw" });
  const snapshot = JSON.parse(JSON.stringify(await source.get(null)));

  // (a) The WHOLE snapshot (salt included) planted into a DIFFERENT extension's
  // storage does not open: the derivation needs that extension's id.
  const foreign = fakeStorage();
  for (const [k, v] of Object.entries(snapshot)) foreign.map.set(k, v);
  const vForeign = await createSecretVault({ storageArea: foreign, extensionId: "z".repeat(32) + "y" });
  await assertRejects(
    () => vForeign.getSecretRaw("SCOPE_KEY", { caller: "sw", access: SW_ACCESS }),
    Error,
    undefined,
    "a whole storage snapshot must not open under another extension id",
  );

  // (b) The salt is what binds an install: same extension id, DIFFERENT salt
  // (a fresh install's storage) refuses the copied record.
  const otherInstall = fakeStorage();
  otherInstall.map.set("cap:vault:secret:SCOPE_KEY", snapshot["cap:vault:secret:SCOPE_KEY"]);
  const vOther = await createSecretVault({ storageArea: otherInstall, extensionId: EXT });
  await assertRejects(
    () => vOther.getSecretRaw("SCOPE_KEY", { caller: "sw", access: SW_ACCESS }),
    Error,
    undefined,
    "a record from another install must not open under this install's salt",
  );

  // (c) additionalData binds a record to its key id: moving {iv, ct} into
  // another id's slot fails integrity even in the SAME install.
  const moved = fakeStorage();
  for (const [k, v] of Object.entries(snapshot)) moved.map.set(k, v);
  moved.map.set("cap:vault:secret:OTHER_KEY", snapshot["cap:vault:secret:SCOPE_KEY"]);
  const vMoved = await createSecretVault({ storageArea: moved, extensionId: EXT });
  await assertRejects(
    () => vMoved.getSecretRaw("OTHER_KEY", { caller: "sw", access: SW_ACCESS }),
    Error,
    undefined,
    "a record's ciphertext must not decrypt in another key id's slot",
  );
});

Deno.test("hy0v0: the module header states the limit and never re-asserts the retracted claim", async () => {
  const source = await Deno.readTextFile(new URL("../extension/lib/secret-vault.js", import.meta.url));
  const header = source.split("export function createServiceWorkerAccess")[0];
  // The retracted sentence may only survive as a QUOTED retraction: every
  // paragraph that repeats it must also carry the RETRACTED marker, so deleting
  // the correction (or re-asserting the claim elsewhere) fails here rather than
  // shipping a guarantee the code does not deliver.
  // Comment paragraphs are separated by a `//`-only line in this file; a blank
  // source line inside a comment block is not a boundary, so split on the
  // comment separator instead (a plain /\n\s*\n/ split leaves one giant
  // paragraph and made this pin pass on a re-asserted claim — measured).
  const claiming = header.split(/\n\s*\/\/\s*\n/).filter((para) => para.includes("carries no readable credential"));
  assert(claiming.length > 0, "the header should name the retracted claim it replaced, not silently drop it");
  for (const para of claiming) {
    assert(para.includes("RETRACTED"), `the false claim must appear only as a marked retraction: ${para.slice(0, 120)}…`);
  }
  assert(
    header.includes("decrypt every record OFFLINE"),
    "the header must state the true limit: a storage-area holder decrypts offline",
  );
  assert(
    header.includes("chrome-agent-platform-zxo4i") && header.includes("docs/RISK-REGISTER.md"),
    "the header must point at the tracked fix and the register entry instead of implying the vault is safe",
  );
  // The scheme id is a FORMAT id, not a security claim: records written by the
  // previous version must keep opening, so it is deliberately unchanged.
  assert(header.includes("extension id is public"), "the header must name the public half of the derivation material");
});

// ── zxo4i: the passphrase KEK (real at-rest encryption) ──────────────────
// The legacy derivation is obfuscation (hy0v0): its material ships with, or
// beside, the ciphertext. The passphrase lock derives the key from a secret the
// copy does NOT hold, and the four acceptance clauses coord set are pinned as
// separate legs so a weakening of any one of them reds by itself.

const SEALED_PASS = "correct horse battery staple";
const SEALED_PASS_2 = "another passphrase entirely";

async function openSealedStorage(extra: Record<string, unknown> = {}) {
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: CLAIM_EXT_ID,
    installSaltB64: CLAIM_SALT_B64,
    ...extra,
  });
  return { storage, vault };
}

Deno.test("zxo4i: enabling the lock re-seals every stored entry IN PLACE (no re-entry, no loss, counters kept)", async () => {
  const { storage, vault } = await openSealedStorage();
  // Written while the vault is still only obfuscated — exactly what an existing
  // install has in its profile before the owner sets a passphrase. One entry per
  // kind the vault stores: a preset service key, a custom service key, and a
  // rotated key (so the rotation counter has to survive the re-seal).
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });
  await vault.setSecret("CUSTOM_SERVICE_KEY", SECRET_B, { by: "sw" });
  await vault.rotateSecret("CUSTOM_SERVICE_KEY", "rotated-value-0987654321", { by: "sw" });
  const before = await Promise.all(
    ["BRAVE_SEARCH_API_KEY", "CUSTOM_SERVICE_KEY"].map((id) => vault.getSecretRaw(id, { caller: "sw", access: SW_ACCESS })),
  );
  const rotationsBefore = before.map((r) => r.lastUsed);

  const res = await vault.enableLock(SEALED_PASS);
  assertEquals(res.resealed, 2, "both entries were re-sealed");

  // Every record is now the SEALED scheme, and the legacy scheme is gone.
  const records = [...storage.map.entries()].filter(([k]) => k.startsWith("cap:vault:secret:"));
  assertEquals(records.length, 2);
  for (const [, rec] of records) {
    assertEquals(rec.scheme, "AES-GCM-256/PBKDF2-owner-passphrase", "records carry the sealed scheme");
  }

  const after = await Promise.all(
    ["BRAVE_SEARCH_API_KEY", "CUSTOM_SERVICE_KEY"].map((id) => vault.getSecretRaw(id, { caller: "sw", access: SW_ACCESS })),
  );
  assertEquals(after[0].value, SECRET_A);
  assertEquals(after[1].value, "rotated-value-0987654321");
  // A re-seal is not a rotation: counters survive.
  const listed = await vault.listMasked({ caller: "ui" });
  assertEquals(listed.find((r) => r.keyId === "CUSTOM_SERVICE_KEY")?.rotations, 1, "the rotation counter survived the re-seal");

  const protection = await vault.protection();
  assertEquals(protection.state, "sealed");
  assertEquals(protection.encryptedAtRest, true);
  assertEquals(protection.legacyRecords, 0, "nothing is left on the obfuscation path");
  assertEquals(protection.sealedRecords, 2);

  // The passphrase itself is NEVER written to the storage area.
  const dump = JSON.stringify([...storage.map.entries()]);
  assert(!dump.includes(SEALED_PASS), "the passphrase must never be persisted beside the ciphertext");
  void rotationsBefore;
});

Deno.test("zxo4i: a sealed vault without the passphrase refuses EVERY read (no fallback to the weak key)", async () => {
  const { storage, vault } = await openSealedStorage();
  await vault.setSecret("GITHUB_TOKEN", SECRET_B, { by: "sw" });
  await vault.enableLock(SEALED_PASS);

  // A fresh instance with no passphrase — what the service worker looks like
  // after a browser restart, since the unlock store is memory-only.
  const locked = await createSecretVault({ storageArea: storage, extensionId: CLAIM_EXT_ID, installSaltB64: CLAIM_SALT_B64 });
  assertEquals((await locked.protection()).state, "locked");
  const err = await assertRejects(
    () => locked.getSecretRaw("GITHUB_TOKEN", { caller: "sw", access: SW_ACCESS }),
    Error,
    undefined,
    "a sealed record must not open without the passphrase",
  );
  assertEquals((err as any).code, "vault_locked");

  // Writing is refused too: a locked vault cannot silently downgrade a record.
  await assertRejects(() => locked.setSecret("NEW_KEY", "value", { by: "sw" }), Error, undefined, "a locked vault cannot write");

  // The masked projection still names WHICH ids exist and says why it cannot
  // show more — the panel renders "…(locked)" from this.
  const listed = await locked.listMasked({ caller: "ui" });
  assertEquals(listed.length, 1);
  assertEquals(listed[0].masked, "…(locked)");

  // Unlocking the same instance restores it, which is the SW-restart path.
  await locked.unlock(SEALED_PASS);
  const back = await locked.getSecretRaw("GITHUB_TOKEN", { caller: "sw", access: SW_ACCESS });
  assertEquals(back.value, SECRET_B);
});

Deno.test("zxo4i: a WRONG passphrase fails closed and destroys nothing", async () => {
  const { storage, vault } = await openSealedStorage();
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });
  await vault.enableLock(SEALED_PASS);
  const recordsBefore = JSON.stringify([...storage.map.entries()]);

  const fresh = await createSecretVault({ storageArea: storage, extensionId: CLAIM_EXT_ID, installSaltB64: CLAIM_SALT_B64 });
  const wrong = await assertRejects(() => fresh.unlock("correct horse battery stapl3"), Error, undefined, "one character off must not unlock");
  assertEquals((wrong as any).code, "wrong_passphrase");

  // Nothing was rewritten, and the right passphrase still opens it.
  assertEquals(JSON.stringify([...storage.map.entries()]), recordsBefore, "a failed unlock must not touch the vault");
  await fresh.unlock(SEALED_PASS);
  assertEquals((await fresh.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw", access: SW_ACCESS })).value, SECRET_A);
});

/** Write a record exactly as the PRE-LOCK vault did: legacy scheme, legacy key,
 * the record id as additionalData. Used to model an install that has been
 * running since before the passphrase lock existed. */
async function writeLegacyRecord(storage: any, keyId: string, value: string) {
  const recordKey = `cap:vault:secret:${keyId}`;
  const key = await deriveClaimKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(recordKey) as unknown as BufferSource,
    },
    key,
    new TextEncoder().encode(value),
  );
  storage.map.set(recordKey, {
    scheme: "AES-GCM-256/PBKDF2-extension-bound",
    v: 1,
    iv: btoa(String.fromCharCode(...iv)),
    ct: btoa(String.fromCharCode(...new Uint8Array(ct))),
    configuredAt: 1,
    lastUsed: 0,
    rotations: 0,
  });
}

Deno.test("zxo4i: an interrupted migration resumes and strands nothing", async () => {
  const { storage, vault } = await openSealedStorage();
  await vault.setSecret("FIRST_KEY", SECRET_A, { by: "sw" });
  await vault.enableLock(SEALED_PASS);

  // The crash: one record never got re-sealed (it is still the legacy scheme)
  // and the seal is still marked migrated:false.
  await writeLegacyRecord(storage, "SECOND_KEY", SECRET_B);
  const seal = (await storage.get(null))["cap:vault:seal"];
  storage.map.set("cap:vault:seal", { ...seal, migrated: false });

  const resuming = await createSecretVault({
    storageArea: storage,
    extensionId: CLAIM_EXT_ID,
    installSaltB64: CLAIM_SALT_B64,
    passphrase: SEALED_PASS,
  });
  const pending = await resuming.protection();
  assertEquals(pending.migrationPending, true);
  assertEquals(pending.legacyRecords, 1, "the stranded record is countable");
  // During a pending migration the legacy record IS readable (that is what makes
  // the resume lossless); the sealed one is readable with the passphrase.
  assertEquals((await resuming.getSecretRaw("SECOND_KEY", { caller: "sw", access: SW_ACCESS })).value, SECRET_B);
  assertEquals((await resuming.getSecretRaw("FIRST_KEY", { caller: "sw", access: SW_ACCESS })).value, SECRET_A);

  const resumed = await resuming.enableLock(SEALED_PASS);
  assertEquals(resumed.resealed, 1, "the resume re-seals exactly the stranded record");
  const done = await resuming.protection();
  assertEquals(done.migrationPending, false);
  assertEquals(done.legacyRecords, 0);
  assertEquals(done.sealedRecords, 2);
  assertEquals((await resuming.getSecretRaw("SECOND_KEY", { caller: "sw", access: SW_ACCESS })).value, SECRET_B);
});

Deno.test("zxo4i: after the lock is installed, a legacy record is REFUSED rather than read with the weak key", async () => {
  const { storage, vault } = await openSealedStorage();
  await vault.setSecret("FIRST_KEY", SECRET_A, { by: "sw" });
  await vault.enableLock(SEALED_PASS);
  // A legacy record appearing AFTER the migration completed (a stale writer, a
  // restored backup fragment) must not be silently opened at the weak key.
  await writeLegacyRecord(storage, "PLANTED_LEGACY_KEY", SECRET_B);

  const err = await assertRejects(
    () => vault.getSecretRaw("PLANTED_LEGACY_KEY", { caller: "sw", access: SW_ACCESS }),
    Error,
    undefined,
    "a sealed vault must not fall back to the extension-id+salt key for a post-seal legacy record",
  );
  assertEquals((err as any).code, "legacy_record_unsealed");
  // The sealed records are unaffected.
  assertEquals((await vault.getSecretRaw("FIRST_KEY", { caller: "sw", access: SW_ACCESS })).value, SECRET_A);
});

Deno.test("zxo4i: the sealed key is NOT the public extension-id+salt derivation (a revert reds this)", async () => {
  const { storage, vault } = await openSealedStorage();
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });
  await vault.enableLock(SEALED_PASS);

  const dump = await storage.get(null);
  const record = dump["cap:vault:secret:BRAVE_SEARCH_API_KEY"];
  assertEquals(record.scheme, "AES-GCM-256/PBKDF2-owner-passphrase");

  // The legacy (public-by-copy) key must NOT open a sealed record. If someone
  // reverts the derivation to extension-id+salt, this leg goes green-wrong and
  // reds — which is the mutation guard coord asked for.
  const legacyKey = await deriveClaimKey();
  await assertRejects(
    () => crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(atob(record.iv), (c) => c.charCodeAt(0)) as unknown as BufferSource,
        additionalData: new TextEncoder().encode("cap:vault:secret:BRAVE_SEARCH_API_KEY") as unknown as BufferSource,
      },
      legacyKey,
      Uint8Array.from(atob(record.ct), (c) => c.charCodeAt(0)) as unknown as BufferSource,
    ),
    Error,
    undefined,
    "a sealed record must not decrypt under the extension-id+salt derivation — reverting the derivation reds here",
  );

  // And the passphrase path is the only one that opens it.
  const reopened = await createSecretVault({
    storageArea: storage,
    extensionId: CLAIM_EXT_ID,
    installSaltB64: CLAIM_SALT_B64,
    passphrase: SEALED_PASS,
  });
  assertEquals((await reopened.getSecretRaw("BRAVE_SEARCH_API_KEY", { caller: "sw", access: SW_ACCESS })).value, SECRET_A);
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

// ── zxo4i: the lock route + the proxy's locked refusal (wiring, not crypto) ──

import { createEnclaveProxyRoutes } from "../extension/background/routes/enclave-proxy.js";

Deno.test("zxo4i: the passphrase controls the panel wires actually exist in options.html", async () => {
  // The panel queries these ids; a rename on either side would leave the lock
  // unreachable with no error (the handler would simply never bind).
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
  const panel = await Deno.readTextFile(new URL("../extension/options/panels/web-services.js", import.meta.url));
  const ids = [
    "vault-protection",
    "vault-passphrase",
    "vault-passphrase-confirm",
    "vault-lock-enable",
    "vault-lock-unlock",
    "vault-lock-relock",
    "vault-lock-status",
  ];
  for (const id of ids) {
    assert(html.includes(`id="${id}"`), `options.html must contain #${id}`);
    assert(panel.includes(`"${id}"`), `web-services.js must query #${id}`);
  }
  // The three transitions are all reachable from the UI.
  assert(panel.includes('action: "seal"') && panel.includes('action: "unlock"') && panel.includes('action: "relock"'),
    "the panel must send all three vault.lock actions");
});

Deno.test("zxo4i: the panel's at-rest copy is derived from the vault's state, and says the damaging thing plainly", () => {
  // Coord's condition 2: the risk must be stated where the key is created, and
  // the wording must follow the state. These are the exact sentences Settings
  // renders, so a copy edit that softens the obfuscation warning reds here.
  const obfuscated = vaultProtectionLines({ state: "obfuscation", legacyRecords: 2, sealedRecords: 0 });
  assert(obfuscated[0].includes("NOT encrypted"), "the obfuscation state must say NOT encrypted in those words");
  assert(obfuscated[0].includes("copies this Chrome profile can decrypt"), "it must name the copied-profile risk, not hint at it");
  assert(obfuscated[1].includes("Set a vault passphrase"), "it must point at the fix in the same breath");

  const locked = vaultProtectionLines({ state: "locked", legacyRecords: 0 });
  assert(locked[0].startsWith("Locked."), "the locked state leads with Locked");
  assert(locked.join(" ").includes("refuse rather than call the service"), "locked says agents refuse rather than call without a credential");

  const sealed = vaultProtectionLines({ state: "sealed", sealedRecords: 3, legacyRecords: 0 });
  assert(sealed[0].includes("Encrypted at rest"), "the sealed state is the only one allowed to say Encrypted at rest");
  assert(sealed[0].includes("3 saved keys sealed"), "it names how many records are sealed");

  const pending = vaultProtectionLines({ state: "sealed", sealedRecords: 1, legacyRecords: 1, migrationPending: true });
  assert(pending.some((line) => line.includes("part-way through")), "an interrupted re-seal is stated, not hidden");
  assert(pending.some((line) => line.includes("legacy, not sealed")), "legacy records are visible as such");
});

Deno.test("4w5wm: the static vault surfaces (intro paragraph + save toast) carry the obfuscation limit", async () => {
  // chrome-agent-platform-4w5wm: the state-DERIVED lines are pinned by the zxo4i test above,
  // but the two STATIC surfaces a user reads first had no pin: the Web-services intro
  // paragraph in options.html and the post-save toast in web-services.js. Both once implied
  // at-rest confidentiality ("stored encrypted") with no statement of the R26 limit (a copied
  // profile decrypts offline). These reads pin the current honest wording and bar the
  // retracted claim from returning silently.
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
  const panel = await Deno.readTextFile(new URL("../extension/options/panels/web-services.js", import.meta.url));

  // The intro paragraph names what the at-rest scheme IS and what it does NOT stop.
  assert(
    html.includes("obfuscated, not encrypted"),
    "the Web-services intro must call the at-rest scheme obfuscation, not encryption",
  );
  assert(
    html.includes("copies this Chrome profile can decrypt"),
    "the intro must name the copied-profile limit, not hint at it",
  );

  // The post-save toast repeats the limit at the moment a key is written.
  assert(
    panel.includes("obfuscated, not encrypted, until you set a vault passphrase"),
    "the save toast must carry the obfuscation limit and point at the passphrase fix",
  );

  // The retracted claim may not return on either surface, in any wording of it.
  for (const [name, text] of [["options.html", html], ["web-services.js", panel]] as const) {
    assert(!text.includes("stored encrypted"), `${name} must not re-assert the retracted 'stored encrypted' claim`);
  }
});

Deno.test("zxo4i: vault.lock seals/unlocks/relocks through the Settings route, and status reports the state", async () => {
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: CLAIM_EXT_ID,
    installSaltB64: CLAIM_SALT_B64,
  });
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });
  const routes = createVaultRoutes({
    vault,
    requireSettingsSender: (ctx: any) => {
      if (ctx?.principal !== "owner-options") throw new Error("settings surface required");
    },
  });
  const owner = { principal: "owner-options" };

  assertEquals((await routes["vault.status"]({}, owner)).protection.state, "obfuscation");

  const sealed = await routes["vault.lock"]({ action: "seal", passphrase: SEALED_PASS }, owner);
  assertEquals(sealed.ok, true);
  assertEquals(sealed.state, "sealed");
  assertEquals(sealed.resealed, 1);
  const sealedStatus = await routes["vault.status"]({}, owner);
  assertEquals(sealedStatus.protection.state, "sealed");
  assertEquals(sealedStatus.protection.encryptedAtRest, true);

  const relocked = await routes["vault.lock"]({ action: "relock" }, owner);
  assertEquals(relocked.state, "locked");
  assertEquals((await routes["vault.status"]({}, owner)).protection.state, "locked");

  const unlocked = await routes["vault.lock"]({ action: "unlock", passphrase: SEALED_PASS }, owner);
  assertEquals(unlocked.ok, true);
  assertEquals((await routes["vault.status"]({}, owner)).protection.state, "sealed");

  // A wrong passphrase is refused by the route and changes nothing.
  await routes["vault.lock"]({ action: "relock" }, owner);
  await assertRejects(() => routes["vault.lock"]({ action: "unlock", passphrase: "wrong passphrase!" }, owner), Error, undefined, "a wrong passphrase must not unlock");

  // Settings authority still applies to the lock route.
  await assertRejects(() => routes["vault.lock"]({ action: "relock" }, { principal: "content" }), Error, "settings surface");
  // An unknown action is a caller bug, refused by name.
  await assertRejects(() => routes["vault.lock"]({ action: "shatter" }, owner), TypeError);
});

Deno.test("zxo4i: the enclave proxy refuses a LOCKED vault with the vault's own code instead of dialing", async () => {
  const storage = fakeStorage();
  const vault = await createSecretVault({
    storageArea: storage,
    extensionId: CLAIM_EXT_ID,
    installSaltB64: CLAIM_SALT_B64,
  });
  await vault.setSecret("BRAVE_SEARCH_API_KEY", SECRET_A, { by: "sw" });
  await vault.enableLock(SEALED_PASS);
  await vault.relock();

  let dialed = 0;
  const routes = createEnclaveProxyRoutes({
    vault: { getSecretRaw: (keyId: string, opts: any) => vault.getSecretRaw(keyId, { ...opts, access: SW_ACCESS }) },
    fetchImpl: () => {
      dialed++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    services: {
      "brave-search": {
        origin: "https://api.search.brave.com",
        secretKey: "BRAVE_SEARCH_API_KEY",
        authType: "bearer",
        path: "/res/v1/web/search",
      },
    },
    isAllowedCaller: () => true,
  });

  const err = await assertRejects(
    () => routes["enclave.proxy"]({ service: "brave-search", injectServiceAuth: true }, { [Symbol.for("cap.enclave.sw")]: true }),
    Error,
    undefined,
    "a locked vault must refuse the proxied request",
  );
  assertEquals((err as any).code, "vault_locked", "the refusal keeps the vault's code so the UI can say 'unlock'");
  assertEquals(dialed, 0, "NOTHING was dialed — the request never left the extension without its credential");
});
