#include "sqlite3.h"

#include <ctype.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define INPUT_LIMIT (1024U * 1024U)
#define OUTPUT_LIMIT (2U * 1024U * 1024U)
#define PARAM_LIMIT 256
#define SQLITE_HEAP_LIMIT (16LL * 1024LL * 1024LL)

#ifdef SQLITE_OMIT_ATTACH
#error "SQLITE_OMIT_ATTACH must be absent for the retained SQLite 3.46.0 amalgamation"
#endif
#ifndef SQLITE_OMIT_LOAD_EXTENSION
#error "SQLITE_OMIT_LOAD_EXTENSION is required after the clean-link gate"
#endif

struct text {
  char *data;
  size_t length;
};

enum value_kind { VALUE_NULL, VALUE_INTEGER, VALUE_FLOAT, VALUE_TEXT, VALUE_BOOL };

struct value {
  enum value_kind kind;
  sqlite3_int64 integer;
  double real;
  struct text text;
  int boolean;
};

struct named_value {
  struct text name;
  struct value value;
};

struct request {
  struct text sql;
  struct text database;
  int has_database;
  int read_only;
  int params_kind; /* 0 absent, 1 positional, 2 named */
  size_t positional_count;
  struct value positional[PARAM_LIMIT];
  size_t named_count;
  struct named_value named[PARAM_LIMIT];
};

struct json_reader {
  char *cursor;
  char *end;
  const char *error;
};

struct output {
  char *data;
  size_t length;
  size_t capacity;
  int failed;
};

struct authorizer_state {
  int denied_action;
};

static void json_skip_space(struct json_reader *reader) {
  while (reader->cursor < reader->end &&
         (*reader->cursor == ' ' || *reader->cursor == '\t' ||
          *reader->cursor == '\r' || *reader->cursor == '\n')) {
    reader->cursor++;
  }
}

static int hex_value(unsigned char value) {
  if (value >= '0' && value <= '9') return (int)(value - '0');
  if (value >= 'a' && value <= 'f') return (int)(value - 'a') + 10;
  if (value >= 'A' && value <= 'F') return (int)(value - 'A') + 10;
  return -1;
}

static int parse_hex4(struct json_reader *reader, uint32_t *result) {
  uint32_t value = 0;
  int digit;
  int index;
  if ((size_t)(reader->end - reader->cursor) < 4U) return 0;
  for (index = 0; index < 4; index++) {
    digit = hex_value((unsigned char)reader->cursor[index]);
    if (digit < 0) return 0;
    value = (value << 4) | (uint32_t)digit;
  }
  reader->cursor += 4;
  *result = value;
  return 1;
}

static int emit_utf8(char **write_cursor, char *write_end, uint32_t codepoint) {
  char *out = *write_cursor;
  if (codepoint <= 0x7fU) {
    if (out >= write_end) return 0;
    *out++ = (char)codepoint;
  } else if (codepoint <= 0x7ffU) {
    if ((size_t)(write_end - out) < 2U) return 0;
    *out++ = (char)(0xc0U | (codepoint >> 6));
    *out++ = (char)(0x80U | (codepoint & 0x3fU));
  } else if (codepoint <= 0xffffU) {
    if ((size_t)(write_end - out) < 3U) return 0;
    *out++ = (char)(0xe0U | (codepoint >> 12));
    *out++ = (char)(0x80U | ((codepoint >> 6) & 0x3fU));
    *out++ = (char)(0x80U | (codepoint & 0x3fU));
  } else if (codepoint <= 0x10ffffU) {
    if ((size_t)(write_end - out) < 4U) return 0;
    *out++ = (char)(0xf0U | (codepoint >> 18));
    *out++ = (char)(0x80U | ((codepoint >> 12) & 0x3fU));
    *out++ = (char)(0x80U | ((codepoint >> 6) & 0x3fU));
    *out++ = (char)(0x80U | (codepoint & 0x3fU));
  } else {
    return 0;
  }
  *write_cursor = out;
  return 1;
}

