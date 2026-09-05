# hasher — bundled dependency licences

CAP-authored wrapper (this repository, MIT AND Apache-2.0 per the project
licence) over these crates, pinned in Cargo.lock:

| crate  | version | licence                              |
|--------|---------|--------------------------------------|
| sha2   | 0.10.9  | MIT OR Apache-2.0 (RustCrypto)       |
| sha3   | 0.10.8  | MIT OR Apache-2.0 (RustCrypto)       |
| blake2 | 0.10.6  | MIT OR Apache-2.0 (RustCrypto)       |
| blake3 | 1.8.2   | Apache-2.0 (official BLAKE3 implementation; CC0-1.0 dedicated public-domain components) |
| hex    | 0.4.3   | MIT OR Apache-2.0                    |

Licence texts ship in the crates' own packages (unpacked under the cargo
registry at build time); the pinned Cargo.lock addresses the exact sources.
