//! Thin WASI entrypoint for numbat: read a program (<=2KiB) from stdin, evaluate
//! it with the built-in prelude (no filesystem/network), print the result (<=64KiB)
//! to stdout. Honest error contract: bounded diagnostics, exit 0 on success, exit 1
//! on failure. No plotting/exchangerates default features.
use std::io::{Read, Write};

use numbat::module_importer::BuiltinModuleImporter;
use numbat::resolver::CodeSource;
use numbat::{Context, FormatOptions, InterpreterSettings};

const MAX_INPUT: usize = 2 * 1024;
const MAX_OUTPUT: usize = 64 * 1024;

fn bounded_stdin() -> Result<String, String> {
    let mut buf = Vec::with_capacity(MAX_INPUT + 1);
    let mut chunk = [0u8; 512];
    let stdin = std::io::stdin();
    let mut handle = stdin.lock();
    loop {
        match handle.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_INPUT {
                    return Err(format!("input exceeds the {MAX_INPUT}-byte limit"));
                }
            }
            Err(e) => return Err(format!("stdin read failed: {e}")),
        }
    }
    String::from_utf8(buf).map_err(|e| format!("input is not valid UTF-8: {e}"))
}

fn main() {
    let mut stdout = std::io::stdout();
    let program = match bounded_stdin() {
        Ok(p) => p,
        Err(e) => {
            let _ = writeln!(stdout, "error: {e}");
            std::process::exit(1);
        }
    };

    let mut context = Context::new(BuiltinModuleImporter::default());

    // Load the built-in prelude (embedded modules; no filesystem/network).
    if let Err(e) = context.interpret("use prelude", CodeSource::Internal) {
        let _ = writeln!(stdout, "error: failed to load prelude: {e}");
        std::process::exit(1);
    }

    let mut settings = InterpreterSettings::default();
    match context.interpret_with_settings(&mut settings, &program, CodeSource::Text) {
        Ok((statements, result)) => {
            let registry = context.dimension_registry();
            let markup = result.to_markup(
                statements.last(),
                registry,
                false,
                false,
                &FormatOptions::default(),
            );
            let text = markup.to_string();
            if text.len() > MAX_OUTPUT {
                let _ = write!(stdout, "{}", &text[..MAX_OUTPUT]);
                let _ = writeln!(stdout, "\n[output truncated at {MAX_OUTPUT} bytes]");
            } else {
                let _ = write!(stdout, "{text}");
            }
        }
        Err(e) => {
            let msg = format!("{e}");
            let bounded: String = msg.chars().take(8 * 1024).collect();
            let _ = writeln!(stdout, "error: {bounded}");
            std::process::exit(1);
        }
    }
}