static int json_string(struct json_reader *reader, struct text *result) {
  char *start;
  char *read_cursor;
  char *write_cursor;
  if (reader->cursor >= reader->end || *reader->cursor != '"') {
    reader->error = "expected JSON string";
    return 0;
  }
  reader->cursor++;
  start = reader->cursor;
  read_cursor = reader->cursor;
  write_cursor = start;
  while (read_cursor < reader->end) {
    unsigned char value = (unsigned char)*read_cursor++;
    if (value == '"') {
      *write_cursor = '\0';
      result->data = start;
      result->length = (size_t)(write_cursor - start);
      reader->cursor = read_cursor;
      return 1;
    }
    if (value < 0x20U) {
      reader->error = "unescaped control byte in JSON string";
      return 0;
    }
    if (value != '\\') {
      *write_cursor++ = (char)value;
      continue;
    }
    if (read_cursor >= reader->end) {
      reader->error = "truncated JSON escape";
      return 0;
    }
    value = (unsigned char)*read_cursor++;
    switch (value) {
      case '"': *write_cursor++ = '"'; break;
      case '\\': *write_cursor++ = '\\'; break;
      case '/': *write_cursor++ = '/'; break;
      case 'b': *write_cursor++ = '\b'; break;
      case 'f': *write_cursor++ = '\f'; break;
      case 'n': *write_cursor++ = '\n'; break;
      case 'r': *write_cursor++ = '\r'; break;
      case 't': *write_cursor++ = '\t'; break;
      case 'u': {
        uint32_t codepoint;
        uint32_t low;
        reader->cursor = read_cursor;
        if (!parse_hex4(reader, &codepoint)) {
          reader->error = "invalid JSON unicode escape";
          return 0;
        }
        read_cursor = reader->cursor;
        if (codepoint >= 0xd800U && codepoint <= 0xdbffU) {
          if ((size_t)(reader->end - read_cursor) < 6U || read_cursor[0] != '\\' ||
              read_cursor[1] != 'u') {
            reader->error = "missing low surrogate";
            return 0;
          }
          reader->cursor = read_cursor + 2;
          if (!parse_hex4(reader, &low) || low < 0xdc00U || low > 0xdfffU) {
            reader->error = "invalid low surrogate";
            return 0;
          }
          codepoint = 0x10000U + ((codepoint - 0xd800U) << 10) + (low - 0xdc00U);
          read_cursor = reader->cursor;
        } else if (codepoint >= 0xdc00U && codepoint <= 0xdfffU) {
          reader->error = "unexpected low surrogate";
          return 0;
        }
        if (!emit_utf8(&write_cursor, reader->end, codepoint)) {
          reader->error = "invalid unicode codepoint";
          return 0;
        }
        break;
      }
      default:
        reader->error = "invalid JSON escape";
        return 0;
    }
  }
  reader->error = "unterminated JSON string";
  return 0;
}

static int text_equals(struct text value, const char *literal) {
  size_t length = strlen(literal);
  return value.length == length && memcmp(value.data, literal, length) == 0;
}

static int json_literal(struct json_reader *reader, const char *literal) {
  size_t length = strlen(literal);
  if ((size_t)(reader->end - reader->cursor) < length ||
      memcmp(reader->cursor, literal, length) != 0) return 0;
  reader->cursor += length;
  return 1;
}

