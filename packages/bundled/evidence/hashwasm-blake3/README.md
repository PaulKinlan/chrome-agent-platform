# hashwasm-blake3 evidence (chrome-agent-platform-uslb)

The FIRST call-export-lane package: hash-wasm 4.12.0's blake3 module — a
zero-import compute module (11,891 bytes; exports memory + Hash_GetBuffer /
Hash_Init / Hash_Update / Hash_Final / Hash_GetState / Hash_Calculate /
STATE_SIZE), extracted from the pinned npm tarball (NO rebuild claimed — the
evidence is the byte-exact extraction).

Pins:
- tarball: hash-wasm-4.12.0.tgz, sha512 (base64) +/2B2rYLb48I/evdOIhP+K/DD2ca2fgBjp6O+GBEnCDk2e4rpeXIK8GvIyRPjTezgmWn9gmKwkQjjx6BtqDHVQ== (registry integrity field matches)
- extracted: binaries/blake3.wasm, 11,891 bytes, sha256 984b12e3b76a670fe58f43aa965658cdfefe0867f88c4935a292f68bdf3c55e1
- extract.mjs re-run is byte-identical (deterministic single-blob decode)

License: MIT (Dani Biró), LICENSES/hash-wasm-MIT.txt.
