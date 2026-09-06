// cap-zxing: this sysroot's libc++abi is built without exception support.
// zxing-cpp throws only on hard error paths; the admission contract is
// fail-closed, so a throw becomes an abort (non-zero exit), never silent
// success. Catch blocks remain compiled but unreachable.
#include <cstdio>
#include <cstdlib>
extern "C" void* __cxa_allocate_exception(size_t) {
  fprintf(stderr, "cap-zxing: internal exception (fail-closed abort)\n");
  abort();
}
extern "C" void __cxa_throw(void*, void*, void (*)(void*)) {
  fprintf(stderr, "cap-zxing: internal exception (fail-closed abort)\n");
  abort();
}
extern "C" void __cxa_free_exception(void*) {}
// Single-threaded: thread-locals are process-locals. Keep fn+arg pairs in a
// small registry and invoke them (with the correct signature) from one real
// atexit callback — a raw cast through atexit() traps on call_indirect.
namespace {
struct DtorEntry { void (*fn)(void*); void* arg; };
DtorEntry g_dtors[64];
int g_ndtors = 0;
void runDtors() { for (int i = g_ndtors - 1; i >= 0; --i) g_dtors[i].fn(g_dtors[i].arg); }
}
extern "C" int __cxa_thread_atexit(void (*fn)(void*), void* arg, void*) {
  if (g_ndtors >= 64) return -1;
  g_dtors[g_ndtors++] = { fn, arg };
  static bool registered = false;
  if (!registered) { atexit(runDtors); registered = true; }
  return 0;
}