static int json_value(struct json_reader *reader, struct value *value) {
  char *number_end;
  char *start;
  int is_float = 0;
  json_skip_space(reader);
  if (reader->cursor >= reader->end) {
    reader->error = "missing JSON parameter value";
    return 0;
  }
  if (*reader->cursor == '"') {
    value->kind = VALUE_TEXT;
    return json_string(reader, &value->text);
  }
  if (json_literal(reader, "null")) {
    value->kind = VALUE_NULL;
    return 1;
  }
  if (json_literal(reader, "true")) {
    value->kind = VALUE_BOOL;
    value->boolean = 1;
    return 1;
  }
  if (json_literal(reader, "false")) {
    value->kind = VALUE_BOOL;
    value->boolean = 0;
    return 1;
  }
  start = reader->cursor;
  if (*reader->cursor == '-') reader->cursor++;
  if (reader->cursor >= reader->end || !isdigit((unsigned char)*reader->cursor)) {
    reader->error = "parameter must be a JSON scalar";
    return 0;
  }
  if (*reader->cursor == '0') {
    reader->cursor++;
  } else {
    while (reader->cursor < reader->end && isdigit((unsigned char)*reader->cursor)) reader->cursor++;
  }
  if (reader->cursor < reader->end && *reader->cursor == '.') {
    is_float = 1;
    reader->cursor++;
    if (reader->cursor >= reader->end || !isdigit((unsigned char)*reader->cursor)) {
      reader->error = "invalid JSON number";
      return 0;
    }
    while (reader->cursor < reader->end && isdigit((unsigned char)*reader->cursor)) reader->cursor++;
  }
  if (reader->cursor < reader->end && (*reader->cursor == 'e' || *reader->cursor == 'E')) {
    is_float = 1;
    reader->cursor++;
    if (reader->cursor < reader->end && (*reader->cursor == '+' || *reader->cursor == '-')) reader->cursor++;
    if (reader->cursor >= reader->end || !isdigit((unsigned char)*reader->cursor)) {
      reader->error = "invalid JSON exponent";
      return 0;
    }
    while (reader->cursor < reader->end && isdigit((unsigned char)*reader->cursor)) reader->cursor++;
  }
  number_end = reader->cursor;
  if (is_float) {
    char saved = *number_end;
    *number_end = '\0';
    errno = 0;
    value->real = strtod(start, NULL);
    *number_end = saved;
    if (errno == ERANGE) {
      reader->error = "JSON number is out of range";
      return 0;
    }
    value->kind = VALUE_FLOAT;
  } else {
    char saved = *number_end;
    char *conversion_end = NULL;
    *number_end = '\0';
    errno = 0;
    value->integer = (sqlite3_int64)strtoll(start, &conversion_end, 10);
    *number_end = saved;
    if (errno == ERANGE || conversion_end != number_end) {
      reader->error = "JSON integer is out of range";
      return 0;
    }
    value->kind = VALUE_INTEGER;
  }
  return 1;
}

static int json_params(struct json_reader *reader, struct request *request) {
  json_skip_space(reader);
  if (reader->cursor >= reader->end) {
    reader->error = "missing params value";
    return 0;
  }
  if (*reader->cursor == '[') {
    reader->cursor++;
    request->params_kind = 1;
    json_skip_space(reader);
    if (reader->cursor < reader->end && *reader->cursor == ']') {
      reader->cursor++;
      return 1;
    }
    for (;;) {
      if (request->positional_count >= PARAM_LIMIT) {
        reader->error = "too many positional parameters";
        return 0;
      }
      if (!json_value(reader, &request->positional[request->positional_count++])) return 0;
      json_skip_space(reader);
      if (reader->cursor < reader->end && *reader->cursor == ']') {
        reader->cursor++;
        return 1;
      }
      if (reader->cursor >= reader->end || *reader->cursor != ',') {
        reader->error = "expected comma in params array";
        return 0;
      }
      reader->cursor++;
    }
  }
  if (*reader->cursor == '{') {
    reader->cursor++;
    request->params_kind = 2;
    json_skip_space(reader);
    if (reader->cursor < reader->end && *reader->cursor == '}') {
      reader->cursor++;
      return 1;
    }
    for (;;) {
      struct named_value *entry;
      if (request->named_count >= PARAM_LIMIT) {
        reader->error = "too many named parameters";
        return 0;
      }
      entry = &request->named[request->named_count++];
      if (!json_string(reader, &entry->name)) return 0;
      json_skip_space(reader);
      if (reader->cursor >= reader->end || *reader->cursor != ':') {
        reader->error = "expected colon in params object";
        return 0;
      }
      reader->cursor++;
      if (!json_value(reader, &entry->value)) return 0;
      json_skip_space(reader);
      if (reader->cursor < reader->end && *reader->cursor == '}') {
        reader->cursor++;
        return 1;
      }
      if (reader->cursor >= reader->end || *reader->cursor != ',') {
        reader->error = "expected comma in params object";
        return 0;
      }
      reader->cursor++;
      json_skip_space(reader);
    }
  }
  reader->error = "params must be an array or object";
  return 0;
}

