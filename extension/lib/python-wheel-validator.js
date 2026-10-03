// extension/lib/python-wheel-validator.js — Content-based validation for pure-Python wheels (PEP 427).
// Part of chrome-agent-platform-4p7j (Slice 2, S1.1).
//
// Refuses binary wheels, sdists, path traversal, desynced archives, and malformed zip archives
// by content, not just by extension.
// Enforces:
// 1. Filename structure: pure-Python wheels must have tag -none-any.whl.
// 2. Zip signature: must begin with standard local file header magic PK\x03\x04 (0x04034b50).
// 3. Central Directory vs Local Headers consistency: prevents hiding binaries via CD/LFH desync.
// 4. Metadata presence: must contain *.dist-info/WHEEL.
// 5. Zero path traversal: no absolute paths or '..' directory traversal segments.
// 6. Zero binary extensions: must not contain compiled native code (.so, .pyd, .dylib, .dll, .exe).

const PURE_WHEEL_SUFFIX_RE = /-(?:py2\.py3|py[23])-none-any\.whl$/i;
const BINARY_EXT_RE = /\.(so|pyd|dylib|dll|exe)(?:\.[0-9]+)*$/i;
const DIST_INFO_WHEEL_RE = /^[A-Za-z0-9_.-]+\.dist-info\/WHEEL$/;
const TRAVERSAL_RE = /(?:^|\/|\\)\.\.(?:\/|\\|$)/;

/**
 * Check whether a path contains path traversal ('..') or is absolute.
 * @param {string} path
 * @returns {boolean}
 */
export function isPathTraversalOrAbsolute(path) {
  if (typeof path !== "string") return true;
  const p = path.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return true;
  return TRAVERSAL_RE.test(p);
}

/**
 * Parses and verifies both Central Directory and Local File Headers.
 * Returns null if the zip is malformed, truncated, or if Central Directory and Local Headers desync.
 *
 * @param {Uint8Array} bytes
 * @returns {{ cdNames: string[], localNames: string[] } | null}
 */
export function parseZipArchive(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Check initial local header magic PK\x03\x04
  if (view.getUint32(0, true) !== 0x04034b50) return null;

  // Scan backwards for End of Central Directory (EOCD) signature PK\x05\x06 (0x06054b50)
  let eocdOffset = -1;
  const maxScan = Math.min(bytes.byteLength, 65535 + 22);
  for (let i = bytes.byteLength - 22; i >= bytes.byteLength - maxScan; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return null;

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset >= bytes.byteLength) return null;

  const cdNames = [];
  const cdOffsets = new Set();
  let off = cdOffset;
  const decoder = new TextDecoder();

  // 1. Walk Central Directory entries
  for (let i = 0; i < totalEntries && off + 46 <= bytes.byteLength; i++) {
    if (view.getUint32(off, true) !== 0x02014b50) return null;
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localHeaderOffset = view.getUint32(off + 42, true);

    if (off + 46 + nameLen > bytes.byteLength) return null;
    const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    cdNames.push(name);
    cdOffsets.add(localHeaderOffset);

    // Verify corresponding local header at localHeaderOffset
    if (localHeaderOffset + 30 > bytes.byteLength) return null;
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) return null;
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    if (localHeaderOffset + 30 + localNameLen > bytes.byteLength) return null;
    const localName = decoder.decode(bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLen));
    if (localName !== name) return null; // Desync between CD entry and its LFH

    off += 46 + nameLen + extraLen + commentLen;
  }

  if (cdNames.length !== totalEntries) return null;

  // 2. Walk Local File Headers sequentially to detect hidden files omitted from CD
  const localNames = [];
  let localOff = 0;
  while (localOff + 30 <= bytes.byteLength && localOff < cdOffset) {
    const sig = view.getUint32(localOff, true);
    if (sig !== 0x04034b50) break;
    const flags = view.getUint16(localOff + 6, true);
    const compressedSize = view.getUint32(localOff + 18, true);
    const nameLen = view.getUint16(localOff + 26, true);
    const extraLen = view.getUint16(localOff + 28, true);

    if (localOff + 30 + nameLen > bytes.byteLength) return null;
    const name = decoder.decode(bytes.subarray(localOff + 30, localOff + 30 + nameLen));
    localNames.push(name);

    if (flags & 0x0008) {
      // Bit 3 set: compressed size in local header is 0; cannot jump safely without data descriptor
      return null;
    }
    localOff += 30 + nameLen + extraLen + compressedSize;
  }

  return { cdNames, localNames };
}

/**
 * Scan verified filenames in a ZIP archive.
 * @param {Uint8Array} bytes
 * @returns {string[] | null} List of entry paths in the zip, or null if invalid zip.
 */
export function extractZipFilenames(bytes) {
  const parsed = parseZipArchive(bytes);
  if (!parsed) return null;
  return parsed.cdNames;
}

/**
 * Validates a Python wheel by content and filename according to PEP 427 purelib rules.
 *
 * @param {{ name: string, bytes: Uint8Array }} param0
 * @returns {{ ok: true, name: string, distInfo: string, files: string[] } | { ok: false, refused: string, error: string }}
 */
export function validatePurePythonWheel({ name, bytes }) {
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, refused: "invalid-name", error: "Wheel filename is required" };
  }
  const cleanName = name.trim();
  if (!cleanName.toLowerCase().endsWith(".whl")) {
    return { ok: false, refused: "not-a-wheel", error: `Filename '${cleanName}' must have .whl extension` };
  }

  if (!PURE_WHEEL_SUFFIX_RE.test(cleanName)) {
    return {
      ok: false,
      refused: "not-pure-python",
      error: `Wheel '${cleanName}' has platform/ABI-specific tags; only pure-Python wheels (*-none-any.whl) are admitted`,
    };
  }

  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) {
    return { ok: false, refused: "invalid-zip", error: "Package bytes are empty or truncated" };
  }

  const parsed = parseZipArchive(bytes);
  if (!parsed) {
    return { ok: false, refused: "invalid-zip", error: "Package is not a valid zip archive (missing PK signature or corrupt headers)" };
  }

  const { cdNames, localNames } = parsed;

  // Strict check: Central Directory and Local Header entries must match exactly
  const cdSet = new Set(cdNames);
  const localSet = new Set(localNames);
  if (cdSet.size !== localSet.size || cdNames.length !== localNames.length) {
    return {
      ok: false,
      refused: "zip-header-mismatch",
      error: `Wheel archive local headers and central directory entries disagree (possible hidden payload/tampering)`,
    };
  }
  for (const n of cdSet) {
    if (!localSet.has(n)) {
      return {
        ok: false,
        refused: "zip-header-mismatch",
        error: `Wheel archive local headers and central directory entries disagree on '${n}'`,
      };
    }
  }

  let distInfo = null;
  for (const file of cdNames) {
    if (isPathTraversalOrAbsolute(file)) {
      return {
        ok: false,
        refused: "path-traversal-rejected",
        error: `Wheel archive contains path traversal or absolute entry '${file}'`,
      };
    }
    if (BINARY_EXT_RE.test(file)) {
      return {
        ok: false,
        refused: "binary-wheel-rejected",
        error: `Pure-Python wheel contains compiled native binary '${file}'`,
      };
    }
    if (DIST_INFO_WHEEL_RE.test(file)) {
      distInfo = file;
    }
  }

  if (!distInfo) {
    return {
      ok: false,
      refused: "missing-dist-info",
      error: `Wheel archive '${cleanName}' is missing required .dist-info/WHEEL metadata`,
    };
  }

  return { ok: true, name: cleanName, distInfo, files: cdNames };
}
