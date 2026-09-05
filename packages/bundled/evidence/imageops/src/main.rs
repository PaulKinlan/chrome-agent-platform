// imageops — CAP-authored WASI image tool (chrome-agent-platform-e5o8).
// stdin carries the source image bytes; stdout carries the result. Errors go
// to stderr with a non-zero exit. No network, no env, no threads.
//
//   imageops info                              → JSON {width,height,format,bytes}
//   imageops resize --width N --height M       → re-encoded image (same format)
//   imageops convert --format png|jpeg|webp

use std::io::{Read, Write};

fn fail(msg: &str) -> ! {
    eprintln!("imageops: {msg}");
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

fn write_stdout(bytes: &[u8]) {
    if std::io::stdout().write_all(bytes).is_err() {
        fail("could not write stdout");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first() else {
        fail("usage: imageops info | resize --width N --height M | convert --format png|jpeg|webp");
    };
    let input = read_stdin();
    match cmd.as_str() {
        "info" => {
            let img = image::load_from_memory(&input).unwrap_or_else(|e| fail(&format!("unreadable image: {e}")));
            let format = image::guess_format(&input)
                .map(|f| format!("{f:?}").to_lowercase())
                .unwrap_or_else(|_| "unknown".into());
            let out = format!(
                "{{\"width\":{},\"height\":{},\"format\":\"{}\",\"bytes\":{}}}",
                img.width(),
                img.height(),
                format,
                input.len()
            );
            println!("{out}");
        }
        "resize" => {
            let w: u32 = arg_value(&args, "--width").and_then(|v| v.parse().ok()).unwrap_or(0);
            let h: u32 = arg_value(&args, "--height").and_then(|v| v.parse().ok()).unwrap_or(0);
            if w == 0 && h == 0 {
                fail("resize needs --width and/or --height");
            }
            let img = image::load_from_memory(&input).unwrap_or_else(|e| fail(&format!("unreadable image: {e}")));
            // One zero axis keeps the aspect ratio for the other.
            let (w, h) = match (w, h) {
                (0, h) => (((img.width() as u64 * h as u64) / img.height() as u64) as u32, h),
                (w, 0) => (w, ((img.height() as u64 * w as u64) / img.width() as u64) as u32),
                (w, h) => (w, h),
            };
            let out = img.resize_exact(w, h, image::imageops::FilterType::Lanczos3);
            let format = image::guess_format(&input).unwrap_or(image::ImageFormat::Png);
            let mut buf = std::io::Cursor::new(Vec::new());
            if out.write_to(&mut buf, format).is_err() {
                fail("could not encode the resized image");
            }
            write_stdout(&buf.into_inner());
        }
        "convert" => {
            let format = match arg_value(&args, "--format") {
                Some("png") => image::ImageFormat::Png,
                Some("jpeg") | Some("jpg") => image::ImageFormat::Jpeg,
                Some("webp") => image::ImageFormat::WebP,
                Some(other) => fail(&format!("unsupported format: {other} (png|jpeg|webp)")),
                None => fail("convert needs --format png|jpeg|webp"),
            };
            let img = image::load_from_memory(&input).unwrap_or_else(|e| fail(&format!("unreadable image: {e}")));
            let mut buf = std::io::Cursor::new(Vec::new());
            if img.write_to(&mut buf, format).is_err() {
                fail("could not encode the converted image");
            }
            write_stdout(&buf.into_inner());
        }
        other => fail(&format!("unknown subcommand: {other}")),
    }
}
