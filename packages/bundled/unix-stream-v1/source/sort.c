// MIT. In-memory sort kernel. The OPFS host feeds finite line-complete chunks
// and performs pairwise external merges, so total input size is not a Wasm
// linear-memory limit.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

typedef struct { char *text; size_t length; } line_t;
static int reverse_order = 0;
static int numeric_order = 0;
static int unique_lines = 0;

static int byte_compare(const line_t *a, const line_t *b) {
  size_t common = a->length < b->length ? a->length : b->length;
  int result = memcmp(a->text, b->text, common);
  if (result == 0) result = a->length < b->length ? -1 : a->length > b->length ? 1 : 0;
  return result;
}

typedef struct {
  int negative;
  const char *integer;
  size_t integer_length;
  const char *fraction;
  size_t fraction_length;
} numeric_key_t;

static numeric_key_t numeric_key(const line_t *line) {
  const char *p = line->text, *end = line->text + line->length;
  while (p < end && (*p == ' ' || *p == '\t' || *p == '\v' || *p == '\f' || *p == '\r')) p++;
  int negative = 0;
  if (p < end && (*p == '+' || *p == '-')) { negative = *p == '-'; p++; }
  while (p < end && *p == '0') p++;
  const char *integer = p;
  while (p < end && *p >= '0' && *p <= '9') p++;
  size_t integer_length = (size_t)(p - integer);
  const char *fraction = p;
  size_t fraction_length = 0;
  if (p < end && *p == '.') {
    fraction = ++p;
    while (p < end && *p >= '0' && *p <= '9') {
      if (*p != '0') fraction_length = (size_t)(p - fraction) + 1;
      p++;
    }
  }
  if (integer_length == 0 && fraction_length == 0) negative = 0;
  numeric_key_t key = { negative, integer, integer_length, fraction, fraction_length };
  return key;
}

static int compare_padded(const char *a, size_t a_length, const char *b, size_t b_length) {
  size_t length = a_length > b_length ? a_length : b_length;
  for (size_t i = 0; i < length; i++) {
    unsigned char av = i < a_length ? (unsigned char)a[i] : (unsigned char)'0';
    unsigned char bv = i < b_length ? (unsigned char)b[i] : (unsigned char)'0';
    if (av != bv) return av < bv ? -1 : 1;
  }
  return 0;
}

static int numeric_compare(const line_t *a, const line_t *b) {
  numeric_key_t ak = numeric_key(a), bk = numeric_key(b);
  if (ak.negative != bk.negative) return ak.negative ? -1 : 1;
  int absolute;
  if (ak.integer_length != bk.integer_length) absolute = ak.integer_length < bk.integer_length ? -1 : 1;
  else {
    absolute = memcmp(ak.integer, bk.integer, ak.integer_length);
    if (absolute < 0) absolute = -1;
    else if (absolute > 0) absolute = 1;
    else absolute = compare_padded(ak.fraction, ak.fraction_length, bk.fraction, bk.fraction_length);
  }
  return ak.negative ? -absolute : absolute;
}

static int compare_lines(const void *left, const void *right) {
  const line_t *a = left, *b = right;
  int result = numeric_order ? numeric_compare(a, b) : byte_compare(a, b);
  if (result == 0 && numeric_order) result = byte_compare(a, b);
  return reverse_order ? -result : result;
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "-r")) reverse_order = 1;
    else if (!strcmp(argv[i], "-n")) numeric_order = 1;
    else if (!strcmp(argv[i], "-u")) unique_lines = 1;
    else if (argv[i][0] == '-' && argv[i][1]) {
      for (const char *p = argv[i] + 1; *p; p++) {
        if (*p == 'r') reverse_order = 1;
        else if (*p == 'n') numeric_order = 1;
        else if (*p == 'u') unique_lines = 1;
        else { fprintf(stderr, "sort: unsupported argument %s\n", argv[i]); return 2; }
      }
    } else { fprintf(stderr, "sort: file operands are unavailable; use stdin\n"); return 2; }
  }

  line_t *lines = NULL;
  size_t used = 0, capacity = 0;
  char *line = NULL;
  size_t line_capacity = 0;
  ssize_t got;
  while ((got = getline(&line, &line_capacity, stdin)) >= 0) {
    size_t length = (size_t)got;
    if (length > 0 && line[length - 1] == '\n') length--;
    if (memchr(line, '\0', length) != NULL) {
      fprintf(stderr, "sort: NUL input is not text\n");
      free(line);
      for (size_t i = 0; i < used; i++) free(lines[i].text);
      free(lines);
      return 2;
    }
    if (used == capacity) {
      size_t next_capacity = capacity ? capacity * 2 : 1024;
      line_t *next = realloc(lines, next_capacity * sizeof *next);
      if (!next) { fprintf(stderr, "sort: out of memory\n"); return 2; }
      lines = next;
      capacity = next_capacity;
    }
    lines[used].text = malloc(length + 1);
    if (!lines[used].text) { fprintf(stderr, "sort: out of memory\n"); return 2; }
    memcpy(lines[used].text, line, length);
    lines[used].text[length] = '\0';
    lines[used].length = length;
    used++;
  }
  free(line);
  if (ferror(stdin)) { fprintf(stderr, "sort: read error\n"); return 2; }
  qsort(lines, used, sizeof *lines, compare_lines);
  for (size_t i = 0; i < used; i++) {
    if (unique_lines && i > 0 && byte_compare(&lines[i - 1], &lines[i]) == 0) {
      free(lines[i - 1].text);
      continue;
    }
    if (fwrite(lines[i].text, 1, lines[i].length, stdout) != lines[i].length || fputc('\n', stdout) == EOF) return 2;
    if (i > 0) free(lines[i - 1].text);
  }
  if (used) free(lines[used - 1].text);
  free(lines);
  return 0;
}
