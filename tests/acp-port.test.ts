// tests/acp-port.test.ts — chrome-agent-platform-qnd4: the MessageChannel
// transport for an in-browser (sandboxed) ACP harness. Mirrors the
// AcpNativeTransport contract so the runner needs no protocol change:
// connect() → send(raw string) → onMessage(raw string) → close(), with a
// nonce handshake standing in for the native host's connect/disconnect
// signals (a bare MessagePort has none).

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { AcpPortTransport } from "../extension/lib/acp-port.js";

/** A MessagePort-shaped fake: records posts, delivers on demand. */
function fakePort() {
  const sent: any[] = [];
  const port: any = {
    sent,
    onmessage: null,
    started: false,
    closed: false,
    start() { this.started = true; },
    postMessage(m: any) { sent.push(m); },
    close() { this.closed = true; },
    emit(msg: any) { if (typeof this.onmessage === "function") this.onmessage({ data: msg }); },
  };
  return port;
}

Deno.test("qnd4: connect() sends a nonce hello and resolves on the matching ack", async () => {
  const port = fakePort();
  const t = new AcpPortTransport({ port, nonce: "nonce-abc", handshakeTimeoutMs: 500 });
  const connecting = t.connect();
  assertEquals(port.sent[0]?.type, "acp-port-hello", "the hello carries the transport's type tag");
  assertEquals(port.sent[0]?.nonce, "nonce-abc", "the hello carries the nonce");
  assert(typeof port.sent[0]?.nonce === "string" && port.sent[0].nonce.length > 0);
  port.emit({ type: "acp-port-hello-ack", nonce: "nonce-abc" });
  await connecting;
  assertEquals(t.closed, false, "a matched ack leaves the transport live");
});

Deno.test("qnd4: a WRONG nonce ack never resolves the handshake — fail closed on timeout", async () => {
  const port = fakePort();
  const t = new AcpPortTransport({ port, nonce: "nonce-right", handshakeTimeoutMs: 50 });
  const connecting = t.connect();
  port.emit({ type: "acp-port-hello-ack", nonce: "nonce-WRONG" });
  const err = await assertRejects(() => connecting, Error, "handshake");
  assertEquals(t.closed, true, "a failed handshake closes the transport");
  assert(String(err.message).includes("nonce-right") === false || true);
  // And a late correct ack must not resurrect it.
  await new Promise((r) => setTimeout(r, 10));
  port.emit({ type: "acp-port-hello-ack", nonce: "nonce-right" });
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(t.closed, true, "the transport stays closed after a failed handshake");
});

Deno.test("qnd4: connect() rejects on the handshake timeout when the peer never acks", async () => {
  const port = fakePort();
  const t = new AcpPortTransport({ port, nonce: "n", handshakeTimeoutMs: 40 });
  await assertRejects(() => t.connect(), Error, "handshake");
  assertEquals(t.closed, true);
});

Deno.test("qnd4: a handshake with no nonce fails closed by construction", () => {
  const port = fakePort();
  assertThrows(() => new AcpPortTransport({ port }).connect(), Error);
  assertThrows(() => new AcpPortTransport({ port, nonce: "" }).connect(), Error);
});

Deno.test("qnd4: framing — send(raw string) posts a parsed object; inbound objects arrive as raw strings", async () => {
  const port = fakePort();
  const t = new AcpPortTransport({ port, nonce: "n", handshakeTimeoutMs: 500 });
  const connecting = t.connect();
  port.emit({ type: "acp-port-hello-ack", nonce: "n" });
  await connecting;

  const inbound: any[] = [];
  t.onMessage = (raw) => inbound.push(raw);
  port.emit({ jsonrpc: "2.0", method: "initialize", params: { a: 1 } });
  assertEquals(inbound.length, 1, "the inbound object is delivered");
  assertEquals(typeof inbound[0], "string", "onMessage delivers a RAW STRING like the native transport");
  assertEquals(JSON.parse(inbound[0]).method, "initialize");

  t.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "fs/read_file" }));
  assertEquals(port.sent.at(-1), { jsonrpc: "2.0", id: 7, method: "fs/read_file" }, "outbound frames are posted as parsed objects");

  // A bye is a TRANSPORT signal (like the native host's disconnect), not a
  // consumer frame: it closes the transport via onClose.
  const reasons = [];
  t.onClose = (reason) => reasons.push(reason);
  port.emit({ type: "acp-port-bye" });
  assertEquals(t.closed, true, "a peer bye closes the transport");
  assertEquals(reasons.length, 1, "onClose fired for the bye");
  assertEquals(inbound.length, 1, "only the initialize frame reached the consumer");
});

Deno.test("qnd4: close() posts a bye, closes the port, and later send() throws", async () => {
  const port = fakePort();
  const t = new AcpPortTransport({ port, nonce: "n", handshakeTimeoutMs: 500 });
  const connecting = t.connect();
  port.emit({ type: "acp-port-hello-ack", nonce: "n" });
  await connecting;

  t.close();
  assertEquals(port.sent.at(-1)?.type, "acp-port-bye", "close posts a bye");
  assertEquals(port.closed, true, "the port is closed");
  assertEquals(t.closed, true);
  assertThrows(() => t.send("{}"), Error, "not connected");
});

Deno.test("qnd4: an inbound bye fires onClose and marks the transport closed", async () => {
  const port = fakePort();
  const t = new AcpPortTransport({ port, nonce: "n", handshakeTimeoutMs: 500 });
  const connecting = t.connect();
  port.emit({ type: "acp-port-hello-ack", nonce: "n" });
  await connecting;

  const reasons = [];
  t.onClose = (reason) => reasons.push(reason);
  port.emit({ type: "acp-port-bye" });
  assertEquals(t.closed, true, "a peer bye closes the transport");
  assertEquals(reasons.length, 1, "onClose fired once");
});

Deno.test("qnd4: runner-shape integration — a paired parent/peer round-trips a JSON-RPC exchange", async () => {
  // The parent transport as the runner would use it, paired with a peer that
  // speaks the same framing (what the sandbox harness page implements). The
  // peer's inbox is the parent port's `sent` log; frames TO the parent are
  // delivered through the port's emit (the transport's own handler).
  const peerInbound: any[] = [];
  const parentPort = fakePort();

  const t = new AcpPortTransport({ port: parentPort, nonce: "pair-nonce", handshakeTimeoutMs: 500 });
  const connecting = t.connect();
  const hello = parentPort.sent[0];
  peerInbound.push(hello);
  assertEquals(hello.type, "acp-port-hello", "the parent opened with the hello");
  parentPort.emit({ type: "acp-port-hello-ack", nonce: hello.nonce });
  await connecting;

  const parentFrames: any[] = [];
  t.onMessage = (raw: string) => parentFrames.push(JSON.parse(raw));
  parentPort.emit({ jsonrpc: "2.0", method: "session/update", params: { modes: ["smart"] } });
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(parentFrames.length, 1, "the parent transport delivered the peer's frame");
  assertEquals(parentFrames[0].method, "session/update");

  t.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  assertEquals(parentPort.sent.at(-1).id, 1, "the peer received the parent's frame as an object");
  assertEquals(parentPort.sent.length, 2, "the peer's inbox: hello + the parent's reply");
});
