// cap-zxing — CAP-authored WASI barcode tool (chrome-agent-platform-2htn).
// A stdin→stdout wrapper over zxing-cpp (Apache-2.0) with stb_image /
// stb_image_write (public domain) for the PNG/JPEG boundary.
//
//   zxing read                      image bytes on stdin → one JSON object per
//                                   found barcode on stdout ({"format","text"})
//   zxing write <format> <text>     encode text → PNG bytes on stdout
//
// Fail-closed: undecodable input or an unknown format exits non-zero with a
// stderr line, never silent empty output.
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "ReadBarcode.h"
#include "BarcodeFormat.h"
#include "MultiFormatWriter.h"
#include "BitMatrix.h"

#define STB_IMAGE_IMPLEMENTATION
#define STBI_FAILURE_USERMSG
#include "stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

static std::string jsonEscape(const std::string& s) {
  std::string out;
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) { char buf[8]; snprintf(buf, sizeof(buf), "\\u%04x", c); out += buf; }
        else out += (char)c;
    }
  }
  return out;
}

static std::vector<unsigned char> readAllStdin() {
  std::vector<unsigned char> data;
  unsigned char buf[16384]; // small stack chunk — wasi-libc default stack is 64 KiB
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), stdin)) > 0) data.insert(data.end(), buf, buf + n);
  return data;
}

static int cmdRead() {
  const auto bytes = readAllStdin();
  if (bytes.empty()) { fprintf(stderr, "cap-zxing: empty stdin\n"); return 2; }
  int w = 0, h = 0, channels = 0;
  // One channel (luminance) — the reader's native input.
  unsigned char* img = stbi_load_from_memory(bytes.data(), (int)bytes.size(), &w, &h, &channels, 1);
  if (!img) { fprintf(stderr, "cap-zxing: undecodable image (%s)\n", stbi_failure_reason()); return 2; }
  ZXing::ImageView view(img, w, h, ZXing::ImageFormat::Lum);
  ZXing::ReaderOptions opts;
  opts.setTryHarder(true).setTryRotate(true);
  const auto results = ZXing::ReadBarcodes(view, opts);
  for (const auto& r : results) {
    if (!r.isValid()) continue;
    printf("{\"format\":\"%s\",\"text\":\"%s\"}\n",
           ZXing::ToString(r.format()).c_str(), jsonEscape(r.text()).c_str());
  }
  stbi_image_free(img);
  return 0;
}

static void stdioWrite(void* ctx, void* data, int len) {
  (void)ctx;
  fwrite(data, 1, (size_t)len, stdout);
}

static int cmdWrite(const char* formatName, const char* text) {
  ZXing::BarcodeFormat format;
  try {
    format = ZXing::BarcodeFormatFromString(formatName);
  } catch (...) {
    fprintf(stderr, "cap-zxing: unknown format '%s'\n", formatName);
    return 2;
  }
  if (format == ZXing::BarcodeFormat::None) {
    fprintf(stderr, "cap-zxing: unknown format '%s'\n", formatName);
    return 2;
  }
  if (!text || !*text) { fprintf(stderr, "cap-zxing: empty text\n"); return 2; }
  try {
    ZXing::MultiFormatWriter writer(format);
    writer.setMargin(2);
    // Bounded raster: generous enough for a QR of any realistic payload.
    const auto matrix = writer.encode(std::string(text), 512, 512);
    const int w = matrix.width(), h = matrix.height();
    std::vector<unsigned char> gray((size_t)w * (size_t)h);
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++)
        gray[(size_t)y * w + x] = matrix.get(x, y) ? 0 : 255;
    if (!stbi_write_png_to_func(stdioWrite, nullptr, w, h, 1, gray.data(), w)) {
      fprintf(stderr, "cap-zxing: PNG encode failed\n");
      return 2;
    }
  } catch (const std::exception& e) {
    fprintf(stderr, "cap-zxing: encode failed: %s\n", e.what());
    return 2;
  }
  return 0;
}

int main(int argc, char** argv) {
  if (argc >= 2 && strcmp(argv[1], "read") == 0) return cmdRead();
  if (argc >= 4 && strcmp(argv[1], "write") == 0) return cmdWrite(argv[2], argv[3]);
  fprintf(stderr, "usage: zxing read | zxing write <format> <text>\n");
  return 2;
}
