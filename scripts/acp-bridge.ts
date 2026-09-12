// scripts/acp-bridge.ts — Loopback WebSocket-to-stdio bridge for ACP harnesses.
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)
//
// Bridges Chrome Extension WebSocket connections to a locally spawned ACP adapter (e.g. pi-acp).
// Usage: deno run -A scripts/acp-bridge.ts [--port 3210] [--adapter path/to/pi-acp]

import { parseArgs } from "jsr:@std/cli@1/parse-args";

const args = parseArgs(Deno.args, {
  string: ["port", "adapter", "harness"],
  default: {
    port: "3210",
    adapter: "/home/paulkinlan/.pi/agent/npm/node_modules/pi-acp/dist/index.js",
    harness: "pi",
  },
});

const PORT = parseInt(args.port, 10);
const ADAPTER_PATH = args.adapter;
const HARNESS = args.harness;

console.log(`[acp-bridge] Starting bridge for harness "${HARNESS}" using adapter: ${ADAPTER_PATH}`);

export function createAcpServer(port: number, adapterPath = ADAPTER_PATH) {
  return Deno.serve({ port, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, harness: HARNESS, adapter: adapterPath }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("ACP Bridge: Connect via WebSocket at /acp", { status: 426 });
    }

    const clientOrigin = req.headers.get("origin") || "extension";
    const { socket, response } = Deno.upgradeWebSocket(req);

    // Spawn the ACP adapter process
    let child: Deno.ChildProcess | null = null;
    let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

    socket.onopen = async () => {
      console.log(`[acp-bridge] Client connected from ${clientOrigin}`);
      try {
        const cmd = new Deno.Command("node", {
          args: [adapterPath],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
          env: {
            ...Deno.env.toObject(),
            PI_ACP_HARNESS: HARNESS,
          },
        });
        child = cmd.spawn();
        writer = child.stdin.getWriter();

        // Stream stdout from adapter to WebSocket client
        (async () => {
          const reader = child.stdout.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let nl: number;
              while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (line.trim() && socket.readyState === WebSocket.OPEN) {
                  socket.send(line);
                }
              }
            }
          } catch (e) {
            console.error("[acp-bridge] Error reading adapter stdout:", e);
          }
        })();

        // Relay stderr to console
        (async () => {
          const reader = child.stderr.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              if (text.trim()) {
                console.error(`[adapter-stderr] ${text.trim()}`);
              }
            }
          } catch {}
        })();
      } catch (err) {
        console.error("[acp-bridge] Failed to spawn adapter:", err);
        socket.close(1011, `Failed to spawn adapter: ${err}`);
      }
    };

    socket.onmessage = async (event) => {
      if (!writer) return;
      try {
        const data = String(event.data);
        const encoder = new TextEncoder();
        await writer.write(encoder.encode(data + "\n"));
      } catch (err) {
        console.error("[acp-bridge] Failed to write to adapter stdin:", err);
      }
    };

    socket.onclose = () => {
      console.log("[acp-bridge] Client disconnected, cleaning up adapter process");
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    };

    socket.onerror = (e) => {
      console.error("[acp-bridge] WebSocket error:", e);
    };

    return response;
  });
}

// If invoked directly from CLI
if (import.meta.main) {
  createAcpServer(PORT);
}
