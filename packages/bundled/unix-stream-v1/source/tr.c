// MIT. Streaming byte-locale tr with ranges, escapes, complement, and common
// POSIX character classes.
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { unsigned char *bytes; size_t length, capacity; } set_t;

static int push(set_t *set, unsigned char byte) {
  if (set->length == set->capacity) {
    size_t capacity = set->capacity ? set->capacity * 2 : 64;
    unsigned char *bytes = realloc(set->bytes, capacity);
    if (!bytes) return -1;
    set->bytes = bytes; set->capacity = capacity;
  }
  set->bytes[set->length++] = byte;
  return 0;
}

static int push_class(set_t *set, const char *name, size_t length) {
  for (int c = 0; c <= 255; c++) {
    int include = 0;
    if (length == 5 && !memcmp(name, "alnum", 5)) include = isalnum(c);
    else if (length == 5 && !memcmp(name, "alpha", 5)) include = isalpha(c);
    else if (length == 5 && !memcmp(name, "blank", 5)) include = c == ' ' || c == '\t';
    else if (length == 5 && !memcmp(name, "cntrl", 5)) include = iscntrl(c);
    else if (length == 5 && !memcmp(name, "digit", 5)) include = isdigit(c);
    else if (length == 5 && !memcmp(name, "graph", 5)) include = isgraph(c);
    else if (length == 5 && !memcmp(name, "lower", 5)) include = islower(c);
    else if (length == 5 && !memcmp(name, "print", 5)) include = isprint(c);
    else if (length == 5 && !memcmp(name, "punct", 5)) include = ispunct(c);
    else if (length == 5 && !memcmp(name, "space", 5)) include = isspace(c);
    else if (length == 5 && !memcmp(name, "upper", 5)) include = isupper(c);
    else if (length == 6 && !memcmp(name, "xdigit", 6)) include = isxdigit(c);
    else return -1;
    if (include && push(set, (unsigned char)c) != 0) return -1;
  }
  return 0;
}

static int read_atom(const char *text, size_t length, size_t *position, unsigned char *out) {
  if (*position >= length) return -1;
  unsigned char c = (unsigned char)text[(*position)++];
  if (c != '\\') { *out = c; return 0; }
  if (*position >= length) return -1;
  c = (unsigned char)text[(*position)++];
  if (c == 'n') c = '\n'; else if (c == 'r') c = '\r'; else if (c == 't') c = '\t';
  else if (c == 'b') c = '\b'; else if (c == 'f') c = '\f'; else if (c == 'v') c = '\v';
  else if (c >= '0' && c <= '7') {
    int value = c - '0', digits = 1;
    while (digits < 3 && *position < length && text[*position] >= '0' && text[*position] <= '7') {
      value = value * 8 + text[(*position)++] - '0'; digits++;
    }
    c = (unsigned char)value;
  }
  *out = c;
  return 0;
}

static int expand(const char *text, set_t *set) {
  size_t length = strlen(text), position = 0;
  while (position < length) {
    if (position + 4 < length && text[position] == '[' && text[position + 1] == ':') {
      const char *end = strstr(text + position + 2, ":]");
      if (!end || push_class(set, text + position + 2, (size_t)(end - text - position - 2)) != 0) return -1;
      position = (size_t)(end - text) + 2;
      continue;
    }
    if (position + 2 < length && text[position] == '[' && (text[position + 1] == '=' || text[position + 1] == '.')) return -1;
    unsigned char first;
    if (read_atom(text, length, &position, &first) != 0) return -1;
    if (position < length && text[position] == '-' && position + 1 < length) {
      position++;
      unsigned char last;
      if (read_atom(text, length, &position, &last) != 0 || first > last) return -1;
      for (unsigned value = first; value <= last; value++) if (push(set, (unsigned char)value) != 0) return -1;
    } else if (push(set, first) != 0) return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  int delete_mode = 0, squeeze = 0, complement = 0, index = 1;
  while (index < argc && argv[index][0] == '-' && argv[index][1]) {
    for (const char *p = argv[index] + 1; *p; p++) {
      if (*p == 'd') delete_mode = 1;
      else if (*p == 's') squeeze = 1;
      else if (*p == 'c' || *p == 'C') complement = 1;
      else { fprintf(stderr, "tr: unknown option -%c\n", *p); return 1; }
    }
    index++;
  }
  int operands = argc - index;
  if ((!delete_mode && operands != 2) || (delete_mode && (operands < 1 || operands > 2))) {
    fprintf(stderr, "usage: tr [-cds] SET1 [SET2]\n");
    return 1;
  }
  set_t first = {0}, second = {0};
  if (expand(argv[index], &first) != 0 || (operands == 2 && expand(argv[index + 1], &second) != 0)) {
    fprintf(stderr, "tr: invalid or unsupported set expression\n");
    free(first.bytes); free(second.bytes); return 1;
  }
  if (!delete_mode && second.length == 0) {
    fprintf(stderr, "tr: SET2 must not be empty\n");
    free(first.bytes); free(second.bytes); return 1;
  }

  unsigned char selected[256] = {0}, squeeze_set[256] = {0}, translate[256];
  for (int i = 0; i < 256; i++) translate[i] = (unsigned char)i;
  for (size_t i = 0; i < first.length; i++) selected[first.bytes[i]] = 1;
  if (complement) for (int i = 0; i < 256; i++) selected[i] = !selected[i];
  if (!delete_mode) {
    if (complement) {
      size_t target = 0;
      for (int c = 0; c < 256; c++) if (selected[c]) {
        translate[c] = second.bytes[target < second.length ? target : second.length - 1];
        target++;
      }
    } else {
      for (size_t i = 0; i < first.length; i++) {
        translate[first.bytes[i]] = second.bytes[i < second.length ? i : second.length - 1];
      }
    }
  }
  const set_t *squeezed = operands == 2 ? &second : &first;
  for (size_t i = 0; i < squeezed->length; i++) squeeze_set[squeezed->bytes[i]] = 1;

  unsigned char input[32768], output[32768];
  int have_previous = 0;
  unsigned char previous = 0;
  for (;;) {
    size_t count = fread(input, 1, sizeof input, stdin), used = 0;
    for (size_t i = 0; i < count; i++) {
      unsigned char c = input[i];
      if (delete_mode && selected[c]) continue;
      c = translate[c];
      if (squeeze && have_previous && c == previous && squeeze_set[c]) continue;
      output[used++] = c; previous = c; have_previous = 1;
    }
    if (used && fwrite(output, 1, used, stdout) != used) return 1;
    if (count < sizeof input) break;
  }
  free(first.bytes); free(second.bytes);
  if (ferror(stdin)) { fprintf(stderr, "tr: read error\n"); return 1; }
  return 0;
}
