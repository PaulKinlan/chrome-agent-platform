#include <emscripten/emscripten.h>

#ifndef SIDE_SYMBOL
#define SIDE_SYMBOL side_increment
#endif

extern int SIDE_SYMBOL(int value);

EMSCRIPTEN_KEEPALIVE
int cap_linked_compute(int value) {
  return SIDE_SYMBOL(value);
}
