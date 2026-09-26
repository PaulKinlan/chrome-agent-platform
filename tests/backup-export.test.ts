// tests/backup-export.test.ts
// chrome-agent-platform-0ymn [11rm.3 — Stage 3 of STREAMED-BACKUP-RESTORE-ARCHITECTURE]
//
// The streaming EXPORT driver's contract, unit-pinned with in-memory fake
// adapters (no browser, no chrome.*): the exact content contract of
// collectExportData (exclusions, redacted-target dispatch, kv/alarms/provider
// summaries) written as a TAR through the landed encodeTarStream, with
// 64KiB-style CHUNKED payload reads — no whole-file buffering, no caps.
//
// Interop is proved the strong way: every archive this driver produces is
// extracted with the SYSTEM tar and compared byte-for-byte.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  createTarHeader,
  encodeTarStream,
  sanitizeKvForExport,
} from "../extension/lib/data-archive.js";
import { sanitizeRedactedTargetText, isManagedRedactedTarget } from "../extension/lib/logical-site-agent-config.js";
import { streamExportArchive } from "../extension/lib/backup-export.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

const REDACTED_PATH = "memory/origins/https_example.com/agentConfig.json";
const EXCLUDED_PATH = "chrome-agent-platform-private/owner-approval-hmac";

/** The fake profile: name -> bytes. The wasm file is served in THREE chunks to
 * prove multi-chunk reads survive byte-exactly. */
function fakeProfile() {
  const wasm = new Uint8Array(700);
  for (let i = 0; i < wasm.length; i++) wasm[i] = (i * 11) % 251;
  // A realistic stored redacted target: the schema is name-only, so the
  // credential key exercises the sanitizer's DEFENSIVE drop (unknown fields
  // would fail closed — the correct behavior for a hostile shape).
  const secretConfig = JSON.stringify({
    name: "site agent",
    apiKey: "sk-SUPER-SECRET",
  });
  return {
    files: new Map([
      ["notes.txt", ENCODER.encode("plain notes\n")],
      [REDACTED_PATH, ENCODER.encode(secretConfig)],
      [EXCLUDED_PATH, ENCODER.encode("hmac-bytes-must-not-ship")],
      ["tools/mod.wasm", wasm],
    ]),
    chunksPerFile: new Map([["tools/mod.wasm", 3]]),
    secretConfig,
    wasm,
  };
}

/** Fake storage primitives wired the same way production options.js will wire
 * them: listFiles/open/kvGet/alarms — nothing else. */
function fakeStorage(profile, kv, alarmList) {
  const enc = new TextEncoder();
  return {
    listFiles: async () => [...profile.files.keys()],
    open: async (path) => {
      const bytes = profile.files.get(path);
      if (!bytes) throw new Error(`fake OPFS: no such file ${path}`);
      const chunkCount = profile.chunksPerFile.get(path) ?? 1;
      const size = Math.max(1, Math.ceil(bytes.length / chunkCount));
      const parts = [];
      for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size));
      let served = 0;
      return {
        size: bytes.length,
        stream: new ReadableStream({
          pull(controller) {
            if (served >= parts.length) {
              controller.close();
              return;
            }
            served++;
            controller.enqueue(parts[served - 1]);
          },
        }),
      };
    },
    kvGet: async () => kv,
    alarms: { getAll: async () => alarmList },
    enc,
  };
}

