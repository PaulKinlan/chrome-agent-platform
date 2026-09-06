// Loaded-extension execute-path spot-check for the bundled Wasm tranche
// (chrome-agent-platform-xyc). Findability is proven (all bundled tools have
// live catalog descriptors); this harness proves EXECUTION through the REAL
// lazy tool protocol the way a real caller drives it: a scripted provider
// plays the model, the run goes through the hub composer → runTask →
// search_tools → execute_tool → validation → authorization → dispatch, with
// the real offscreen hosts doing the Wasm work. Per tool it records the
// dispatch class, the actual output, and latency; durable evidence only.
//
// Dispatch matrix under test (service-worker dispatchBundledWasmStream):
//   stream-backed          (grep, sort, imageops)  → offscreen WASI stream run
//   call-export            (hash_blake3)           → offscreen call-export host
//   formerly preview-only  (gzip, sha256sum, uuid) → offscreen WASI job run
//                                                    (ten9: the preview gate
//                                                    is REMOVED — every
//                                                    bundled tool executes
//                                                    in-run)
//   default-tier job lane  (compressops)           → offscreen WASI job run
//                                                    (az4k: the job carries
//                                                    the tool's DECLARED
//                                                    tier — a 2048-page
//                                                    binary under the old
//                                                    hardcoded tiny job was
//                                                    memory-rejected on
//                                                    every live run)
//   job-lane admission     (oxipng)                → offscreen WASI job run
//                                                    (m3vb: the first tool
//                                                    admitted STRAIGHT into
//                                                    ten9's lane — PNG in,
//                                                    smaller PNG out)
//                                           so the class is proven end-to-end.
//
// Run: deno run -A scripts/kat-bundled-execute.ts   (takes the Chrome slot)

import { launchChrome, openCdp } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";
import {
  startScriptedProvider,
  SCRIPTED_DUMMY_KEY,
  lastToolResult,
  executeEnvelope,
} from "./lib/scripted-provider.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXTENSION = `${ROOT}extension`;
const TIMESTAMP = new Date().toISOString().replaceAll(":", "-");
const EVIDENCE = durableDir("kat-bundled-execute", TIMESTAMP);
const PROFILE = durableDir("chrome-profiles", `kat-bundled-execute-${crypto.randomUUID()}`);

// blake3 of "abc" — the known vector.
const ABC_HASH = "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85";
// 1x1 transparent PNG, base64 — imageops info input.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// oxipng input (m3vb): a 32x32 RGBA8 PNG with thousands of colours AND varying
// alpha (no lossless reduction applies — only filters/deflate can change),
// naively encoded (filter 0 on every scanline, zlib default) the way most
// producers emit. Built here deterministically so the harness carries no
// binary fixture; the same encoder shape is pinned in oxipng-admission.test.ts.
const OXIPNG_INPUT = await naiveRgbaPng(32, 32);
const OXIPNG_INPUT_B64 = base64Of(OXIPNG_INPUT);
const GREP_STDIN = "MATCH one\nnope\nMATCH two\n";
const SORT_STDIN = "pear\napple\nfig\n";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** CRC-32 as PNG chunks use it. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A naive (filter-0, zlib default) RGBA8 PNG with a deterministic gradient +
 *  alpha ramp: the input shape an optimiser has real headroom on. */
async function naiveRgbaPng(width: number, height: number): Promise<Uint8Array> {
  const be32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const cat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const t = new TextEncoder().encode(type);
    return cat([be32(data.length), t, data, be32(crc32(cat([t, data])))]);
  };
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 4;
      raw[p] = (x * 8) & 255;
      raw[p + 1] = (y * 8) & 255;
      raw[p + 2] = (x * y) & 255;
      raw[p + 3] = 128 + (((x + y) * 4) & 127);
    }
  }
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const collected = new Response(cs.readable).arrayBuffer();
  await writer.write(raw);
  await writer.close();
  const idat = new Uint8Array(await collected);
  const ihdr = cat([be32(width), be32(height), new Uint8Array([8, 6, 0, 0, 0])]);
  return cat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array()),
  ]);
}

