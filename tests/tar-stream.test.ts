// tests/tar-stream.test.ts — tests for streaming POSIX ustar + PAX regular-file TAR encoder
// (chrome-agent-platform-11rm.1).
import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  createTarHeader,
  decodeTarStream,
  encodeTarStream,
  formatPaxRecord,
  USTAR_SIZE_LIMIT,
  validateTarMemberName,
  validateTarMemberSize,
} from "../extension/lib/tar-stream.js";

// Static references so buildReverseGraph in scripts/select-tests.mjs links evidence instruments to this test
const _LARGE_PROBE = new URL("../cap-evidence/tar-stream-large-probe.ts", import.meta.url);
const _CHROME_ACCEPTANCE = new URL("../cap-evidence/11rm1-tar-stream-acceptance.ts", import.meta.url);

function ensureSystemTar() {
  try {
    const p = new Deno.Command("tar", { args: ["--version"], stdout: "piped", stderr: "piped" }).outputSync();
    if (p.code !== 0) throw new Error("tar command exited with non-zero status");
  } catch (err) {
    throw new Error(`SETUP FAILURE: System tar utility is required for TAR interoperability tests: ${(err as any)?.message ?? err}`);
  }
}

Deno.test("11rm.1: validateTarMemberName rejects invalid, absolute, traversal, and malformed paths", () => {
  // Valid names
  assertEquals(validateTarMemberName("file.txt"), "file.txt");
  assertEquals(validateTarMemberName("nested/dir/file.txt"), "nested/dir/file.txt");
  assertEquals(validateTarMemberName("valid-unicøde-🔥.json"), "valid-unicøde-🔥.json");

  // Invalid: empty or non-string
  assertThrows(() => validateTarMemberName(""), Error, "cannot be empty");
  assertThrows(() => validateTarMemberName(null as any), TypeError, "must be a string");
  assertThrows(() => validateTarMemberName(123 as any), TypeError, "must be a string");

  // Invalid: NUL byte
  assertThrows(() => validateTarMemberName("file\0.txt"), TypeError, "NUL");

  // Invalid: unpaired surrogates
  assertThrows(() => validateTarMemberName("bad-\uD800-surrogate.txt"), TypeError, "unpaired surrogates");

  // Invalid: absolute paths
  assertThrows(() => validateTarMemberName("/absolute/file.txt"), Error, "cannot be absolute");
  assertThrows(() => validateTarMemberName("\\absolute\\file.txt"), Error, "cannot be absolute");

  // Invalid: traversal components
  assertThrows(() => validateTarMemberName("../traversal.txt"), Error, "traversal");
  assertThrows(() => validateTarMemberName("dir/../traversal.txt"), Error, "traversal");
  assertThrows(() => validateTarMemberName("./current.txt"), Error, "traversal");
  assertThrows(() => validateTarMemberName("dir/./file.txt"), Error, "traversal");
  assertThrows(() => validateTarMemberName("dir//empty-comp.txt"), Error, "traversal");
  assertThrows(() => validateTarMemberName("trailing-slash/"), Error, "traversal");
});

Deno.test("11rm.1: validateTarMemberSize strictly validates integers and rejects fractional, negative, or non-finite sizes", () => {
  assertEquals(validateTarMemberSize(0), 0n);
  assertEquals(validateTarMemberSize(1024), 1024n);
  assertEquals(validateTarMemberSize(10_000_000_000n), 10_000_000_000n);

  assertThrows(() => validateTarMemberSize(-1), TypeError, "non-negative");
  assertThrows(() => validateTarMemberSize(-10n), TypeError, "non-negative");
  assertThrows(() => validateTarMemberSize(1.5), TypeError, "safe integer");
  assertThrows(() => validateTarMemberSize(NaN), TypeError, "safe integer");
  assertThrows(() => validateTarMemberSize(Infinity), TypeError, "safe integer");
  assertThrows(() => validateTarMemberSize("100" as any), TypeError, "number or bigint");
});

