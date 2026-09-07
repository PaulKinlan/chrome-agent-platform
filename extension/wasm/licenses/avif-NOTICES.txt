avif bundled-package notices

avif (cap.bundled.avif) combines:
  1. ravif 0.13.0 (the AVIF encoder front-end, https://github.com/kornelski/cavif-rs) —
     BSD-3-Clause (see LICENSE-ravif-BSD-3-Clause.txt);
  2. rav1e 0.8.1 (the AV1 encoder, https://github.com/xiph/rav1e) — BSD-2-Clause
     (see LICENSE-rav1e-BSD-2-Clause.txt); built with default-features = false (no
     nasm/cc SIMD asm, no rayon threading — the software path);
  3. image 0.25.10 (the stdin image decoder, png/jpeg/webp) — MIT OR Apache-2.0
     (see LICENSE-image-MIT.txt / LICENSE-image-Apache-2.0.txt);
  4. imgref 1.12.0 — CC0-1.0 OR Apache-2.0; rgb 0.8.53 — MIT (see LICENSE-rgb-MIT.txt);
  5. base64 0.22.1 — MIT OR Apache-2.0 (see LICENSE-base64-*.txt);
  6. every remaining transitive crate (see sbom/cyclonedx-1.5.json) — each
     MIT / Apache-2.0 / BSD-2/3-Clause / Zlib / CC0-1.0 / Unlicense / 0BSD /
     Unicode-3.0 as listed per component, used under Apache-2.0 where offered; and
  7. the CAP-authored WASI driver (src/main.rs) — Apache-2.0 (see LICENSE-Apache-2.0.txt).

Package licence expression: "BSD-3-Clause AND BSD-2-Clause AND (MIT OR Apache-2.0)".
Full component list with versions: sbom/cyclonedx-1.5.json.
