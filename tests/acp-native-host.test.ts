// tests/acp-native-host.test.ts — the native-messaging half of ACP, driven with
// Chrome's OWN framing (4-byte little-endian length + JSON) so the host is
// verified without a browser in the loop: initialize → session/new → prompt,
// through scripts/acp-native-host.sh → the fixture adapter.
//
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { encodeNativeMessage, NativeFrameDecoder } from "../scripts/acp-native-host.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FAKE_ADAPTER = fromFileUrl(new URL("./fixtures/acp-fake-adapter.mjs", import.meta.url));
const HOST_SH = `${ROOT}scripts/acp-native-host.sh`;

Deno.test("native framing: encode/decode round-trips, including split and coalesced frames", () => {
  const decoder = new NativeFrameDecoder();
  const one = encodeNativeMessage({ a: 1 });
  assertEquals(decoder.push(one), [{ a: 1 }]);

  const two = encodeNativeMessage({ b: "two" });
  // Split across two reads (Chrome does not promise frame boundaries).
  assertEquals(decoder.push(two.subarray(0, 3)), []);
  assertEquals(decoder.push(two.subarray(3)), [{ b: "two" }]);

  // Two frames in one read.
  const merged = new Uint8Array([...encodeNativeMessage({ c: 3 }), ...encodeNativeMessage({ d: 4 })]);
  assertEquals(decoder.push(merged), [{ c: 3 }, { d: 4 }]);

  // A malformed frame is skipped, not fatal.
  const bad = new Uint8Array(4);
  new DataView(bad.buffer).setUint32(0, 3, true);
  const badFull = new Uint8Array([...bad, 0x7b, 0x21, 0x7d]); // "{!}" — invalid JSON
  assertEquals(decoder.push(badFull), []);
});

Deno.test("acp native host: drives a full turn over Chrome's native framing (no bridge, no port)", async () => {
  // The fixture logs every frame the ADAPTER received — the observer for "the
  // host filled the cwd the extension never sent".
  const logPath = `${durableDir("acp-fixture-logs")}/native-${Date.now()}.jsonl`;
  const child = new Deno.Command(HOST_SH, {
    env: {
      ...Deno.env.toObject(),
      CAP_ACP_ADAPTER: FAKE_ADAPTER,
      CAP_ACP_CWD: "/tmp",
      CAP_ACP_FIXTURE_LOG: logPath,
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();

  const writer = child.stdin.getWriter();
  const decoder = new NativeFrameDecoder();
  const seen: any[] = [];
  const waits = new Map<number, (m: any) => void>();
  let readerDone = false;
  (async () => {
    const reader = child.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const msg of decoder.push(value)) {
          seen.push(msg);
          const pending = waits.get((msg as any).id);
          if (pending) { waits.delete((msg as any).id); pending(msg); }
        }
      }
    } finally { readerDone = true; }
  })();

  let nextId = 1;
  const request = (method: string, params: unknown = {}) => {
    const id = nextId++;
    const p = new Promise<any>((resolve, reject) => {
      waits.set(id, resolve);
      setTimeout(() => { if (waits.has(id)) { waits.delete(id); reject(new Error(`${method} timed out`)); } }, 20000);
    });
    void writer.write(encodeNativeMessage({ jsonrpc: "2.0", id, method, params }));
    return p;
  };
  const respondToAgent = (msg: any, result: unknown) => {
    void writer.write(encodeNativeMessage({ jsonrpc: "2.0", id: msg.id, result }));
  };

  try {
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    assertEquals(init.result.protocolVersion, 1);
    assertEquals(init.result.agentInfo.name, "fake-acp-adapter");

    const session = await request("session/new", { cwd: "", mcpServers: [] });
    const sessionId = session.result.sessionId;
    assertEquals(sessionId, "ses_fake_1");

    // The host fills the working directory the extension cannot know: the
    // adapter's own frame log shows the request it received.
    const frames = (await Deno.readTextFile(logPath)).trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l));
    const newFrame = frames.find((f: any) => f.dir === "in" && f.msg.method === "session/new");
    assertEquals(newFrame?.msg?.params?.cwd, "/tmp", "the host must fill the host-side cwd");

    const turn = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "native hello" }] });
    assertEquals(turn.result.stopReason, "end_turn");

    // Streamed updates arrived as native frames.
    const kinds = seen.filter((m) => m.method === "session/update").map((m) => m.params?.update?.sessionUpdate);
    assert(kinds.includes("agent_message_chunk"), `expected a message chunk, saw ${JSON.stringify(kinds)}`);
    const text = seen.filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((m) => m.params.update.content.text).join("");
    assertEquals(text, "fake reply");
    assertEquals(readerDone, false, "the host must stay alive for the next turn");
  } finally {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    await child.status.catch(() => null);
  }
});
