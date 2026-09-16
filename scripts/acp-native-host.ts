// scripts/acp-native-host.ts — the ACP adapter as a CHROME NATIVE MESSAGING
// HOST: no WebSocket, no port, no daemon. Chrome launches this process when the
// extension calls chrome.runtime.connectNative() and kills it when the port
// closes, so there is nothing for the user to start, babysit or supervise.
//
// Framing (the native-messaging protocol, NOT the ACP one):
//   Chrome → host: 4-byte little-endian length + UTF-8 JSON
//   host → Chrome: same
//   adapter (pi-acp et al): newline-delimited JSON
// This file is spawned by scripts/acp-native-host.sh (a native messaging
// manifest names ONE executable and cannot pass arguments).
//
// Harness selection: $CAP_ACP_HARNESS (default "pi"), plus $CAP_ACP_CWD and
// $CAP_ACP_ADAPTER for overrides — the same table and host-default rules the
// WebSocket bridge uses (imported, not duplicated).

import { applyHostDefaults, resolveAdapter, HARNESS_ADAPTERS } from "./acp-bridge.ts";

const HARNESS = Deno.env.get("CAP_ACP_HARNESS") || "pi";
const ADAPTER_OVERRIDE = Deno.env.get("CAP_ACP_ADAPTER") || "";
const CWD_OVERRIDE = Deno.env.get("CAP_ACP_CWD") || "";

/** One native-messaging frame: 4-byte LE length + JSON payload. */
export function encodeNativeMessage(msg: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(4 + json.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  return out;
}

/** Incremental native-messaging decoder (handles split/coalesced frames). */
export class NativeFrameDecoder {
  #buf = new Uint8Array(0);
  push(chunk: Uint8Array): unknown[] {
    const merged = new Uint8Array(this.#buf.length + chunk.length);
    merged.set(this.#buf, 0);
    merged.set(chunk, this.#buf.length);
    this.#buf = merged;
    const out: unknown[] = [];
    while (this.#buf.length >= 4) {
      const len = new DataView(this.#buf.buffer, this.#buf.byteOffset).getUint32(0, true);
      if (this.#buf.length < 4 + len) break;
      const payload = this.#buf.subarray(4, 4 + len);
      this.#buf = this.#buf.subarray(4 + len);
      try { out.push(JSON.parse(new TextDecoder().decode(payload))); } catch { /* skip malformed frame */ }
    }
    return out;
  }
}

if (import.meta.main) {
  const resolved = resolveAdapter(HARNESS, ADAPTER_OVERRIDE);
  if (resolved.cmd === "node" && !(() => { try { return Deno.statSync(resolved.args[0]).isFile; } catch { return false; } })()) {
    // Report through the native channel, then exit: Chrome surfaces nothing
    // itself, so the extension must be told why the harness is unavailable.
    Deno.stderr.writeSync(new TextEncoder().encode(`adapter not found: ${resolved.args[0]}\n`));
  }
  const child = new Deno.Command(resolved.cmd, {
    args: resolved.args,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  const childWriter = child.stdin.getWriter();

  // Chrome → adapter (with the host-side cwd default the extension cannot know)
  (async () => {
    const decoder = new NativeFrameDecoder();
    const reader = Deno.stdin.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const msg of decoder.push(value)) {
          const framed = applyHostDefaults(JSON.stringify(msg), CWD_OVERRIDE || undefined);
          await childWriter.write(new TextEncoder().encode(framed + "\n"));
        }
      }
    } catch { /* stdin closed: Chrome closed the port */ }
  })();

  // adapter → Chrome (newline frames → native frames)
  (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            Deno.stdout.writeSync(encodeNativeMessage(JSON.parse(line)));
          } catch { /* non-JSON adapter noise */ }
        }
      }
    } catch { /* adapter exited */ }
  })();

  // The adapter exiting is a real answer: tell the extension instead of hanging,
  // then stop (Chrome will re-launch the host on the next connectNative).
  const status = await child.status;
  const reason = `adapter exited (code ${status.code}${status.signal ? `, signal ${status.signal}` : ""})`;
  Deno.stderr.writeSync(new TextEncoder().encode(`${reason}\n`));
  try { Deno.stdout.writeSync(encodeNativeMessage({ jsonrpc: "2.0", method: "host/exit", params: { reason, harness: HARNESS, knownHarnesses: Object.keys(HARNESS_ADAPTERS) } })); } catch { /* port already gone */ }
  Deno.exit(0);
}