Deno.test("11rm.1: formatPaxRecord formats POSIX length key=value lines exactly", () => {
  const enc = new TextDecoder();
  const rec1 = formatPaxRecord("path", "hello.txt");
  assertEquals(enc.decode(rec1), "18 path=hello.txt\n");
  assertEquals(rec1.length, 18);

  const rec2 = formatPaxRecord("size", "8589934592");
  assertEquals(enc.decode(rec2), "19 size=8589934592\n");
  assertEquals(rec2.length, 19);

  // Exact boundary transitions:
  const exactLenPath = "a".repeat(89);
  // "98 path=" + 89 'a's + "\n" = 3 + 5 + 89 + 1 = 98
  const rec3 = formatPaxRecord("path", exactLenPath);
  assertEquals(rec3.length, 98);
  assertEquals(enc.decode(rec3).startsWith("98 path="), true);

  // Length transitions from 2 to 3 digits (e.g. 101):
  const path101 = "a".repeat(91);
  const rec4 = formatPaxRecord("path", path101);
  assertEquals(rec4.length, 101);
  assertEquals(enc.decode(rec4).startsWith("101 path="), true);
});

Deno.test("11rm.1: ustar to PAX size transition pins 8,589,934,591 -> 8,589,934,592 (representation coverage)", () => {
  const enc = new TextDecoder();

  // Exactly at the 8 GiB - 1 limit (fits in 11 octal digits):
  const headerUnder = createTarHeader("max-ustar.bin", USTAR_SIZE_LIMIT, "0");
  const sizeFieldUnder = enc.decode(headerUnder.subarray(124, 136));
  assertEquals(sizeFieldUnder, "77777777777 "); // 11 octal sevens + space

  // At 8 GiB (2^33): requires 12 octal digits, cannot fit in ustar 11-digit field
  const headerOver = createTarHeader("pax-size.bin", 8_589_934_592n, "0");
  const sizeFieldOver = enc.decode(headerOver.subarray(124, 136));
  assertEquals(sizeFieldOver, "00000000000 "); // ustar size set to 0, true size in PAX record

  const paxRec = formatPaxRecord("size", "8589934592");
  assertEquals(enc.decode(paxRec), "19 size=8589934592\n");
});