static int parse_request(char *input, size_t input_length, struct request *request,
                         const char **error) {
  struct json_reader reader;
  struct text key;
  int seen_sql = 0;
  int seen_database = 0;
  int seen_read_only = 0;
  int seen_params = 0;
  char *raw = input;
  char *raw_end = input + input_length;
  memset(request, 0, sizeof(*request));
  while (raw < raw_end && isspace((unsigned char)*raw)) raw++;
  if (raw == raw_end) {
    *error = "empty input";
    return 0;
  }
  if (*raw != '{') {
    request->sql.data = raw;
    request->sql.length = (size_t)(raw_end - raw);
    return 1;
  }
  reader.cursor = raw;
  reader.end = raw_end;
  reader.error = "invalid JSON request";
  reader.cursor++;
  json_skip_space(&reader);
  if (reader.cursor < reader.end && *reader.cursor == '}') {
    *error = "JSON request is missing sql";
    return 0;
  }
  for (;;) {
    json_skip_space(&reader);
    if (!json_string(&reader, &key)) break;
    json_skip_space(&reader);
    if (reader.cursor >= reader.end || *reader.cursor != ':') {
      reader.error = "expected colon after request field";
      break;
    }
    reader.cursor++;
    json_skip_space(&reader);
    if (text_equals(key, "sql")) {
      if (seen_sql || !json_string(&reader, &request->sql)) {
        if (seen_sql) reader.error = "duplicate sql field";
        break;
      }
      seen_sql = 1;
    } else if (text_equals(key, "database")) {
      if (seen_database || !json_string(&reader, &request->database)) {
        if (seen_database) reader.error = "duplicate database field";
        break;
      }
      request->has_database = 1;
      seen_database = 1;
    } else if (text_equals(key, "readOnly")) {
      if (seen_read_only) {
        reader.error = "duplicate readOnly field";
        break;
      }
      if (json_literal(&reader, "true")) request->read_only = 1;
      else if (json_literal(&reader, "false")) request->read_only = 0;
      else {
        reader.error = "readOnly must be boolean";
        break;
      }
      seen_read_only = 1;
    } else if (text_equals(key, "params")) {
      if (seen_params || !json_params(&reader, request)) {
        if (seen_params) reader.error = "duplicate params field";
        break;
      }
      seen_params = 1;
    } else {
      reader.error = "unknown request field";
      break;
    }
    json_skip_space(&reader);
    if (reader.cursor < reader.end && *reader.cursor == '}') {
      reader.cursor++;
      json_skip_space(&reader);
      if (reader.cursor != reader.end) {
        reader.error = "trailing bytes after JSON request";
        break;
      }
      if (!seen_sql || request->sql.length == 0U) {
        *error = "JSON request is missing sql";
        return 0;
      }
      return 1;
    }
    if (reader.cursor >= reader.end || *reader.cursor != ',') {
      reader.error = "expected comma in request object";
      break;
    }
    reader.cursor++;
  }
  *error = reader.error;
  return 0;
}

static int safe_database_name(struct text name) {
  size_t index;
  if (name.length == 0U || name.length > 128U) return 0;
  if (name.length == 1U && name.data[0] == '.') return 0;
  if (name.length == 2U && name.data[0] == '.' && name.data[1] == '.') return 0;
  for (index = 0; index < name.length; index++) {
    unsigned char value = (unsigned char)name.data[index];
    if (!(isalnum(value) || value == '.' || value == '_' || value == '-')) return 0;
  }
  return 1;
}

static int authorizer_cb(void *context, int action, const char *arg1,
                         const char *arg2, const char *database,
                         const char *trigger) {
  struct authorizer_state *state = (struct authorizer_state *)context;
  (void)database;
  (void)trigger;
  if (action == SQLITE_ATTACH || action == SQLITE_DETACH) {
    if (state != NULL) state->denied_action = action;
    return SQLITE_DENY;
  }
  if (action == SQLITE_FUNCTION) {
    if ((arg1 != NULL && sqlite3_stricmp(arg1, "load_extension") == 0) ||
        (arg2 != NULL && sqlite3_stricmp(arg2, "load_extension") == 0)) {
      return SQLITE_DENY;
    }
  }
  return SQLITE_OK;
}

static void output_bytes(struct output *output, const char *data, size_t length) {
  if (output->failed) return;
  if (length > output->capacity - output->length) {
    output->failed = 1;
    return;
  }
  memcpy(output->data + output->length, data, length);
  output->length += length;
}

static void output_char(struct output *output, char value) {
  output_bytes(output, &value, 1U);
}

