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
