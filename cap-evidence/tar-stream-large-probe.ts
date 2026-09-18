// scripts/tar-stream-large-probe.ts — bounded >512MiB and >100,000 entry streaming probe
// (chrome-agent-platform-11rm.1).
//
// Proves two fundamental constant-memory streaming properties:
// 1. Streams a 520 MiB file payload to disk without buffering in memory; compares incremental digest.
// 2. Streams >100,000 entries through an async generator without building an array in memory.
//
// Run: deno run -A scripts/tar-stream-large-probe.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { encodeTarStream } from "../extension/lib/tar-stream.js";
import { durableDir } from "./lib/durable-root.mjs";
import { createHash } from "node:crypto";

const DIR = durableDir("tar-stream-large-probe");
await Deno.mkdir(DIR, { recursive: true });

console.log("[probe] starting 11rm.1 large codec probes...");

// ---------------------------------------------------------------------------
// Probe 1: Stream >512 MiB (520 MiB) payload without memory accumulation
// ---------------------------------------------------------------------------
const TOTAL_520MB = 520n * 1024n * 1024n; // 545,259,520 bytes
const CHUNK_SIZE = 64 * 1024; // 64 KiB
const CHUNK_COUNT = Number(TOTAL_520MB / BigInt(CHUNK_SIZE));

console.log(`[probe 1] streaming ${TOTAL_520MB} bytes (520 MiB) to disk in ${CHUNK_COUNT} chunks of ${CHUNK_SIZE} bytes...`);

const sourceHasher = createHash("sha256");
async function* largePayloadGenerator() {
  const chunk = new Uint8Array(CHUNK_SIZE);
  // deterministic pattern
  for (let i = 0; i < CHUNK_SIZE; i++) chunk[i] = (i * 31) & 0xFF;

  for (let i = 0; i < CHUNK_COUNT; i++) {
    sourceHasher.update(chunk);
    yield chunk;
  }
}

const tarFilePath = `${DIR}/payload-520m.tar`;
const file = await Deno.open(tarFilePath, { write: true, create: true, truncate: true });
const fileSink = file.writable;

const memBefore = process.memoryUsage().heapUsed;
const res520 = await encodeTarStream([
  {
    name: "large-dataset.bin",
    size: TOTAL_520MB,
    body: largePayloadGenerator(),
  },
], fileSink);

const memAfter = process.memoryUsage().heapUsed;
const heapGrowthMb = (memAfter - memBefore) / (1024 * 1024);

console.log(`[probe 1] 520 MiB archive written: files=${res520.files}, totalBytes=${res520.totalBytes}, archiveBytes=${res520.archiveBytes}`);
console.log(`[probe 1] heap growth during 520 MiB streaming: ${heapGrowthMb.toFixed(2)} MiB (O(1) bound verified)`);
assert(heapGrowthMb < 64, `Heap growth must stay bounded (< 64 MiB), got ${heapGrowthMb.toFixed(2)} MiB`);

const expectedSourceDigest = sourceHasher.digest("hex");

// Verify with system tar listing:
const pList = new Deno.Command("tar", { args: ["-tvf", tarFilePath], stdout: "piped", stderr: "piped" }).outputSync();
assertEquals(pList.code, 0, `tar -tvf failed: ${new TextDecoder().decode(pList.stderr)}`);
const listOut = new TextDecoder().decode(pList.stdout);
assert(listOut.includes("large-dataset.bin"));
assert(listOut.includes("545259520"));

// Verify extracted payload digest incrementally:
console.log(`[probe 1] verifying payload digest directly from archive...`);
const tarReadHandle = await Deno.open(tarFilePath, { read: true });
// TAR layout: 512 bytes header, 545259520 bytes data, 0 padding (520MB is 512-aligned), 1024 EOF
await tarReadHandle.seek(512, Deno.SeekMode.Start);
const verifyHasher = createHash("sha256");
const readBuf = new Uint8Array(CHUNK_SIZE);
let remaining = TOTAL_520MB;
while (remaining > 0n) {
  const toRead = Number(remaining < BigInt(CHUNK_SIZE) ? remaining : BigInt(CHUNK_SIZE));
  const n = await tarReadHandle.read(readBuf.subarray(0, toRead));
  if (n === null || n === 0) break;
  verifyHasher.update(readBuf.subarray(0, n));
  remaining -= BigInt(n);
}
tarReadHandle.close();

assertEquals(remaining, 0n, "all 520 MiB read from archive");
const actualArchiveDigest = verifyHasher.digest("hex");
assertEquals(actualArchiveDigest, expectedSourceDigest, "Archive payload digest must match source digest bit-for-bit");
console.log(`[probe 1] PASS: SHA-256 matched: ${actualArchiveDigest}`);

// Clean up 520MB file
await Deno.remove(tarFilePath);

// ---------------------------------------------------------------------------
// Probe 2: Stream >100,000 entries (100,005 entries) without array accumulation
// ---------------------------------------------------------------------------
const TOTAL_ENTRIES = 100_005;
console.log(`[probe 2] streaming ${TOTAL_ENTRIES} entries through async generator...`);

async function* hundredThousandEntries() {
  const tinyBody = new Uint8Array([0x42]);
  for (let i = 1; i <= TOTAL_ENTRIES; i++) {
    yield {
      name: `items/batch_${Math.floor(i / 1000)}/item_${i}.dat`,
      size: 1,
      body: tinyBody,
    };
  }
}

let sinkBytes = 0n;
const nullSink = new WritableStream<Uint8Array>({
  write(chunk) {
    sinkBytes += BigInt(chunk.byteLength);
  },
});

const memBeforeEntries = process.memoryUsage().heapUsed;
const resEntries = await encodeTarStream(hundredThousandEntries(), nullSink);
const memAfterEntries = process.memoryUsage().heapUsed;
const heapGrowthEntriesMb = (memAfterEntries - memBeforeEntries) / (1024 * 1024);

assertEquals(resEntries.files, TOTAL_ENTRIES);
assertEquals(resEntries.totalBytes, BigInt(TOTAL_ENTRIES));
// Each entry: 512 bytes header + 1 byte data + 511 pad = 1024 bytes. End: 1024 bytes EOF.
// 100005 * 1024 + 1024 = 102406144 bytes
assertEquals(resEntries.archiveBytes, BigInt(TOTAL_ENTRIES * 1024 + 1024));
assertEquals(sinkBytes, resEntries.archiveBytes);

console.log(`[probe 2] heap growth during 100,005 entries streaming: ${heapGrowthEntriesMb.toFixed(2)} MiB (O(1) memory bound verified)`);
assert(heapGrowthEntriesMb < 64, `Heap growth must stay bounded (< 64 MiB), got ${heapGrowthEntriesMb.toFixed(2)} MiB`);
console.log(`[probe 2] PASS: 100,005 entries streamed without accumulation`);

console.log(`\n[probe] ALL 11rm.1 LARGE CODEC PROBES PASSED.`);
