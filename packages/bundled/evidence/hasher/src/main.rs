// hasher — CAP-authored WASI hash tool (chrome-agent-platform-3wei).
// stdin carries the source bytes; stdout carries the lowercase hex digest.
// Errors go to stderr with a non-zero exit. No network, no env, no threads.
//
//   hasher --algo sha256|sha512|sha3-256|sha3-512|blake2b|blake3
//
// Admitted on behalf of the catalogue §3 candidates hash-wasm + blake3-wasm:
// the algorithms come from the audited reference implementations those npm
// packages wrap (RustCrypto sha2/sha3, blake2, and the official blake3 crate).

use std::io::{Read, Write};

fn fail(msg: &str) -> ! {
    eprintln!("hasher: {msg}");
    std::process::exit(2);
}

fn read_stdin() -> Vec<u8> {
    let mut buf = Vec::new();
    if std::io::stdin().read_to_end(&mut buf).is_err() {
        fail("could not read stdin");
    }
    buf
}

fn write_stdout(text: &str) {
    if std::io::stdout().write_all(text.as_bytes()).is_err() {
        fail("could not write stdout");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(schema) = args.first() else {
        fail("usage: hasher --algo sha256|sha512|sha3-256|sha3-512|blake2b|blake3");
    };
    if schema != "--algo" {
        fail(&format!("unknown flag {schema} (expected --algo)"));
    }
    let Some(algo) = args.get(1).map(|s| s.as_str()) else {
        fail("missing --algo value");
    };
    if args.get(2).is_some() {
        fail("unexpected extra arguments");
    }
    let input = read_stdin();
    let digest: Vec<u8> = match algo {
        "sha256" => {
            use sha2::Digest;
            sha2::Sha256::digest(&input).to_vec()
        }
        "sha512" => {
            use sha2::Digest;
            sha2::Sha512::digest(&input).to_vec()
        }
        "sha3-256" => {
            use sha3::Digest;
            sha3::Sha3_256::digest(&input).to_vec()
        }
        "sha3-512" => {
            use sha3::Digest;
            sha3::Sha3_512::digest(&input).to_vec()
        }
        "blake2b" => {
            use blake2::Digest;
            blake2::Blake2b512::digest(&input).to_vec()
        }
        "blake3" => blake3::hash(&input).as_bytes().to_vec(),
        other => fail(&format!(
            "unknown algo {other} (supported: sha256 sha512 sha3-256 sha3-512 blake2b blake3)"
        )),
    };
    write_stdout(&hex::encode(digest));
    write_stdout("\n");
}