static void output_json_string(struct output *output, const unsigned char *data,
                               size_t length) {
  static const char hex[] = "0123456789abcdef";
  size_t index;
  output_char(output, '"');
  for (index = 0; index < length && !output->failed; index++) {
    unsigned char value = data[index];
    if (value == '"' || value == '\\') {
      output_char(output, '\\');
      output_char(output, (char)value);
    } else if (value == '\b') {
      output_bytes(output, "\\b", 2U);
    } else if (value == '\f') {
      output_bytes(output, "\\f", 2U);
    } else if (value == '\n') {
      output_bytes(output, "\\n", 2U);
    } else if (value == '\r') {
      output_bytes(output, "\\r", 2U);
    } else if (value == '\t') {
      output_bytes(output, "\\t", 2U);
    } else if (value < 0x20U) {
      char escaped[6] = {'\\', 'u', '0', '0', hex[value >> 4], hex[value & 15U]};
      output_bytes(output, escaped, sizeof(escaped));
    } else {
      output_char(output, (char)value);
    }
  }
  output_char(output, '"');
}

static void output_column(struct output *output, sqlite3_stmt *statement, int column) {
  int type = sqlite3_column_type(statement, column);
  char number[64];
  int length;
  if (type == SQLITE_NULL) {
    output_bytes(output, "null", 4U);
  } else if (type == SQLITE_INTEGER) {
    length = snprintf(number, sizeof(number), "%lld",
                      (long long)sqlite3_column_int64(statement, column));
    if (length < 0 || (size_t)length >= sizeof(number)) output->failed = 1;
    else output_bytes(output, number, (size_t)length);
  } else if (type == SQLITE_FLOAT) {
    length = snprintf(number, sizeof(number), "%.17g",
                      sqlite3_column_double(statement, column));
    if (length < 0 || (size_t)length >= sizeof(number)) output->failed = 1;
    else output_bytes(output, number, (size_t)length);
  } else if (type == SQLITE_TEXT) {
    const unsigned char *text = sqlite3_column_text(statement, column);
    int bytes = sqlite3_column_bytes(statement, column);
    if (text == NULL && bytes != 0) output->failed = 1;
    else output_json_string(output, text, (size_t)bytes);
  } else {
    const unsigned char *blob = (const unsigned char *)sqlite3_column_blob(statement, column);
    int bytes = sqlite3_column_bytes(statement, column);
    int index;
    static const char hex[] = "0123456789ABCDEF";
    output_bytes(output, "{\"$blob\":\"", 10U);
    for (index = 0; index < bytes && !output->failed; index++) {
      char pair[2];
      pair[0] = hex[blob[index] >> 4];
      pair[1] = hex[blob[index] & 15U];
      output_bytes(output, pair, 2U);
    }
    output_bytes(output, "\"}", 2U);
  }
}

static const struct value *named_parameter(const struct request *request,
                                            const char *name) {
  size_t index;
  size_t length;
  if (name == NULL) return NULL;
  length = strlen(name);
  for (index = 0; index < request->named_count; index++) {
    if (request->named[index].name.length == length &&
        memcmp(request->named[index].name.data, name, length) == 0) {
      return &request->named[index].value;
    }
  }
  return NULL;
}

static int bind_value(sqlite3_stmt *statement, int index, const struct value *value) {
  switch (value->kind) {
    case VALUE_NULL: return sqlite3_bind_null(statement, index);
    case VALUE_INTEGER: return sqlite3_bind_int64(statement, index, value->integer);
    case VALUE_FLOAT: return sqlite3_bind_double(statement, index, value->real);
    case VALUE_TEXT:
      if (value->text.length > (size_t)INT32_MAX) return SQLITE_TOOBIG;
      return sqlite3_bind_text(statement, index, value->text.data,
                               (int)value->text.length, SQLITE_TRANSIENT);
    case VALUE_BOOL: return sqlite3_bind_int(statement, index, value->boolean);
  }
  return SQLITE_MISUSE;
}

