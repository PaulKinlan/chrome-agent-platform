// tests/wheel-archive-bounds.test.ts — archive-bomb bounds for wheels unpacked in the Python sandbox.
// chrome-agent-platform-gdrfu.
//
// The defect: a wheel is a plain ZIP, and pyodide.unpackArchive extracts every entry into MEMFS with
// no byte, ratio or count limits of its own. The upload validator checked structure but never the
// DECLARED shape, and the run-time hop that feeds the sandbox checked nothing at all.
//
// These fixtures lie in the CENTRAL DIRECTORY only: the local header keeps the true stored length
// (so the parser's sequential walk still lands on the next header) while the CD declares the bomb.
// That is the shape that matters - the guard must refuse on what the archive DECLARES, because
// reading the declarations is all that happens before extraction.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildDeflatedZip,
  buildStoredZip,
  legitWheelBytes,
  legitWheelEntries,
  LEGIT_WHEEL_NAME,
} from "./fixtures/wheel-archive-fixtures.ts";
import {
  inspectWheelArchiveBounds,
  validatePurePythonWheel,
  validateWheelArchiveBounds,
  WHEEL_ARCHIVE_BOUNDS,
} from "../extension/lib/python-wheel-validator.js";

type Bounds =
  | { ok: true; entries: number; totalUncompressedBytes: number; expansionRatio: number }
  | { ok: false; refused: string; error: string };

/** Narrow an admitted archive, or fail loudly with the refusal that surprised us. */
function admitted(result: Bounds): { entries: number; totalUncompressedBytes: number; expansionRatio: number } {
  if (!result.ok) throw new Error(`expected the archive to be admitted, got ${JSON.stringify(result)}`);
  return result;
}

/** Narrow a refusal, or fail loudly when something was admitted that should not have been. */
function refusal(result: Bounds): { refused: string; error: string } {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result;
}

const buildZip = buildStoredZip;
const wheelEntries = legitWheelEntries;
const legitWheel = legitWheelBytes;

Deno.test("archive bounds: a real pure-Python wheel is ADMITTED and reports its measured shape", () => {
  const wheel = legitWheel();
  const bounds = admitted(validateWheelArchiveBounds({ name: "pkg-1.0.0-py3-none-any.whl", bytes: wheel }));
  assertEquals(bounds.entries, 2);
  assertEquals(bounds.totalUncompressedBytes, 29); // "VALUE = 1\n" (10) + "Wheel-Version: 1.0\n" (19), TRUE declared sizes
  const validated = validatePurePythonWheel({ name: "pkg-1.0.0-py3-none-any.whl", bytes: wheel });
  if (!validated.ok) throw new Error(`a real wheel must be admitted: ${JSON.stringify(validated)}`);
  assertEquals(validated.archive.entries, 2, "the upload gate carries the measured shape forward");
});

Deno.test("archive bounds: every byte/ratio/count shape has its OWN refusing name", () => {
  const zero = new Uint8Array(0);
  const ratioBomb = buildZip(wheelEntries([
    { name: "pkg/payload.py", data: zero, declaredUncompressed: 40 * 1024 * 1024 },
  ]));
  const ratio = refusal(validateWheelArchiveBounds({ name: "bomb-py3-none-any.whl", bytes: ratioBomb }));
  assertEquals(ratio.refused, "archive-expansion-ratio");

  // Too MANY entries, each trivially small, so only the count ceiling can refuse it.
  const many = buildZip(
    wheelEntries(Array.from({ length: WHEEL_ARCHIVE_BOUNDS.maxEntries }, (_, i) => ({
      name: `pkg/f${i}.py`,
      data: zero,
      declaredUncompressed: 1,
    }))),
  );
  const count = refusal(validateWheelArchiveBounds({ name: "many-py3-none-any.whl", bytes: many }));
  assertEquals(count.refused, "archive-entry-count");

  // Too MANY bytes at a ratio the ratio ceiling cannot catch on its own: an archive that really is
  // multi-MiB (stored, so the ratio stays low) declaring far past the byte ceiling.
  const sizeBomb = buildZip(wheelEntries([
    { name: "pkg/big.py", data: new Uint8Array(8 * 1024 * 1024), declaredUncompressed: 200 * 1024 * 1024 },
  ]));
  const size = refusal(validateWheelArchiveBounds({ name: "big-py3-none-any.whl", bytes: sizeBomb }));
  assertEquals(size.refused, "archive-uncompressed-size");

  // An archive whose declared shape cannot be read at all is refused, not unpacked unbounded.
  const truncated = legitWheel().slice(0, 40);
  const unprovableTruncated = refusal(inspectWheelArchiveBounds(truncated));
  assertEquals(unprovableTruncated.refused, "archive-bounds-unprovable");
  const zip64 = buildZip(wheelEntries([{ name: "pkg/zip64.py", data: zero, declaredUncompressed: 0xffffffff }]));
  assertEquals(refusal(inspectWheelArchiveBounds(zip64)).refused, "archive-bounds-unprovable");

  const names = new Set([ratio.refused, count.refused, size.refused]);
  assertEquals(names.size, 3, "an operator must be able to tell a ratio bomb from a count flood from a size bomb");
  for (const named of [ratio, count, size, unprovableTruncated]) {
    assert(typeof named.error === "string" && named.error.length > 0, "every refusal explains itself");
  }
});

