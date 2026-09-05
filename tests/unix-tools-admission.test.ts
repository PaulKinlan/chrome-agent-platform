// @ts-nocheck
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { createWasiPreview1Runtime } from "../extension/lib/wasi-preview1-runtime.js";
import { buildPreviewAuthority, buildPreviewJob, previewSpecFor, validatePreviewInput } from "../extension/lib/tool-exec-preview.js";
import { createSyncWorkspace } from "../extension/lib/wasm-sync-workspace.js";
import { WasiProcExit } from "../extension/lib/wasm-host-types.js";

function assert(condition, message = "assertion failed") { if (!condition) throw new Error(message); }
function equal(actual, expected, message = "values differ") {
  if (actual !== expected) throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
function concat(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

const REQUIRED = Object.freeze(["grep", "sed", "awk", "sort", "uniq", "wc", "tr", "base64", "jq"]);

async function run(toolId, args, stdin) {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === toolId);
  assert(row?.admitted && row?.settingsPreview, `${toolId} must be admitted`);
  const wasm = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);
  const inputBytes = stdin instanceof Uint8Array ? stdin : new TextEncoder().encode(stdin);
  const validated = validatePreviewInput({ toolId, args, stdin: "" });
  const authority = buildPreviewAuthority({ origin: "https://settings.cap", documentId: `kat-${toolId}`, now: () => 1 });
  const base = buildPreviewJob({ input: validated, authority, quota: {
    hostCalls: Number.POSITIVE_INFINITY,
    pathCalls: 4096,
    stdinBytes: Number.POSITIVE_INFINITY,
    stdoutBytes: Number.POSITIVE_INFINITY,
    stderrBytes: Number.POSITIVE_INFINITY,
    fileBytes: Number.POSITIVE_INFINITY,
    fileSize: Number.POSITIVE_INFINITY,
    dynamicFds: 256,
  } });
  let inputOffset = 0, instance = null;
  const stdout = [], stderr = [];
  const runtime = createWasiPreview1Runtime({
    job: { ...base, stdin: new Uint8Array() },
    memory: {
      size: () => instance?.exports?.memory?.buffer?.byteLength ?? 0,
      read(pointer, length) { return new Uint8Array(instance.exports.memory.buffer, pointer, length); },
      write(pointer, bytes) { new Uint8Array(instance.exports.memory.buffer, pointer, bytes.byteLength).set(bytes); },
    },
    workspace: createSyncWorkspace({ root: base.context.workspaceRoot, seed: base.workspaceSeed }),
    stdio: {
      readStdin(_offset, length) {
        const chunk = inputBytes.slice(inputOffset, inputOffset + Math.min(length, 7));
        inputOffset += chunk.byteLength;
        return chunk;
      },
      writeStdout(_offset, bytes) { stdout.push(bytes.slice()); return bytes.byteLength; },
      writeStderr(_offset, bytes) { stderr.push(bytes.slice()); return bytes.byteLength; },
    },
  });
  const instantiated = await WebAssembly.instantiate(wasm, runtime.imports);
  instance = instantiated.instance;
  let code = 0;
  try { instance.exports._start(); }
  catch (error) { if (error instanceof WasiProcExit) code = error.code; else throw error; }
  const decoder = new TextDecoder();
  return {
    code,
    stdout: decoder.decode(concat(stdout)),
    stderr: decoder.decode(concat(stderr)),
    stdoutBytes: concat(stdout),
    spec: previewSpecFor(toolId),
    row,
  };
}

Deno.test("Unix tools: all nine exact executable IDs resolve to immutable shipped CAS bytes", async () => {
  for (const toolId of REQUIRED) {
    const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === toolId);
    assert(row, `${toolId} row`);
    equal(row.toolId, toolId);
    assert(row.description.includes("file-backed"), `${toolId} description discloses file backing`);
    assert(!/(?:<=|≤)\s*(?:2|64)\s*KiB/iu.test(row.description), `${toolId} has no legacy content cap`);
    const bytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);
    equal(bytes.byteLength, row.binary.bytes, `${toolId} CAS size`);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    equal(digest, row.binary.sha256, `${toolId} CAS digest`);
    equal(row.binary.initialPages, 64, `${toolId} initial pages`);
    equal(row.binary.maxPages, 512, `${toolId} maximum pages`);
  }
});

