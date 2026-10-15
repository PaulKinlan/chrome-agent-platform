// Deterministic, read-only name planning from a checked repair intent's
// requested source fingerprints. No OPFS access, byte copying, approval,
// quarantine publication or backup/export authorization lives here.
const ENCODER = new TextEncoder();
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", ENCODER.encode(JSON.stringify(value))));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveMasterJournalQuarantineManifest(intent) {
  if (!intent || intent.schemaVersion !== 1 || !Number.isSafeInteger(intent.sequence) ||
      intent.sequence < 1 || intent.sequence > 32 || !ID.test(intent.id) ||
      !SHA256.test(intent.evidenceSha256) || !Array.isArray(intent.requestedRepairRecords) ||
      intent.requestedRepairRecords.length > 32) {
    throw new Error("master journal quarantine manifest requires a bounded checked intent");
  }
  let previous = null;
  const entries = [];
  for (const row of intent.requestedRepairRecords) {
    if (!row || typeof row.name !== "string" || !row.name || row.name.length > 128 ||
        row.name.includes("/") || row.name.startsWith("repair-intent-") ||
        row.name.startsWith("quarantine-") || (previous !== null && previous >= row.name) ||
        !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !SHA256.test(row.sha256)) {
      throw new Error("master journal quarantine manifest source names must be unique and sorted");
    }
    previous = row.name;
    const quarantineDigest = await digest({ schemaVersion: 1, intentId: intent.id,
      intentSequence: intent.sequence, sourceName: row.name,
      sourceBytes: row.bytes, sourceSha256: row.sha256 });
    entries.push({ sourceName: row.name, sourceBytes: row.bytes,
      sourceSha256: row.sha256,
      quarantineLeaf: `quarantine-${intent.sequence}-${quarantineDigest}.json` });
  }
  return { schemaVersion: 1, intentId: intent.id, intentSequence: intent.sequence,
    sha256: await digest({ schemaVersion: 1, intentId: intent.id,
      intentSequence: intent.sequence, evidenceSha256: intent.evidenceSha256, entries }),
    entries, actionable: false, candidates: [] };
}
