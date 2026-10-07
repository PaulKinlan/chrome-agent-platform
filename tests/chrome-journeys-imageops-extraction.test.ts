// Guard the real inline imageops journey without importing chrome-journeys.ts
// (importing it launches Chrome). Run its source block against the production
// scripted-provider extractor and representative model-facing tool messages.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { executeEnvelope } from "../scripts/lib/scripted-provider.ts";

const source = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));
const start = source.indexOf("    const IMAGEOPS_PNG_B64 = ");
const end = source.indexOf("    const keylessBefore = ", start);
assert(start !== -1 && end > start, "find the complete imageops journey block");
const imageopsBlock = source.slice(start, end);
const RESIZE_SHA = "085de7b5f422a7474cbd6502934befa346a57628f933cdb0dd345653d505c623";

type Result = { name: string; pass: boolean; detail: unknown };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function scriptedRequest(value: unknown): Record<string, unknown> {
  return { messages: [{ role: "user", content: "run imageops" }, {
    role: "tool", content: JSON.stringify({ modelContent: JSON.stringify(value) }),
  }] };
}

async function executeBlock(block: string, responses: unknown[]): Promise<Result[]> {
  const checks: Result[] = [];
  let calls = 0;
  const runScriptedToolProbe = async () => ({
    provider: {
      requests: [{}, {}, responses[calls++] ?? {}],
      close: async () => {},
    },
    run: { phase: "terminal", terminal: { ok: true } },
  });
  const check = (name: string, pass: boolean, detail: unknown) => checks.push({ name, pass, detail });
  const fn = new AsyncFunction("runScriptedToolProbe", "executeEnvelope", "evalOpts", "check", "cdp", "ntpSession", "optsSession", "selectionRefOf", block);
  await fn(runScriptedToolProbe, executeEnvelope, async () => ({}), check, {}, {}, {}, () => "sel_test");
  return checks;
}

const info = scriptedRequest({ ok: true, selectedTool: "imageops", result: {
  phase: "completed", exitCode: 0, stdout: '{"width":2,"height":2,"format":"png"}',
} });
const resize = scriptedRequest({ ok: true, selectedTool: "imageops", result: {
  phase: "completed", exitCode: 0, output: { bytes: 120, sha256: RESIZE_SHA },
} });

Deno.test("g599r: execute both real journey checks against the selected imageops envelopes", async () => {
  const checks = await executeBlock(imageopsBlock, [info, resize]);
  assertEquals(checks.map((c) => c.name), [
    "bundled wasm: imageops info executes live through the hub run",
    "bundled wasm: imageops resize round-trip through the hub run",
  ]);
  assertEquals(checks.map((c) => c.pass), [true, true]);
});

Deno.test("g599r: selecting the envelope instead of its result cannot credit resize", async () => {
  // Mutate the source IN MEMORY, never the worktree. A guard that accidentally
  // checks only the envelope's top-level keys must go RED on this variant.
  const wrongPath = imageopsBlock.replace(
    /imageopsResizeEnv\?\.result\s*\?\?\s*\{\}/,
    "imageopsResizeEnv ?? {}",
  );
  assert(wrongPath !== imageopsBlock, "wrong-path mutant must replace the actual result lookup");
  const checks = await executeBlock(wrongPath, [info, resize]);
  assertEquals(checks[1].pass, false);
});

Deno.test("g599r: absent, malformed and wrong-tool responses fail the named checks, without throwing", async () => {
  for (const response of [{}, { messages: [{ role: "tool", content: "not json" }] },
    scriptedRequest(null), scriptedRequest({ ok: true, selectedTool: "other", result: { phase: "completed" } }),
    scriptedRequest({ ok: true, selectedTool: "imageops", phase: "completed", exitCode: 0,
      output: { bytes: 120, sha256: RESIZE_SHA } })]) {
    const checks = await executeBlock(imageopsBlock, [response, response]);
    assertEquals(checks.map((c) => c.pass), [false, false]);
  }
});
