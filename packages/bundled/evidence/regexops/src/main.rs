// regexops — CAP-authored WASI regex tool (chrome-agent-platform-nmc2).
// Linear-time RE2-style matching via the regex crate; the binary SELF-BOUNDS
// its inputs so the host wrapper needs no regex-specific ceilings:
//   - pattern <= 256 chars (exit 2 pattern_too_long beyond that)
//   - match output capped at --max (default 32, hard cap 256), with an
//     explicit "truncated" flag when the cap bites
//   - stdin subject must be valid UTF-8 (exit 2 otherwise)
// No env, no clock, no randomness: same input -> same output, always.
//
//   regexops match   -p <pattern> [--max N]     subject on stdin (UTF-8)
//   regexops replace -p <pattern> -r <repl>     subject on stdin (UTF-8)
//
// stdout (match):   {"matches":[{"start":S,"end":E,"groups":[{"start":..,"end":..},..]},..],"truncated":B}
//   S/E are BYTE offsets into the subject; groups[0] is the whole match.
// stdout (replace): the subject with every non-overlapping match replaced.

use std::io::{Read, Write};
use regex::Regex;

const MAX_PATTERN_CHARS: usize = 256;
const DEFAULT_MAX_MATCHES: usize = 32;
const HARD_MAX_MATCHES: usize = 256;
const MAX_REPL_CHARS: usize = 1024;

fn fail(msg: &str) -> ! {
    eprintln!("regexops: {msg}");
    std::process::exit(2);
}

fn arg_value<'a>(args: &'a [String], name: &str, short: &str) -> Option<&'a str> {
    for (i, a) in args.iter().enumerate() {
        if a == name || a == short {
            return args.get(i + 1).map(|s| s.as_str());
        }
    }
    None
}

fn read_stdin() -> Vec<u8> {
    let mut buf = Vec::new();
    if std::io::stdin().read_to_end(&mut buf).is_err() {
        fail("stdin_read_failed");
    }
    buf
}

fn subject_string() -> String {
    let bytes = read_stdin();
    match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => fail("stdin_not_utf8"),
    }
}

fn compile_pattern(args: &[String], name: &str, short: &str) -> Regex {
    let pattern = match arg_value(args, name, short) {
        Some(p) => p,
        None => fail("pattern_missing"),
    };
    if pattern.chars().count() > MAX_PATTERN_CHARS {
        fail("pattern_too_long");
    }
    // The crate's error message is bounded prose from a pinned dependency —
    // safe to surface; it never echoes the subject.
    match Regex::new(pattern) {
        Ok(re) => re,
        Err(e) => fail(&format!("pattern_invalid: {e}")),
    }
}

fn emit(s: &str) -> ! {
    let out = std::io::stdout();
    let mut lock = out.lock();
    if lock.write_all(s.as_bytes()).is_err() || lock.flush().is_err() {
        fail("stdout_write_failed");
    }
    std::process::exit(0);
}

fn run_match(args: &[String]) -> ! {
    let re = compile_pattern(args, "--pattern", "-p");
    let max = match arg_value(args, "--max", "-m") {
        Some(v) => match v.parse::<usize>() {
            Ok(n) if n >= 1 && n <= HARD_MAX_MATCHES => n,
            _ => fail("max_out_of_range"),
        },
        None => DEFAULT_MAX_MATCHES,
    };
    let subject = subject_string();

    let mut out = String::from("{\"matches\":[");
    let mut truncated = false;
    let mut count = 0usize;
    for mat in re.captures_iter(&subject) {
        if count >= max {
            truncated = true;
            break;
        }
        let whole = mat.get(0).expect("group 0 always present");
        if count > 0 {
            out.push(',');
        }
        out.push_str(&format!("{{\"start\":{},\"end\":{},\"groups\":[", whole.start(), whole.end()));
        for (gi, group) in mat.iter().enumerate() {
            if gi > 0 {
                out.push(',');
            }
            match group {
                Some(g) => out.push_str(&format!("{{\"start\":{},\"end\":{}}}", g.start(), g.end())),
                None => out.push_str("null"),
            }
        }
        out.push_str("]}");
        count += 1;
    }
    out.push_str(&format!("],\"truncated\":{}}}", truncated));
    emit(&out);
}

fn run_replace(args: &[String]) -> ! {
    let re = compile_pattern(args, "--pattern", "-p");
    let repl = match arg_value(args, "--replacement", "-r") {
        Some(r) => r,
        None => fail("replacement_missing"),
    };
    if repl.chars().count() > MAX_REPL_CHARS {
        fail("replacement_too_long");
    }
    let subject = subject_string();
    // $-syntax in the replacement follows the crate's expansion rules; the
    // bound above keeps the expansion budget explicit at the tool boundary.
    let replaced = re.replace_all(&subject, repl);
    emit(&replaced);
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match argv.first().map(String::as_str) {
        Some("match") => run_match(&argv[1..]),
        Some("replace") => run_replace(&argv[1..]),
        _ => fail("usage: regexops match|replace"),
    }
}
