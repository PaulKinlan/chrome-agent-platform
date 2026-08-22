// tests/wasm-fixture-builder.mjs — a tiny programmatic wasm builder for the
// Gate 2 REAL-WASM round-trip fixture (no external toolchain).
// @ts-nocheck

function u32leb(value) {
  const out = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return out;
}
function u64leb(value) {
  let big = BigInt(value);
  const out = [];
  do {
    let byte = Number(big & 0x7fn);
    big >>= 7n;
    if (big > 0n) byte |= 0x80;
    out.push(byte);
  } while (big > 0n);
  return out;
}
function section(id, payload) {
  return [id, ...u32leb(payload.length), ...payload];
}
function nameBytes(text) {
  const bytes = [...new TextEncoder().encode(text)];
  return [bytes.length, ...bytes];
}

/** A wasm module whose run() export performs a REAL file round trip:
 *  path_open(3, 0, "scratch/f.bin", 13, CREAT, R, 0n, 0, &fd)   // R includes
 *    FD_READ|FD_WRITE|FD_SEEK|FD_TELL|FD_FILESTAT_GET            // FD_READ
 *  → fd_write(fd, &{0x30,5}, 1, &nwritten)      // writes "hello" (payload at 0x30)
 *  → fd_seek(fd, 0n, SET, &newoffset)           // back to 0
 *  → fd_read(fd, &{0x20,5}, 1, &nread)          // reads into 0x20 (seeded "!!!!!")
 *  → fd_write(1, &{0x20,5}, 1, &nwritten2)      // echoes the READ BACK to STDOUT
 *  → fd_close(fd)
 * EVERY syscall errno is CHECKED: a nonzero errno TRAPS the module
 * (i32.const 0; i32.ne; if; unreachable; end) — a failed file op can never be
 * silently dropped. The stdout echo can only emit "hello" after a REAL fd_read
 * of the file (the read buffer starts as GARBAGE, not the payload).
 */
export function buildWasiFdRoundTripWasm() {
  const t0 = [0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f];
  const t1 = [0x60, 1, 0x7f, 1, 0x7f];
  const t2 = [0x60, 9, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7e, 0x7e, 0x7f, 0x7f, 1, 0x7f];
  const t3 = [0x60, 4, 0x7f, 0x7e, 0x7f, 0x7f, 1, 0x7f];
  const t4 = [0x60, 0, 0];
  const typePayload = [5, ...t0, ...t1, ...t2, ...t3, ...t4];

  const imp = (m, n, ti) => [...nameBytes(m), ...nameBytes(n), 0x00, ti];
  const importPayload = [5,
    ...imp("wasi_snapshot_preview1", "fd_write", 0),
    ...imp("wasi_snapshot_preview1", "fd_close", 1),
    ...imp("wasi_snapshot_preview1", "path_open", 2),
    ...imp("wasi_snapshot_preview1", "fd_seek", 3),
    ...imp("wasi_snapshot_preview1", "fd_read", 0),
  ];

  const funcPayload = [1, 0x04];
  const memoryPayload = [1, 0x01, 0x01, 0x01];

  const PATH = [...new TextEncoder().encode("scratch/f.bin")]; // 13 bytes
  const HELLO = [...new TextEncoder().encode("hello")];
  const GARBAGE = [...new TextEncoder().encode("!!!!!")];
  const iovecWrite = [0x30, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00];
  const iovecRead = [0x20, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00];
  const dataPayload = [
    5,
    0x00, 0x41, ...u32leb(0x10), 0x0b, ...u32leb(PATH.length), ...PATH,
    0x00, 0x41, ...u32leb(0x20), 0x0b, ...u32leb(GARBAGE.length), ...GARBAGE,
    0x00, 0x41, ...u32leb(0x30), 0x0b, ...u32leb(HELLO.length), ...HELLO,
    0x00, 0x41, ...u32leb(0x200), 0x0b, ...u32leb(iovecWrite.length), ...iovecWrite,
    0x00, 0x41, ...u32leb(0x210), 0x0b, ...u32leb(iovecRead.length), ...iovecRead,
  ];

  const exportPayload = [
    2,
    ...nameBytes("run"), 0x00, 0x05,
    ...nameBytes("memory"), 0x02, 0x00,
  ];

  // errno CHECK: errno==0 continues, else unreachable (trap).
  const CHECK = [0x41, 0x00, 0x47, 0x04, 0x40, 0x00, 0x0b];
  // rights = FD_READ(2)|FD_WRITE(64)|FD_SEEK(4)|FD_TELL(32)|FD_FILESTAT_GET(2097152)
  const body = [
    0x41, 0x03, 0x41, 0x00, 0x41, 0x10, 0x41, 0x0d, 0x41, 0x01,
    0x42, ...u64leb(2097254), 0x42, 0x00, 0x41, 0x00, 0x41, 0x80, 0x02,
    0x10, 0x02, ...CHECK,
    0x41, 0x80, 0x02, 0x28, 0x02, 0x00,
    0x41, 0x80, 0x04, 0x41, 0x01, 0x41, 0x80, 0x06,
    0x10, 0x00, ...CHECK,
    0x41, 0x80, 0x02, 0x28, 0x02, 0x00, 0x42, 0x00, 0x41, 0x00, 0x41, 0x80, 0x08,
    0x10, 0x03, ...CHECK,
    0x41, 0x80, 0x02, 0x28, 0x02, 0x00,
    0x41, 0x90, 0x04, 0x41, 0x01, 0x41, 0x80, 0x0a,   // fd_read(fd, &{0x20,5} via 0x210)
    0x10, 0x04, ...CHECK,
    0x41, 0x01, 0x41, 0x90, 0x04, 0x41, 0x01, 0x41, 0x80, 0x0c, // stdout echoes the 0x210 buffer
    0x10, 0x00, ...CHECK,
    0x41, 0x80, 0x02, 0x28, 0x02, 0x00,
    0x10, 0x01, ...CHECK,
    0x0b,
  ];
  const codePayload = [1, ...u32leb(1 + body.length), 0x00, ...body];

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, typePayload),
    ...section(2, importPayload),
    ...section(3, funcPayload),
    ...section(5, memoryPayload),
    ...section(7, exportPayload),
    ...section(10, codePayload),
    ...section(11, dataPayload),
  ]);
}