Deno.test("11rm.1: multi-file TAR with empty, binary, Unicode and long paths interoperates with GNU tar", async () => {
  ensureSystemTar();

  const longPath = "deep/nested/path/that/exceeds/the/one/hundred/character/ustar/limit/by/a/large/margin/for/testing/pax/file.txt";
  assert(longPath.length > 100, "must exceed 100 bytes to exercise PAX path header");

  const unicodePath = "documents/unicøde-tëst-🔥/data.json";
  const binaryBytes = new Uint8Array([0x00, 0xFF, 0xFE, 0x01, 0x80, 0x7F, 0x55, 0xAA]);

  const testEntries = [
    {
      name: "empty.txt",
      size: 0,
      body: new Uint8Array(0),
    },
    {
      name: "small.txt",
      size: 11,
      body: new TextEncoder().encode("hello world"),
    },
    {
      name: binaryBytes.length ? "binary.dat" : "",
      size: binaryBytes.length,
      body: binaryBytes,
    },
    {
      name: unicodePath,
      size: 19,
      body: new TextEncoder().encode('{"unicode": "🔥"}'),
    },
    {
      name: longPath,
      size: 15,
      body: new TextEncoder().encode("long path data\n"),
    },
  ];

  const chunks: Uint8Array[] = [];
  const sink = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });

  const result = await encodeTarStream(testEntries, sink);
  assertEquals(result.files, 5);
  assertEquals(result.totalBytes, BigInt(0 + 11 + binaryBytes.length + 19 + 15));

  const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  assertEquals(BigInt(totalLen), result.archiveBytes);
  assertEquals(totalLen % 512, 0, "TAR archive size must be an exact multiple of 512 bytes");

  const fullArchive = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    fullArchive.set(c, off);
    off += c.byteLength;
  }

  // Interoperability with system tar:
  const tmpDir = durableDir(`tar-interop-${Date.now()}`);
  await Deno.mkdir(tmpDir, { recursive: true });
  const tarFile = `${tmpDir}/test.tar`;
  const extractDir = `${tmpDir}/extracted`;
  await Deno.mkdir(extractDir);

  try {
    await Deno.writeFile(tarFile, fullArchive);

    // 1. System tar lists archive without error
    const listProc = new Deno.Command("tar", {
      args: ["-tvf", tarFile],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assertEquals(listProc.code, 0, `tar -tvf failed: ${new TextDecoder().decode(listProc.stderr)}`);
    const listOut = new TextDecoder().decode(listProc.stdout);
    assert(listOut.includes("empty.txt"));
    assert(listOut.includes("small.txt"));
    assert(listOut.includes("binary.dat"));
    assert(listOut.includes("unicøde-tëst-"));
    assert(listOut.includes("deep/nested/path/that/exceeds"));

    // 2. System tar extracts archive cleanly
    const extractProc = new Deno.Command("tar", {
      args: ["-xvf", tarFile, "-C", extractDir],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assertEquals(extractProc.code, 0, `tar -xvf failed: ${new TextDecoder().decode(extractProc.stderr)}`);

    // Verify extracted files bit-for-bit:
    assertEquals((await Deno.readFile(`${extractDir}/empty.txt`)).length, 0);
    assertEquals(await Deno.readTextFile(`${extractDir}/small.txt`), "hello world");
    assertEquals(await Deno.readFile(`${extractDir}/binary.dat`), binaryBytes);
    assertEquals(await Deno.readTextFile(`${extractDir}/${unicodePath}`), '{"unicode": "🔥"}');
    assertEquals(await Deno.readTextFile(`${extractDir}/${longPath}`), "long path data\n");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("11rm.1: backpressure is awaited and first payload chunk emits before source exhaustion", async () => {
  let writesStarted = 0;
  let writesFinished = 0;
  let pausedWriterResolve: (() => void) | null = null;

  const sink = new WritableStream<Uint8Array>({
    async write(_chunk) {
      writesStarted++;
      if (writesStarted === 2) {
        // Hold backpressure on the second write
        await new Promise<void>((resolve) => {
          pausedWriterResolve = resolve;
        });
      }
      writesFinished++;
    },
  });

  let generatorYielded = 0;
  async function* sourceEntries() {
    generatorYielded++;
    yield {
      name: "file1.txt",
      size: 5,
      body: new TextEncoder().encode("chunk"),
    };
    generatorYielded++;
    yield {
      name: "file2.txt",
      size: 5,
      body: new TextEncoder().encode("chunk"),
    };
  }

  const encodePromise = encodeTarStream(sourceEntries(), sink);

  // Wait a tick: first entry has emitted, second write is paused
  await new Promise((r) => setTimeout(r, 20));

  assertEquals(writesStarted, 2, "Second write was dispatched to sink");
  assertEquals(writesFinished, 1, "Only first write finished; second is held by backpressure");
  assertEquals(generatorYielded, 1, "Source has only yielded first entry (paused on its body write)");

  // Release backpressure
  pausedWriterResolve!();
  const res = await encodePromise;
  assertEquals(res.files, 2);
  assertEquals(writesFinished, writesStarted);
});

Deno.test("11rm.1: body length mismatch rejects and aborts writer", async () => {
  // 1. Shorter body than declared
  const sink1 = new WritableStream<Uint8Array>();
  await assertRejects(
    () => encodeTarStream([
      { name: "short.txt", size: 10, body: new TextEncoder().encode("12345") },
    ], sink1),
    Error,
    "shorter than declared size",
  );

  // 2. Longer body than declared
  const sink2 = new WritableStream<Uint8Array>();
  await assertRejects(
    () => encodeTarStream([
      { name: "long.txt", size: 5, body: new TextEncoder().encode("1234567890") },
    ], sink2),
    Error,
    "exceeded declared size",
  );
});

Deno.test("11rm.1: cancellation signal aborts writer and stops processing immediately", async () => {
  const controller = new AbortController();
  const sink = new WritableStream<Uint8Array>();

  let filesRead = 0;
  async function* infiniteFiles() {
    while (true) {
      filesRead++;
      yield { name: `file_${filesRead}.txt`, size: 4, body: new TextEncoder().encode("test") };
      if (filesRead === 3) {
        controller.abort(new Error("custom_abort_reason"));
      }
    }
  }

  await assertRejects(
    () => encodeTarStream(infiniteFiles(), sink, { signal: controller.signal }),
    Error,
    "custom_abort_reason",
  );

  assertEquals(filesRead, 4, "Infinite generator stopped immediately upon cancellation");
});

Deno.test("11rm.1: falsification controls (mutants fail closed)", async () => {
  ensureSystemTar();

  // Mutant 1: Checksum corruption fails system tar
  const validHeader = createTarHeader("corrupt.txt", 10n, "0");
  validHeader[148] = 0x39; // corrupt checksum byte
  const corruptedArchive = new Uint8Array(512 + 1024);
  corruptedArchive.set(validHeader, 0);

  const tmpDir = durableDir(`tar-falsify-${Date.now()}`);
  await Deno.mkdir(tmpDir, { recursive: true });
  const tarPath = `${tmpDir}/corrupt.tar`;
  await Deno.writeFile(tarPath, corruptedArchive);

  try {
    const p = new Deno.Command("tar", { args: ["-tvf", tarPath], stdout: "piped", stderr: "piped" }).outputSync();
    assertNotEquals(p.code, 0, "tar must reject corrupted header checksum");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }

  // Mutant 2: Omitted PAX header for long path truncates path and fails exact name assertion
  const tmpDir2 = durableDir(`tar-falsify-trunc-${Date.now()}`);
  await Deno.mkdir(tmpDir2, { recursive: true });
  const longName = "nested/directory/structure/that/exceeds/one/hundred/characters/so/it/cannot/fit/in/a/standard/ustar/header/file.txt";
  const truncatedUstarHeader = createTarHeader(longName.slice(0, 100), 5n, "0");
  const truncatedArchive = new Uint8Array(512 + 512 + 1024);
  truncatedArchive.set(truncatedUstarHeader, 0);
  truncatedArchive.set(new TextEncoder().encode("hello"), 512);

  const tarTruncPath = `${tmpDir2}/trunc.tar`;
  await Deno.writeFile(tarTruncPath, truncatedArchive);
  try {
    const p = new Deno.Command("tar", { args: ["-tvf", tarTruncPath], stdout: "piped", stderr: "piped" }).outputSync();
    assertEquals(p.code, 0);
    const out = new TextDecoder().decode(p.stdout);
    assert(!out.includes("file.txt"), "Truncated ustar header must NOT contain full path ending in file.txt");
  } finally {
    try { await Deno.remove(tmpDir2, { recursive: true }); } catch { /* ignore */ }
  }
});

// ── 11rm.2: streaming TAR decoder (chrome-agent-platform-vv8c) ──────────────

async function collectDecode(source: any, options: any = {}) {
  // The body must be consumed DURING onEntry — the decoder drains whatever the
  // consumer leaves unread (the contract the Stage-4 restore driver uses:
  // stream to staging while inside the callback).
  const entries: any[] = [];
  await decodeTarStream(
    source,
    (entry: any) => {
      const chunks2: Uint8Array[] = [];
      const reader = entry.body.getReader();
      const drain = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks2.push(value);
        }
      })();
      return Promise.resolve(drain).then(() => {
        const bytes = new Uint8Array(chunks2.reduce((a: number, c: Uint8Array) => a + c.byteLength, 0));
        let off = 0;
        for (const c of chunks2) {
          bytes.set(c, off);
          off += c.byteLength;
        }
        entries.push({ name: entry.name, size: entry.size, typeflag: entry.typeflag, bytes });
        return true;
      });
    },
    options,
  );
  return entries;
}

function bytesEqual(a: any, b: any) {
  return a instanceof Uint8Array && b instanceof Uint8Array && a.byteLength === b.byteLength &&
    a.every((v: number, i: number) => v === b[i]);
}

Deno.test("11rm.2: round-trip decode is byte-exact across the encoder's entry matrix", async () => {

  const longPath = "deep/nested/path/that/exceeds/the/one/hundred/character/ustar/limit/by/a/large/margin/for/testing/pax/roundtrip.txt";
  const unicodePath = "documents/unicøde-tëst-🔥/roundtrip.json";
  const binaryBytes = new Uint8Array([0x00, 0xFF, 0xFE, 0x01, 0x80, 0x7F, 0x55, 0xAA, 0x00, 0x00]);
  const entries = [
    { name: "empty.txt", size: 0, body: new Uint8Array(0) },
    { name: "small.txt", size: 11, body: new TextEncoder().encode("hello world") },
    { name: "exact-512.bin", size: 512, body: new Uint8Array(512).fill(0xAB) },
    { name: "odd-513.bin", size: 513, body: new Uint8Array(513).map((_v: number, i: number) => i % 251) },
    { name: "binary.dat", size: binaryBytes.length, body: binaryBytes },
    { name: unicodePath, size: 19, body: new TextEncoder().encode('{"unicode": "🔥"}') },
    { name: longPath, size: 15, body: new TextEncoder().encode("long path data\n") },
  ];

  const chunks: Uint8Array[] = [];
  const sink = new WritableStream<Uint8Array>({ write(chunk) { chunks.push(chunk); } });
  const enc = await encodeTarStream(entries, sink);
  const archive = new Uint8Array(chunks.reduce((a: number, c: Uint8Array) => a + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) { archive.set(c, off); off += c.byteLength; }

  const decoded = await collectDecode(new Blob([archive]).stream());
  assertEquals(decoded.length, entries.length, "every entry is decoded in order");
  for (let i = 0; i < entries.length; i++) {
    assertEquals(decoded[i].name, entries[i].name, `entry ${i} name`);
    assertEquals(decoded[i].size, BigInt(entries[i].size), `entry ${i} size`);
    assert(bytesEqual(decoded[i].bytes, entries[i].body), `entry ${i} payload must be byte-exact`);
  }
  assertEquals(decoded.reduce((a, e) => a + e.bytes.byteLength, 0), Number(enc.totalBytes));
});

Deno.test("11rm.2: decodeTarStream reads a REAL GNU-tar-created archive (default format, long-name L entries)", async () => {
  const tmpDir = durableDir(`tar-decode-gnu-${Date.now()}`);
  await Deno.mkdir(`${tmpDir}/payload/deep/nested/directory/structure/that/is/deliberately/well/beyond/the/ustar/name/limit/for/gnu/longname`, { recursive: true });
  await Deno.writeTextFile(`${tmpDir}/payload/top.txt`, "top level\n");
  await Deno.writeTextFile(`${tmpDir}/payload/deep/nested/directory/structure/that/is/deliberately/well/beyond/the/ustar/name/limit/for/gnu/longname/deep.txt`, "deep gnu longname data\n");
  const bin = new Uint8Array(700).map((_v: number, i: number) => (i * 7) % 256);
  await Deno.writeFile(`${tmpDir}/payload/binary700.bin`, bin);
  const tarFile = `${tmpDir}/gnu.tar`;
  try {
    const mk = new Deno.Command("tar", { args: ["-cf", tarFile, "-C", `${tmpDir}/payload`, "."], stdout: "piped", stderr: "piped" }).outputSync();
    assertEquals(mk.code, 0, `GNU tar -cf failed: ${new TextDecoder().decode(mk.stderr)}`);

    const decoded = await collectDecode(new Blob([await Deno.readFile(tarFile)]).stream());
    const byName = new Map(decoded.map((e) => [e.name.replace(/^\.\//, ""), e]));
    assert(byName.has("top.txt"), `top.txt decoded (got: ${decoded.map((e: any) => e.name).join(", ")})`);
    assert(byName.has("binary700.bin"), "binary file decoded");
    assert(
      byName.has("deep/nested/directory/structure/that/is/deliberately/well/beyond/the/ustar/name/limit/for/gnu/longname/deep.txt"),
      "the >100-char GNU longname path decodes through the L entry",
    );
    assertEquals(new TextDecoder().decode(byName.get("top.txt").bytes), "top level\n");
    assert(bytesEqual(byName.get("binary700.bin").bytes, bin), "GNU-tar'd binary bytes are byte-exact");
    assertEquals(
      new TextDecoder().decode(byName.get("deep/nested/directory/structure/that/is/deliberately/well/beyond/the/ustar/name/limit/for/gnu/longname/deep.txt").bytes),
      "deep gnu longname data\n",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("11rm.2: decodeTarStream reads a POSIX pax-format GNU tar archive (PAX x-header overlay)", async () => {
  const tmpDir = durableDir(`tar-decode-pax-${Date.now()}`);
  await Deno.mkdir(`${tmpDir}/payload`, { recursive: true });
  const longPath = "pax/deep/nested/path/that/exceeds/the/one/hundred/character/ustar/limit/yes/really/long/pax-file.txt";
  await Deno.mkdir(`${tmpDir}/payload/${longPath.split("/").slice(0, -1).join("/")}`, { recursive: true });
  await Deno.writeTextFile(`${tmpDir}/payload/${longPath}`, "pax overlay data\n");
  const tarFile = `${tmpDir}/pax.tar`;
  try {
    const mk = new Deno.Command("tar", { args: ["--format=pax", "-cf", tarFile, "-C", tmpDir, "payload"], stdout: "piped", stderr: "piped" }).outputSync();
    assertEquals(mk.code, 0, `pax tar -cf failed: ${new TextDecoder().decode(mk.stderr)}`);

    for (const f of [tarFile]) {
      const decoded = await collectDecode(new Blob([await Deno.readFile(f)]).stream());
      const longEntry = decoded.find((e: any) => e.name.includes("pax-file.txt"));
      assert(longEntry, `the long pax path decodes (${decoded.map((e: any) => e.name).join(", ")})`);
      assertEquals(new TextDecoder().decode(longEntry.bytes), "pax overlay data\n");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("11rm.2: PAX size overlay decodes the declared size (ustar field lies by design there)", async () => {
  // Hand-craft what the encoder emits for a size beyond ustar: a PAX 'x' header
  // carrying a `size` record, then a regular header whose ustar size field is 0.
  const paxRecords = formatPaxRecord("path", "big/lies-about-size.bin") ? null : null;
  void paxRecords;
  const pathRecord = formatPaxRecord("path", "big/lies-about-size.bin");
  const sizeRecord = formatPaxRecord("size", "10");
  const paxData = new Uint8Array(pathRecord.length + sizeRecord.length);
  paxData.set(pathRecord, 0);
  paxData.set(sizeRecord, pathRecord.length);

  const chunks: Uint8Array[] = [];
  const sink = new WritableStream<Uint8Array>({ write(c) { chunks.push(c); } });
  await encodeTarStream([
    { name: "PaxHeaders.0/placeholder", size: paxData.length, body: paxData, _forcePax: false },
  ].map((e) => e), new WritableStream<Uint8Array>({ write() {} }));
  // Build the archive by hand instead: PAX header + data, regular header (size 0) + 10-byte payload, terminator.
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  parts.push(createTarHeader("PaxHeaders.0/big", BigInt(paxData.length), "x", 0));
  parts.push(paxData);
  parts.push(new Uint8Array((512 - (paxData.length % 512)) % 512));
  parts.push(createTarHeader("big/lies-about-size.bin", 0n, "0", 0));
  const payload = enc.encode("0123456789");
  parts.push(payload);
  parts.push(new Uint8Array((512 - (payload.length % 512)) % 512));
  parts.push(new Uint8Array(1024));
  const archive = new Uint8Array(parts.reduce((a: number, c: Uint8Array) => a + c.byteLength, 0));
  let off = 0;
  for (const c of parts) { archive.set(c, off); off += c.byteLength; }

  const decoded = await collectDecode(new Blob([archive]).stream());
  assertEquals(decoded.length, 1, "the PAX header is consumed, not delivered");
  assertEquals(decoded[0].name, "big/lies-about-size.bin");
  assertEquals(decoded[0].size, 10n, "the PAX size record wins over the ustar field");
  assertEquals(new TextDecoder().decode(decoded[0].bytes), "0123456789");
});

Deno.test("11rm.2: fail closed — header checksum corruption is a named error", async () => {
  const chunks: Uint8Array[] = [];
  await encodeTarStream([{ name: "victim.txt", size: 3, body: new TextEncoder().encode("abc") }], new WritableStream<Uint8Array>({ write(c) { chunks.push(c); } }));
  const archive = new Uint8Array(chunks.reduce((a: number, c: Uint8Array) => a + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) { archive.set(c, off); off += c.byteLength; }
  archive[6] ^= 0x01; // inside the ASCII name field, checksum no longer matches

  await assertRejects(
    () => collectDecode(new Blob([archive]).stream()),
    Error,
    "checksum",
  );
});

Deno.test("11rm.2: fail closed — truncated payload and missing terminator are named errors", async () => {
  const chunks: Uint8Array[] = [];
  await encodeTarStream(
    [{ name: "a.bin", size: 1000, body: new Uint8Array(1000).fill(1) }, { name: "b.txt", size: 5, body: new TextEncoder().encode("b.txt") }],
    new WritableStream<Uint8Array>({ write(c) { chunks.push(c); } }),
  );
  const archive = new Uint8Array(chunks.reduce((a: number, c: Uint8Array) => a + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) { archive.set(c, off); off += c.byteLength; }

  // Cut mid-payload of the first entry.
  await assertRejects(() => collectDecode(new Blob([archive.slice(0, 512 + 300)]).stream()), Error, "truncat");
  // Drop the terminator blocks entirely.
  await assertRejects(() => collectDecode(new Blob([archive.slice(0, archive.byteLength - 512)]).stream()), Error, "terminat");
});

Deno.test("11rm.2: onEntry false skips an entry — the payload is drained and later entries stay byte-exact", async () => {
  const big = new Uint8Array(1024 * 1024).map((_v: number, i: number) => i % 253);
  const entries = [
    { name: "big skipped.bin", size: big.length, body: big },
    { name: "kept.txt", size: 4, body: new TextEncoder().encode("kept") },
  ];
  const chunks: Uint8Array[] = [];
  await encodeTarStream(entries, new WritableStream<Uint8Array>({ write(c) { chunks.push(c); } }));
  const archive = new Uint8Array(chunks.reduce((a: number, c: Uint8Array) => a + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) { archive.set(c, off); off += c.byteLength; }

  const seen: any[] = [];
  await decodeTarStream(
    new Blob([archive]).stream(),
    (entry: any) => {
      seen.push({ name: entry.name, size: entry.size });
      return entry.name === "kept.txt"; // false = skip; the decoder drains
    },
  );
  assertEquals(seen.map((e: any) => e.name), ["big skipped.bin", "kept.txt"], "skipped entries are announced, not delivered");
  // `kept.txt` content verified via full read:
  const kept = await (async () => {
    const out: any[] = [];
    await decodeTarStream(new Blob([archive]).stream(), (e: any) => {
      if (e.name !== "kept.txt") return false;
      const r = e.body.getReader();
      return (async () => {
        const { value } = await r.read();
        out.push(new TextDecoder().decode(value!));
        await r.cancel();
        return true;
      })();
    });
    return out[0];
  })();
  assertEquals(kept, "kept");
});

Deno.test("11rm.2: abort signal stops decoding and cancels the source", async () => {
  const chunks: Uint8Array[] = [];
  await encodeTarStream(
    [{ name: "one.bin", size: 600, body: new Uint8Array(600) }, { name: "two.bin", size: 600, body: new Uint8Array(600) }],
    new WritableStream<Uint8Array>({ write(c) { chunks.push(c); } }),
  );

  const controller = new AbortController();
  let cancelled = false;
  // A live source: the real archive first, then ENDLESS filler — so the stream
  // is still open when the abort fires (a source that closed itself cannot be
  // cancelled; that was a test bug, not a decoder property).
  const pending: Uint8Array[] = [...chunks];
  const tracked = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      const next = pending.shift();
      if (next) {
        ctrl.enqueue(next);
        return;
      }
      if (controller.signal.aborted) {
        ctrl.close();
        return;
      }
      ctrl.enqueue(new Uint8Array(512).fill(0x41));
    },
    cancel() { cancelled = true; },
  });

  await assertRejects(
    () =>
      decodeTarStream(
        tracked,
        () => {
          controller.abort();
          return true;
        },
        { signal: controller.signal },
      ),
    Error,
  );
  assert(cancelled, "the underlying source must be cancelled on abort");
});
