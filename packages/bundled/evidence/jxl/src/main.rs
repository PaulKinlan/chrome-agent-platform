// jxl — CAP-authored WASI JPEG XL decoder (chrome-agent-platform-agpu).
// stdin carries the source JXL image as base64 TEXT (stdin is a JSON string
// at the agent boundary — raw binary cannot ride it); stdout carries the
// decoded PNG as RAW bytes (the tool protocol re-encodes stdout as base64 for
// this tool — the stdoutEncoding row in extension/lib/tool-exec-preview.js).
// Errors go to stderr with exit 2. No network, no env, no threads, no filesystem.
//
//   jxl [--to png]
//
// decodes frame 0 of the JPEG XL image to PNG bytes on stdout.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use jxl_oxide::JxlImage;
use std::io::{Cursor, Read};

fn fail(msg: &str) -> ! {
    eprintln!("jxl: {msg}");
    std::process::exit(2);
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

// Whitespace-tolerant base64 decode (imageops/oxipng convention).
fn read_stdin_image() -> Vec<u8> {
    let raw = read_stdin();
    let text = String::from_utf8(raw).unwrap_or_else(|_| fail("stdin is not base64 text"));
    let clean: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    B64.decode(clean.as_bytes()).unwrap_or_else(|_| fail("stdin is not valid base64 JXL bytes"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => {
                fail("usage: jxl [--to png]  (base64 JXL on stdin -> PNG bytes on stdout)");
            }
            "--to" => {
                i += 1;
                if i >= args.len() || args[i] != "png" {
                    fail("--to format must be png");
                }
            }
            arg => {
                fail(&format!("unknown argument: {arg}"));
            }
        }
        i += 1;
    }

    let input = read_stdin_image();
    let image = match JxlImage::builder().read(Cursor::new(&input)) {
        Ok(img) => img,
        Err(e) => fail(&format!("invalid JXL: {e}")),
    };

    let render = match image.render_frame(0) {
        Ok(r) => r,
        Err(e) => fail(&format!("render error: {e}")),
    };

    let mut stream = render.stream();
    let width = stream.width();
    let height = stream.height();
    let channels = stream.channels();

    let total_samples = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|px| px.checked_mul(channels as usize))
    {
        Some(s) => s,
        None => fail("image dimensions overflow buffer"),
    };

    let mut buf = vec![0u8; total_samples];
    let written = stream.write_to_buffer(&mut buf);
    if written != total_samples {
        fail("incomplete stream decode");
    }

    let stdout = std::io::stdout();
    let mut encoder = png::Encoder::new(stdout.lock(), width, height);
    match channels {
        1 => encoder.set_color(png::ColorType::Grayscale),
        2 => encoder.set_color(png::ColorType::GrayscaleAlpha),
        3 => encoder.set_color(png::ColorType::Rgb),
        4 => encoder.set_color(png::ColorType::Rgba),
        _ => fail(&format!("unsupported channel count: {channels}")),
    }
    encoder.set_depth(png::BitDepth::Eight);

    let mut writer = match encoder.write_header() {
        Ok(w) => w,
        Err(e) => fail(&format!("failed to write PNG header: {e}")),
    };

    if let Err(e) = writer.write_image_data(&buf) {
        fail(&format!("failed to write PNG data: {e}"));
    }
}
