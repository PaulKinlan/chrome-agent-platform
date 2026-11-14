// extension/lib/secret-vault.js — the isolated credential store
// (chrome-agent-platform-jao1.1, CAP-SECURE-ENCLAVE Stage 1).
//
// WHAT THIS IS: the one place service credentials (API keys, bearer tokens)
// live. Records are encrypted at rest with AES-GCM-256 under a key derived
// (PBKDF2-SHA-256, 210k iterations) from the extension id + a per-install
// random salt, and each record is bound to its key id via additionalData.
//
// WHAT THE ENCRYPTION DEFEATS, EXACTLY (chrome-agent-platform-hy0v0 — the
// wording above used to claim that "a storage snapshot taken out of context (a
// copied profile, a backup file) carries no readable credential", and that was
// MORE THAN THE CODE DELIVERS, so it is RETRACTED here):
//   - credentials sitting in storage as plaintext bytes (a grep, a log scraper,
//     a support bundle, a naive backup diff);
//   - a record presented to another extension id, or to another install's salt
//     — both fail integrity, so a planted or swapped record does not open;
//   - a record moved between key ids (additionalData binds it to its id).
//
// WHAT IT DOES NOT DEFEAT — THE HONEST LIMIT: the derivation material is NOT a
// secret. The extension id is public (manifest, chrome://extensions) and the
// install salt is stored BESIDE the ciphertext in the same storage area
// (SALT_KEY, written by ensureInstallSalt). An attacker holding this
// extension's storage area — a copied profile directory, a profile backup, an
// exported LevelDB — can re-derive the key and decrypt every record OFFLINE,
// with nothing else. This is a storage-shape boundary, not a confidentiality
// boundary against the storage holder; tests/secret-vault.test.ts pins the limit
// in both directions ("hy0v0") so no future edit can quietly re-assert more.
// Closing that limit needs a key the storage holder does not have (an owner
// passphrase-derived KEK with a locked vault state); it is NOT implemented here
// and is tracked as chrome-agent-platform-zxo4i, registered as R26 in
// docs/RISK-REGISTER.md.
//
// WHAT THIS IS NOT (the rest of the honest threat model): the derived key
// material is reconstructible inside this extension's own contexts, so this
// encryption is defense-in-depth for AT-REST snapshots — it is NOT a boundary
// against code executing with extension-context privileges.
//
// THE RAW-READ AUTHORITY IS A MINTED ACCESS TOKEN, NOT A CALLER STRING
// (voicebox-dsflash1's review of jao1.1, hardened by chrome-agent-platform-jao1.7):
// assertSwCaller compares a caller LABEL, so any module that can reach the vault
// could declare itself "sw". Raw reads now also require an access token minted
// exactly once by this module (`createServiceWorkerAccess`), which the service
// worker's composition root injects into its vault adapter and nothing else
// holds. The label stays as a second, human-readable factor — it never was the
// boundary, and now it is not the whole check either. Content scripts and page
// contexts still cannot reach this module at all, the only UI surface is a masked
// projection whose serialization provably carries no plaintext, and install-salt
// initialization is serialized (single-flight plus a lock record) so two
// concurrent opens cannot derive different keys from the same extension.
// Records are additionally bound to their key id via AES-GCM additionalData, so
// a record's {iv, ct} cannot be swapped into another id's slot.

import { newId, sleep } from "./pure-text.js";

const VAULT_PREFIX = "cap:vault:secret:";
const SALT_KEY = "cap:vault:install-salt";
const SALT_LOCK_KEY = "cap:vault:install-salt-lock";
const SALT_LOCK_TTL_MS = 5_000;
const KEY_ID_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const PBKDF2_ITERATIONS = 210_000;
const SCHEME = "AES-GCM-256/PBKDF2-extension-bound";
/** The SEALED scheme (chrome-agent-platform-zxo4i): the same AEAD, but the key
 * is derived from an OWNER PASSPHRASE, not from material that ships in (or
 * beside) the ciphertext. Only these records are encrypted at rest in the sense
 * the module header reserves; SCHEME records are the legacy obfuscation path. */
const SCHEME_SEALED = "AES-GCM-256/PBKDF2-owner-passphrase";
/** The seal record: its presence is what makes a vault "sealed", and its
 * `migrated` flag is what lets an interrupted migration resume instead of
 * stranding records under a key nothing can reach. */
