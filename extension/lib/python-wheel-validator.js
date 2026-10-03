// extension/lib/python-wheel-validator.js — Content-based validation for pure-Python wheels (PEP 427).
// Part of chrome-agent-platform-4p7j (Slice 2, S1.1).
//
// Refuses binary wheels, sdists, and malformed zip archives by content, not just by extension.
// Enforces:
// 1. Filename structure: pure-Python wheels must have tag -none-any.whl.
// 2. Zip signature: must begin with standard local file header magic PK\x03\x04 (0x04034b50).
// 3. Metadata presence: must contain *.dist-info/WHEEL.
// 4. Zero binary extensions: must not contain compiled native code (.so, .pyd, .dylib, .dll).

const PURE_WHEEL_SUFFIX_RE = /-(?:py2\.py3|py[23])-none-any\.whl$/i;
const BINARY_EXT_RE = /\.(so|pyd|dylib|dll|exe)(?:\.[0-9]+)*$/i;
const DIST_INFO_WHEEL_RE = /^[A-Za-z0-9_.-]+\.dist-info\/WHEEL$/;

/**
 * Scan filenames in a ZIP archive from the Central Directory.
 * @param {Uint8Array} bytes
 * @returns {string[] | null} List of entry paths in the zip, or null if invalid zip.
 */
export function extractZipFilenames(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Check initial local header magic
  if (view.getUint32(0, true) !== 0x04034b50) return null;

  // Scan backwards for End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  const maxScan = Math.min(bytes.byteLength, 65535 + 22);
  for (let i = bytes.byteLength - 22; i >= bytes.byteLength - maxScan; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  // If EOCD is found, parse Central Directory entries
  if (eocdOffset !== -1) {
    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    if (cdOffset < bytes.byteLength) {
      const names = [];
      let off = cdOffset;
      for (let i = 0; i < totalEntries && off + 46 <= bytes.byteLength; i++) {
        if (view.getUint32(off, true) !== 0x02014b50) break;
        const nameLen = view.getUint16(off + 28, true);
        const extraLen = view.getUint16(off + 30, true);
        const commentLen = view.getUint16(off + 32, true);
        if (off + 46 + nameLen > bytes.byteLength) break;
        const nameBytes = bytes.subarray(off + 46, off + 46 + nameLen);
        names.push(new TextDecoder().decode(nameBytes));
        off += 46 + nameLen + extraLen + commentLen;
      }
      if (names.length > 0) return names;
    }
  }

  // Fallback: iterate local file headers from the beginning
  const localNames = [];
  let off = 0;
  while (off + 30 <= bytes.byteLength) {
    const sig = view.getUint32(off, true);
    if (sig !== 0x04034b50) break;
    const compressedSize = view.getUint32(off + 18, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    if (off + 30 + nameLen > bytes.byteLength) break;
    const nameBytes = bytes.subarray(off + 30, off + 30 + nameLen);
    localNames.push(new TextDecoder().decode(nameBytes));
    off += 30 + nameLen + extraLen + compressedSize;
  }
  return localNames.length > 0 ? localNames : null;
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

  const files = extractZipFilenames(bytes);
  if (!files) {
    return { ok: false, refused: "invalid-zip", error: "Package is not a valid zip archive (missing PK signature)" };
  }

  let distInfo = null;
  for (const file of files) {
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

  return { ok: true, name: cleanName, distInfo, files };
}
