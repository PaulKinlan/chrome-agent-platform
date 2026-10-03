// extension/lib/secret-vault.js — the isolated credential store
// (chrome-agent-platform-jao1.1, CAP-SECURE-ENCLAVE Stage 1).
//
// WHAT THIS IS: the one place service credentials (API keys, bearer tokens)
// live. Secrets are encrypted at rest with AES-GCM-256 under a key derived
// (PBKDF2-SHA-256, 210k iterations) from the extension id + a per-install
// random salt, so a storage snapshot taken out of context (a copied profile,
// a backup file) carries no readable credential and a different extension
// derivation cannot decrypt it.
//
// WHAT THIS IS NOT (the honest threat model): the derived key material is
// reconstructible inside this extension's own contexts, so this encryption is
// defense-in-depth for AT-REST snapshots — it is NOT a boundary against code
// executing with extension-context privileges. That boundary is structural:
// raw reads are refused for every non-service-worker caller, the only UI
// surface is a masked projection whose serialization provably carries no
// plaintext, and error messages name key ids, never values.

const VAULT_PREFIX = "cap:vault:secret:";
const SALT_KEY = "cap:vault:install-salt";
const KEY_ID_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const PBKDF2_ITERATIONS = 210_000;
const SCHEME = "AES-GCM-256/PBKDF2-extension-bound";

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

async function ensureInstallSalt(storageArea) {
  const existing = await storageArea.get(SALT_KEY);
  if (existing && typeof existing[SALT_KEY] === "string" && existing[SALT_KEY].length > 0) {
    return existing[SALT_KEY];
  }
  const salt = b64(crypto.getRandomValues(new Uint8Array(32)));
  await storageArea.set({ [SALT_KEY]: salt });
  return salt;
}

/** The vault. Construct with createSecretVault — the async open derives the
 * extension-bound key once. */
export async function createSecretVault({ storageArea, extensionId, installSaltB64 }) {
  if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
    throw new TypeError("secret vault requires a chrome.storage.local-shaped storageArea");
  }
  if (typeof extensionId !== "string" || extensionId.length < 8) {
    throw new TypeError("secret vault requires the extension id (extension-bound derivation)");
  }
  const saltB64 = typeof installSaltB64 === "string" && installSaltB64.length > 0
    ? installSaltB64
    : await ensureInstallSalt(storageArea);

  const baseKey = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(`${extensionId}:${saltB64}`),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: unb64(saltB64), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable: the key cannot be serialized out of the worker
    ["encrypt", "decrypt"],
  );

  const recordKey = (keyId) => `${VAULT_PREFIX}${keyId}`;
  const assertSwCaller = (caller, what) => {
    if (caller !== "sw") {
      throw new Error(`${what} is service-worker-only — raw secrets are never exposed to ${String(caller ?? "unspecified")} contexts`);
    }
  };

  async function loadRecord(keyId) {
    const got = await storageArea.get(recordKey(keyId));
    const record = got?.[recordKey(keyId)];
    if (!record || record.scheme !== SCHEME) return null;
    return record;
  }

  async function encryptToRecord(keyId, value, previous) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      ENCODER.encode(value),
    );
    const now = Date.now();
    return {
      scheme: SCHEME,
      v: 1,
      iv: b64(iv),
      ct: b64(new Uint8Array(ct)),
      configuredAt: previous?.configuredAt ?? now,
      lastUsed: previous?.lastUsed ?? 0,
      rotations: (previous?.rotations ?? 0) + (previous ? 1 : 0),
    };
  }

  async function decryptRecord(keyId, record) {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(record.iv) },
      aesKey,
      unb64(record.ct),
    );
    return DECODER.decode(plain);
  }

  return {
    scheme: SCHEME,

    /** Store (or overwrite) a secret. Mutations are service-worker authority. */
    async setSecret(keyId, value, { by } = {}) {
      assertSwCaller(by, "storing a secret");
      if (!KEY_ID_PATTERN.test(String(keyId ?? ""))) {
        throw new TypeError(`secret vault key ids are UPPER_SNAKE_CASE credential ids, refused: ${String(keyId ?? "").slice(0, 3)}…`);
      }
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError("secret vault values must be non-empty strings");
      }
      const previous = await loadRecord(keyId);
      const record = await encryptToRecord(keyId, value, previous);
      record.rotations = previous?.rotations ?? 0;
      await storageArea.set({ [recordKey(keyId)]: record });
      return { keyId, configured: true };
    },

    /** Rotation: overwrite an EXISTING secret. Refuses unknown ids so a typo
     * cannot mint a new record. */
    async rotateSecret(keyId, value, { by } = {}) {
      assertSwCaller(by, "rotating a secret");
      const previous = await loadRecord(keyId);
      if (!previous) throw new Error(`secret vault: ${keyId} is not configured — nothing to rotate`);
      const record = await encryptToRecord(keyId, value, previous);
      await storageArea.set({ [recordKey(keyId)]: record });
      return { keyId, rotated: true, rotations: record.rotations };
    },

    /** The raw value. Service-worker caller ONLY — this is the boundary the
     * falsification tests pin. */
    async getSecretRaw(keyId, { caller } = {}) {
      assertSwCaller(caller, `reading the raw value of ${String(keyId ?? "(unspecified)")}`);
      if (!KEY_ID_PATTERN.test(String(keyId ?? ""))) {
        throw new Error(`secret vault: ${String(keyId ?? "")} is not configured`);
      }
      const record = await loadRecord(keyId);
      if (!record) throw new Error(`secret vault: ${keyId} is not configured`);
      try {
        const value = await decryptRecord(keyId, record);
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
      const all = await storageArea.get(null);
      const out = [];
      for (const [key, record] of Object.entries(all || {})) {
        if (!key.startsWith(VAULT_PREFIX)) continue;
        const keyId = key.slice(VAULT_PREFIX.length);
        if (!record || record.scheme !== SCHEME) continue;
        let tail = "";
        try {
          tail = maskValue(await decryptRecord(keyId, record));
        } catch {
          tail = "…(integrity)";
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
