// MIT. Streaming grep subset with POSIX BRE/ERE and fixed-string modes.
#include <ctype.h>
#include <inttypes.h>
#include <regex.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

static int contains_fixed(const unsigned char *line, size_t length, const unsigned char *pattern, size_t pattern_length, int ignore_case) {
  if (pattern_length == 0) return 1;
  if (pattern_length > length) return 0;
  for (size_t i = 0; i + pattern_length <= length; i++) {
    size_t j = 0;
    for (; j < pattern_length; j++) {
      unsigned char a = line[i + j], b = pattern[j];
      if (ignore_case) { a = (unsigned char)tolower(a); b = (unsigned char)tolower(b); }
      if (a != b) break;
    }
    if (j == pattern_length) return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  int ignore_case = 0, invert = 0, number = 0, count = 0, fixed = 0, extended = 0;
  const char *pattern = NULL;
  int options = 1;
  for (int i = 1; i < argc; i++) {
    const char *arg = argv[i];
    if (options && !strcmp(arg, "--")) { options = 0; continue; }
    if (options && arg[0] == '-' && arg[1]) {
      for (const char *p = arg + 1; *p; p++) {
        if (*p == 'i') ignore_case = 1;
        else if (*p == 'v') invert = 1;
        else if (*p == 'n') number = 1;
        else if (*p == 'c') count = 1;
        else if (*p == 'F') fixed = 1;
        else if (*p == 'E') extended = 1;
        else { fprintf(stderr, "grep: unknown option -%c\n", *p); return 2; }
      }
    } else if (!pattern) pattern = arg;
    else { fprintf(stderr, "grep: file operands are unavailable; use stdin\n"); return 2; }
  }
  if (!pattern || (fixed && extended)) {
    fprintf(stderr, "usage: grep [-ivncFE] PATTERN\n");
    return 2;
  }

  regex_t regex;
  if (!fixed) {
    int flags = REG_NOSUB | (extended ? REG_EXTENDED : 0) | (ignore_case ? REG_ICASE : 0);
    int code = regcomp(&regex, pattern, flags);
    if (code != 0) {
      char message[256];
      regerror(code, &regex, message, sizeof message);
      fprintf(stderr, "grep: %s\n", message);
      return 2;
    }
  }

  char *line = NULL;
  size_t capacity = 0;
  uint64_t line_number = 0, matches = 0;
  ssize_t length;
  while ((length = getline(&line, &capacity, stdin)) >= 0) {
    line_number++;
    size_t text_length = (size_t)length;
    int had_newline = text_length > 0 && line[text_length - 1] == '\n';
    if (had_newline) text_length--;
    if (memchr(line, '\0', text_length) != NULL) {
      fprintf(stderr, "grep: NUL input is not text\n");
      free(line);
      if (!fixed) regfree(&regex);
      return 2;
    }
    char saved = line[text_length];
    line[text_length] = '\0';
    int matched = fixed
      ? contains_fixed((const unsigned char *)line, text_length, (const unsigned char *)pattern, strlen(pattern), ignore_case)
      : regexec(&regex, line, 0, NULL, 0) == 0;
    line[text_length] = saved;
    if (invert) matched = !matched;
    if (!matched) continue;
    matches++;
    if (!count) {
      if (number) printf("%" PRIu64 ":", line_number);
      if (fwrite(line, 1, (size_t)length, stdout) != (size_t)length) {
        free(line); if (!fixed) regfree(&regex); return 2;
      }
    }
  }
  free(line);
  if (!fixed) regfree(&regex);
  if (ferror(stdin)) { fprintf(stderr, "grep: read error\n"); return 2; }
  if (count) printf("%" PRIu64 "\n", matches);
  return matches > 0 ? 0 : 1;
}