static int bind_parameters(sqlite3_stmt *statement, const struct request *request,
                           const char **custom_error) {
  int count = sqlite3_bind_parameter_count(statement);
  int index;
  if (count == 0) return SQLITE_OK;
  if (request->params_kind == 0) {
    *custom_error = "statement has parameters but params was not provided";
    return SQLITE_MISUSE;
  }
  if (request->params_kind == 1) {
    if ((size_t)count != request->positional_count) {
      *custom_error = "positional parameter count mismatch";
      return SQLITE_RANGE;
    }
    for (index = 1; index <= count; index++) {
      int status = bind_value(statement, index, &request->positional[(size_t)index - 1U]);
      if (status != SQLITE_OK) return status;
    }
  } else {
    for (index = 1; index <= count; index++) {
      const char *name = sqlite3_bind_parameter_name(statement, index);
      const struct value *value = named_parameter(request, name);
      int status;
      if (value == NULL) {
        *custom_error = "named parameter is missing";
        return SQLITE_RANGE;
      }
      status = bind_value(statement, index, value);
      if (status != SQLITE_OK) return status;
    }
  }
  return SQLITE_OK;
}

static int keyword_is_transaction(const char *start, size_t length) {
  static const char *const keywords[] = {
    "BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"
  };
  size_t index;
  for (index = 0; index < sizeof(keywords) / sizeof(keywords[0]); index++) {
    size_t keyword_length = strlen(keywords[index]);
    if (length == keyword_length && sqlite3_strnicmp(start, keywords[index], (int)length) == 0) {
      return 1;
    }
  }
  return 0;
}

static int has_transaction_control(const char *sql, size_t length) {
  size_t index = 0;
  int statement_start = 1;
  while (index < length) {
    unsigned char value = (unsigned char)sql[index];
    if (isspace(value) || value == ';') {
      if (value == ';') statement_start = 1;
      index++;
      continue;
    }
    if (value == '-' && index + 1U < length && sql[index + 1U] == '-') {
      index += 2U;
      while (index < length && sql[index] != '\n') index++;
      continue;
    }
    if (value == '/' && index + 1U < length && sql[index + 1U] == '*') {
      index += 2U;
      while (index + 1U < length && !(sql[index] == '*' && sql[index + 1U] == '/')) index++;
      if (index + 1U < length) index += 2U;
      continue;
    }
    if (statement_start && (isalpha(value) || value == '_')) {
      size_t start = index;
      while (index < length && (isalnum((unsigned char)sql[index]) || sql[index] == '_')) index++;
      if (keyword_is_transaction(sql + start, index - start)) return 1;
      statement_start = 0;
      continue;
    }
    statement_start = 0;
    if (value == '\'' || value == '"' || value == '`') {
      unsigned char quote = value;
      index++;
      while (index < length) {
        if ((unsigned char)sql[index] == quote) {
          if (index + 1U < length && (unsigned char)sql[index + 1U] == quote) index += 2U;
          else { index++; break; }
        } else index++;
      }
    } else if (value == '[') {
      index++;
      while (index < length && sql[index] != ']') index++;
      if (index < length) index++;
    } else {
      index++;
    }
  }
  return 0;
}

static void rollback(sqlite3 *database, int implicit_transaction) {
  char *ignored = NULL;
  if (implicit_transaction) {
    (void)sqlite3_exec(database, "ROLLBACK TO cap_batch; RELEASE cap_batch;", NULL, NULL, &ignored);
  } else if (!sqlite3_get_autocommit(database)) {
    (void)sqlite3_exec(database, "ROLLBACK;", NULL, NULL, &ignored);
  }
  sqlite3_free(ignored);
}

static void capture_sqlite_error(sqlite3 *database, char *buffer, size_t capacity,
                                 const char **custom_error) {
  const char *message;
  if (*custom_error != NULL || capacity == 0U) return;
  message = sqlite3_errmsg(database);
  if (snprintf(buffer, capacity, "%s", message) < 0) {
    *custom_error = "SQLite operation failed";
  } else {
    *custom_error = buffer;
  }
}

