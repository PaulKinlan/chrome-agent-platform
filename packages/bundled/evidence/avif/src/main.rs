// avif — CAP-authored WASI AVIF encoder over ravif+rav1e (chrome-agent-platform-ou4x).
// The model sends the source image as base64 TEXT at the tool boundary; the job
// lane (spec stdinEncoding "base64", extension/lib/tool-exec-preview.js) decodes
// it and the WORKER writes RAW image bytes to this process's stdin pipe — so this
// tool reads RAW bytes, NOT base64 (the compressops/zxing 8oil contract). stdout
// carries the RAW AVIF bytes (the protocol re-encodes stdout as base64 — the
// stdoutEncoding row). Errors go to stderr with exit 2. No network, no env, no
// threads, no filesystem.
//
//   avif [--quality 1..100 (default 80)] [--speed 1..10 (default 10)]
//
// The wall bound is the executor's 5 s (PREVIEW_LIMITS.wallMs): measured at
// speed 10 a 512×512 encode is ~280 ms and a 1024×768 encode ~840 ms (speed 8
// ~2.9 s), so the default stays at speed 10 for headroom. Chrome cannot encode
// AVIF from canvas (native probe, cap-evidence/cap-avif/native-probe.md) — this
// fills that gap on-device.

use imgref::Img;
use ravif::{Encoder, RGBA8};
use std::io::{Read, Write};

fn fail(msg: &str) -> ! {
    eprintln!("avif: {msg}");
    std::process::exit(2);
}

fn arg_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(|s| s.as_str())
}

fn read_stdin_image() -> Vec<u8> {
    // RAW image bytes on the stdin pipe (the worker already decoded the model's
    // base64). No base64 decode here.
    let mut buf = Vec::new();
    if std::io::stdin().read_to_end(&mut buf).is_err() { fail("could not read stdin"); }
    if buf.is_empty() { fail("empty stdin"); }
    buf
}

fn write_stdout(bytes: &[u8]) {
    if std::io::stdout().write_all(bytes).is_err() { fail("could not write stdout"); }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    for a in &args {
        if a == "-h" || a == "--help" {
            fail("usage: avif [--quality 1..100 (default 80)] [--speed 1..10 (default 10)]  (base64 PNG/JPEG/WebP on stdin -> AVIF on stdout)");
        }
    }
    let quality: f32 = match arg_value(&args, "--quality") {
        None => 80.0,
        Some(v) => match v.parse::<f32>() {
            Ok(n) if (1.0..=100.0).contains(&n) => n,
            _ => fail("--quality must be 1..100"),
        },
    };
    let speed: u8 = match arg_value(&args, "--speed") {
        None => 10,
        Some(v) => match v.parse::<u8>() {
            Ok(n) if (1..=10).contains(&n) => n,
            _ => fail("--speed must be 1..10"),
        },
    };

    let input = read_stdin_image();
    let decoded = image::load_from_memory(&input).unwrap_or_else(|_| fail("stdin is not a PNG/JPEG/WebP image"));
    let rgba = decoded.to_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    let pixels: Vec<RGBA8> = rgba.as_raw().chunks_exact(4)
        .map(|c| RGBA8 { r: c[0], g: c[1], b: c[2], a: c[3] }).collect();

    let encoded = Encoder::new()
        .with_quality(quality)
        .with_speed(speed)
        .encode_rgba(Img::new(&pixels[..], w, h))
        .unwrap_or_else(|e| fail(&format!("encode failed: {e:?}")));
    write_stdout(&encoded.avif_file);
}
