/*
 * clean-room 0BSD date — lightweight, pure-WASI preview-1 date utility.
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
#include <time.h>
#include <stdbool.h>
#include <ctype.h>

#define MAX_OUT_LEN 4096

static time_t parse_date_spec(const char *spec) {
    if (!spec || !*spec) return time(NULL);

    while (isspace((unsigned char)*spec)) spec++;

    // Epoch timestamp @1724000000
    if (*spec == '@') {
        return (time_t)atoll(spec + 1);
    }

    // Pure numeric epoch
    bool all_digits = true;
    for (const char *p = spec; *p; p++) {
        if (!isdigit((unsigned char)*p)) {
            all_digits = false;
            break;
        }
    }
    if (all_digits && strlen(spec) >= 9) {
        return (time_t)atoll(spec);
    }

    // ISO format YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
    int year = 0, month = 0, day = 0, hour = 0, min = 0, sec = 0;
    if (sscanf(spec, "%d-%d-%d", &year, &month, &day) >= 3) {
        struct tm tm_val;
        memset(&tm_val, 0, sizeof(struct tm));
        tm_val.tm_year = year - 1900;
        tm_val.tm_mon = month - 1;
        tm_val.tm_mday = day;

        const char *t = strchr(spec, 'T');
        if (!t) t = strchr(spec, ' ');
        if (t) {
            sscanf(t + 1, "%d:%d:%d", &hour, &min, &sec);
        }
        tm_val.tm_hour = hour;
        tm_val.tm_min = min;
        tm_val.tm_sec = sec;

        time_t t_res = timegm(&tm_val);
        if (t_res != (time_t)-1) return t_res;
    }

    return time(NULL);
}

int main(int argc, char **argv) {
    const char *format = NULL;
    const char *date_str = NULL;
    bool utc = false;
    const char *iso_spec = NULL;

    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];
        if (arg[0] == '+') {
            format = arg + 1;
        } else if (strcmp(arg, "-u") == 0 || strcmp(arg, "--utc") == 0 || strcmp(arg, "--universal") == 0) {
            utc = true;
        } else if (strcmp(arg, "-d") == 0 || strcmp(arg, "--date") == 0) {
            if (++i < argc) {
                date_str = argv[i];
            }
        } else if (strncmp(arg, "--date=", 7) == 0) {
            date_str = arg + 7;
        } else if (strncmp(arg, "-I", 2) == 0) {
            iso_spec = arg + 2;
        } else if (strncmp(arg, "--iso-8601", 10) == 0) {
            if (arg[10] == '=') iso_spec = arg + 11;
            else iso_spec = "";
        } else if (strcmp(arg, "--help") == 0) {
            printf("Usage: date [OPTION]... [+FORMAT]\n");
            return 0;
        } else {
            fprintf(stderr, "date: unrecognized option '%s'\n", arg);
            return 1;
        }
    }

    time_t raw_time = date_str ? parse_date_spec(date_str) : time(NULL);

    struct tm tm_info;
    if (utc) {
        gmtime_r(&raw_time, &tm_info);
    } else {
        localtime_r(&raw_time, &tm_info);
    }

    char out[MAX_OUT_LEN];

    if (iso_spec != NULL) {
        if (strcmp(iso_spec, "hours") == 0 || strcmp(iso_spec, "hour") == 0) {
            strftime(out, sizeof(out), "%Y-%m-%dT%H", &tm_info);
        } else if (strcmp(iso_spec, "minutes") == 0 || strcmp(iso_spec, "minute") == 0) {
            strftime(out, sizeof(out), "%Y-%m-%dT%H:%M", &tm_info);
        } else if (strcmp(iso_spec, "seconds") == 0 || strcmp(iso_spec, "second") == 0 || strcmp(iso_spec, "s") == 0) {
            strftime(out, sizeof(out), "%Y-%m-%dT%H:%M:%S%z", &tm_info);
        } else {
            // default date: %Y-%m-%d
            strftime(out, sizeof(out), "%Y-%m-%d", &tm_info);
        }
    } else if (format != NULL) {
        strftime(out, sizeof(out), format, &tm_info);
    } else {
        // Standard default POSIX date format: %a %b %e %H:%M:%S %Z %Y
        strftime(out, sizeof(out), "%a %b %e %H:%M:%S %Z %Y", &tm_info);
    }

    puts(out);
    return 0;
}
