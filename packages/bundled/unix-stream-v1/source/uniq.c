// MIT. Streaming adjacent-line uniq for WASI stdin/stdout.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

static int emit(const char *line, size_t length, int newline, uint64_t count,
                int show_count, int duplicates_only, int unique_only) {
  if ((duplicates_only && count == 1) || (unique_only && count != 1)) return 0;
  if (show_count && printf("%7" PRIu64 " ", count) < 0) return -1;
  if (fwrite(line, 1, length, stdout) != length) return -1;
  if (newline && fputc('\n', stdout) == EOF) return -1;
  return 0;
}

int main(int argc, char **argv) {
  int show_count = 0, duplicates_only = 0, unique_only = 0;
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] != '-' || !argv[i][1]) {
      fprintf(stderr, "uniq: file operands are unavailable; use stdin\n");
      return 1;
    }
    for (const char *p = argv[i] + 1; *p; p++) {
      if (*p == 'c') show_count = 1;
      else if (*p == 'd') duplicates_only = 1;
      else if (*p == 'u') unique_only = 1;
      else { fprintf(stderr, "uniq: unknown option -%c\n", *p); return 1; }
    }
  }
  if (duplicates_only && unique_only) {
    fprintf(stderr, "uniq: -d and -u are mutually exclusive\n");
    return 1;
  }

  char *line = NULL, *previous = NULL;
  size_t capacity = 0, previous_length = 0;
  int previous_newline = 0;
  uint64_t count = 0;
  ssize_t got;
  while ((got = getline(&line, &capacity, stdin)) >= 0) {
    size_t length = (size_t)got;
    int newline = length > 0 && line[length - 1] == '\n';
    if (newline) length--;
    if (memchr(line, '\0', length) != NULL) {
      fprintf(stderr, "uniq: NUL input is not text\n");
      free(line); free(previous); return 1;
    }
    if (previous && previous_length == length && memcmp(previous, line, length) == 0) {
      count++;
      continue;
    }
    if (previous && emit(previous, previous_length, previous_newline, count,
                         show_count, duplicates_only, unique_only) != 0) {
      free(line); free(previous); return 1;
    }
    char *next = realloc(previous, length ? length : 1);
    if (!next) { fprintf(stderr, "uniq: out of memory\n"); free(line); free(previous); return 1; }
    previous = next;
    if (length) memcpy(previous, line, length);
    previous_length = length;
    previous_newline = newline;
    count = 1;
  }
  int status = 0;
  if (previous && emit(previous, previous_length, previous_newline, count,
                       show_count, duplicates_only, unique_only) != 0) status = 1;
  if (ferror(stdin)) { fprintf(stderr, "uniq: read error\n"); status = 1; }
  free(line);
  free(previous);
  return status;
}
