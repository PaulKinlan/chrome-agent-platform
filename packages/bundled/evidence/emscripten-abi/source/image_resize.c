#include <limits.h>
#include <stdint.h>
#include <emscripten/emscripten.h>

#define STB_IMAGE_RESIZE_IMPLEMENTATION
#define STBIR_NO_SIMD
#include "third_party/stb_image_resize2.h"

EMSCRIPTEN_KEEPALIVE
int cap_resize_rgba(const uint8_t *input, int input_width, int input_height,
                    uint8_t *output, int output_width, int output_height) {
  if (!input || !output || input_width <= 0 || input_height <= 0 ||
      output_width <= 0 || output_height <= 0 ||
      input_width > INT_MAX / 4 || output_width > INT_MAX / 4) {
    return 0;
  }
  return stbir_resize_uint8_linear(input, input_width, input_height,
                                   input_width * 4, output, output_width,
                                   output_height, output_width * 4,
                                   STBIR_RGBA) != NULL;
}
