#include <emscripten.h>

EM_JS(int, side_js_increment, (int value), {
  return value + 7;
});

int side_em_js(int value) {
  return side_js_increment(value);
}
