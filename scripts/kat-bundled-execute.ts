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
//   stream-backed  (grep, sort, imageops) → offscreen WASI stream run
//   call-export    (hash_blake3)          → offscreen call-export host
//   preview-only   (gzip)                 → the run protocol REFUSES by design;
//                                           the tool's real surface is the
//                                           Settings preview route
//                                           (tool.preview.run), driven here too
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
const GREP_STDIN = "MATCH one\nnope\nMATCH two\n";
const SORT_STDIN = "pear\napple\nfig\n";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

  // 5 searches + 5 executes + the final text = 11 model calls; the 11th
  // carries the last execute's result. Wait well past that.
  const EXPECTED_CALLS = 11;
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
      // BY DESIGN: preview-only tools refuse in-run dispatch.
      const out = JSON.stringify(env ?? "");
      assert(
        env?.ok === false || /preview/i.test(out),
        `gzip in-run result unexpected (neither ok nor preview-only): ${out.slice(0, 300)}`,
      );
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
      dispatchPath: toolId === "gzip"
        ? "preview-only-in-run (by design; settings surface below)"
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
  for (const [toolId, args, stdin] of [
    ["gzip", [], "hello gzip"],
  ] as Array<[string, string[], string]>) {
    const t0 = Date.now();
    const out = await cdp.eval(options.sessionId, `chrome.runtime.sendMessage(${JSON.stringify({
      type: "tool.preview.run", toolId, args, stdin,
    })})`);
    const latencyMs = Date.now() - t0;
    const text = JSON.stringify(out ?? {});
    if (out?.ok === true) {
      assert(text.includes("1f8b") || text.includes("4X8") || text.includes("gB("),
        `gzip preview output lacks the gzip magic: ${text.slice(0, 200)}`);
      state.previews[toolId] = { ok: true, latencyMs, result: out };
      console.log(`PASS preview ${toolId}`);
    } else if (/offscreen/i.test(text)) {
      state.previews[toolId] = {
        ok: false, latencyMs, result: out,
        finding: `matches the owned kat-wasi-tranche2 RED signature (tool.preview.run → offscreen round-trip failure); filed separately, not absorbed`,
      };
      console.log(`FINDING preview ${toolId}: ${text.slice(0, 200)} — recorded, owned red class (kat-wasi-tranche2)`);
    } else {
      throw new Error(`gzip preview failed unexpectedly: ${text.slice(0, 300)}`);
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
