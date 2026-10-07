// tests/tar-stream.test.ts — tests for streaming POSIX ustar + PAX regular-file TAR encoder
// (chrome-agent-platform-11rm.1).
import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  createTarHeader,
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
    // macOS bsdtar prints Unicode names escaped unless a UTF-8 locale is set, so force one there
    // (en_US.UTF-8 ships with every macOS). Elsewhere the environment is inherited UNCHANGED: forcing
    // a locale a Linux host may not have installed would make GNU tar fall back to the C locale and
    // escape the names — a regression on the primary platform.
    const tarEnv = Deno.build.os === "darwin"
      ? { ...Deno.env.toObject(), LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" }
      : Deno.env.toObject();
    const listProc = new Deno.Command("tar", {
      args: ["-tvf", tarFile],
      env: tarEnv,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assertEquals(listProc.code, 0, `tar -tvf failed: ${new TextDecoder().decode(listProc.stderr)}`);
    // stdout ONLY: stderr text must never be able to satisfy the `includes` checks below.
    // macOS bsdtar lists this archive's Unicode name DECOMPOSED (measured on macOS arm64: the name arrives
    // as code points f8,308,1f525 rather than f8,eb,1f525), so the listing is composed back to NFC there.
    // On every other platform the listing is used as printed and the check stays byte-exact.
    const rawList = new TextDecoder().decode(listProc.stdout);
    const listOut = Deno.build.os === "darwin" ? rawList.normalize("NFC") : rawList;
    assert(listOut.includes("empty.txt"));
    assert(listOut.includes("small.txt"));
    assert(listOut.includes("binary.dat"));
    assert(listOut.includes("unicøde-tëst-"));
    assert(listOut.includes("deep/nested/path/that/exceeds"));

    // 2. System tar extracts archive cleanly
    const extractProc = new Deno.Command("tar", {
      args: ["-xvf", tarFile, "-C", extractDir],
      env: tarEnv,
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


// ── vv8c re-review regressions (M3 traversal, M4 ustar prefix, H1 desync) ──

function vvcHeader(name: string, size: number, typeflag = "0") {
  const b = new Uint8Array(512);
  const enc = new TextEncoder();
  b.set(enc.encode(name).subarray(0, 100), 0);
  b.set(enc.encode("0000644\0"), 100);
  b.set(enc.encode("0000000\0"), 108);
  b.set(enc.encode("0000000\0"), 116);
  b.set(enc.encode(size.toString(8).padStart(11, "0") + " "), 124);
  b.set(enc.encode("00000000000 "), 136);
  b.set(enc.encode("        "), 148);
  b[156] = enc.encode(typeflag)[0];
  b.set(enc.encode("ustar\0"), 257);
  b.set(enc.encode("00"), 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  b.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return b;
}

// ── vv8c re-review regressions (M3 traversal, M4 ustar prefix, H1 desync) ──

function vv8cHeader(name: string, size: number, typeflag = "0", opts: { prefix?: string } = {}) {
  const vvcHeaderEnc = new TextEncoder();
  const b = new Uint8Array(512);
  b.set(vvcHeaderEnc.encode(name).subarray(0, 100), 0);
  b.set(vvcHeaderEnc.encode("0000644\0"), 100);
  b.set(vvcHeaderEnc.encode("0000000\0"), 108);
  b.set(vvcHeaderEnc.encode("0000000\0"), 116);
  b.set(vvcHeaderEnc.encode(size.toString(8).padStart(11, "0") + " "), 124);
  b.set(vvcHeaderEnc.encode("00000000000 "), 136);
  b.set(vvcHeaderEnc.encode("        "), 148);
  b[156] = vvcHeaderEnc.encode(typeflag)[0];
  b.set(vvcHeaderEnc.encode("ustar\0"), 257);
  b.set(vvcHeaderEnc.encode("00"), 263);
  if (opts.prefix) b.set(vvcHeaderEnc.encode(opts.prefix).subarray(0, 155), 345);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  b.set(vvcHeaderEnc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return b;
}

Deno.test("vv8c M3: hostile names (ustar ../, absolute, PAX overlay, GNU L) are REFUSED, never delivered to onEntry", async () => {
  const enc = new TextEncoder();
  const cases: Array<{ label: string; chunks: Uint8Array[]; expectedError: string }> = [];
  const add = (label: string, chunks: Uint8Array[], expectedError: string) => cases.push({ label, chunks, expectedError });

  add("ustar ../", [vv8cHeader("../evil.txt", 5), enc.encode("pwned"), new Uint8Array(507), new Uint8Array(1024)], "escapes the archive root");
  add("absolute /", [vv8cHeader("/etc/evil.txt", 5), enc.encode("pwned"), new Uint8Array(507), new Uint8Array(1024)], "tar member name is absolute");
  add("PAX overlay", [
    vv8cHeader("PaxHeader", 25, "x"),
    enc.encode("25 path=../../etc/shadow\n"),
    new Uint8Array(487),
    vv8cHeader("benign.txt", 5),
    enc.encode("pwned"),
    new Uint8Array(507),
    new Uint8Array(1024),
  ], "escapes the archive root");
  add("GNU L", [
    vv8cHeader("L", 17, "L"),
    enc.encode("../../evil/long\0"),
    new Uint8Array(496),
    vv8cHeader("benign.txt", 5),
    enc.encode("pwned"),
    new Uint8Array(507),
    new Uint8Array(1024),
  ], "escapes the archive root");

  const decodeTarStream = (await import("../extension/lib/tar-stream.js") as any).decodeTarStream;
  for (const { label, chunks, expectedError } of cases) {
    const archive = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) { archive.set(c, off); off += c.byteLength; }
    // dump the bytes right after the L entry for diagnosis
    const lEnd = 512 + 17 + 495;
    console.log("L entry end:", lEnd, "next 16 bytes:", Array.from(archive.subarray(lEnd, lEnd + 16)).map((b) => b.toString(16)).join(" "));
    await assertRejects(
      () => decodeTarStream(new Blob([archive]).stream(), () => true),
      Error,
      expectedError,
      `hostile name ${label} must fail closed`,
    );
  }
});

Deno.test("vv8c M4: a POSIX ustar prefix+name header decodes as the FULL joined path", async () => {
  const enc = new TextEncoder();
  const rel = ("d".repeat(30) + "/").repeat(4) + "e".repeat(30) + ".txt";
  const slash = rel.lastIndexOf("/");
  const prefix = rel.slice(0, slash);
  const base = rel.slice(slash + 1);
  const payload = enc.encode("ustar prefix payload");
  const chunks: Uint8Array[] = [
    vv8cHeader(base, payload.length, "0", { prefix }),
    payload,
    new Uint8Array((512 - (payload.length % 512)) % 512),
    new Uint8Array(1024),
  ];
  const archive = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) { archive.set(c, off); off += c.byteLength; }

  const decodeTarStream = (await import("../extension/lib/tar-stream.js") as any).decodeTarStream;
  const seen: Array<{ name: string; size: string }> = [];
  await decodeTarStream(new Blob([archive]).stream(), (entry: any) => {
    seen.push({ name: entry.name, size: String(entry.size) });
    return true;
  });
  assertEquals(seen.length, 1);
  assertEquals(seen[0].name, rel, "the ustar prefix joins the name (was truncated to the bare 100-byte field)");
});
