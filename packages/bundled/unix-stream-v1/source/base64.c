// MIT. Streaming base64 encode/decode for WASI stdin/stdout.
#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int value_of(unsigned char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

static int encode_stream(void) {
  unsigned char in[3];
  for (;;) {
    size_t n = fread(in, 1, sizeof in, stdin);
    if (n == 0) break;
    unsigned char out[4] = {
      (unsigned char)alphabet[in[0] >> 2],
      (unsigned char)alphabet[((in[0] & 3u) << 4) | (n > 1 ? in[1] >> 4 : 0)],
      (unsigned char)(n > 1 ? alphabet[((in[1] & 15u) << 2) | (n > 2 ? in[2] >> 6 : 0)] : '='),
      (unsigned char)(n > 2 ? alphabet[in[2] & 63u] : '='),
    };
    if (fwrite(out, 1, sizeof out, stdout) != sizeof out) return 1;
    if (n < sizeof in) break;
  }
  if (ferror(stdin) || fputc('\n', stdout) == EOF) return 1;
  return 0;
}

static int decode_stream(void) {
  int quartet[4];
  int used = 0;
  int finished = 0;
  for (;;) {
    int ch = fgetc(stdin);
    if (ch == EOF) break;
    if (isspace((unsigned char)ch)) continue;
    if (finished) {
      fprintf(stderr, "base64: data after padding\n");
      return 1;
    }
    if (ch == '=') quartet[used++] = -2;
    else {
      int value = value_of((unsigned char)ch);
      if (value < 0) {
        fprintf(stderr, "base64: invalid input\n");
        return 1;
      }
      quartet[used++] = value;
    }
    if (used == 4) {
      if (quartet[0] < 0 || quartet[1] < 0 || quartet[2] == -2 && quartet[3] != -2) {
        fprintf(stderr, "base64: invalid padding\n");
        return 1;
      }
      unsigned char out[3];
      out[0] = (unsigned char)((quartet[0] << 2) | (quartet[1] >> 4));
      size_t n = 1;
      if (quartet[2] >= 0) {
        out[n++] = (unsigned char)(((quartet[1] & 15) << 4) | (quartet[2] >> 2));
        if (quartet[3] >= 0) out[n++] = (unsigned char)(((quartet[2] & 3) << 6) | quartet[3]);
        else if (quartet[3] != -2) {
          fprintf(stderr, "base64: invalid padding\n");
          return 1;
        }
      }
      if (fwrite(out, 1, n, stdout) != n) return 1;
      finished = quartet[2] == -2 || quartet[3] == -2;
      used = 0;
    }
  }
  if (ferror(stdin) || used != 0) {
    fprintf(stderr, "base64: invalid input length\n");
    return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  int decode = 0;
  if (argc == 2 && (!strcmp(argv[1], "-d") || !strcmp(argv[1], "--decode"))) decode = 1;
  else if (argc != 1) {
    fprintf(stderr, "usage: base64 [-d|--decode]\n");
    return 1;
  }
  return decode ? decode_stream() : encode_stream();
}