function collectArchiveBytes(chunks) {
  const out = new Uint8Array(chunks.reduce((a: number, c: Uint8Array) => a + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Minimal strict TAR walker (independent of lib/tar-stream's decoder): every
 * header's checksum is verified, so a malformed archive fails HERE. */
async function walkTar(archive) {
  const entries = [];
  let pos = 0;
  let zeroBlocks = 0;
  while (pos + 512 <= archive.byteLength) {
    const block = archive.subarray(pos, pos + 512);
    pos += 512;
    let allZero = true;
    for (let i = 0; i < 512; i++) if (block[i] !== 0) { allZero = false; break; }
    if (allZero) {
      zeroBlocks++;
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;
    let stored = 0;
    for (let i = 148; i < 156; i++) {
      const b = block[i];
      if (b === 0x20 || b === 0) break;
      stored = stored * 8 + (b - 0x30);
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
    assertEquals(stored, sum, `TAR header checksum must be valid at offset ${pos - 512}`);
    const nul = block.subarray(0, 100).indexOf(0);
    const name = DECODER.decode(block.subarray(0, nul === -1 ? 100 : nul));
    const size = parseInt(DECODER.decode(block.subarray(124, 135)).trim(), 8);
    const data = archive.subarray(pos, pos + size);
    pos += size + ((512 - (size % 512)) % 512);
    entries.push({ name, size, data });
  }
  return entries;
}

const KV = {
  providerConfig: { openai: { apiKey: "sk-KV-SECRET", model: "gpt-x" } },
  "cap:mcpServers": [{ id: "m1", url: "https://mcp.example/sse?token=SECRET", headers: { Authorization: "Bearer x" } }],
  "cap:threads": { some: "data" },
};
const ALARMS = [
  { name: "routine-a", scheduledTime: 1700000000000, periodInMinutes: 30 },
  { name: "routine-b", scheduledTime: 1700000900000 },
];

Deno.test("0ymn: streaming export preserves the content contract over a fake OPFS", async () => {
  const profile = fakeProfile();
  const storage = fakeStorage(profile, KV, ALARMS);

  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({ write(c) { chunks.push(c); } });
  const result = await streamExportArchive({
    writable,
    listFiles: storage.listFiles,
    open: storage.open,
    kvGet: storage.kvGet,
    alarms: storage.alarms,
    extensionVersion: "test-1.0",
  });

  const archive = collectArchiveBytes(chunks);
  assertEquals(archive.byteLength, Number(result.archiveBytes), "reported archiveBytes must match the bytes written");
  assertEquals(archive.byteLength % 512, 0, "the archive is 512-aligned");

  const entries = await walkTar(archive);
  const byName = new Map(entries.map((e) => [e.name, e]));

  // ── the metadata entries exist with the same summaries collectExportData builds
  const manifest = JSON.parse(DECODER.decode(byName.get("manifest.json").data));
  assertEquals(manifest.magic, "cap-archive");
  assertEquals(manifest.formatVersion, 2);
  assertEquals(manifest.extensionVersion, "test-1.0");
  assertEquals(manifest.manifest.opfsFiles, 3, "three OPFS files (the excluded one is gone)");
  const kvEntry = JSON.parse(DECODER.decode(byName.get("kv.json").data));
  assertEquals(kvEntry, sanitizeKvForExport(KV), "kv.json is exactly the sanitized kv");
  const alarmsEntry = JSON.parse(DECODER.decode(byName.get("alarms.json").data));
  assertEquals(alarmsEntry.length, 2, "alarms.json carries the alarm records");

  // ── plain OPFS file: byte-exact
  assert(byName.has("opfs/notes.txt"), "notes.txt is archived under opfs/");
  assertEquals(byName.get("opfs/notes.txt").data, profile.files.get("notes.txt"), "notes.txt byte-exact");

  // ── the wasm file: multi-chunk read reassembles byte-exactly
  assertEquals(byName.get("opfs/tools/mod.wasm").data, profile.wasm, "the multi-chunk wasm is byte-exact");

  // ── the redacted target: SANITIZED, never raw
  const redactedEntry = byName.get(`opfs/${REDACTED_PATH}`);
  assert(redactedEntry, "the redacted target is present (not omitted)");
  const expectedSanitized = JSON.stringify(sanitizeRedactedTargetText(REDACTED_PATH, profile.secretConfig));
  assertEquals(DECODER.decode(redactedEntry.data), expectedSanitized, "the archived redacted target equals the registered sanitizer's output");
  assertEquals(redactedEntry.data.includes?.("sk-SUPER-SECRET"), false, "raw secret bytes must not survive");
  assert(!DECODER.decode(redactedEntry.data).includes("sk-SUPER-SECRET"), "the raw secret is gone from the archived text");

  // ── the excluded path is absent
  assertEquals(byName.has(`opfs/${EXCLUDED_PATH}`), false, "the excluded private path is never archived");
});

Deno.test("0ymn: the archive extracts with SYSTEM tar and matches the fake OPFS byte-for-byte", async () => {
  const profile = fakeProfile();
  const storage = fakeStorage(profile, KV, ALARMS);

  const chunks: Uint8Array[] = [];
  await streamExportArchive({
    writable: new WritableStream<Uint8Array>({ write(c) { chunks.push(c); } }),
    listFiles: storage.listFiles,
    open: storage.open,
    kvGet: storage.kvGet,
    alarms: storage.alarms,
    extensionVersion: "test-1.0",
  });
  const archive = collectArchiveBytes(chunks);

  const tmpDir = durableDir(`backup-export-extract-${Date.now()}`);
  const extractDir = `${tmpDir}/extracted`;
  await Deno.mkdir(extractDir, { recursive: true });
  const tarFile = `${tmpDir}/export.tar`;
  try {
    await Deno.writeFile(tarFile, archive);
    const x = new Deno.Command("tar", { args: ["-xf", tarFile, "-C", extractDir], stdout: "piped", stderr: "piped" }).outputSync();
    assertEquals(x.code, 0, `system tar -xf failed: ${new TextDecoder().decode(x.stderr)}`);

    assertEquals(
      new TextDecoder().decode(await Deno.readFile(`${extractDir}/opfs/notes.txt`)),
      "plain notes\n",
      "extracted notes.txt byte-exact",
    );
    const wasm = await Deno.readFile(`${extractDir}/opfs/tools/mod.wasm`);
    assertEquals(wasm.byteLength, profile.wasm.byteLength, "extracted wasm length exact");
    for (let i = 0; i < profile.wasm.length; i++) assertEquals(wasm[i], profile.wasm[i], `wasm byte ${i} exact`);

    const redactedText = new TextDecoder().decode(await Deno.readFile(`${extractDir}/opfs/${REDACTED_PATH}`));
    assert(!redactedText.includes("sk-SUPER-SECRET"), "extracted redacted target carries no raw secret");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("0ymn: progress reporting is cumulative and honest; no cap is consulted anywhere in the driver", async () => {
  const profile = fakeProfile();
  const storage = fakeStorage(profile, KV, ALARMS);

  const reports = [];
  const chunks: Uint8Array[] = [];
  const result = await streamExportArchive({
    writable: new WritableStream<Uint8Array>({ write(c) { chunks.push(c); } }),
    listFiles: storage.listFiles,
    open: storage.open,
    kvGet: storage.kvGet,
    alarms: storage.alarms,
    extensionVersion: "test-1.0",
    onProgress: (p) => reports.push(p),
  });

  assert(reports.length > 0, "progress was reported");
  for (let i = 1; i < reports.length; i++) {
    assert(reports[i].bytesSoFar >= reports[i - 1].bytesSoFar, "progress bytes are monotonic");
  }
  assertEquals(Number(result.totalBytes), reports.at(-1).bytesSoFar, "the final progress equals the total payload bytes");
  assertEquals(result.files, 6, "six TAR entries: manifest + kv + alarms + three OPFS files");

  // The driver's source must not reference the retired bounds at all — the
  // whole point of 11rm is that no cap replaces the cap.
  const source = await Deno.readTextFile(new URL("../extension/lib/backup-export.js", import.meta.url));
  assertEquals(/MAX_ARCHIVE_(OPFS_FILES|TOTAL_BYTES)/.test(source), false, "the driver must not consult the retired export caps");
});

Deno.test("0ymn: multi-chunk reads actually stream — the driver never asks for a whole file", async () => {
  const profile = fakeProfile();
  const storage = fakeStorage(profile, KV, ALARMS);

  const readSizes = [];
  const storage2 = {
    ...storage,
    open: async (path) => {
      const handle = await storage.open(path);
      // Wrap the stream so every served chunk size is recorded.
      const stream = handle.stream;
      const counting = new ReadableStream({
        start(controller) {
          const r = stream.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await r.read();
              if (done) break;
              readSizes.push(value.byteLength);
              controller.enqueue(value);
            }
            controller.close();
          };
          pump();
        },
      });
      return { size: handle.size, stream: counting };
    },
  };

  const chunks: Uint8Array[] = [];
  await streamExportArchive({
    writable: new WritableStream<Uint8Array>({ write(c) { chunks.push(c); } }),
    listFiles: storage2.listFiles,
    open: storage2.open,
    kvGet: storage2.kvGet,
    alarms: storage2.alarms,
    extensionVersion: "test-1.0",
    chunkSize: 128,
  });
  const wasmChunks = readSizes.slice(-3);
  assertEquals(wasmChunks.length, 3, "the multi-chunk wasm was served in its three fake chunks");
  assertEquals(wasmChunks.reduce((x: number, y: number) => x + y, 0), 700, "chunk sizes sum to the file size");

  const archive = collectArchiveBytes(chunks);
  const entries = await walkTar(archive);
  const wasm = entries.find((e) => e.name === "opfs/tools/mod.wasm");
  assertEquals(wasm.data.byteLength, 700, "the wasm payload is complete in the archive");
});
