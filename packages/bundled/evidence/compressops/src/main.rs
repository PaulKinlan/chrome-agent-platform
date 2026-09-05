// compressops — CAP-authored WASI compression tool (chrome-agent-platform-y75s).
// stdin carries input bytes; stdout carries compressed or decompressed output.
// Errors go to stderr with a non-zero exit. No network, no env, no threads.
//
//   compressops zstd [-d] [-l 1..19]
//   compressops brotli [-d] [-q 0..11]
//   compressops info

use std::io::{Read, Write};

fn fail(msg: &str) -> ! {
    eprintln!("compressops: {msg}");
    std::process::exit(2);
}

fn arg_flag(args: &[String], name: &str, short: &str) -> bool {
    args.iter().any(|a| a == name || a == short)
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
        fail("could not read stdin");
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
        fail("usage: compressops zstd [-d] [-l 1..19] | brotli [-d] [-q 0..11] | info");
    };

    let subargs = &args[1..];
    let decompress = arg_flag(subargs, "--decompress", "-d");

    match cmd.as_str() {
        "info" => {
            let input = read_stdin();
            let magic = if input.len() >= 4 && input[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                "zstd"
            } else if input.len() >= 2 && input[0..2] == [0x1f, 0x8b] {
                "gzip"
            } else {
                "unknown"
            };
            let json = format!("{{\"bytes\":{},\"magic\":\"{}\"}}\n", input.len(), magic);
            write_stdout(json.as_bytes());
        }
        "zstd" => {
            let input = read_stdin();
            if decompress {
                let decompressed = zstd::decode_all(&input[..])
                    .unwrap_or_else(|e| fail(&format!("zstd decompress failed: {e}")));
                write_stdout(&decompressed);
            } else {
                let level: i32 = arg_value(subargs, "--level", "-l")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(3);
                let level = level.clamp(1, 19);
                let compressed = zstd::encode_all(&input[..], level)
                    .unwrap_or_else(|e| fail(&format!("zstd compress failed: {e}")));
                write_stdout(&compressed);
            }
        }
        "brotli" => {
            let input = read_stdin();
            if decompress {
                let mut decompressed = Vec::new();
                let mut reader = brotli::Decompressor::new(&input[..], 4096);
                if reader.read_to_end(&mut decompressed).is_err() {
                    fail("brotli decompress failed");
                }
                write_stdout(&decompressed);
            } else {
                let quality: u32 = arg_value(subargs, "--quality", "-q")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(6);
                let quality = quality.clamp(0, 11);
                let mut compressed = Vec::new();
                {
                    let mut writer = brotli::CompressorWriter::new(&mut compressed, 4096, quality, 22);
                    if writer.write_all(&input).is_err() {
                        fail("brotli compress failed");
                    }
                }
                write_stdout(&compressed);
            }
        }
        _ => fail(&format!("unknown command '{cmd}'; supported: zstd, brotli, info")),
    }
}