Deno.test("archive bounds: the ceilings are the declared constants, and the boundary is inclusive", () => {
  const atEntryCeiling = buildZip(
    wheelEntries(Array.from({ length: WHEEL_ARCHIVE_BOUNDS.maxEntries - 2 }, () => ({
      name: "pkg/x.py",
      data: new Uint8Array(0),
      declaredUncompressed: 1,
    }))),
  );
  assertEquals(atEntryCeiling.length > 0, true);
  const edge = admitted(validateWheelArchiveBounds({ name: "edge-py3-none-any.whl", bytes: atEntryCeiling }));
  assertEquals(edge.entries, WHEEL_ARCHIVE_BOUNDS.maxEntries, "exactly maxEntries is inside the ceiling");
});

Deno.test("archive bounds: an unreadable byte shape is refused rather than skipped", () => {
  for (const bytes of [undefined, null, "not bytes", 42, {}, new Uint8Array(0)]) {
    const refused = refusal(validateWheelArchiveBounds({ name: "odd-py3-none-any.whl", bytes }));
    assertEquals(refused.refused, "archive-bounds-unprovable", `bytes ${String(bytes)} must not pass the gate`);
  }
});

Deno.test("archive bounds: the upload gate refuses a bomb BEFORE any of its other verdicts can admit it", () => {
  const bomb = buildZip(wheelEntries([
    { name: "pkg/payload.py", data: new Uint8Array(0), declaredUncompressed: 40 * 1024 * 1024 },
  ]));
  const refused = validatePurePythonWheel({ name: "bomb-1.0.0-py3-none-any.whl", bytes: bomb });
  if (refused.ok) throw new Error("a declared 40 MiB expansion must not be admitted");
  assertEquals(refused.refused, "archive-expansion-ratio");
  assert(String(refused.error).includes("bomb-1.0.0-py3-none-any.whl"), "the refusal names the wheel");
});

Deno.test("archive bounds: a genuinely COMPRESSED wheel is admitted, not only stored ones", async () => {
  // Every STORED fixture above has ratio ~1. A real wheel is DEFLATE-compressed, so this is the
  // case that decides whether the guard is usable: compressible Python source expands, and the
  // ceiling must still be far above it.
  const source = Array.from({ length: 400 }, (_, i) => `def fn_${i}():\n    return ${i}\n`).join("");
  const wheel = await buildDeflatedZip("pkg/big_module.py", source);
  const bounds = admitted(validateWheelArchiveBounds({ name: LEGIT_WHEEL_NAME, bytes: wheel }));
  assertEquals(bounds.totalUncompressedBytes, new TextEncoder().encode(source).byteLength);
  assert(bounds.entries === 1 && wheel.byteLength < source.length,
    `the fixture must really be compressed: ${wheel.byteLength} archive bytes for ${source.length} source bytes`);
  assert(bounds.expansionRatio > 1 && bounds.expansionRatio < WHEEL_ARCHIVE_BOUNDS.maxExpansionRatio,
    `real deflate expansion must sit inside the ceiling, measured ${bounds.expansionRatio.toFixed(1)}:1`);
});