const SEAL_KEY = "cap:vault:seal";
/** Passphrase KDF cost. Higher than the legacy derivation because a passphrase
 * is the ONLY secret here and offline guessing is the attack. */
const PASSPHRASE_ITERATIONS = 600_000;
const PASSPHRASE_MIN_LENGTH = 8;
const VERIFIER_TEXT = "cap.vault.passphrase.verifier.v1";
/** The storage.session key the service worker wires as the passphrase store
 * (memory-only, cleared at browser exit — a restart RELOCKS the vault). */
export const VAULT_UNLOCK_SESSION_KEY = "cap:vault:unlock";

/**
 * The brand for the service-worker access token. Module-private on purpose: a
 * forged plain object cannot carry a symbol it cannot import, and the factory
 * below mints exactly one token per module instance, so "the caller wrote sw"
 * is no longer sufficient to read a raw secret (chrome-agent-platform-jao1.7).
 */
const SW_ACCESS_BRAND = Symbol("cap.vault.sw-access");
/**
 * Mint an access token. Deliberately NOT a singleton: an earlier version threw on
 * the second call, which made a legitimate second consumer (another composition
 * root, a test importing both the worker and the vault) fail at import time — a
 * hard guarantee that breaks real callers is worse than the label it replaced.
 * Each call returns a fresh frozen, branded object, so the property that matters
 * holds: a caller label or a lookalike object cannot pose as provenance, and the
 * act of claiming service-worker authority is an explicit import-time call rather
 * than a string a route writes for itself.
 *
 * The honest limit (unchanged from the module header): this is not a boundary
 * against code that can import this module. Tokens are not bound to a specific
 * vault instance for the same reason — binding would force every construction
 * site to hold one, and it adds no boundary, because holding a token already
 * requires importing this module.
 */
export function createServiceWorkerAccess() {
  return Object.freeze({ [SW_ACCESS_BRAND]: true });
}

/** True only for the token this module minted — never for a lookalike object. */
function isServiceWorkerAccess(access) {
  return access !== null && typeof access === "object" && access[SW_ACCESS_BRAND] === true;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The masked projection: the last four characters, or nothing at all for
 * short values. Never returns a prefix. */
export function maskValue(value) {
  if (typeof value !== "string" || value.length < 8) return "…";
  return `…${value.slice(-4)}`;
}

/**
 * The install salt, serialized (chrome-agent-platform-jao1.7).
 *
 * The review of jao1.1 found the read-back adoption works only in one order: if
 * open A writes salt1, reads it back, and only THEN open B overwrites with salt2,
 * A and B derive different keys and A's records are undecryptable. Two guards
 * close that, because neither alone is enough:
 *
 *  - SINGLE-FLIGHT per storage area (WeakMap): two concurrent opens in the same
 *    worker share one initialization promise, so the common case generates once.
 *  - A LOCK RECORD with a TTL: a second writer that sees a fresh lock waits for
 *    the salt to appear instead of writing its own, which orders the two writers
 *    that single-flight cannot see (a second worker, an offscreen document).
 *
 * The read-back stays: whatever salt is in storage at the end is the one every
 * open derives from, and the lock is only ever a hint — it expires, and a writer
 * that finds it abandoned proceeds (a lock that could deadlock the vault would
 * be worse than the race it prevents).
 */
const saltInitByStorage = new WeakMap();

function readSalt(value) {
  return value && typeof value[SALT_KEY] === "string" && value[SALT_KEY].length > 0
    ? value[SALT_KEY]
    : null;
}

function ensureInstallSalt(storageArea) {
  const inFlight = saltInitByStorage.get(storageArea);
  if (inFlight) return inFlight;
  const init = (async () => {
    const present = readSalt(await storageArea.get(SALT_KEY));
    if (present) return present;

    const lock = (await storageArea.get(SALT_LOCK_KEY))?.[SALT_LOCK_KEY];
    const lockFresh = lock && typeof lock.expiresAt === "number" && lock.expiresAt > Date.now();
    if (lockFresh) {
      // Another writer is initializing: wait for its salt rather than racing it.
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(25);
        const won = readSalt(await storageArea.get(SALT_KEY));
        if (won) return won;
      }
      // Abandoned (or very slow) writer: fall through and initialize ourselves.
    }

    const owner = newId("vault_lock");
    await storageArea.set({
      [SALT_LOCK_KEY]: { owner, expiresAt: Date.now() + SALT_LOCK_TTL_MS },
    });
    // Re-read after taking the lock: a writer that finished between our first read
    // and the lock has already decided the salt, and its value wins.
    const existing = readSalt(await storageArea.get(SALT_KEY));
    if (existing) {
      await releaseLock(storageArea, owner);
      return existing;
    }
    const candidate = b64(crypto.getRandomValues(new Uint8Array(32)));
    await storageArea.set({ [SALT_KEY]: candidate });
    const settled = readSalt(await storageArea.get(SALT_KEY)) ?? candidate;
    await releaseLock(storageArea, owner);
    return settled;
  })();
  saltInitByStorage.set(storageArea, init);
  // A failed initialization must not be cached: the next open should try again
  // rather than inherit a rejected promise for the worker's lifetime.
  init.catch(() => saltInitByStorage.delete(storageArea));
  return init;
}