static int execute_request(sqlite3 *database, const struct request *request,
                           struct output *output, const char **custom_error,
                           char *error_buffer, size_t error_capacity,
                           struct authorizer_state *authorizer) {
  const char *cursor = request->sql.data;
  const char *end = request->sql.data + request->sql.length;
  int implicit_transaction = !has_transaction_control(request->sql.data, request->sql.length);
  int wrote_row = 0;
  int status;
  char *exec_error = NULL;
  output_char(output, '[');
  if (implicit_transaction) {
    status = sqlite3_exec(database, "SAVEPOINT cap_batch;", NULL, NULL, &exec_error);
    if (status != SQLITE_OK) {
      capture_sqlite_error(database, error_buffer, error_capacity, custom_error);
      sqlite3_free(exec_error);
      return status;
    }
  }
  while (cursor < end) {
    sqlite3_stmt *statement = NULL;
    const char *tail = NULL;
    authorizer->denied_action = 0;
    status = sqlite3_prepare_v2(database, cursor, (int)(end - cursor), &statement, &tail);
    if (status != SQLITE_OK) {
      if (authorizer->denied_action == SQLITE_ATTACH) {
        *custom_error = "not authorized to use ATTACH DATABASE";
      } else if (authorizer->denied_action == SQLITE_DETACH) {
        *custom_error = "not authorized to use DETACH DATABASE";
      } else {
        capture_sqlite_error(database, error_buffer, error_capacity, custom_error);
      }
      rollback(database, implicit_transaction);
      return status;
    }
    if (tail == NULL || tail <= cursor) {
      sqlite3_finalize(statement);
      rollback(database, implicit_transaction);
      *custom_error = "SQL parser made no progress";
      return SQLITE_ERROR;
    }
    cursor = tail;
    if (statement == NULL) continue;
    if (request->read_only && !sqlite3_stmt_readonly(statement)) {
      sqlite3_finalize(statement);
      rollback(database, implicit_transaction);
      *custom_error = "attempt to write in readonly database";
      return SQLITE_READONLY;
    }
    status = bind_parameters(statement, request, custom_error);
    if (status != SQLITE_OK) {
      capture_sqlite_error(database, error_buffer, error_capacity, custom_error);
      sqlite3_finalize(statement);
      rollback(database, implicit_transaction);
      return status;
    }
    for (;;) {
      status = sqlite3_step(statement);
      if (status == SQLITE_ROW) {
        int columns = sqlite3_column_count(statement);
        int column;
        if (wrote_row) output_char(output, ',');
        output_char(output, '{');
        for (column = 0; column < columns; column++) {
          const char *name = sqlite3_column_name(statement, column);
          if (column != 0) output_char(output, ',');
          output_json_string(output, (const unsigned char *)name, strlen(name));
          output_char(output, ':');
          output_column(output, statement, column);
        }
        output_char(output, '}');
        wrote_row = 1;
        if (output->failed) {
          sqlite3_finalize(statement);
          rollback(database, implicit_transaction);
          *custom_error = "output exceeds 2097152 bytes";
          return SQLITE_TOOBIG;
        }
      } else if (status == SQLITE_DONE) {
        break;
      } else {
        capture_sqlite_error(database, error_buffer, error_capacity, custom_error);
        sqlite3_finalize(statement);
        rollback(database, implicit_transaction);
        return status;
      }
    }
    status = sqlite3_finalize(statement);
    if (status != SQLITE_OK) {
      capture_sqlite_error(database, error_buffer, error_capacity, custom_error);
      rollback(database, implicit_transaction);
      return status;
    }
  }
  if (implicit_transaction) {
    status = sqlite3_exec(database, "RELEASE cap_batch;", NULL, NULL, &exec_error);
    if (status != SQLITE_OK) {
      capture_sqlite_error(database, error_buffer, error_capacity, custom_error);
      sqlite3_free(exec_error);
      rollback(database, implicit_transaction);
      return status;
    }
  } else if (!sqlite3_get_autocommit(database)) {
    rollback(database, 0);
    *custom_error = "transaction left open";
    return SQLITE_ERROR;
  }
  output_char(output, ']');
  return output->failed ? SQLITE_TOOBIG : SQLITE_OK;
}

static int read_input(char **input_out, size_t *length_out) {
  char *input = (char *)malloc(INPUT_LIMIT + 2U);
  size_t length = 0;
  if (input == NULL) return 0;
  while (length <= INPUT_LIMIT) {
    size_t count = fread(input + length, 1U, INPUT_LIMIT + 1U - length, stdin);
    length += count;
    if (count == 0U) {
      if (ferror(stdin)) {
        free(input);
        return 0;
      }
      break;
    }
  }
  if (length > INPUT_LIMIT) {
    free(input);
    fprintf(stderr, "sqlite3: input exceeds 1048576 bytes\n");
    return -1;
  }
  if (memchr(input, '\0', length) != NULL) {
    free(input);
    fprintf(stderr, "sqlite3: input contains NUL byte\n");
    return -1;
  }
  input[length] = '\0';
  *input_out = input;
  *length_out = length;
  return 1;
}

