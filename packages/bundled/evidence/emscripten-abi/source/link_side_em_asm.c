#include <emscripten.h>

int side_em_asm(int value) {
  return value + EM_ASM_INT({ return 7; });
}
