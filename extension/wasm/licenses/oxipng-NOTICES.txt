oxipng bundled-package notices

oxipng (cap.bundled.oxipng) combines:
  1. oxipng 10.2.1 (the PNG optimiser crate) — MIT License, Copyright (c) 2016
     Joshua Holmer (full text below);
  2. libdeflate 1.26 (the C DEFLATE library vendored by libdeflate-sys 1.26.0,
     compiled -ffreestanding -nostdlib) — MIT License, Copyright 2016 Eric Biggers,
     Copyright 2024 Google LLC (full text below);
  3. libdeflater 1.26.0 and libdeflate-sys 1.26.0 (the Rust bindings) — Apache-2.0
     (see Apache-2.0.txt);
  4. base64, bytemuck, cc, equivalent, find-msvc-tools, hashbrown, indexmap, log,
     rgb, rustc-hash, shlex — each "MIT OR Apache-2.0" (rgb: MIT; bytemuck:
     Zlib OR Apache-2.0 OR MIT), used here under Apache-2.0 where offered; and
  5. the CAP-authored WASI driver (src/main.rs) — Apache-2.0 (see Apache-2.0.txt).

Package licence expression: "MIT AND Apache-2.0".
Full component list with versions: extension/wasm/sbom/oxipng.cdx.json.

======================================================================
oxipng — MIT License
======================================================================

The MIT License (MIT)
Copyright (c) 2016 Joshua Holmer

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

======================================================================
libdeflate — MIT License
======================================================================

Copyright 2016 Eric Biggers
Copyright 2024 Google LLC

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation files
(the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software,
and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
