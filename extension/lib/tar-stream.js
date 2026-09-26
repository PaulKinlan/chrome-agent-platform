// extension/lib/tar-stream.js — streaming POSIX ustar + PAX regular-file TAR encoder
// (chrome-agent-platform-11rm.1).
//
// Pure JavaScript / Web Streams API implementation with zero external dependencies.
// Streams arbitrary files and sizes under sink backpressure with O(1) memory overhead.
// Emits standard POSIX ustar regular files, using POSIX per-file PAX extended headers (typeflag 'x')
// for paths exceeding 100 bytes or non-ASCII, and for file sizes >= 8,589,934,592 bytes (8 GiB).
// Strict validation of member names (rejects malformed/unpaired surrogates, NUL, absolute, traversal)
// and strict lossless size validation (rejects fractional, negative, non-finite, unsafe numbers).
// Fails closed on payload length mismatch (short or long), sink backpressure errors, or cancellation.

export const USTAR_SIZE_LIMIT = 8_589_934_591n; // 2^33 - 1 (11 octal digits)

/**
 * Validates a TAR member name according to POSIX regular-file wire safety rules.
 * Wire-path validation: relative only, no traversal, no NUL, well-formed Unicode.
 * (This is wire format validation, NOT product target admission/redaction policy).
 *
 * @param {string} name
 * @returns {string}
 */
export function validateTarMemberName(name) {
  if (typeof name !== "string") {
    throw new TypeError("TAR member name must be a string");
  }
  if (!name || name.length === 0) {
    throw new Error("TAR member name cannot be empty");
  }
  if (name.includes("\0")) {
    throw new TypeError("TAR member name cannot contain NUL byte");
  }
  if (typeof name.isWellFormed === "function") {
    if (!name.isWellFormed()) {
      throw new TypeError("TAR member name contains unpaired surrogates");
    }
  } else if (/[\uD800-\uDFFF]/.test(name)) {
    throw new TypeError("TAR member name contains unpaired surrogates");
  }
  if (name.startsWith("/") || name.startsWith("\\")) {
    throw new Error("TAR member name cannot be absolute");
  }
  const parts = name.split(/[/\\]/);
  for (const p of parts) {
    if (!p || p === "." || p === "..") {
      throw new Error(`TAR member name contains invalid or traversal component: "${name}"`);
    }
  }
  return name;
}

/**
 * Validates a TAR member size strictly and losslessly.
 * Rejects negative, fractional, NaN, Infinity, and non-numeric inputs.
 *
 * @param {number | bigint} size
 * @returns {bigint}
 */
export function validateTarMemberSize(size) {
  if (typeof size === "number") {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError(`TAR member size must be a non-negative safe integer, got ${size}`);
    }
    return BigInt(size);
  }
  if (typeof size === "bigint") {
    if (size < 0n) {
      throw new TypeError(`TAR member size must be non-negative, got ${size}`);
    }
    return size;
  }
  throw new TypeError(`TAR member size must be a number or bigint, got ${typeof size}`);
}

/**
 * Formats a POSIX.1-2001 PAX extended header record: "%d %s=%s\n".
 * The length field includes the length digits and the space themselves.
 *
 * @param {string} key
 * @param {string | Uint8Array} value
 * @returns {Uint8Array}
 */
export function formatPaxRecord(key, value) {
  const enc = new TextEncoder();
  const valBytes = typeof value === "string" ? enc.encode(value) : enc.encode(String(value));
  const prefix = enc.encode(` ${key}=`);
  const suffix = new Uint8Array([0x0A]); // '\n'
  const payloadLen = prefix.length + valBytes.length + suffix.length;
  let len = payloadLen + String(payloadLen).length;
  while (true) {
    const lenBytes = enc.encode(String(len));
    const total = lenBytes.length + payloadLen;
    if (total === len) {
      const out = new Uint8Array(len);
      out.set(lenBytes, 0);
      out.set(prefix, lenBytes.length);
      out.set(valBytes, lenBytes.length + prefix.length);
      out.set(suffix, len - 1);
      return out;
    }
    len = total;
  }
}