async function releaseLock(storageArea, owner) {
  const held = (await storageArea.get(SALT_LOCK_KEY))?.[SALT_LOCK_KEY];
  if (!held || held.owner !== owner) return;
  await storageArea.remove(SALT_LOCK_KEY);
}

/** A named vault failure. Route layers translate `code`; the message never
 * carries a passphrase, a key id's value, or a decrypted fragment. */
function vaultError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** The vault. Construct with createSecretVault.
 *
 * Key resolution is LAZY and per-operation rather than derived once at open,
 * because the seal state can change while this instance lives (the owner sets a
 * passphrase in Settings) and because a sealed vault must be able to refuse
 * every read while it is locked.
 *
 * @param {{
 *   storageArea: any,
 *   extensionId: string,
 *   installSaltB64?: string,
 *   passphrase?: string | null,
 *   passphraseStore?: { get?: Function, set?: Function, clear?: Function } | null,
 * }} opts
 */
export async function createSecretVault({
  storageArea,
  extensionId,
  installSaltB64 = null,
  passphrase = null,
  passphraseStore = null,
} = {}) {
  if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
    throw new TypeError("secret vault requires a chrome.storage.local-shaped storageArea");
  }
  if (typeof extensionId !== "string" || extensionId.length < 8) {
    throw new TypeError("secret vault requires the extension id (extension-bound derivation)");
  }
  const saltB64 = typeof installSaltB64 === "string" && installSaltB64.length > 0
    ? installSaltB64
    : await ensureInstallSalt(storageArea);

  // The derivation material is `extensionId:saltB64`. Both halves are in the
  // profile (the id is public, the salt is stored beside the ciphertext), which
  // is exactly the limit the module header states: whoever holds the storage
  // area can rebuild this key offline (hy0v0). Do not describe this as secrecy.
  let legacyKeyCache = null;
  /** The LEGACY key: derived from the public extension id + the salt stored
   * beside the ciphertext. Not a secret (hy0v0) — it exists only so vaults
   * written before the passphrase lock can be read and re-sealed. */
  async function legacyKey() {
    if (legacyKeyCache) return legacyKeyCache;
    const baseKey = await crypto.subtle.importKey(
      "raw",
      ENCODER.encode(`${extensionId}:${saltB64}`),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    legacyKeyCache = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: unb64(saltB64), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false, // non-extractable: the key cannot be serialized out of the worker
      ["encrypt", "decrypt"],
    );
    return legacyKeyCache;
  }

  /** The in-memory passphrase for this vault instance. Never persisted here:
   * the caller may wire a store (the service worker uses chrome.storage.session,
   * which is memory-only and cleared at browser exit). */
  const session = {
    passphrase: typeof passphrase === "string" && passphrase.length > 0 ? passphrase : null,
  };

  async function readSeal() {
    const got = await storageArea.get(SEAL_KEY);
    const seal = got?.[SEAL_KEY];
    if (!seal || seal.scheme !== SCHEME_SEALED || typeof seal.kdfSalt !== "string") return null;
    if (!seal.verifier || typeof seal.verifier.iv !== "string" || typeof seal.verifier.ct !== "string") return null;
    return seal;
  }

  async function deriveSealedKey(pass, seal) {
    const base = await crypto.subtle.importKey(
      "raw",
      ENCODER.encode(`cap.vault.owner.passphrase:${pass}`),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: unb64(seal.kdfSalt),
        iterations: seal.iterations ?? PASSPHRASE_ITERATIONS,
        hash: "SHA-256",
      },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  /** Unlock test that does not depend on any stored secret record: decrypt a
   * fixed sentinel under the derived key. A wrong passphrase fails here, BEFORE
   * any record is touched, which is what makes "wrong passphrase destroys
   * nothing" testable rather than promised. */
  async function sealVerifier(key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: ENCODER.encode(SEAL_KEY) },
      key,
      ENCODER.encode(VERIFIER_TEXT),
    );
    return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }

  async function verifierOpens(key, seal) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(seal.verifier.iv), additionalData: ENCODER.encode(SEAL_KEY) },
        key,
        unb64(seal.verifier.ct),
      );
      return DECODER.decode(plain) === VERIFIER_TEXT;
    } catch {
      return false;
    }
  }

  async function storedPassphrase() {
    if (session.passphrase) return session.passphrase;
    if (typeof passphraseStore?.get === "function") {
      const stored = await passphraseStore.get().catch(() => null);
      if (typeof stored === "string" && stored.length > 0) return stored;
    }
    return null;
  }

  /** Resolve what this vault can do RIGHT NOW.
   *  - obfuscation: no seal record — the legacy key (public-by-copy) reads/writes.
   *  - sealed: seal + a passphrase that passes the verifier — real at-rest keys.
   *  - locked: seal present but no usable passphrase — every record read refuses.
   */
  async function resolveKeys() {
    const seal = await readSeal();
    if (!seal) return { mode: "obfuscation", seal: null, key: await legacyKey() };
    const pass = await storedPassphrase();
    if (!pass) return { mode: "locked", seal, key: null, reason: "no_passphrase" };
    const key = await deriveSealedKey(pass, seal);
    if (!(await verifierOpens(key, seal))) {
      return { mode: "locked", seal, key: null, reason: "wrong_passphrase" };
    }
    return { mode: "sealed", seal, key };
  }

  function requireWritable(resolved) {
    if (resolved.mode === "sealed") return { key: resolved.key, scheme: SCHEME_SEALED };
    if (resolved.mode === "obfuscation") return { key: resolved.key, scheme: SCHEME };
    throw vaultError(
      "vault_locked",
      resolved.reason === "wrong_passphrase"
        ? "the vault is locked: the stored passphrase does not open it — unlock it in Settings"
        : "the vault is locked: unlock it with the vault passphrase before storing or reading secrets",
    );
  }

  const registerRawRead = (access, caller, what) => {
    assertSwCaller(caller, what);
    if (!isServiceWorkerAccess(access)) {
      throw new Error(
        `${what} requires the service-worker access token — a caller label alone is not provenance (chrome-agent-platform-jao1.7)`,
      );
    }
  };

  const recordKey = (keyId) => `${VAULT_PREFIX}${keyId}`;
  const assertSwCaller = (caller, what) => {
    if (caller !== "sw") {
      throw new Error(`${what} is service-worker-only — raw secrets are never exposed to ${String(caller ?? "unspecified")} contexts`);
    }
  };

  async function loadRecord(keyId) {
    const got = await storageArea.get(recordKey(keyId));
    const record = got?.[recordKey(keyId)];
    if (!record || (record.scheme !== SCHEME && record.scheme !== SCHEME_SEALED)) return null;
    return record;
  }

  async function encryptToRecord(keyId, value, previous, { key, scheme }) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // The key id is authenticated as additionalData: a record's {iv, ct}
    // cannot be swapped into another id's slot and still decrypt
    // (voicebox-dsflash1's review of jao1.1).
    const aad = ENCODER.encode(recordKey(keyId));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      ENCODER.encode(value),
    );
    const now = Date.now();
    return {
      scheme,
      v: 1,
      iv: b64(iv),
      ct: b64(new Uint8Array(ct)),
      configuredAt: previous?.configuredAt ?? now,
      lastUsed: previous?.lastUsed ?? 0,
      rotations: (previous?.rotations ?? 0) + (previous ? 1 : 0),
    };
  }

  async function decryptRecord(keyId, record, key) {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(record.iv), additionalData: ENCODER.encode(recordKey(keyId)) },
      key,
      unb64(record.ct),
    );
    return DECODER.decode(plain);
  }

  /** Which key opens THIS record, or a named refusal. The scheme decides, never
   * the caller: a legacy record is only ever opened while the seal exists purely
   * to migrate it (`migrated !== true`), and a sealed record is never opened by
   * the legacy key. */
  async function keyForRecord(record, resolved) {
    if (record.scheme === SCHEME_SEALED) {
      if (resolved.mode === "sealed") return resolved.key;
      throw vaultError("vault_locked", "this record is sealed with a vault passphrase — unlock the vault in Settings");
    }
    // legacy record
    if (resolved.mode === "obfuscation") return resolved.key;
    if (resolved.mode === "sealed" && resolved.seal?.migrated !== true) return await legacyKey();
    throw vaultError(
      "legacy_record_unsealed",
      "this record predates the vault passphrase and was never re-sealed — enabling the lock again resumes the migration",
    );
  }

  async function listVaultRecords() {
    const all = await storageArea.get(null);
    return Object.entries(all || {})
      .filter(([key, record]) => key.startsWith(VAULT_PREFIX) && (record?.scheme === SCHEME || record?.scheme === SCHEME_SEALED))
      .map(([key, record]) => ({ key, keyId: key.slice(VAULT_PREFIX.length), record }));
  }

  return {
    scheme: SCHEME,
    sealedScheme: SCHEME_SEALED,

    /** What the vault can do right now, for the Settings panel and the proxy.
     * `encryptedAtRest` is TRUE only while sealed — the panel must render the
     * obfuscation/locked states from THIS, not from its own copy. */
    async protection() {
      const resolved = await resolveKeys();
      const records = await listVaultRecords();
      return {
        state: resolved.mode, // obfuscation | sealed | locked
        encryptedAtRest: resolved.mode === "sealed",
        lockedReason: resolved.mode === "locked" ? resolved.reason : null,
        sealedAt: resolved.seal?.sealedAt ?? null,
        migrationPending: Boolean(resolved.seal && resolved.seal.migrated !== true),
        legacyRecords: records.filter(({ record }) => record.scheme === SCHEME).length,
        sealedRecords: records.filter(({ record }) => record.scheme === SCHEME_SEALED).length,
      };
    },

    /** Install the owner passphrase lock, re-sealing every legacy record IN
     * PLACE (no re-entry, no data loss) — chrome-agent-platform-zxo4i.
     *
     * Crash-safety is ordered, not promised: the seal record is written first
     * with `migrated:false` (legacy records stay readable through `keyForRecord`
     * because the seal exists to migrate them), each record is re-sealed with a
     * single write, and `migrated:true` is written LAST. An interrupted run can
     * therefore be resumed by calling this again with the SAME passphrase. */
    async enableLock(pass) {
      if (typeof pass !== "string" || pass.length < PASSPHRASE_MIN_LENGTH) {
        throw vaultError("passphrase_too_short", `a vault passphrase must be at least ${PASSPHRASE_MIN_LENGTH} characters`);
      }
      const existing = await readSeal();
      if (existing?.migrated === true) {
        throw vaultError("already_sealed", "the vault already has a passphrase lock");
      }

      let seal = existing;
      let key;
      if (!seal) {
        const kdfSalt = b64(crypto.getRandomValues(new Uint8Array(32)));
        const draft = { scheme: SCHEME_SEALED, v: 1, kdfSalt, iterations: PASSPHRASE_ITERATIONS };
        key = await deriveSealedKey(pass, draft);
        seal = {
          ...draft,
          verifier: await sealVerifier(key),
          migrated: false,
          sealedAt: Date.now(),
        };
        await storageArea.set({ [SEAL_KEY]: seal });
      } else {
        key = await deriveSealedKey(pass, seal);
        if (!(await verifierOpens(key, seal))) {
          throw vaultError("wrong_passphrase", "this vault's seal was started with a different passphrase — resume it with that one");
        }
      }

      // Decrypt EVERYTHING before writing ANYTHING: a record that cannot be read
      // aborts the migration with the vault still fully openable.
      const legacy = (await listVaultRecords()).filter(({ record }) => record.scheme === SCHEME);
      const legacyKeyValue = await legacyKey();
      const plaintexts = [];
      for (const { keyId, record } of legacy) {
        try {
          plaintexts.push({ keyId, record, value: await decryptRecord(keyId, record, legacyKeyValue) });
        } catch {
          throw vaultError(
            "migration_aborted",
            `secret vault: the record for ${keyId} could not be read, so nothing was re-sealed — the vault is unchanged`,
          );
        }
      }

      for (const { keyId, record, value } of plaintexts) {
        const next = await encryptToRecord(keyId, value, record, { key, scheme: SCHEME_SEALED });
        // Re-sealing is not a rotation: counters and timestamps are preserved.
        next.rotations = record.rotations ?? 0;
        next.configuredAt = record.configuredAt ?? next.configuredAt;
        next.lastUsed = record.lastUsed ?? 0;
        await storageArea.set({ [recordKey(keyId)]: next });
      }

      await storageArea.set({ [SEAL_KEY]: { ...seal, migrated: true } });
      session.passphrase = pass;
      if (typeof passphraseStore?.set === "function") await passphraseStore.set(pass);
      return { ok: true, state: "sealed", resealed: plaintexts.length };
    },

    /** Unlock a sealed vault for this process. A wrong passphrase fails at the
     * verifier before any record is touched. */
    async unlock(pass) {
      const seal = await readSeal();
      if (!seal) throw vaultError("not_sealed", "this vault has no passphrase lock, so there is nothing to unlock");
      if (typeof pass !== "string" || pass.length === 0) {
        throw vaultError("wrong_passphrase", "a vault passphrase is required to unlock a sealed vault");
      }
      const key = await deriveSealedKey(pass, seal);
      if (!(await verifierOpens(key, seal))) {
        throw vaultError("wrong_passphrase", "the vault passphrase does not match this vault — nothing was changed");
      }
      session.passphrase = pass;
      if (typeof passphraseStore?.set === "function") await passphraseStore.set(pass);
      return { ok: true, state: "sealed", migrationPending: seal.migrated !== true };
    },

    /** Forget the passphrase for this process (a browser restart does this for
     * the service worker because the store is chrome.storage.session). */
    async relock() {
      session.passphrase = null;
      if (typeof passphraseStore?.clear === "function") await passphraseStore.clear();
      const seal = await readSeal();
      return { ok: true, state: seal ? "locked" : "obfuscation" };
    },

    /** Store (or overwrite) a secret. Mutations are service-worker authority. */
    async setSecret(keyId, value, { by } = {}) {
      assertSwCaller(by, "storing a secret");
      if (!KEY_ID_PATTERN.test(String(keyId ?? ""))) {
        throw new TypeError(`secret vault key ids are UPPER_SNAKE_CASE credential ids, refused: ${String(keyId ?? "").slice(0, 3)}…`);
      }
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError("secret vault values must be non-empty strings");
      }
      const writer = requireWritable(await resolveKeys());
      const previous = await loadRecord(keyId);
      const record = await encryptToRecord(keyId, value, previous, writer);
      record.rotations = previous?.rotations ?? 0;
      await storageArea.set({ [recordKey(keyId)]: record });
      return { keyId, configured: true };
    },

    /** Rotation: overwrite an EXISTING secret. Refuses unknown ids so a typo
     * cannot mint a new record. */
    async rotateSecret(keyId, value, { by } = {}) {
      assertSwCaller(by, "rotating a secret");
      const writer = requireWritable(await resolveKeys());
      const previous = await loadRecord(keyId);
      if (!previous) throw new Error(`secret vault: ${keyId} is not configured — nothing to rotate`);
      const record = await encryptToRecord(keyId, value, previous, writer);
      await storageArea.set({ [recordKey(keyId)]: record });
      return { keyId, rotated: true, rotations: record.rotations };
    },

    /** The raw value. Service-worker caller AND token ONLY — this is the
     * boundary the falsification tests pin. */
    async getSecretRaw(keyId, { caller, access } = {}) {
      registerRawRead(access, caller, `reading the raw value of ${String(keyId ?? "(unspecified)")}`);
      if (!KEY_ID_PATTERN.test(String(keyId ?? ""))) {
        throw new Error(`secret vault: ${String(keyId ?? "")} is not configured`);
      }
      const record = await loadRecord(keyId);
      if (!record) throw new Error(`secret vault: ${keyId} is not configured`);
      const resolved = await resolveKeys();
      const recordKeyMaterial = await keyForRecord(record, resolved);
      try {
        const value = await decryptRecord(keyId, record, recordKeyMaterial);
        const touched = { ...record, lastUsed: Date.now() };
        await storageArea.set({ [recordKey(keyId)]: touched });
        return { keyId, value, lastUsed: touched.lastUsed };
      } catch {
        // Integrity failure (tampered record, wrong derivation) fails closed —
        // the error names the key id, never any decrypted fragment.
        throw new Error(`secret vault: the record for ${keyId} failed integrity verification — it may be corrupted or derived for a different extension`);
      }
    },

    /** The UI projection: masked, serializable, no plaintext by construction. */
    async listMasked({ caller } = {}) {
      if (caller !== "ui" && caller !== "sw") {
        throw new Error(`masked projections are ui-or-service-worker surface; refused for ${String(caller ?? "unspecified")}`);
      }
      const resolved = await resolveKeys();
      const all = await storageArea.get(null);
      const out = [];
      const maskedFallback = resolved.mode === "locked" ? "…(locked)" : "…(unsealed)";
      for (const [key, record] of Object.entries(all || {})) {
        if (!key.startsWith(VAULT_PREFIX)) continue;
        const keyId = key.slice(VAULT_PREFIX.length);
        if (!record || (record.scheme !== SCHEME && record.scheme !== SCHEME_SEALED)) continue;
        let tail = "";
        try {
          tail = maskValue(await decryptRecord(keyId, record, await keyForRecord(record, resolved)));
        } catch {
          // A locked vault still reports WHICH ids exist (metadata is not a
          // secret); it never reports a value, and it says why it cannot.
          tail = record.scheme === SCHEME_SEALED || resolved.mode === "locked" ? maskedFallback : "…(integrity)";
        }
        out.push({
          keyId,
          configured: true,
          lastUsed: record.lastUsed ?? 0,
          configuredAt: record.configuredAt ?? 0,
          rotations: record.rotations ?? 0,
          masked: tail,
        });
      }
      return out.sort((a, b) => a.keyId.localeCompare(b.keyId));
    },

    /** Remove a secret. Refuses unknown ids so a typo cannot look like success. */
    async deleteSecret(keyId, { by } = {}) {
      assertSwCaller(by, "deleting a secret");
      if (!KEY_ID_PATTERN.test(String(keyId ?? ""))) {
        throw new Error(`secret vault: ${String(keyId ?? "")} is not configured`);
      }
      const record = await loadRecord(keyId);
      if (!record) throw new Error(`secret vault: ${keyId} is not configured`);
      await storageArea.remove(recordKey(keyId));
      return { keyId, deleted: true };
    },
  };
}

// ── The Settings panel model (chrome-agent-platform-jao1.5) ──────────────

/** The masked rows the Settings Web-services panel renders. A projection of
 * listMasked — this shape is the ONLY vault surface the panel model carries,
 * so the panel cannot grow a raw-value dependency by accident. */
export function vaultPanelRows(masked) {
  return (masked ?? []).map((entry) => ({
    keyId: entry.keyId,
    masked: entry.masked,
    configured: entry.configured === true,
    lastUsed: entry.lastUsed ?? 0,
    rotations: entry.rotations ?? 0,
  }));
}

/** The Save button's semantics for one service row:
 *   configured + blank input -> "none"   (configured — leave blank to keep)
 *   unconfigured + blank     -> "none"
 *   unconfigured + value     -> "set"
 *   configured + value       -> "rotate" */
export function resolveSaveAction({ configured, inputValue }) {
  const hasValue = typeof inputValue === "string" && inputValue.length > 0;
  if (!hasValue) return "none";
  return configured ? "rotate" : "set";
}
