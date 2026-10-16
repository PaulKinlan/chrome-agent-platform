// lsqay: a successful build record describes the published marker, not just
// the indexed source. Synthetic markers keep this parallel test build-free.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { buildOnceKeyFromMarkerText } from "../scripts/lib/build-once-key.mjs";
import { writeBuildOnceRecord } from "../scripts/lib/build-once-record.mjs";
import { readMarker } from "./fixtures/build-once.mjs";

const commit = "a".repeat(40);
const digest = "b".repeat(64);
function markerText(outputHash: string) {
  return `${JSON.stringify({
    commit,
    outputs: [{ path: "background/service-worker.js", sha256: outputHash, size: 42 }],
    schema: "cap-dist-complete-v2",
    source: { digest, files: 1 },
    target: "store",
  })}\n`;
}

Deno.test("lsqay: two builds of one source with different output markers write and read distinct records", async () => {
  const root = durableDir("scratch", `lsqay-${crypto.randomUUID()}`);
  const recordDir = join(root, "records");
  const markerPath = join(root, "extension", "dist", "dist.complete");
  const first = markerText("c".repeat(64));
  const second = markerText("d".repeat(64));
  const firstKey = buildOnceKeyFromMarkerText(first);
  const secondKey = buildOnceKeyFromMarkerText(second);
  assert(firstKey && secondKey);
  assertNotEquals(firstKey, secondKey, "a changed bundle hash must change the record key");
  assert(firstKey.startsWith(`${commit}-${digest}-`));
  assert(secondKey.startsWith(`${commit}-${digest}-`));
  try {
    await Deno.mkdir(join(root, "extension", "dist"), { recursive: true });
    for (const [text, key, output] of [
      [first, firstKey, "first build output\n"],
      [second, secondKey, "second build output\n"],
    ] as const) {
      await Deno.writeTextFile(markerPath, text);
      assertEquals(readMarker(root)?.key, key, "the fixture reads the live marker's complete key");
      const written = await writeBuildOnceRecord({
        record: { key, stdout: output }, buildSucceeded: true, exitCode: 0, recordDir,
      });
      assertEquals(written.written, true);
      const record = JSON.parse(await Deno.readTextFile(join(recordDir, `${readMarker(root)?.key}.json`)));
      assertEquals(record.stdout, output, "the marker selects its own build's stdout");
    }
    assertEquals((await Array.fromAsync(Deno.readDir(recordDir))).map((entry) => entry.name).sort(),
      [`${firstKey}.json`, `${secondKey}.json`].sort());
    await Deno.writeTextFile(markerPath, first);
    assertEquals(JSON.parse(await Deno.readTextFile(join(recordDir, `${readMarker(root)?.key}.json`))).stdout,
      "first build output\n", "switching back cannot reuse the second build's record");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("lsqay: the publishing capture and fixture trust path use the same marker-byte key", async () => {
  assertEquals(buildOnceKeyFromMarkerText("not json"), null);
  assertEquals(buildOnceKeyFromMarkerText(JSON.stringify({ commit, source: {} })), null);
  const buildSource = await Deno.readTextFile(new URL("../" + "build" + ".mjs", import.meta.url));
  assert(/key:\s*buildOnceKeyFromMarkerText\(markerText\)/.test(buildSource),
    "the publishing build must key its captured record from the marker it just wrote");
  const fixture = await Deno.readTextFile(new URL("./fixtures/build-once.mjs", import.meta.url));
  assert(fixture.includes("buildOnceKeyFromMarkerText(raw)"), "the reader must hash its already-read marker bytes");
  assert(fixture.includes("const key = marker?.key ?? null"));
  assert(fixture.includes("live?.key === key"), "revalidate and compare the whole live marker key before reuse");
  assert(fixture.includes("const builtKey = built?.key ?? null"), "cold builds must write under the new marker key");
});
