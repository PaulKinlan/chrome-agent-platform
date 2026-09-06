// oxipng — CAP-authored WASI PNG optimiser (chrome-agent-platform-m3vb).
// stdin carries the source PNG as base64 TEXT (stdin is a JSON string at the
// agent boundary — raw binary cannot ride it); stdout carries the optimised PNG
// as RAW bytes (the tool protocol re-encodes stdout as base64 for this tool —
// the stdoutEncoding row in extension/lib/tool-exec-preview.js). Errors go to
// stderr with exit 2. No network, no env, no threads, no filesystem.
//
//   oxipng [-o 0..6] [--strip safe|all]
//
// The pixels never change: oxipng re-encodes the same image data (filter
// choice, palette reduction, deflate level) and returns the ORIGINAL bytes
// when nothing gets smaller — so output.len() <= input.len() always holds.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::io::{Read, Write};

fn fail(msg: &str) -> ! {
    eprintln!("oxipng: {msg}");
    std::process::exit(2);
}

fn arg_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
}

fn read_stdin() -> Vec<u8> {
    let mut buf = Vec::new();
    if std::io::stdin().read_to_end(&mut buf).is_err() {
        fail("could not read stdin");
    }
    if buf.is_empty() {
        fail("empty stdin");
    }
    buf
}

// Whitespace-tolerant base64 decode (imageops convention).
fn read_stdin_image() -> Vec<u8> {
    let raw = read_stdin();
    let text = String::from_utf8(raw).unwrap_or_else(|_| fail("stdin is not base64 text"));
    let clean: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    B64.decode(clean.as_bytes()).unwrap_or_else(|_| fail("stdin is not valid base64 PNG bytes"))
}

fn write_stdout(bytes: &[u8]) {
    if std::io::stdout().write_all(bytes).is_err() {
        fail("could not write stdout");
    }
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    for a in &args {
        if a == "-h" || a == "--help" {
            fail("usage: oxipng [-o 0..6] [--strip safe|all]  (base64 PNG on stdin -> optimised PNG on stdout)");
        }
    }

    let level: u8 = match arg_value(&args, "-o") {
        None => 2,
        Some(v) => match v.parse::<u8>() {
            Ok(n) if n <= 6 => n,
            _ => fail("-o must be an effort level 0..6"),
        },
    };
    let strip = match arg_value(&args, "--strip") {
        None | Some("safe") => oxipng::StripChunks::Safe,
        Some("all") => oxipng::StripChunks::All,
        Some(_) => fail("--strip must be safe or all"),
    };

    let input = read_stdin_image();
    if input.len() < PNG_SIGNATURE.len() || input[..8] != PNG_SIGNATURE {
        fail("stdin is not a PNG (bad signature)");
    }

    let mut opts = oxipng::Options::from_preset(level);
    opts.strip = strip;
    // Bounded work: the executor's wall limit is 5 s; stop trials early rather
    // than trap on the host deadline. Whatever was found by then is returned
    // (or the original bytes if nothing was smaller).
    opts.timeout = Some(std::time::Duration::from_millis(3500));

    let output = oxipng::optimize_from_memory(&input, &opts)
        .unwrap_or_else(|e| fail(&format!("could not optimise PNG: {e}")));
    if output.len() > input.len() {
        // Never hand back a larger file: the crate guards this, but the
        // invariant is ours to keep.
        write_stdout(&input);
    } else {
        write_stdout(&output);
    }
}
