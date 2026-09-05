// MIT. Streaming POSIX-text wc for WASI stdin/stdout.
#include <ctype.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  int lines_flag = 0, words_flag = 0, bytes_flag = 0, explicit_flags = 0;
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] != '-' || argv[i][1] == '\0') {
      fprintf(stderr, "wc: file operands are unavailable; use stdin\n");
      return 1;
    }
    for (const char *p = argv[i] + 1; *p; p++) {
      explicit_flags = 1;
      if (*p == 'l') lines_flag = 1;
      else if (*p == 'w') words_flag = 1;
      else if (*p == 'c') bytes_flag = 1;
      else {
        fprintf(stderr, "wc: unknown option -%c\n", *p);
        return 1;
      }
    }
  }
  if (!explicit_flags) lines_flag = words_flag = bytes_flag = 1;

  uint64_t lines = 0, words = 0, bytes = 0;
  int in_word = 0;
  unsigned char buffer[32768];
  for (;;) {
    size_t n = fread(buffer, 1, sizeof buffer, stdin);
    bytes += (uint64_t)n;
    for (size_t i = 0; i < n; i++) {
      unsigned char c = buffer[i];
      if (c == '\n') lines++;
      if (isspace(c)) in_word = 0;
      else if (!in_word) { in_word = 1; words++; }
    }
    if (n < sizeof buffer) break;
  }
  if (ferror(stdin)) { fprintf(stderr, "wc: read error\n"); return 1; }

  int wrote = 0;
  if (lines_flag) { printf("%" PRIu64, lines); wrote = 1; }
  if (words_flag) { printf("%s%" PRIu64, wrote ? " " : "", words); wrote = 1; }
  if (bytes_flag) printf("%s%" PRIu64, wrote ? " " : "", bytes);
  putchar('\n');
  return ferror(stdout) ? 1 : 0;
}
