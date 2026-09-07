#include <emscripten/emscripten.h>

EMSCRIPTEN_KEEPALIVE
double cap_weighted_sum(double value, double weight, double bias) {
  return value * weight + bias;
}