int main(void) {
  char *input = NULL;
  size_t input_length = 0;
  struct request request;
  const char *custom_error = NULL;
  char database_path[160];
  char error_buffer[512];
  const char *open_path = ":memory:";
  sqlite3 *database = NULL;
  struct output output;
  struct authorizer_state authorizer;
  int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
  int status;
  int read_status;

  memset(&output, 0, sizeof(output));
  memset(&authorizer, 0, sizeof(authorizer));
  sqlite3_hard_heap_limit64(SQLITE_HEAP_LIMIT);
  read_status = read_input(&input, &input_length);
  if (read_status <= 0) return read_status == 0 ? 1 : 1;
  if (!parse_request(input, input_length, &request, &custom_error)) {
    fprintf(stderr, "sqlite3: %s\n", custom_error);
    free(input);
    return 1;
  }
  if (request.has_database) {
    if (!safe_database_name(request.database)) {
      fprintf(stderr, "sqlite3: database path traversal denied\n");
      free(input);
      return 1;
    }
    if (snprintf(database_path, sizeof(database_path), "/workspace/%.*s",
                 (int)request.database.length, request.database.data) < 0) {
      fprintf(stderr, "sqlite3: invalid database path\n");
      free(input);
      return 1;
    }
    open_path = database_path;
    if (request.read_only) flags = SQLITE_OPEN_READONLY;
  }
  status = sqlite3_open_v2(open_path, &database, flags, NULL);
  if (status != SQLITE_OK) {
    fprintf(stderr, "sqlite3: %s\n", database != NULL ? sqlite3_errmsg(database) : "database open failed");
    sqlite3_close(database);
    free(input);
    return 1;
  }
  sqlite3_extended_result_codes(database, 1);
  sqlite3_set_authorizer(database, authorizer_cb, &authorizer);
  sqlite3_limit(database, SQLITE_LIMIT_SQL_LENGTH, (int)INPUT_LIMIT);
  sqlite3_limit(database, SQLITE_LIMIT_COLUMN, 256);
  sqlite3_limit(database, SQLITE_LIMIT_EXPR_DEPTH, 128);
  sqlite3_limit(database, SQLITE_LIMIT_LENGTH, (int)OUTPUT_LIMIT);
  sqlite3_limit(database, SQLITE_LIMIT_VDBE_OP, 10000000);
  (void)sqlite3_db_config(database, SQLITE_DBCONFIG_DEFENSIVE, 1, NULL);
  if (!request.read_only) {
    status = sqlite3_exec(database,
                          "PRAGMA page_size=4096; PRAGMA max_page_count=4096;",
                          NULL, NULL, NULL);
    if (status != SQLITE_OK) {
      fprintf(stderr, "sqlite3: %s\n", sqlite3_errmsg(database));
      sqlite3_close(database);
      free(input);
      return 1;
    }
  }
  output.capacity = OUTPUT_LIMIT;
  output.data = (char *)malloc(output.capacity);
  if (output.data == NULL) {
    fprintf(stderr, "sqlite3: out of memory\n");
    sqlite3_close(database);
    free(input);
    return 1;
  }
  status = execute_request(database, &request, &output, &custom_error,
                           error_buffer, sizeof(error_buffer), &authorizer);
  if (status != SQLITE_OK) {
    const char *message = custom_error != NULL ? custom_error : sqlite3_errmsg(database);
    fprintf(stderr, "sqlite3: %s\n", message);
    free(output.data);
    sqlite3_close(database);
    free(input);
    return 1;
  }
  if (output.length != 0U && fwrite(output.data, 1U, output.length, stdout) != output.length) {
    fprintf(stderr, "sqlite3: output write failed\n");
    free(output.data);
    sqlite3_close(database);
    free(input);
    return 1;
  }
  free(output.data);
  status = sqlite3_close(database);
  free(input);
  if (status != SQLITE_OK) {
    fprintf(stderr, "sqlite3: database close failed\n");
    return 1;
  }
  return 0;
}
