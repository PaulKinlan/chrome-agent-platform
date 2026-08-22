#!/usr/bin/env python3
from pathlib import Path
import shutil
import sys

source = Path(sys.argv[1])
target = Path(sys.argv[2])
shutil.copytree(source, target)
path = target / 'lib/minify.js'
text = path.read_text()
replacements = [
('import { SourceMap } from "./sourcemap.js";\n', ''),
('''// to/from base64 functions
// Prefer built-in Buffer, if available, then use hack
// https://developer.mozilla.org/en-US/docs/Glossary/Base64#The_Unicode_Problem
var to_ascii = typeof Buffer !== "undefined"
    ? (b64) => Buffer.from(b64, "base64").toString()
    : (b64) => decodeURIComponent(escape(atob(b64)));
var to_base64 = typeof Buffer !== "undefined"
    ? (str) => Buffer.from(str).toString("base64")
    : (str) => btoa(unescape(encodeURIComponent(str)));

function read_source_map(code) {
    var match = /(?:^|[^.])\\/\\/# sourceMappingURL=data:application\\/json(;[\\w=-]*)?;base64,([+/0-9A-Za-z]*=*)\\s*$/.exec(code);
    if (!match) {
        console.warn("inline source map not found");
        return null;
    }
    return to_ascii(match[2]);
}

''', ''),
('''    if (options.sourceMap) {
        options.sourceMap = defaults(options.sourceMap, {
            asObject: false,
            content: null,
            filename: null,
            includeSources: false,
            root: null,
            url: null,
        }, true);
    }
''', '''    if (options.sourceMap) {
        throw new Error("source maps are unavailable in terser_bounded");
    }
'''),
('''                if (options.sourceMap && options.sourceMap.content == "inline") {
                    if (Object.keys(files).length > 1)
                        throw new Error("inline source map only works with singular input");
                    options.sourceMap.content = read_source_map(files[name]);
                }
''', ''),
('''        if (options.sourceMap) {
            if (options.sourceMap.includeSources && files instanceof AST_Toplevel) {
                throw new Error("original source content unavailable");
            }
            format_options.source_map = yield* SourceMap({
                file: options.sourceMap.filename,
                orig: options.sourceMap.content,
                root: options.sourceMap.root,
                files: options.sourceMap.includeSources ? files : null,
            });
        }
''', ''),
('''        if (options.sourceMap) {
            Object.defineProperty(result, "map", {
                configurable: true,
                enumerable: true,
                get() {
                    const map = format_options.source_map.getEncoded();
                    return (result.map = options.sourceMap.asObject ? map : JSON.stringify(map));
                },
                set(value) {
                    Object.defineProperty(result, "map", {
                        value,
                        writable: true,
                    });
                }
            });
            result.decoded_map = format_options.source_map.getDecoded();
            if (options.sourceMap.url == "inline") {
                var sourceMap = typeof result.map === "object" ? JSON.stringify(result.map) : result.map;
                result.code += "\\n//# sourceMappingURL=data:application/json;charset=utf-8;base64," + to_base64(sourceMap);
            } else if (options.sourceMap.url) {
                result.code += "\\n//# sourceMappingURL=" + options.sourceMap.url;
            }
        }
''', ''),
('''    if (format_options && format_options.source_map) {
        format_options.source_map.destroy();
    }
''', ''),
('''export {
  minify,
  minify_sync,
  to_ascii,
};
''', '''export {
  minify,
  minify_sync,
};
'''),
]
for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected one exact terser source-map block, found {count}')
    text = text.replace(old, new)
path.write_text(text)
if '@jridgewell/source-map' in text or 'sourceMappingURL' in text or 'SourceMap(' in text:
    raise SystemExit('source-map path remained in bounded minify entry')
