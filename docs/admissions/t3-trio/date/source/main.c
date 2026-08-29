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
#include <errno.h>

#define MAX_OUT_LEN 4096

static bool parse_epoch(const char *text, time_t *out) {
    if (!text || !*text) return false;
    char *end = NULL;
    errno = 0;
    long long value = strtoll(text, &end, 10);
    if (errno == ERANGE || end == text || *end != '\0') return false;
    time_t converted = (time_t)value;
    if ((long long)converted != value) return false;
    *out = converted;
    return true;
}

static bool parse_date_spec(const char *spec, time_t *out) {
    if (!spec || !out) return false;
    while (isspace((unsigned char)*spec)) spec++;
    if (!*spec) return false;

    // Epoch timestamp @1724000000 or a plain numeric epoch.
    if (*spec == '@') return parse_epoch(spec + 1, out);
    bool numeric = *spec == '-' || *spec == '+' || isdigit((unsigned char)*spec);
    if (numeric && parse_epoch(spec, out)) return true;

    // Exact ISO date or timestamp: YYYY-MM-DD[ T]HH:MM:SS. timegm normalizes
    // invalid fields, so compare its round-trip fields before accepting.
    int year = 0, month = 0, day = 0, hour = 0, min = 0, sec = 0;
    int consumed = 0;
    int fields = sscanf(spec, "%d-%d-%d%n", &year, &month, &day, &consumed);
    if (fields != 3 || consumed != 10 || year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const char *rest = spec + consumed;
    if (*rest != '\0') {
        if (*rest != 'T' && *rest != ' ') return false;
        int time_consumed = 0;
        if (sscanf(rest + 1, "%d:%d:%d%n", &hour, &min, &sec, &time_consumed) != 3 || rest[1 + time_consumed] != '\0') return false;
        if (hour < 0 || hour > 23 || min < 0 || min > 59 || sec < 0 || sec > 60) return false;
    }

    struct tm tm_val;
    memset(&tm_val, 0, sizeof(tm_val));
    tm_val.tm_year = year - 1900;
    tm_val.tm_mon = month - 1;
    tm_val.tm_mday = day;
    tm_val.tm_hour = hour;
    tm_val.tm_min = min;
    tm_val.tm_sec = sec;
    time_t parsed = timegm(&tm_val);
    if (parsed == (time_t)-1) return false;
    struct tm roundtrip;
    if (!gmtime_r(&parsed, &roundtrip)) return false;
    if (roundtrip.tm_year != year - 1900 || roundtrip.tm_mon != month - 1 ||
        roundtrip.tm_mday != day || roundtrip.tm_hour != hour ||
        roundtrip.tm_min != min || roundtrip.tm_sec != sec) return false;
    *out = parsed;
    return true;
}

static bool valid_iso_spec(const char *spec) {
    return strcmp(spec, "") == 0 || strcmp(spec, "date") == 0 ||
        strcmp(spec, "hours") == 0 || strcmp(spec, "hour") == 0 ||
        strcmp(spec, "minutes") == 0 || strcmp(spec, "minute") == 0 ||
        strcmp(spec, "seconds") == 0 || strcmp(spec, "second") == 0 ||
        strcmp(spec, "s") == 0;
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
            if (++i >= argc) {
                fprintf(stderr, "date: option '%s' requires an argument\n", arg);
                return 1;
            }
            date_str = argv[i];
        } else if (strncmp(arg, "--date=", 7) == 0) {
            date_str = arg + 7;
        } else if (strncmp(arg, "-I", 2) == 0 && valid_iso_spec(arg + 2)) {
            iso_spec = arg + 2;
        } else if (strcmp(arg, "--iso-8601") == 0) {
            iso_spec = "";
        } else if (strncmp(arg, "--iso-8601=", 11) == 0 && valid_iso_spec(arg + 11)) {
            iso_spec = arg + 11;
        } else if (strcmp(arg, "--help") == 0) {
            printf("Usage: date [OPTION]... [+FORMAT]\n");
            return 0;
        } else {
            fprintf(stderr, "date: unrecognized option '%s'\n", arg);
            return 1;
        }
    }

    time_t raw_time = time(NULL);
    if (date_str && !parse_date_spec(date_str, &raw_time)) {
        fprintf(stderr, "date: invalid date '%.*s'\n", 96, date_str);
        return 1;
    }

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