/**
 * Creates a standard 512-byte POSIX ustar header block.
 *
 * @param {string} name - Header filename (truncated to 100 bytes if needed; full name in PAX)
 * @param {bigint} size - Size in bytes (0 if >= 8 GiB; full size in PAX)
 * @param {string} [typeflag="0"] - '0' for regular file, 'x' for PAX extended header
 * @param {number} [mtime=0] - Modification timestamp in seconds
 * @returns {Uint8Array}
 */
export function createTarHeader(name, size, typeflag = "0", mtime = 0) {
  const buf = new Uint8Array(512);
  const enc = new TextEncoder();

  // 0..100: name
  const nameBytes = enc.encode(name);
  buf.set(nameBytes.subarray(0, 100), 0);

  // 100..108: mode: 0000644\0
  buf.set(enc.encode("0000644\0"), 100);

  // 108..116: uid: 0000000\0
  buf.set(enc.encode("0000000\0"), 108);

  // 116..124: gid: 0000000\0
  buf.set(enc.encode("0000000\0"), 116);

  // 124..136: size: 11 octal digits + space
  const sizeOctal = (size <= USTAR_SIZE_LIMIT ? size.toString(8).padStart(11, "0") : "00000000000") + " ";
  buf.set(enc.encode(sizeOctal), 124);

  // 136..148: mtime: 11 octal digits + space
  const mtimeOctal = Math.max(0, Math.floor(mtime)).toString(8).padStart(11, "0") + " ";
  buf.set(enc.encode(mtimeOctal), 136);

  // 148..156: chksum: fill with 8 spaces initially for checksum calculation
  buf.fill(0x20, 148, 156);

  // 156: typeflag
  buf[156] = typeflag.charCodeAt(0);

  // 157..257: linkname (all 0)

  // 257..263: magic: "ustar\0"
  buf.set(enc.encode("ustar\0"), 257);

  // 263..265: version: "00"
  buf.set(enc.encode("00"), 263);

  // Calculate unsigned byte sum
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += buf[i];
  }

  // 148..156: chksum: 6 octal digits + null + space
  const sumOctal = sum.toString(8).padStart(6, "0") + "\0 ";
  buf.set(enc.encode(sumOctal), 148);

  return buf;
}

/**
 * Encodes an asynchronous stream/iterable of TAR entries into a WritableStream<Uint8Array>.
 *
 * Each entry must be:
 *   {
 *     name: string,
 *     size: number | bigint,
 *     body?: Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
 *     mtime?: number
 *   }
 *
 * @param {AsyncIterable<any> | Iterable<any>} entries
 * @param {WritableStream<Uint8Array>} sink
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ files: number, totalBytes: bigint, archiveBytes: bigint }>}
 */