Deno.test("base64 and wc stream complete positive and negative cases", async () => {
  equal((await run("base64", [], "hello")).stdout, "aGVsbG8=\n");
  equal((await run("base64", [], "")).stdout, "", "empty input stays empty");
  equal((await run("base64", ["-d"], "YQ==\n")).stdout, "a");
  assert((await run("base64", ["-d"], "Y!Q=")).code !== 0, "invalid base64 fails");
  equal((await run("wc", [], "one two\nthree\n")).stdout, "2 3 14\n");
  equal((await run("wc", ["-lc"], "a\nb")).stdout, "1 3\n");
  assert((await run("wc", ["--wat"], "x")).code !== 0, "unknown wc flag fails");
});

Deno.test("grep supports BRE/ERE/fixed/count flags and its no-match exit is admitted", async () => {
  equal((await run("grep", ["-n", "^a.*e$"], "apple\npear\nangle\n")).stdout, "1:apple\n3:angle\n");
  equal((await run("grep", ["-Eic", "^(alpha|beta)$"], "ALPHA\nbeta\ngamma\n")).stdout, "2\n");
  equal((await run("grep", ["-F", "a.b"], "axb\na.b\n")).stdout, "a.b\n");
  const none = await run("grep", ["-c", "missing"], "present\n");
  equal(none.code, 1);
  equal(none.stdout, "0\n");
  assert(none.spec.acceptedExitCodes.includes(1), "no-match result is accepted by immutable spec");
  equal((await run("grep", ["["], "x\n")).code, 2, "invalid regex fails as usage/error");
});

Deno.test("tr and uniq preserve streaming state across tiny host chunks", async () => {
  equal((await run("tr", ["a-z", "A-Z"], "abcz\n")).stdout, "ABCZ\n");
  equal((await run("tr", ["-s", "a"], "baaaad\n")).stdout, "bad\n", "single-set squeeze works");
  equal((await run("tr", ["-d", "[:digit:]"], "a1b2\n")).stdout, "ab\n");
  assert((await run("tr", ["z-a", "x"], "z")).code !== 0, "descending range fails");
  equal((await run("uniq", [], "a\na\nb\nb\nb\nc\n")).stdout, "a\nb\nc\n");
  equal((await run("uniq", ["-c"], "a\na\nb\n")).stdout, "      2 a\n      1 b\n");
  equal((await run("uniq", ["-d"], "a\na\nb\n")).stdout, "a\n");
  equal((await run("uniq", ["-u"], "a\na\nb\n")).stdout, "b\n");
  assert((await run("uniq", [], new Uint8Array([97, 0, 10]))).code !== 0, "NUL text fails");
});

Deno.test("sort run kernel has deterministic lexical/numeric/reverse/unique semantics", async () => {
  equal((await run("sort", [], "z\na\naa\na\n")).stdout, "a\na\naa\nz\n");
  equal((await run("sort", ["-n"], "10\n2\n-3\n2.00\n2.1\n")).stdout, "-3\n2\n2.00\n2.1\n10\n");
  equal((await run("sort", ["-ru"], "b\na\nb\n")).stdout, "b\na\n");
  assert((await run("sort", ["-x"], "a\n")).code !== 0, "unknown sort flag fails");
});

Deno.test("sed, full awk, and jq execute real language programs", async () => {
  equal((await run("sed", ["s/cat/dog/g"], "cat scatter\n")).stdout, "dog sdogter\n");
  equal((await run("sed", ["-n", "-e", "/keep/p"], "drop\nkeep this\n")).stdout, "keep this\n");
  assert((await run("sed", ["s/[//"], "x\n")).code !== 0, "invalid sed program fails");

  const awkProgram = "function sq(x){return x*x} BEGIN{a[\"seed\"]=1} $2>=2{sum+=sq($2)} END{print sum+a[\"seed\"]}";
  equal((await run("awk", [awkProgram], "a 2\nb 3\nc 1\n")).stdout, "14\n");
  equal((await run("awk", ["-F,", "/^ok/{count += $2} END{print count}"], "ok,2\nno,7\nok,3\n")).stdout, "5\n");
  assert((await run("awk", ["BEGIN {"], "")).code !== 0, "invalid awk program fails");

  equal((await run("jq", ["-c", ".items | map(. * 2)"], "{\"items\":[1,2,3]}\n")).stdout, "[2,4,6]\n");
  equal((await run("jq", ["-r", "select(.ok) | .name"], "{\"ok\":true,\"name\":\"yes\"}\n{\"ok\":false,\"name\":\"no\"}\n")).stdout, "yes\n");
  assert((await run("jq", [".items["], "{}\n")).code !== 0, "invalid jq program fails");
});
