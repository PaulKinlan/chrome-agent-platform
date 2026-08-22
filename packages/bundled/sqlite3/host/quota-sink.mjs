export const WASI_ERRNO = Object.freeze({
  SUCCESS: 0,
  BADF: 8,
  FAULT: 21,
  FBIG: 27,
  IO: 29,
});

function rangeFits(offset, length, total) {
  return Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length >= 0 &&
    offset <= total && length <= total - offset;
}

export function makeBoundedFdWrite(originalFdWrite, getMemory, {
  stdoutLimit = 2 * 1024 * 1024,
  stderrLimit = 64 * 1024,
} = {}) {
  if (typeof originalFdWrite !== 'function' || typeof getMemory !== 'function') {
    throw new TypeError('fd_write and memory accessor are required');
  }
  const totals = new Map([[1, 0], [2, 0]]);
  const limits = new Map([[1, stdoutLimit], [2, stderrLimit]]);

  function boundedFdWrite(fd, iovs, iovsLength, nwritten) {
    const memory = getMemory();
    if (!(memory instanceof WebAssembly.Memory)) return WASI_ERRNO.FAULT;
    const byteLength = memory.buffer.byteLength;
    const tableBytes = iovsLength * 8;
    if (!Number.isSafeInteger(tableBytes) || !rangeFits(iovs, tableBytes, byteLength) ||
        !rangeFits(nwritten, 4, byteLength)) {
      return WASI_ERRNO.FAULT;
    }
    const view = new DataView(memory.buffer);
    let requested = 0;
    for (let index = 0; index < iovsLength; index += 1) {
      const entry = iovs + index * 8;
      const pointer = view.getUint32(entry, true);
      const length = view.getUint32(entry + 4, true);
      if (!rangeFits(pointer, length, byteLength)) return WASI_ERRNO.FAULT;
      requested += length;
      if (!Number.isSafeInteger(requested)) return WASI_ERRNO.FBIG;
    }
    if (limits.has(fd)) {
      const used = totals.get(fd);
      const limit = limits.get(fd);
      if (requested > limit - used) {
        view.setUint32(nwritten, 0, true);
        return WASI_ERRNO.FBIG;
      }
    }
    const errno = originalFdWrite(fd, iovs, iovsLength, nwritten);
    if (errno !== WASI_ERRNO.SUCCESS) return errno;
    const afterMemory = getMemory();
    if (!(afterMemory instanceof WebAssembly.Memory) ||
        !rangeFits(nwritten, 4, afterMemory.buffer.byteLength)) return WASI_ERRNO.FAULT;
    const actual = new DataView(afterMemory.buffer).getUint32(nwritten, true);
    if (actual > requested) return WASI_ERRNO.IO;
    if (limits.has(fd)) totals.set(fd, totals.get(fd) + actual);
    return errno;
  }

  return { fdWrite: boundedFdWrite, totals };
}