export async function encodeTarStream(entries, sink, options = {}) {
  if (!sink || typeof sink.getWriter !== "function") {
    throw new TypeError("Sink must be a WritableStream");
  }
  const writer = sink.getWriter();
  const signal = options.signal;

  let files = 0;
  let totalBytes = 0n;
  let archiveBytes = 0n;

  try {
    for await (const entry of entries) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("TAR stream aborted");
      }
      if (!entry || typeof entry !== "object") {
        throw new TypeError("TAR entry must be an object");
      }

      validateTarMemberName(entry.name);
      const declaredSize = validateTarMemberSize(entry.size);
      const mtime = entry.mtime ? Number(entry.mtime) : 0;

      const enc = new TextEncoder();
      const nameBytes = enc.encode(entry.name);
      const nameNeedsPax = nameBytes.length > 100 || /[^\x20-\x7E]/.test(entry.name);
      const sizeNeedsPax = declaredSize > USTAR_SIZE_LIMIT;

      if (nameNeedsPax || sizeNeedsPax) {
        const paxRecords = [];
        if (nameNeedsPax) {
          paxRecords.push(formatPaxRecord("path", entry.name));
        }
        if (sizeNeedsPax) {
          paxRecords.push(formatPaxRecord("size", declaredSize.toString(10)));
        }

        let paxDataLen = 0;
        for (const r of paxRecords) paxDataLen += r.length;
        const paxData = new Uint8Array(paxDataLen);
        let pOff = 0;
        for (const r of paxRecords) {
          paxData.set(r, pOff);
          pOff += r.length;
        }

        const baseName = entry.name.split("/").pop() || "file";
        const paxHeaderName = `PaxHeaders.0/${baseName.slice(0, 80)}`;
        const paxHeader = createTarHeader(paxHeaderName, BigInt(paxDataLen), "x", mtime);
        await writer.write(paxHeader);
        archiveBytes += 512n;

        await writer.write(paxData);
        archiveBytes += BigInt(paxDataLen);

        const paxPadLen = Number((512n - (BigInt(paxDataLen) % 512n)) % 512n);
        if (paxPadLen > 0) {
          await writer.write(new Uint8Array(paxPadLen));
          archiveBytes += BigInt(paxPadLen);
        }
      }

      // Regular file ustar header
      const ustarName = entry.name.slice(0, 100);
      const fileHeader = createTarHeader(ustarName, declaredSize, "0", mtime);
      await writer.write(fileHeader);
      archiveBytes += 512n;

      // Stream payload chunks
      let actualBytes = 0n;
      if (entry.body != null) {
        if (entry.body instanceof Uint8Array) {
          actualBytes = BigInt(entry.body.byteLength);
          if (actualBytes < declaredSize) {
            throw new Error(`Entry "${entry.name}" body shorter than declared size: declared ${declaredSize}, got ${actualBytes}`);
          }
          if (actualBytes > declaredSize) {
            throw new Error(`Entry "${entry.name}" body exceeded declared size (${declaredSize} bytes)`);
          }
          if (actualBytes > 0n) {
            await writer.write(entry.body);
            archiveBytes += actualBytes;
          }
        } else if (typeof entry.body.getReader === "function") {
          const reader = entry.body.getReader();
          try {
            while (true) {
              if (signal?.aborted) {
                throw signal.reason ?? new Error("TAR stream aborted");
              }
              const { done, value } = await reader.read();
              if (done) break;
              if (!(value instanceof Uint8Array)) {
                throw new TypeError(`Entry "${entry.name}" chunk must be Uint8Array`);
              }
              const chunkLen = BigInt(value.byteLength);
              actualBytes += chunkLen;
              if (actualBytes > declaredSize) {
                throw new Error(`Entry "${entry.name}" body exceeded declared size (${declaredSize} bytes)`);
              }
              if (chunkLen > 0n) {
                await writer.write(value);
                archiveBytes += chunkLen;
              }
            }
          } finally {
            reader.releaseLock();
          }
        } else if (Symbol.asyncIterator in entry.body || Symbol.iterator in entry.body) {
          for await (const chunk of entry.body) {
            if (signal?.aborted) {
              throw signal.reason ?? new Error("TAR stream aborted");
            }
            if (!(chunk instanceof Uint8Array)) {
              throw new TypeError(`Entry "${entry.name}" chunk must be Uint8Array`);
            }
            const chunkLen = BigInt(chunk.byteLength);
            actualBytes += chunkLen;
            if (actualBytes > declaredSize) {
              throw new Error(`Entry "${entry.name}" body exceeded declared size (${declaredSize} bytes)`);
            }
            if (chunkLen > 0n) {
              await writer.write(chunk);
              archiveBytes += chunkLen;
            }
          }
        } else {
          throw new TypeError(`Entry "${entry.name}" body is of unsupported type`);
        }
      }

      if (actualBytes !== declaredSize) {
        throw new Error(`Entry "${entry.name}" body shorter than declared size: expected ${declaredSize}, got ${actualBytes}`);
      }

      // Pad payload to 512-byte boundary
      const pad = Number((512n - (declaredSize % 512n)) % 512n);
      if (pad > 0) {
        await writer.write(new Uint8Array(pad));
        archiveBytes += BigInt(pad);
      }

      files++;
      totalBytes += declaredSize;
    }

    // Two 512-byte zero blocks marking end of archive
    await writer.write(new Uint8Array(1024));
    archiveBytes += 1024n;

    await writer.close();
    return { files, totalBytes, archiveBytes };
  } catch (err) {
    try {
      await writer.abort(err);
    } catch {
      // ignore secondary abort error
    }
    throw err;
  }
}

