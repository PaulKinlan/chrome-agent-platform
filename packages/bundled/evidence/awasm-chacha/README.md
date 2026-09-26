# awasm-chacha evidence (chrome-agent-platform-2uhx)

The second call-export-lane package: @awasm/noble 0.1.4's chacha_poly1305 module —
a zero-import compute module (43,461 bytes; exports memory + encryptInit /
encryptBlocks / decryptInit / decryptBlocks / tagFinish / aadBlocks / aadInit /
derive / macInit / macBlocksAt / macFinish / macPadAt / process / reset),
extracted from the pinned npm tarball (NO rebuild claimed — the evidence is the
byte-exact extraction).

Pins:
- tarball: awasm-noble-0.1.4.tgz, sha512 (base64) `LFkAq7VnGc8Hum4x12yxBsyoQYq9mWDf02j1lltzXaeZ14qcXwEYnOl5ByJ49xiBk1L7h6m3vkKkInvtDUIvOg==`
- tarball sha256: `a78cc0db73a29bacb87ad8d8610130df4cc6c4f69f7a0f64ac433e9f3445da91`
- extracted: binaries/chacha_poly1305.wasm, 43,461 bytes, sha256 `e1acae9b3ee3da01b2bd0574f906fede6f5219da4b9b43fd5c36ee16fbf11330`
- extract.mjs re-run is byte-identical (deterministic single-blob decode)

License: MIT (Paul Miller), LICENSES/awasm-noble-MIT.txt.