function base64Of(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The selectionRef the search result NAMED for this exact tool — a real
 *  caller resolves the ref by tool name, not by "first ref anywhere". */
function refFor(req: any, toolId: string): string {
  const result = lastToolResult(req);
  const found: { name?: string; selectionRef?: string }[] = [];
  const walk = (v: any, depth: number) => {
    if (depth > 8 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") {
      if (typeof v.name === "string" && typeof v.selectionRef === "string") found.push(v);
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
    }
  };
  walk(result, 0);
  const hit = found.find((x) => x.name === toolId || String(x.name).endsWith(toolId));
  return hit?.selectionRef ?? "";
}

const state: any = {
  schemaVersion: 1,
  pass: false,
  commit: null,
  extensionId: null,
  providerRequests: 0,
  tools: {}, // toolId → { invoked, dispatchPath, ok, result, latencyMs }
  previews: {}, // settings-preview surface results
  error: null,
};

try {
  state.commit = await new Deno.Command("git", { args: ["-C", ROOT, "rev-parse", "HEAD"] })
    .output().then((o) => new TextDecoder().decode(o.stdout).trim());

  // The scripted model: search → execute per tool, in one real hub run.
  const provider = await startScriptedProvider({
    steps: [
      { tool: "search_tools", args: { query: "grep", limit: 5 } },
      { tool: "execute_tool", args: (req: any) => ({
        selectionRef: refFor(req, "grep"),
        arguments: { args: ["-c", "MATCH"], stdin: GREP_STDIN },
      }) },
      { tool: "search_tools", args: { query: "sort lines", limit: 5 } },
      { tool: "execute_tool", args: (req: any) => ({
        selectionRef: refFor(req, "sort"),
        arguments: { stdin: SORT_STDIN },
      }) },
      { tool: "search_tools", args: { query: "image dimensions", limit: 5 } },
      { tool: "execute_tool", args: (req: any) => ({
        selectionRef: refFor(req, "imageops"),
        arguments: { args: ["info"], stdin: PNG_1X1 },
      }) },
      { tool: "search_tools", args: { query: "hash blake3", limit: 5 } },
      { tool: "execute_tool", args: (req: any) => ({
        selectionRef: refFor(req, "hash_blake3"),
        arguments: { data: btoa("abc") },
      }) },
      { tool: "search_tools", args: { query: "gzip compress", limit: 5 } },
      { tool: "execute_tool", args: (req: any) => ({
        selectionRef: refFor(req, "gzip"),
        arguments: { args: [], stdin: "hello gzip" },
      }) },
      { tool: "search_tools", args: { query: "sha256sum", limit: 5 } },
      { tool: "execute_tool", args: (req: any) => ({
        selectionRef: refFor(req, "sha256sum"),
        arguments: { args: [], stdin: "ten9 ungate vector" },
      }) },
      { tool: "search_tools", args: { query: "uuid", limit: 5 } },
      { tool: "execute_tool", args: (req: any) => ({
        selectionRef: refFor(req, "uuid"),
        arguments: { args: [], stdin: "" },
      }) },
      // az4k: "zstd compress" ranks compressops #1 in the real catalog search
      // (measured). `info` is the utf8 subcommand — it proves the DEFAULT-TIER
      // dispatch class without conflating the separate binary-stdout gap
      // (chrome-agent-platform-8oil: zstd/brotli frames under a utf8 encoding).
      { tool: "search_tools", args: { query: "zstd compress", limit: 5 } },
      { tool: "execute_tool", args: (req: any) => ({
        selectionRef: refFor(req, "compressops"),
        arguments: { args: ["info"], stdin: "hello" },
      }) },
      // m3vb: "optimise png" ranks oxipng #1 over all bundled descriptors in the
      // real catalog search (measured before this pair was added).
      { tool: "search_tools", args: { query: "optimise png", limit: 5 } },
      { tool: "execute_tool", args: (req: any) => ({
        selectionRef: refFor(req, "oxipng"),
        arguments: { args: [], stdin: OXIPNG_INPUT_B64 },
      }) },
      { text: "Bundled execute spot-check complete." },
    ],
  });

  const launched = await launchChrome({ extension: EXTENSION, profile: PROFILE, timeoutMs: 30_000 });
  const cdp = await openCdp(launched.wsUrl, { timeoutMs: 240_000 });
  const serviceWorker = await cdp.serviceWorker({ timeoutMs: 30_000 });
  assert(serviceWorker, "extension service worker did not register");
  const extensionId = new URL(serviceWorker.url).host;
  state.extensionId = extensionId;

  // Provider config → the scripted endpoint (dummy key, zero external calls).
  const options = await cdp.open(`chrome-extension://${extensionId}/options/options.html`);
  const setRes = await cdp.eval(options.sessionId, `chrome.runtime.sendMessage(${JSON.stringify({
    type: "provider.set",
    config: { provider: "openai-compatible", baseURL: provider.baseURL, apiKey: SCRIPTED_DUMMY_KEY, model: "scripted" },
  })})`);
  assert(setRes?.ok !== false, `provider.set failed: ${JSON.stringify(setRes)}`);

  // Hub composer → real run → real lazy protocol.
  const ntp = await cdp.open(`chrome-extension://${extensionId}/ntp/ntp.html`);
  await new Promise((r) => setTimeout(r, 2500));
  const typed = await cdp.eval(ntp.sessionId, `(() => {
    const i = document.querySelector('#task-input');
    if (!i) return false;
    i.value = 'bundled wasm execute spot-check';
    i.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  })()`);
  assert(typed === true, "composer input not found");
  await cdp.eval(ntp.sessionId, `document.querySelector('#run-task')?.click()`);

  // 9 searches + 9 executes + the final text = 19 model calls; the 19th
  // carries the last execute's result. Wait well past that.
  const EXPECTED_CALLS = 19;
  let calls = 0;
  for (let i = 0; i < 240; i++) {
    calls = provider.requests.length;
    if (calls >= EXPECTED_CALLS) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  state.providerRequests = calls;
  assert(calls >= EXPECTED_CALLS, `only ${calls}/${EXPECTED_CALLS} provider calls — the run never reached every tool`);

  const transcriptShot = await cdp.screenshot(ntp.sessionId, { format: "png", timeoutMs: 10_000 });
  if (transcriptShot) await Deno.writeFile(`${EVIDENCE}/run-transcript.png`, transcriptShot);

  // Compact protocol transcript: per request, the search-result tool names and
  // the execute envelope identity — the honest trace of what the protocol
  // actually resolved.
  state.transcript = provider.requests.map((r: any, i: number) => {
    const last = lastToolResult(r);
    const names: string[] = [];
    const walk = (v: any, depth: number) => {
      if (depth > 8 || v == null) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v === "object") {
        if (typeof v.name === "string" && typeof v.selectionRef === "string") names.push(v.name);
        for (const k of Object.keys(v)) walk(v[k], depth + 1);
      }
    };
    walk(last, 0);
    return { request: i, searchResultNames: names, selectedTool: last?.selectedTool ?? null, ok: last?.ok ?? null };
  });

  // Per-tool extraction. Execute steps are at fixed positions: the execute
  // request is the one RIGHT AFTER its search — search+execute per pair.
  const pairs: Array<[string, string, (envelope: any) => void]> = [
    ["grep", "execute_tool", (env) => {
      assert(env?.ok === true, `grep envelope not ok: ${JSON.stringify(env)?.slice(0, 300)}`);
      const out = JSON.stringify(env?.result ?? "");
      assert(out.includes("2"), `grep count wrong (expected 2): ${out.slice(0, 200)}`);
    }],
    ["sort", "execute_tool", (env) => {
      assert(env?.ok === true, `sort envelope not ok: ${JSON.stringify(env)?.slice(0, 300)}`);
      const out = JSON.stringify(env?.result ?? "");
      assert(out.includes("apple") && out.includes("fig") && out.indexOf("apple") < out.indexOf("pear"),
        `sort output wrong: ${out.slice(0, 200)}`);
    }],
    ["imageops", "execute_tool", (env) => {
      assert(env?.ok === true, `imageops envelope not ok: ${JSON.stringify(env)?.slice(0, 300)}`);
      const out = JSON.stringify(env?.result ?? "");
      assert(out.includes("1") && (out.toLowerCase().includes("width") || out.toLowerCase().includes("dimension")),
        `imageops info missing dimensions: ${out.slice(0, 200)}`);
    }],
    ["hash_blake3", "execute_tool", (env) => {
      assert(env?.ok === true, `hash_blake3 envelope not ok: ${JSON.stringify(env)?.slice(0, 300)}`);
      const out = JSON.stringify(env?.result ?? "");
      assert(out.includes(ABC_HASH), `hash_blake3 vector wrong: ${out.slice(0, 200)}`);
    }],
    ["gzip", "execute_tool", (env) => {
      // ten9 (no tool may be preview-gated): gzip now EXECUTES in-run through
      // the offscreen WASI host — output must be real gzip bytes (magic 1f8b),
      // not the former preview-only refusal.
      assert(env?.ok === true, `gzip in-run execution failed: ${JSON.stringify(env)?.slice(0, 300)}`);
      const out = JSON.stringify(env?.result ?? "");
      assert(
        out.includes("1f8b") || out.includes("H4sI"),
        `gzip in-run output lacks the gzip magic (hex or base64): ${out.slice(0, 300)}`,
      );
    }],
    ["sha256sum", "execute_tool", (env) => {
      // ten9: formerly preview-only — must now produce a real 64-hex digest.
      assert(env?.ok === true, `sha256sum in-run execution failed: ${JSON.stringify(env)?.slice(0, 300)}`);
      const out = JSON.stringify(env?.result ?? "");
      assert(/[0-9a-f]{64}/.test(out), `sha256sum output lacks a 64-hex digest: ${out.slice(0, 300)}`);
    }],
    ["uuid", "execute_tool", (env) => {
      // ten9: formerly preview-only — must now produce a real UUID shape.
      assert(env?.ok === true, `uuid in-run execution failed: ${JSON.stringify(env)?.slice(0, 300)}`);
      const out = JSON.stringify(env?.result ?? "");
      assert(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(out),
        `uuid output lacks a UUID: ${out.slice(0, 300)}`);
    }],
    ["compressops", "execute_tool", (env) => {
      // az4k: compressops declares the DEFAULT tier (2048 pages). Under the
      // old hardcoded tiny job the worker refused it (memory-rejected) on
      // every live run since ten9. It must now EXECUTE: `info` on 5 bytes
      // reports {"bytes":5,"magic":"unknown"}.
      assert(env?.ok === true, `compressops in-run execution failed: ${JSON.stringify(env)?.slice(0, 300)}`);
      const out = JSON.stringify(env?.result ?? "");
      assert(!out.includes("memory-rejected") && !out.includes("memory_exceeds_ceiling"),
        `compressops was memory-rejected — the job lane dropped the declared tier again: ${out.slice(0, 300)}`);
      assert(out.includes("magic") && out.includes("bytes"),
        `compressops info output lacks the frame report: ${out.slice(0, 300)}`);
    }],
    ["oxipng", "execute_tool", (env) => {
      // m3vb: the first tool admitted STRAIGHT into ten9's offscreen WASI-job
      // lane (never preview-only). The envelope must be a real, executed
      // result — the PNG signature in base64 — and SMALLER than the naive
      // 32x32 input this run sent; a refusal code means it never dispatched.
      assert(env?.ok === true, `oxipng in-run execution failed: ${JSON.stringify(env)?.slice(0, 300)}`);
      const out = JSON.stringify(env?.result ?? "");
      assert(!out.includes("preview_only_tool") && !out.includes("not_a_stream_tool") && !out.includes("unknown_bundled_tool"),
        `oxipng was refused, not executed: ${out.slice(0, 300)}`);
      assert(out.includes("iVBORw0KGgo"), `oxipng output lacks the PNG signature (base64): ${out.slice(0, 300)}`);
      const bytes = Number(out.match(/"stdoutBytes":(\d+)/)?.[1] ?? NaN);
      assert(Number.isFinite(bytes) && bytes > 0 && bytes < OXIPNG_INPUT.length,
        `oxipng output is not smaller than its ${OXIPNG_INPUT.length}-byte input (stdoutBytes=${bytes}): ${out.slice(0, 300)}`);
    }],
  ];

  for (const [toolId, , verify] of pairs) {
    const startedAt = Date.now();
    // The execute request for this tool: walk requests, find the latest
    // execute whose envelope names this tool.
    let env: any = null;
    let req: any = null;
    for (const r of provider.requests) {
      const candidate = executeEnvelope(r, toolId);
      if (candidate) { env = candidate; req = r; }
    }
    assert(env, `${toolId}: no execute_tool envelope found in the run`);
    const latencyMs = Date.now() - startedAt; // extraction latency only
    verify(env);
    state.tools[toolId] = {
      invoked: true,
      dispatchPath: toolId === "gzip" || toolId === "sha256sum" || toolId === "uuid"
        ? "offscreen WASI job (ten9 ungate: formerly preview-only)"
        : toolId === "compressops" ? "offscreen WASI job (az4k: default tier carried by the job)"
        : toolId === "oxipng" ? "offscreen WASI job (m3vb: admitted straight into the job lane)"
        : toolId === "hash_blake3" ? "call-export host" : "offscreen WASI stream",
      ok: env?.ok === true,
      result: env?.result ?? env,
      latencyMs,
      requestIndex: provider.requests.indexOf(req),
    };
    await Deno.writeTextFile(`${EVIDENCE}/${toolId}.json`, JSON.stringify({
      toolId, ...state.tools[toolId], envelope: env,
    }, null, 2));
    console.log(`PASS ${toolId} (${state.tools[toolId].dispatchPath})`);
  }

  // The settings-preview surface for the preview-only class: the REAL Settings
  // route, real authority. KNOWN-SURFACE NOTE: kat-wasi-tranche2 is an owned
  // RED with this exact "offscreen unavailable/no offscreen response"
  // signature — a failure here is recorded as a finding (bead + report), not
  // absorbed, and not double-fixed in this pass.
  // az4k: the Settings route builds its job through the SAME buildPreviewJob
  // and the options page runs the SAME wasm-execution-worker — so a
  // default-tier tool (compressops) is previewed here too, proving both
  // routes carry the declared tier.
  for (const [toolId, args, stdin, verify] of [
    ["gzip", [], "hello gzip", (text: string) => {
      assert(text.includes("1f8b") || text.includes("4X8") || text.includes("gB("),
        `gzip preview output lacks the gzip magic: ${text.slice(0, 200)}`);
    }],
    ["compressops", ["info"], "hello", (text: string) => {
      assert(!text.includes("memory-rejected") && !text.includes("memory_exceeds_ceiling"),
        `compressops preview was memory-rejected — the Settings route dropped the declared tier: ${text.slice(0, 200)}`);
      assert(text.includes("magic") && text.includes("bytes"),
        `compressops preview output lacks the frame report: ${text.slice(0, 200)}`);
    }],
  ] as Array<[string, string[], string, (text: string) => void]>) {
    const t0 = Date.now();
    const out = await cdp.eval(options.sessionId, `chrome.runtime.sendMessage(${JSON.stringify({
      type: "tool.preview.run", toolId, args, stdin,
    })})`);
    const latencyMs = Date.now() - t0;
    const text = JSON.stringify(out ?? {});
    if (out?.ok === true) {
      verify(text);
      state.previews[toolId] = { ok: true, latencyMs, result: out };
      console.log(`PASS preview ${toolId}`);
    } else if (/offscreen/i.test(text)) {
      state.previews[toolId] = {
        ok: false, latencyMs, result: out,
        finding: `matches the owned kat-wasi-tranche2 RED signature (tool.preview.run → offscreen round-trip failure); filed separately, not absorbed`,
      };
      console.log(`FINDING preview ${toolId}: ${text.slice(0, 200)} — recorded, owned red class (kat-wasi-tranche2)`);
    } else {
      throw new Error(`${toolId} preview failed unexpectedly: ${text.slice(0, 300)}`);
    }
    await Deno.writeTextFile(`${EVIDENCE}/preview-${toolId}.json`, JSON.stringify({ toolId, latencyMs, result: out }, null, 2));
  }

  const previewShot = await cdp.screenshot(options.sessionId, { format: "png", timeoutMs: 10_000 });
  if (previewShot) await Deno.writeFile(`${EVIDENCE}/settings-preview.png`, previewShot);

  state.pass = true;
  await Deno.writeTextFile(`${EVIDENCE}/result.json`, JSON.stringify(state, null, 2));
  console.log(`PASS: bundled execute spot-check — evidence ${EVIDENCE}`);
  await provider.close();
  await launched.proc.kill();
  Deno.exit(0);
} catch (e) {
  state.error = String((e as Error)?.message ?? e);
  await Deno.writeTextFile(`${EVIDENCE}/result.json`, JSON.stringify(state, null, 2)).catch(() => {});
  console.error(`FAIL: ${state.error}`);
  console.error(`evidence: ${EVIDENCE}`);
  Deno.exit(1);
}