// ── Decoding (chrome-agent-platform-vv8c / 11rm.2) ─────────────────────
// The restore-side mirror of encodeTarStream: parses a ustar + PAX (+ GNU
// longname 'L') archive from a byte stream and hands each regular-file entry
// to onEntry with a pull-backed body stream — O(1) memory, no whole-archive
// buffering. Fail closed: checksum mismatch, missing ustar magic, truncated
// payload/archive, missing end-of-archive terminator, data after the
// terminator, base-256 size extension (PAX is the supported big-size path),
// unsupported typeflags.

const TAR_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

class TarByteReader {
  constructor(reader) {
    this.reader = reader;
    this.queue = [];
    this.queueOffset = 0;
    this.eof = false;
    this.pos = 0;
  }

  async pull() {
    if (this.eof) return false;
    const { done, value } = await this.reader.read();
    if (done) {
      this.eof = true;
      return false;
    }
    if (!(value instanceof Uint8Array) || value.byteLength === 0) {
      // Empty chunks are legal; keep pulling.
      return this.pull();
    }
    this.queue.push(value);
    return true;
  }

  /** Buffered byte count immediately available (no await). */
  get buffered() {
    let n = 0;
    for (let i = this.queueOffset; i < this.queue.length; i++) n += this.queue[i].byteLength;
    return n;
  }

  async ensure(n) {
    while (this.buffered < n) {
      if (!(await this.pull())) {
        throw new Error(`tar archive truncated: needed ${n} bytes at offset, got ${this.buffered}`);
      }
    }
  }

  async readExact(n) {
    if (n === 0) return new Uint8Array(0);
    await this.ensure(n);
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.queue[this.queueOffset];
      const take = Math.min(head.byteLength, n - filled);
      out.set(take === head.byteLength ? head : head.subarray(0, take), filled);
      filled += take;
      if (take === head.byteLength) {
        this.queueOffset++;
      } else {
        this.queue[this.queueOffset] = head.subarray(take);
      }
    }
    this.pos += n;
    return out;
  }

  async skip(n) {
    let remaining = n;
    const discard = 64 * 1024;
    while (remaining > 0) {
      const take = Math.min(discard, remaining);
      await this.readExact(take);
      remaining -= take;
    }
  }

  /** True only when the queue is empty AND the source is at EOF — a check
   * that must NEVER call pull() while buffered bytes remain. */
  async atEnd() {
    if (this.buffered > 0) return false;
    return !(await this.pull());
  }

  async cancel(reason) {
    this.queue = [];
    this.queueOffset = 0;
    this.eof = true;
    try {
      await this.reader.cancel(reason);
    } catch {
      // a cancelled/closed source may reject cancel; the decode is over either way
    }
  }
}

