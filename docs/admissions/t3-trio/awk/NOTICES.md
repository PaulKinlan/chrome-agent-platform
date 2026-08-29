# awk_filter_bounded notices and component inventory

## CAP clean-room source

- Component: `awk_filter_bounded` (`source/main.c`)
- Copyright: 2026 Chrome Agent Platform Authors
- License: 0BSD

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

## Linked runtime component

- Component: wasi-libc from wasi-sdk 18.1.2 sysroot
- Project: https://github.com/WebAssembly/wasi-libc
- License: Apache-2.0 WITH LLVM-exception
- Role: statically linked C runtime and WASI preview-1 bindings

The full upstream license is at
https://github.com/WebAssembly/wasi-libc/blob/main/LICENSE and is represented in
`sbom.cdx.json`. No other third-party application component is linked.
