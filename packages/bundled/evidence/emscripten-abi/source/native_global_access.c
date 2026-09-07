#include <emscripten.h>

// Deliberately adversarial evidence: DYNAMIC_EXECUTION=0 still permits an
// EM_JS import to inspect ambient worker globals. This artifact is never loaded
// by the extension and must remain rejected by the ABI safety check.
EM_JS(int, cap_ambient_global_probe, (), {
  return typeof globalThis.fetch == 'function' &&
         typeof globalThis.WebAssembly == 'object' ? 0x434150 : 0;
});

EMSCRIPTEN_KEEPALIVE
int cap_probe_ambient_global(void) {
  return cap_ambient_global_probe();
}