function tarBlockIsAllZero(block) {
  for (let i = 0; i < block.byteLength; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function parseTarHeader(block) {
  // Checksum: the 8 chksum bytes are summed as 0x20 per POSIX. Both the
  // unsigned and signed byte-sum variants are accepted (GNU tar emits the
  // unsigned form; POSIX requires readers to tolerate both).
  let stored = 0;
  for (let i = 148; i < 156; i++) {
    const b = block[i];
    if (b === 0x20 || b === 0) break;
    stored = stored * 8 + (b - 0x30);
  }
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  if (stored !== unsigned && stored !== signed) {
    // The diagnostic name MUST NOT be decoded strictly: a corrupted header can
    // hold bytes that are not valid UTF-8, and the checksum error — not a
    // decoder crash — is the named failure the caller needs.
    const lenient = new TextDecoder("utf-8", { fatal: false });
    const nameBytes = block.subarray(0, 100);
    const nul = nameBytes.indexOf(0);
    const name = lenient.decode(nameBytes.subarray(0, nul === -1 ? 100 : nul));
    throw new Error(`tar header checksum mismatch for "${name}" (stored ${stored}, computed ${unsigned})`);
  }

  const magic = TAR_FATAL_DECODER.decode(block.subarray(257, 262));
  if (magic !== "ustar") {
    throw new Error(`tar header missing ustar magic (got "${magic}")`);
  }

  const nameBytes = block.subarray(0, 100);
  const nameNul = nameBytes.indexOf(0);
  const name = TAR_FATAL_DECODER.decode(nameBytes.subarray(0, nameNul === -1 ? 100 : nameNul));

  const sizeField = TAR_FATAL_DECODER.decode(block.subarray(124, 136));
  if (sizeField.charCodeAt(0) & 0x80 || sizeField.charCodeAt(0) === 0xFF) {
    throw new Error("tar header uses base-256 size encoding; only ustar octal and PAX size records are supported");
  }
  const sizeOctal = sizeField.trim();
  const size = sizeOctal === "" ? 0n : BigInt(parseInt(sizeOctal, 8));

  const typeflag = String.fromCharCode(block[156]);
  return { name, size, typeflag };
}

function parsePaxRecords(bytes) {
  // Record lengths count BYTES, so parsing must walk the raw bytes — a decoded
  // JS string's character offsets diverge the moment a path contains non-ASCII.
  const records = {};
  let i = 0;
  while (i < bytes.byteLength) {
    let sp = -1;
    for (let j = i; j < bytes.byteLength; j++) {
      if (bytes[j] === 0x20) {
        sp = j;
        break;
      }
    }
    if (sp === -1) throw new Error("malformed PAX record: missing length terminator");
    const lenText = TAR_FATAL_DECODER.decode(bytes.subarray(i, sp));
    const len = Number(lenText);
    if (!Number.isInteger(len) || len <= 0 || i + len > bytes.byteLength) {
      throw new Error(`malformed PAX record: length out of bounds (${lenText})`);
    }
    const recordEnd = i + len;
    let eq = -1;
    for (let j = sp + 1; j < recordEnd; j++) {
      if (bytes[j] === 0x3D) {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Error("malformed PAX record: missing '='");
    const key = TAR_FATAL_DECODER.decode(bytes.subarray(sp + 1, eq));
    const value = TAR_FATAL_DECODER.decode(bytes.subarray(eq + 1, recordEnd - 1)); // strip trailing \n
    records[key] = value;
    i = recordEnd;
  }
  return records;
}

/**
 * Decodes a TAR byte stream and hands each regular-file entry to onEntry.
 *
 * Mirrors encodeTarStream: pure JavaScript, Web Streams, zero dependencies,
 * O(1) memory — payload bytes are delivered through a pull-backed
 * ReadableStream (or drained when skipped), never buffered whole.
 *
 * onEntry(entry) is awaited per entry; return false to SKIP the entry (the
 * decoder drains its payload; later entries are unaffected). The entry is
 * { name: string, size: bigint, typeflag: string, body: ReadableStream<Uint8Array> }.
 * Regular files are typeflag "0"; directories ("5", present in real `tar -cf`
 * tree archives) are announced with an empty body and no payload.
 *
 * Handles ustar regular files ('0'/'\0'), PAX extended headers ('x' — path and
 * size records overlay the next entry), GNU long names ('L'), and directory
 * entries ('5'). Fails closed
 * on checksum mismatch, missing ustar magic, base-256 size encoding,
 * unsupported typeflags, truncated payloads, a missing end-of-archive
 * terminator, or non-zero data after the terminator.
 *
 * @param {ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Iterable<Uint8Array>} source
 * @param {(entry: any) => boolean | Promise<boolean>} onEntry
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ files: number, totalBytes: bigint }>}
 */
export async function decodeTarStream(source, onEntry, options = {}) {
  if (typeof onEntry !== "function") {
    throw new TypeError("onEntry must be a function");
  }
  const rawReader = typeof source.getReader === "function"
    ? source.getReader()
    : (async function* () {
        yield* source;
      }());
  // Normalize an async-iterator source into a reader-shaped object.
  const readerLike = typeof rawReader.read === "function"
    ? rawReader
    : {
        read: () => rawReader.next().then((r) => ({ done: r.done, value: r.value })),
        cancel: (reason) => rawReader.return?.(reason).then(() => {}),
      };
  const reader = new TarByteReader(readerLike);
  const signal = options.signal;

  let files = 0;
  let totalBytes = 0n;
  let zeroBlocks = 0;
  let overlayName = null;
  let overlaySize = null;

  try {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("TAR stream aborted");
      }
      const headerBytes = await reader.readExact(512);
      if (tarBlockIsAllZero(headerBytes)) {
        zeroBlocks++;
        if (zeroBlocks === 1) {
          // The SECOND terminator block must exist: EOF after a single zero
          // block is a truncated archive, not an end.
          if (await reader.atEnd()) {
            throw new Error("tar archive truncated: end-of-archive terminator incomplete");
          }
          continue;
        }
        // zeroBlocks >= 2: end of archive. Trailing blocks (GNU tar's blocking-
        // factor padding) must be zero until EOF.
        while (!(await reader.atEnd())) {
          const block = await reader.readExact(512);
          if (!tarBlockIsAllZero(block)) {
            throw new Error("tar archive has data after its end-of-archive terminator");
          }
        }
        await reader.cancel("tar archive decoded");
        return { files, totalBytes };
      }
      zeroBlocks = 0;

      const header = parseTarHeader(headerBytes);
      const padded = Number((512n - (header.size % 512n)) % 512n);

      if (header.typeflag === "x") {
        // PAX extended header: records overlay the NEXT entry.
        const paxBytes = await reader.readExact(Number(header.size));
        if (padded > 0) await reader.skip(padded);
        const records = parsePaxRecords(paxBytes);
        if (Object.hasOwn(records, "path")) overlayName = records.path;
        if (Object.hasOwn(records, "size")) overlaySize = BigInt(records.size);
        continue;
      }
      if (header.typeflag === "L") {
        // GNU long name: the payload IS the next entry's name.
        const longNameBytes = await reader.readExact(Number(header.size));
        if (padded > 0) await reader.skip(padded);
        const nul = longNameBytes.indexOf(0);
        overlayName = TAR_FATAL_DECODER.decode(longNameBytes.subarray(0, nul === -1 ? longNameBytes.length : nul));
        continue;
      }
      if (header.typeflag === "K") {
        // GNU long LINK name: links are not retained files; drain and ignore.
        await reader.skip(Number(header.size));
        if (padded > 0) await reader.skip(padded);
        continue;
      }
      if (header.typeflag === "5") {
        // Directory entry (a real `tar -cf` of a tree contains them): announced
        // with an empty body so a restore driver can create the directory;
        // there is no payload to drain.
        const dirName = overlayName ?? header.name;
        overlayName = null;
        overlaySize = null;
        const keep = await onEntry({ name: dirName, size: 0n, typeflag: "5", body: new ReadableStream({ start(c) { c.close(); } }) });
        if (keep !== false) {
          files++;
        }
        continue;
      }
      if (header.typeflag !== "0" && header.typeflag !== "\0") {
        throw new Error(`unsupported TAR entry typeflag "${header.typeflag}" (entry "${header.name}")`);
      }

      const name = overlayName ?? header.name;
      const size = overlaySize ?? header.size;
      // The pad belongs to the EFFECTIVE payload: the ustar size field lies by
      // design when a PAX size record overlays it (the encoder writes 0 there).
      const padLen = Number((512n - (size % 512n)) % 512n);
      overlayName = null;
      overlaySize = null;

      let remaining = size;
      // HWM 0 is LOAD-BEARING: the default strategy (HWM 1) calls pull once at
      // construction, consuming payload bytes before onEntry has even run — the
      // drain below would then re-consume them and desync the archive (measured:
      // a +11-byte drift after the first non-empty entry). With HWM 0 the payload
      // is only read when the consumer actually reads the body (or drained here).
      const body = new ReadableStream({
        async pull(controller) {
          if (remaining === 0n) {
            controller.close();
            return;
          }
          const want = Number(remaining > 64n * 1024n ? 64n * 1024n : remaining);
          const chunk = await reader.readExact(want);
          remaining -= BigInt(want);
          controller.enqueue(chunk);
        },
      }, new CountQueuingStrategy({ highWaterMark: 0 }));

      const keep = await onEntry({ name, size, typeflag: "0", body });
      if (keep === false) {
        await body.cancel();
        remaining = size; // everything undelivered is drained below
      }
      // Drain whatever the consumer did not read (skipped tail or a fully
      // skipped entry) — bounded chunks, still O(1) memory.
      while (remaining > 0n) {
        const want = Number(remaining > 64n * 1024n ? 64n * 1024n : remaining);
        await reader.readExact(want);
        remaining -= BigInt(want);
      }
      if (padLen > 0) await reader.skip(padLen);

      files++;
      totalBytes += size;
    }
  } catch (err) {
    await reader.cancel(err);
    throw err;
  }
}
