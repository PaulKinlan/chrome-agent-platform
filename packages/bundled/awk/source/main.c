/*
 * clean-room 0BSD awk — lightweight, pure-WASI preview-1 awk engine.
 *
 * Copyright (C) 2026 Chrome Agent Platform Authors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <stdbool.h>

#define MAX_FIELDS 128
#define MAX_LINE_LEN 65536
#define MAX_VAR_NAME 64
#define MAX_VAR_VAL 1024
#define MAX_VARS 64
#define MAX_ACTIONS 32

typedef struct {
    char name[MAX_VAR_NAME];
    char val[MAX_VAR_VAL];
    double num;
    bool is_num;
} Var;

static Var g_vars[MAX_VARS];
static int g_var_count = 0;

static char g_fs[64] = " ";
static char g_ofs[64] = " ";
static long g_nr = 0;
static int g_nf = 0;
static char *g_fields[MAX_FIELDS];
static char g_line_buf[MAX_LINE_LEN];
static char g_raw_line[MAX_LINE_LEN];

static void set_var(const char *name, const char *val) {
    for (int i = 0; i < g_var_count; i++) {
        if (strcmp(g_vars[i].name, name) == 0) {
            strncpy(g_vars[i].val, val, MAX_VAR_VAL - 1);
            g_vars[i].val[MAX_VAR_VAL - 1] = '\0';
            char *end;
            g_vars[i].num = strtod(val, &end);
            g_vars[i].is_num = (*end == '\0' && end != val);
            return;
        }
    }
    if (g_var_count < MAX_VARS) {
        strncpy(g_vars[g_var_count].name, name, MAX_VAR_NAME - 1);
        strncpy(g_vars[g_var_count].val, val, MAX_VAR_VAL - 1);
        char *end;
        g_vars[g_var_count].num = strtod(val, &end);
        g_vars[g_var_count].is_num = (*end == '\0' && end != val);
        g_var_count++;
    }
}

static const char *get_var(const char *name) {
    if (strcmp(name, "FS") == 0) return g_fs;
    if (strcmp(name, "OFS") == 0) return g_ofs;
    for (int i = 0; i < g_var_count; i++) {
        if (strcmp(g_vars[i].name, name) == 0) return g_vars[i].val;
    }
    return "";
}

static void split_fields(char *line) {
    g_nf = 0;
    strncpy(g_raw_line, line, sizeof(g_raw_line) - 1);
    g_raw_line[sizeof(g_raw_line) - 1] = '\0';
    g_fields[0] = g_raw_line;

    if (!line || !*line) {
        return;
    }

    if (strcmp(g_fs, " ") == 0 || g_fs[0] == '\0') {
        // Default: space/tab separated, trimming leading/trailing whitespace
        char *p = line;
        while (*p && isspace((unsigned char)*p)) p++;
        while (*p && g_nf < MAX_FIELDS - 1) {
            g_fields[++g_nf] = p;
            while (*p && !isspace((unsigned char)*p)) p++;
            if (*p) {
                *p++ = '\0';
                while (*p && isspace((unsigned char)*p)) p++;
            }
        }
    } else {
        // Single or multi-char delimiter
        char *p = line;
        size_t fs_len = strlen(g_fs);
        while (p && g_nf < MAX_FIELDS - 1) {
            g_fields[++g_nf] = p;
            char *next = strstr(p, g_fs);
            if (next) {
                *next = '\0';
                p = next + fs_len;
            } else {
                break;
            }
        }
    }
}

static const char *eval_term(const char *term, char *out_buf, size_t out_size) {
    while (isspace((unsigned char)*term)) term++;
    if (!*term) {
        out_buf[0] = '\0';
        return out_buf;
    }

    // String literal "..."
    if (*term == '"') {
        size_t len = 0;
        term++;
        while (*term && *term != '"' && len < out_size - 1) {
            if (*term == '\\' && *(term + 1)) {
                term++;
                if (*term == 'n') out_buf[len++] = '\n';
                else if (*term == 't') out_buf[len++] = '\t';
                else out_buf[len++] = *term;
            } else {
                out_buf[len++] = *term;
            }
            term++;
        }
        out_buf[len] = '\0';
        return out_buf;
    }

    // Field reference $0, $1, $NF, etc.
    if (*term == '$') {
        term++;
        int fld_idx = 0;
        if (strcmp(term, "NF") == 0) {
            fld_idx = g_nf;
        } else {
            fld_idx = atoi(term);
        }
        if (fld_idx >= 0 && fld_idx <= g_nf && g_fields[fld_idx]) {
            strncpy(out_buf, g_fields[fld_idx], out_size - 1);
            out_buf[out_size - 1] = '\0';
        } else {
            out_buf[0] = '\0';
        }
        return out_buf;
    }

    // Special variable names
    if (strcmp(term, "NR") == 0) {
        snprintf(out_buf, out_size, "%ld", g_nr);
        return out_buf;
    }
    if (strcmp(term, "NF") == 0) {
        snprintf(out_buf, out_size, "%d", g_nf);
        return out_buf;
    }
    if (strcmp(term, "FS") == 0) {
        strncpy(out_buf, g_fs, out_size - 1);
        out_buf[out_size - 1] = '\0';
        return out_buf;
    }

    // Named variable
    const char *v = get_var(term);
    if (*v) {
        strncpy(out_buf, v, out_size - 1);
        out_buf[out_size - 1] = '\0';
        return out_buf;
    }

    // Numeric / plain literal fallback
    strncpy(out_buf, term, out_size - 1);
    out_buf[out_size - 1] = '\0';
    return out_buf;
}

static void execute_print(const char *args) {
    if (!args || !*args) {
        if (g_fields[0]) puts(g_fields[0]);
        else putchar('\n');
        return;
    }

    // Parse comma-separated arguments
    const char *p = args;
    bool first = true;

    while (*p) {
        while (isspace((unsigned char)*p)) p++;
        if (!*p) break;

        char token[512];
        size_t t_len = 0;
        bool in_quote = false;

        while (*p && t_len < sizeof(token) - 1) {
            if (*p == '"') {
                in_quote = !in_quote;
                token[t_len++] = *p++;
            } else if (*p == ',' && !in_quote) {
                p++; // skip comma
                break;
            } else {
                token[t_len++] = *p++;
            }
        }
        token[t_len] = '\0';

        while (t_len > 0 && isspace((unsigned char)token[t_len - 1])) {
            token[--t_len] = '\0';
        }

        char val[1024];
        eval_term(token, val, sizeof(val));
        if (!first) {
            fputs(g_ofs, stdout);
        }
        fputs(val, stdout);
        first = false;
    }
    putchar('\n');
}

static bool eval_condition(const char *cond, const char *raw_line) {
    while (isspace((unsigned char)*cond)) cond++;
    if (!*cond) return true;

    // Bounded literal pattern /text/ with optional ^ and $ anchors. This is
    // deliberately NOT a general regular-expression engine: metacharacters
    // other than edge anchors are matched literally.
    if (*cond == '/' && cond[strlen(cond) - 1] == '/') {
        char pat[256];
        size_t len = strlen(cond) - 2;
        if (len >= sizeof(pat)) return false;
        memcpy(pat, cond + 1, len);
        pat[len] = '\0';

        bool anchor_start = pat[0] == '^';
        if (anchor_start) {
            memmove(pat, pat + 1, len);
            len--;
        }
        bool anchor_end = len > 0 && pat[len - 1] == '$';
        if (anchor_end) pat[--len] = '\0';

        if (anchor_start && anchor_end) return strcmp(raw_line, pat) == 0;
        if (anchor_start) return strncmp(raw_line, pat, len) == 0;
        if (anchor_end) {
            size_t raw_len = strlen(raw_line);
            return raw_len >= len && strcmp(raw_line + raw_len - len, pat) == 0;
        }
        return strstr(raw_line, pat) != NULL;
    }

    // Equality $1 == "val" or $1 != "val"
    char left[128], op[8], right[128];
    if (sscanf(cond, "%127s %7s %127s", left, op, right) == 3) {
        char l_val[256], r_val[256];
        eval_term(left, l_val, sizeof(l_val));
        eval_term(right, r_val, sizeof(r_val));

        if (strcmp(op, "==") == 0) return strcmp(l_val, r_val) == 0;
        if (strcmp(op, "!=") == 0) return strcmp(l_val, r_val) != 0;

        double l_num = strtod(l_val, NULL);
        double r_num = strtod(r_val, NULL);
        if (strcmp(op, ">") == 0) return l_num > r_num;
        if (strcmp(op, "<") == 0) return l_num < r_num;
        if (strcmp(op, ">=") == 0) return l_num >= r_num;
        if (strcmp(op, "<=") == 0) return l_num <= r_num;
    }

    // Numeric check NR == 1
    if (strstr(cond, "NR")) {
        char *eq = strstr(cond, "==");
        if (eq) {
            long target = atol(eq + 2);
            return g_nr == target;
        }
    }

    return true;
}

static void run_action_block(const char *action_body) {
    const char *p = action_body;
    while (*p) {
        while (isspace((unsigned char)*p) || *p == ';') p++;
        if (!*p) break;

        char stmt[1024];
        size_t s_len = 0;
        bool in_quote = false;

        while (*p && s_len < sizeof(stmt) - 1) {
            if (*p == '"') {
                in_quote = !in_quote;
                stmt[s_len++] = *p++;
            } else if ((*p == ';' || *p == '\n') && !in_quote) {
                p++;
                break;
            } else {
                stmt[s_len++] = *p++;
            }
        }
        stmt[s_len] = '\0';

        char *s = stmt;
        while (isspace((unsigned char)*s)) s++;

        if (strncmp(s, "print", 5) == 0 && (isspace((unsigned char)s[5]) || s[5] == '\0' || s[5] == '(')) {
            const char *args = s + 5;
            while (isspace((unsigned char)*args)) args++;
            if (*args == '(') {
                args++;
                char clean_args[1024];
                strncpy(clean_args, args, sizeof(clean_args) - 1);
                clean_args[sizeof(clean_args) - 1] = '\0';
                char *rparen = strrchr(clean_args, ')');
                if (rparen) *rparen = '\0';
                execute_print(clean_args);
            } else {
                execute_print(args);
            }
        }
    }
}

typedef struct {
    char condition[256];
    char action[1024];
    bool is_begin;
    bool is_end;
} Rule;

static Rule g_rules[MAX_ACTIONS];
static int g_rule_count = 0;

static void parse_script(const char *script) {
    const char *p = script;
    while (*p) {
        while (isspace((unsigned char)*p)) p++;
        if (!*p) break;

        if (g_rule_count >= MAX_ACTIONS) break;
        Rule *rule = &g_rules[g_rule_count++];
        memset(rule, 0, sizeof(Rule));

        if (strncmp(p, "BEGIN", 5) == 0 && (isspace((unsigned char)p[5]) || p[5] == '{')) {
            rule->is_begin = true;
            p += 5;
            while (isspace((unsigned char)*p)) p++;
        } else if (strncmp(p, "END", 3) == 0 && (isspace((unsigned char)p[3]) || p[3] == '{')) {
            rule->is_end = true;
            p += 3;
            while (isspace((unsigned char)*p)) p++;
        } else if (*p != '{') {
            size_t c_len = 0;
            while (*p && *p != '{' && c_len < sizeof(rule->condition) - 1) {
                rule->condition[c_len++] = *p++;
            }
            rule->condition[c_len] = '\0';
            while (c_len > 0 && isspace((unsigned char)rule->condition[c_len - 1])) {
                rule->condition[--c_len] = '\0';
            }
        }

        if (*p == '{') {
            p++; // skip '{'
            size_t a_len = 0;
            int depth = 1;
            while (*p && depth > 0 && a_len < sizeof(rule->action) - 1) {
                if (*p == '{') depth++;
                else if (*p == '}') {
                    depth--;
                    if (depth == 0) { p++; break; }
                }
                rule->action[a_len++] = *p++;
            }
            rule->action[a_len] = '\0';
        } else if (!rule->is_begin && !rule->is_end) {
            strcpy(rule->action, "print $0");
        }
    }
}

static void process_stream(FILE *in) {
    char line[MAX_LINE_LEN];
    while (fgets(line, sizeof(line), in)) {
        size_t len = strlen(line);
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) {
            line[--len] = '\0';
        }

        g_nr++;
        strncpy(g_line_buf, line, sizeof(g_line_buf) - 1);
        g_line_buf[sizeof(g_line_buf) - 1] = '\0';

        split_fields(g_line_buf);

        for (int i = 0; i < g_rule_count; i++) {
            if (g_rules[i].is_begin || g_rules[i].is_end) continue;
            if (eval_condition(g_rules[i].condition, g_raw_line)) {
                run_action_block(g_rules[i].action);
            }
        }
    }
}

int main(int argc, char **argv) {
    const char *script = NULL;
    int arg_idx = 1;

    while (arg_idx < argc && argv[arg_idx][0] == '-' && argv[arg_idx][1] != '\0') {
        if (strcmp(argv[arg_idx], "-F") == 0) {
            if (++arg_idx < argc) {
                strncpy(g_fs, argv[arg_idx], sizeof(g_fs) - 1);
            }
        } else if (strncmp(argv[arg_idx], "-F", 2) == 0) {
            strncpy(g_fs, argv[arg_idx] + 2, sizeof(g_fs) - 1);
        } else if (strcmp(argv[arg_idx], "-v") == 0) {
            if (++arg_idx < argc) {
                char *eq = strchr(argv[arg_idx], '=');
                if (eq) {
                    *eq = '\0';
                    set_var(argv[arg_idx], eq + 1);
                }
            }
        } else if (strcmp(argv[arg_idx], "--") == 0) {
            arg_idx++;
            break;
        } else {
            fprintf(stderr, "awk: unrecognized option '%s'\n", argv[arg_idx]);
            return 1;
        }
        arg_idx++;
    }

    if (arg_idx < argc) {
        script = argv[arg_idx++];
    }

    if (!script || !*script) {
        script = "{ print $0 }";
    }

    parse_script(script);

    // Execute BEGIN blocks
    for (int i = 0; i < g_rule_count; i++) {
        if (g_rules[i].is_begin) {
            run_action_block(g_rules[i].action);
        }
    }

    // Process file inputs or stdin
    if (arg_idx >= argc) {
        process_stream(stdin);
    } else {
        while (arg_idx < argc) {
            FILE *f = fopen(argv[arg_idx], "r");
            if (!f) {
                fprintf(stderr, "awk: cannot open file %s\n", argv[arg_idx]);
                return 1;
            }
            process_stream(f);
            fclose(f);
            arg_idx++;
        }
    }

    // Execute END blocks
    for (int i = 0; i < g_rule_count; i++) {
        if (g_rules[i].is_end) {
            run_action_block(g_rules[i].action);
        }
    }

    return 0;
}
